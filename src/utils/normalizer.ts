import crypto from "node:crypto";
import type { BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	type FieldMapping,
	canonicalMappedValue,
	getBacklogTargetValue,
	getMappedJiraValue,
	isCoreOverrideTarget,
	loadFieldMappings,
	readTaskFrontmatter,
} from "./field-mapping.ts";
import {
	backlogParentValue,
	jiraParentValue,
	parentLinksEnabled,
} from "./parent-payload.ts";
import {
	SPRINT_PAYLOAD_KEY,
	type SprintPayloadSource,
	backlogSprintValue,
	jiraSprintValue,
	loadSprintPayloadSource,
} from "./sprint-payload.ts";
import {
	type StatusMappingConfig,
	loadStatusMapping,
	mapJiraStatusToBacklog,
} from "./status-mapping.ts";

/**
 * Normalized payload for comparison between Backlog and Jira
 * Contains only the fields that should be synced
 */
export interface NormalizedPayload {
	title: string;
	description: string;
	status: string;
	priority?: string;
	labels: string[];
	assignee?: string;
	// AC is Backlog-specific but we normalize it for comparison
	acceptanceCriteria: Array<{ text: string; checked: boolean }>;
	// Values of user-defined field mappings, keyed by Backlog target, in
	// canonical Backlog representation. Omitted when no mappings apply so
	// hashes for users without fieldMappings are unchanged.
	mappedFields?: Record<string, string>;
	// Parent as a Jira key (see parent-payload.ts): "" for none. Omitted when
	// parent links are off; hashed only when set, so hashes of tasks without
	// a parent are unchanged.
	parent?: string;
}

export interface NormalizeOptions {
	/** Field mappings to apply; loaded from config.json when omitted */
	fieldMappings?: FieldMapping[];
	/** Task frontmatter; read from the task file when omitted and needed */
	frontmatter?: Record<string, unknown>;
	/** Status mapping for Jira statuses; loaded from config.json when omitted */
	statusMapping?: StatusMappingConfig;
	/** Sprint sync source; loaded from config.json when omitted, null for none */
	sprint?: SprintPayloadSource | null;
	/** Whether to carry the parent; read from config.json when omitted */
	parentLinks?: boolean;
}

function getSprintSource(
	options?: Pick<NormalizeOptions, "sprint">,
): SprintPayloadSource | null {
	return options?.sprint === undefined
		? loadSprintPayloadSource()
		: options.sprint;
}

/**
 * Field mappings that contribute to the payload, in any direction.
 * Priority/labels mappings replace the core field instead of adding to
 * mappedFields. Direction is applied when classifying changes, so both sides
 * carry every mapped value and hash identically when in sync.
 */
function getMappedFieldMappings(options?: NormalizeOptions): FieldMapping[] {
	return options?.fieldMappings ?? loadFieldMappings();
}

/**
 * Normalize a Backlog task to a comparable payload
 */
export function normalizeBacklogTask(
	task: BacklogTask,
	options?: NormalizeOptions,
): NormalizedPayload {
	const payload: NormalizedPayload = {
		title: task.title.trim(),
		description: (task.description || "").trim(),
		status: canonicalStatus(task.status),
		priority: task.priority?.toLowerCase(),
		labels: (task.labels || []).map((l) => l.toLowerCase()).sort(),
		assignee: task.assignee?.trim().toLowerCase(),
		acceptanceCriteria: (task.acceptanceCriteria || []).map((ac) => ({
			text: ac.text.trim(),
			checked: ac.checked,
		})),
	};
	if (options?.parentLinks ?? parentLinksEnabled()) {
		payload.parent = backlogParentValue(task.parent);
	}

	const mappings = getMappedFieldMappings(options).filter(
		(m) => !isCoreOverrideTarget(m.backlog),
	);
	const sprint = getSprintSource(options);
	if (mappings.length > 0 || sprint) {
		const frontmatter = options?.frontmatter ?? readTaskFrontmatter(task.id);
		payload.mappedFields = {};
		for (const mapping of mappings) {
			payload.mappedFields[mapping.backlog] = canonicalMappedValue(
				getBacklogTargetValue(frontmatter, mapping.backlog),
				mapping.backlog,
			);
		}
		if (sprint) {
			payload.mappedFields[SPRINT_PAYLOAD_KEY] = backlogSprintValue(
				sprint,
				frontmatter.milestone,
			);
		}
	}

	return payload;
}

/**
 * Normalize a Jira issue to a comparable payload
 */
export function normalizeJiraIssue(
	issue: JiraIssue,
	options?: Pick<
		NormalizeOptions,
		"fieldMappings" | "statusMapping" | "sprint" | "parentLinks"
	>,
): NormalizedPayload {
	const payload: NormalizedPayload = {
		title: issue.summary.trim(),
		description: (issue.description || "").trim(),
		status: canonicalStatus(
			mapJiraStatusToBacklog(
				issue.status,
				issue.key.split("-")[0],
				options?.statusMapping ?? loadStatusMapping(),
			),
		),
		priority: issue.priority?.toLowerCase(),
		labels: (issue.labels || []).map((l) => l.toLowerCase()).sort(),
		assignee: issue.assignee?.trim().toLowerCase(),
		// Jira doesn't have AC, so we extract from description if formatted
		acceptanceCriteria: extractAcceptanceCriteria(issue.description || ""),
	};
	if (options?.parentLinks ?? parentLinksEnabled()) {
		payload.parent = jiraParentValue(issue);
	}

	for (const mapping of getMappedFieldMappings(options)) {
		const value = getMappedJiraValue(issue, mapping);
		if (mapping.backlog === "priority") {
			// Mapped priority replaces the built-in Jira priority as the source
			payload.priority =
				typeof value === "string" ? value.toLowerCase() : undefined;
		} else if (mapping.backlog === "labels") {
			// Mapped labels replace the built-in Jira labels as the source
			payload.labels = (Array.isArray(value) ? value : [])
				.map((l) => l.toLowerCase())
				.sort();
		} else {
			payload.mappedFields = payload.mappedFields ?? {};
			payload.mappedFields[mapping.backlog] = canonicalMappedValue(
				value,
				mapping.backlog,
			);
		}
	}

	const sprint = getSprintSource(options);
	if (sprint) {
		payload.mappedFields = payload.mappedFields ?? {};
		payload.mappedFields[SPRINT_PAYLOAD_KEY] = jiraSprintValue(sprint, issue);
	}

	return payload;
}

/**
 * Canonical tokens for Backlog's default statuses. Kept so hashes stored by
 * earlier versions stay valid; other statuses are compared lower-cased.
 */
const CANONICAL_STATUS_TOKENS: Record<string, string> = {
	"to do": "todo",
	"in progress": "in_progress",
};

/**
 * Canonical form of a Backlog status for comparison. Jira statuses are first
 * resolved to their Backlog status through the configured status mapping
 * (backlog.statusMapping and projectOverrides in config.json), the same
 * mapping pull uses, so both sides compare equal exactly when pull would
 * leave the Backlog status unchanged.
 */
function canonicalStatus(status: string): string {
	const normalized = status.toLowerCase().trim();
	return CANONICAL_STATUS_TOKENS[normalized] ?? normalized;
}

/**
 * Format acceptance criteria for inclusion in Jira description
 * Converts array of AC to markdown format with checked/unchecked boxes
 */
export function formatAcceptanceCriteriaForJira(
	acceptanceCriteria: Array<{ text: string; checked: boolean }>,
): string {
	if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
		return "";
	}

	const formatted = acceptanceCriteria
		.map((ac) => {
			const checkbox = ac.checked ? "[x]" : "[ ]";
			return `- ${checkbox} ${ac.text}`;
		})
		.join("\n");

	return `\n\nAcceptance Criteria:\n${formatted}`;
}

/**
 * Remove acceptance criteria section from a description
 * Returns the description without the AC section
 */
export function stripAcceptanceCriteriaFromDescription(
	description: string,
): string {
	if (!description) return "";

	// Remove AC section (case-insensitive, handles variations)
	const withoutAc = description.replace(
		/\n\n?Acceptance Criteria:?\s*[\s\S]*?(?=\n\n|$)/i,
		"",
	);
	return withoutAc.trim();
}

/**
 * Merge description with acceptance criteria for Jira
 * Strips any existing AC section from description first, then appends formatted AC
 */
export function mergeDescriptionWithAc(
	description: string,
	acceptanceCriteria: Array<{ text: string; checked: boolean }>,
	implementationPlan?: string,
	implementationNotes?: string,
): string {
	const cleanDescription = stripAcceptanceCriteriaFromDescription(description);
	const acSection = formatAcceptanceCriteriaForJira(acceptanceCriteria);

	// Build the full description with all sections
	let fullDescription = cleanDescription + acSection;

	// Add Implementation Plan if present
	if (implementationPlan?.trim()) {
		fullDescription += `\n\nImplementation Plan:\n${implementationPlan.trim()}`;
	}

	// Add Implementation Notes if present
	if (implementationNotes?.trim()) {
		fullDescription += `\n\nImplementation Notes:\n${implementationNotes.trim()}`;
	}

	return fullDescription;
}

/**
 * Extract acceptance criteria from Jira description
 * Looks for patterns like "Acceptance Criteria:" followed by bullet points
 */
function extractAcceptanceCriteria(
	description: string,
): Array<{ text: string; checked: boolean }> {
	const criteria: Array<{ text: string; checked: boolean }> = [];

	// Look for AC section
	const acMatch = description.match(
		/acceptance criteria:?\s*([\s\S]*?)(?=\n\n|$)/i,
	);
	if (!acMatch) return criteria;

	const acSection = acMatch[1];
	const lines = acSection.split("\n");

	for (const line of lines) {
		// Match checked or unchecked bullet points
		const checkedMatch = line.match(/^[\s-]*\[x\]\s*(.+)/i);
		const uncheckedMatch = line.match(/^[\s-]*\[ \]\s*(.+)/i);
		const bulletMatch = line.match(/^[\s-]*[*•-]\s*(.+)/);

		if (checkedMatch) {
			criteria.push({ text: checkedMatch[1].trim(), checked: true });
		} else if (uncheckedMatch) {
			criteria.push({ text: uncheckedMatch[1].trim(), checked: false });
		} else if (bulletMatch) {
			criteria.push({ text: bulletMatch[1].trim(), checked: false });
		}
	}

	return criteria;
}

/**
 * Compute a hash of a normalized payload for change detection
 * Uses stable JSON serialization and SHA-256
 */
export function computeHash(payload: NormalizedPayload): string {
	// Sort object keys for stable hashing
	const stable = {
		acceptanceCriteria: payload.acceptanceCriteria,
		assignee: payload.assignee || "",
		description: payload.description,
		labels: payload.labels,
		priority: payload.priority || "",
		status: payload.status,
		title: payload.title,
	};

	// Only include mapped fields when present, so hashes for users without
	// fieldMappings stay identical to earlier versions
	const mappedKeys = Object.keys(payload.mappedFields ?? {}).sort();
	if (mappedKeys.length > 0) {
		const mappedFields: Record<string, string> = {};
		for (const key of mappedKeys) {
			mappedFields[key] = (payload.mappedFields as Record<string, string>)[key];
		}
		(stable as Record<string, unknown>).mappedFields = mappedFields;
	}
	if (payload.parent) {
		(stable as Record<string, unknown>).parent = payload.parent;
	}

	const json = JSON.stringify(stable);
	return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Compare two normalized payloads field by field
 * Returns a list of changed fields
 */
export function comparePayloads(
	a: NormalizedPayload,
	b: NormalizedPayload,
): string[] {
	const changes: string[] = [];

	if (a.title !== b.title) changes.push("title");
	if (a.description !== b.description) changes.push("description");
	if (a.status !== b.status) changes.push("status");
	if (a.priority !== b.priority) changes.push("priority");
	if (a.assignee !== b.assignee) changes.push("assignee");
	if ((a.parent ?? "") !== (b.parent ?? "")) changes.push("parent");

	// Compare arrays
	if (JSON.stringify(a.labels) !== JSON.stringify(b.labels)) {
		changes.push("labels");
	}
	if (
		JSON.stringify(a.acceptanceCriteria) !==
		JSON.stringify(b.acceptanceCriteria)
	) {
		changes.push("acceptanceCriteria");
	}

	const mappedKeys = new Set([
		...Object.keys(a.mappedFields ?? {}),
		...Object.keys(b.mappedFields ?? {}),
	]);
	for (const key of [...mappedKeys].sort()) {
		if ((a.mappedFields?.[key] ?? "") !== (b.mappedFields?.[key] ?? "")) {
			changes.push(key);
		}
	}

	return changes;
}
