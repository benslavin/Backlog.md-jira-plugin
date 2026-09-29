import type { BacklogClient, BacklogTask } from "../integrations/backlog.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import type { FrontmatterStore } from "../state/store.ts";
import {
	type FieldMapping,
	type MappedJiraFieldUpdates,
	type MappedValue,
	type SprintMapping,
	buildBacklogValueUpdates,
	buildJiraValueUpdates,
	canonicalMappedValue,
	coerceForTarget,
	getBacklogTargetValue,
	getMappedJiraValue,
	isCoreOverrideTarget,
	withoutBuiltInMappings,
} from "./field-mapping.ts";
import { getTaskFilePath, updateFrontmatterFields } from "./frontmatter.ts";
import { logger } from "./logger.ts";
import {
	type NormalizedPayload,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "./normalizer.ts";

/**
 * Push, conflict and display helpers for user-defined field mappings.
 * Direction rules: `pull` mappings are never written to Jira and `push`
 * mappings are never written to Backlog.
 */

// ===== Writing mapped fields to Jira =====

export interface MappedFieldFailure {
	mapping: FieldMapping | SprintMapping;
	error: string;
}

/**
 * Raised after a push or create when one or more mapped fields could not be
 * written to Jira. Everything else was written.
 */
export class MappedFieldPushError extends Error {
	constructor(
		public readonly issueKey: string,
		public readonly failures: MappedFieldFailure[],
	) {
		super(formatMappedFieldFailures(issueKey, failures));
		this.name = "MappedFieldPushError";
	}
}

/**
 * Human-readable summary naming each failed mapped field
 */
export function formatMappedFieldFailures(
	issueKey: string,
	failures: MappedFieldFailure[],
): string {
	const lines = failures.map(
		(f) =>
			`  - ${f.mapping.jira} (mapped to ${f.mapping.backlog}): ${firstLine(f.error)}`,
	);
	const hints: string[] = [];
	if (failures.some((f) => f.mapping.type !== "sprint")) {
		hints.push(
			"Check the field is on the issue type's edit screen (backlog-jira doctor) or fix the mapping with backlog-jira map-fields.",
		);
	}
	if (failures.some((f) => f.mapping.type === "sprint")) {
		hints.push(
			"Check the milestone matches a future or active sprint on the configured board (backlog-jira doctor).",
		);
	}
	return `Mapped field${failures.length === 1 ? "" : "s"} could not be updated on ${issueKey}:\n${lines.join("\n")}\n${hints.join("\n")}`;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type CoreIssueFields = {
	summary?: string;
	description?: string;
	assignee?: string;
	priority?: string;
	labels?: string[];
};

/**
 * Update an issue's core fields and mapped fields in one request.
 *
 * Jira rejects the whole update when any field cannot be set, so if the
 * combined request fails the core fields are retried alone and each mapped
 * field is sent separately to find the ones at fault. A failure of the core
 * fields is rethrown; mapped field failures (including values that could not
 * be converted) are returned.
 */
export async function updateIssueWithMappedFields(
	jira: Pick<JiraClient, "updateIssue">,
	issueKey: string,
	coreFields: CoreIssueFields,
	mapped: MappedJiraFieldUpdates,
): Promise<MappedFieldFailure[]> {
	const failures: MappedFieldFailure[] = [...mapped.errors];
	const hasCore = Object.keys(coreFields).length > 0;
	const mappedIds = Object.keys(mapped.fields);

	if (mappedIds.length === 0) {
		if (hasCore) await jira.updateIssue(issueKey, coreFields);
		return failures;
	}

	try {
		await jira.updateIssue(issueKey, { ...coreFields, fields: mapped.fields });
		return failures;
	} catch (error) {
		logger.warn(
			{ issueKey, error: errorMessage(error), mappedFields: mappedIds },
			"Update with mapped fields failed; retrying fields individually",
		);
	}

	if (hasCore) {
		await jira.updateIssue(issueKey, coreFields);
	}

	for (const fieldId of mappedIds) {
		try {
			await jira.updateIssue(issueKey, {
				fields: { [fieldId]: mapped.fields[fieldId] },
			});
		} catch (error) {
			for (const change of mapped.changes) {
				if (change.mapping.jira === fieldId) {
					failures.push({
						mapping: change.mapping,
						error: errorMessage(error),
					});
				}
			}
		}
	}

	return failures;
}

/**
 * Create an issue including mapped field values.
 *
 * When Jira rejects the creation because of a mapped field (the error names
 * the field), the issue is created without mapped fields and they are then
 * set one by one, so the failing fields can be reported.
 */
export async function createIssueWithMappedFields(
	jira: Pick<JiraClient, "createIssue" | "updateIssue">,
	projectKey: string,
	issueType: string,
	summary: string,
	options: CoreIssueFields,
	mapped: MappedJiraFieldUpdates,
): Promise<{ issue: JiraIssue; failures: MappedFieldFailure[] }> {
	const mappedIds = Object.keys(mapped.fields);
	try {
		const issue = await jira.createIssue(projectKey, issueType, summary, {
			...options,
			...(mappedIds.length > 0 ? { fields: mapped.fields } : {}),
		});
		return { issue, failures: [...mapped.errors] };
	} catch (error) {
		const message = errorMessage(error);
		if (!mappedIds.some((id) => message.includes(id))) {
			throw error;
		}
		logger.warn(
			{ error: message, mappedFields: mappedIds },
			"Create with mapped fields failed; creating without them",
		);
	}

	const issue = await jira.createIssue(projectKey, issueType, summary, options);
	const failures = await updateIssueWithMappedFields(
		jira,
		issue.key,
		{},
		mapped,
	);
	return { issue, failures };
}

/**
 * Copy the given targets' values from another payload
 */
function payloadWithValuesFrom(
	payload: NormalizedPayload,
	source: NormalizedPayload,
	targets: string[],
): NormalizedPayload {
	const result: NormalizedPayload = {
		...payload,
		...(payload.mappedFields
			? { mappedFields: { ...payload.mappedFields } }
			: {}),
	};
	for (const key of targets) {
		if (key === "priority") {
			result.priority = source.priority;
		} else if (key === "labels") {
			result.labels = source.labels;
		} else if (result.mappedFields) {
			result.mappedFields[key] = source.mappedFields?.[key] ?? "";
		}
	}
	return result;
}

/**
 * Backlog payload to store as the snapshot after a push in which some mapped
 * fields failed: failed fields carry Jira's value, so the next sync still sees
 * them as changed in Backlog and retries the push.
 */
export function payloadWithFailedFields(
	backlogPayload: NormalizedPayload,
	jiraPayload: NormalizedPayload,
	failures: MappedFieldFailure[],
): NormalizedPayload {
	return payloadWithValuesFrom(
		backlogPayload,
		jiraPayload,
		failures.map((f) => f.mapping.backlog),
	);
}

/**
 * One-way fields owned by the other side (`pull` mappings when storing the
 * Backlog snapshot, `push` mappings when storing the Jira snapshot) whose
 * value differs between the sides. Storing the owner's value for them in the
 * snapshot makes the next sync restore them from their owner.
 * Returns null when there is nothing to mark.
 */
export function markOwnerValues(
	payload: NormalizedPayload,
	owner: NormalizedPayload,
	mappings: FieldMapping[],
	ownedDirection: "pull" | "push",
): NormalizedPayload | null {
	const targets = mappings
		.filter(
			(m) =>
				m.direction === ownedDirection &&
				payloadValue(payload, m.backlog) !== payloadValue(owner, m.backlog),
		)
		.map((m) => m.backlog);
	return targets.length > 0
		? payloadWithValuesFrom(payload, owner, targets)
		: null;
}

type SnapshotStore = Pick<FrontmatterStore, "setSnapshot" | "updateSyncState">;

/**
 * Record snapshots after a successful push (source "backlog") or pull
 * (source "jira"). Both sides are stored with the source's hash, except that
 * one-way fields the source could not write are marked for restoring.
 */
export function recordSyncedSnapshots(
	store: SnapshotStore,
	taskId: string,
	payloads: { backlog: NormalizedPayload; jira: NormalizedPayload },
	source: "backlog" | "jira",
	mappings: FieldMapping[],
): void {
	const syncedHash = computeHash(payloads[source]);
	const target = source === "backlog" ? "jira" : "backlog";
	// A push cannot write pull-only fields; a pull cannot write push-only ones
	const marked = markOwnerValues(
		payloads[source],
		payloads[target],
		mappings,
		source === "backlog" ? "pull" : "push",
	);
	store.setSnapshot(
		taskId,
		source,
		marked ? computeHash(marked) : syncedHash,
		marked ?? payloads[source],
	);
	store.setSnapshot(taskId, target, syncedHash, payloads[target]);
}

/**
 * Record snapshots after a push or create in which some mapped fields failed.
 * The Jira snapshot reflects Jira as it now is; the Backlog snapshot carries
 * Jira's values for the failed fields so they stay pending (NeedsPush) and
 * are retried by the next push or sync.
 */
export function recordPartialPush(
	store: SnapshotStore,
	taskId: string,
	task: BacklogTask,
	issue: JiraIssue,
	failures: MappedFieldFailure[],
	mappings: FieldMapping[] = [],
): void {
	const jiraPayload = normalizeJiraIssue(issue);
	const withFailures = payloadWithFailedFields(
		normalizeBacklogTask(task),
		jiraPayload,
		failures,
	);
	const backlogPayload =
		markOwnerValues(withFailures, jiraPayload, mappings, "pull") ??
		withFailures;
	store.setSnapshot(
		taskId,
		"backlog",
		computeHash(backlogPayload),
		backlogPayload,
	);
	store.setSnapshot(taskId, "jira", computeHash(jiraPayload), jiraPayload);
	store.updateSyncState(taskId, { lastSyncAt: new Date().toISOString() });
}

// ===== Writing mapped fields to Backlog =====

/**
 * Write mapped values to a Backlog task: native targets via the Backlog CLI,
 * frontmatter:<key> targets directly afterwards. Unchanged values are skipped.
 */
export async function writeBacklogMappedValues(
	backlog: Pick<BacklogClient, "updateTask">,
	taskId: string,
	values: Array<{ mapping: FieldMapping; value: MappedValue }>,
	currentFrontmatter: Record<string, unknown>,
): Promise<void> {
	const updates = buildBacklogValueUpdates(values, currentFrontmatter);
	if (Object.keys(updates.cli).length > 0) {
		await backlog.updateTask(taskId, updates.cli);
	}
	if (Object.keys(updates.frontmatter).length > 0) {
		updateFrontmatterFields(getTaskFilePath(taskId), updates.frontmatter);
	}
}

// ===== Field-level conflicts =====

export interface MappedFieldConflict {
	field: string;
	backlogValue: MappedValue;
	jiraValue: MappedValue;
	baseValue: MappedValue;
	mapping: FieldMapping;
}

/** A mapped field's canonical value within a normalized payload */
function payloadValue(
	payload: Partial<NormalizedPayload> | null | undefined,
	target: string,
): string {
	if (!payload) return "";
	if (target === "priority") return payload.priority ?? "";
	if (target === "labels") return JSON.stringify(payload.labels ?? []);
	return payload.mappedFields?.[target] ?? "";
}

/** Turn a canonical payload value back into a displayable value */
function fromCanonical(value: string, target: string): MappedValue {
	if (!value) return null;
	if (target === "labels" || value.startsWith("[")) {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
		} catch {
			// not a list
		}
	}
	return value;
}

export interface MappedFieldState {
	/** Current normalized payloads */
	current: { backlog: NormalizedPayload; jira: NormalizedPayload };
	/** Payloads stored at the last sync */
	base: {
		backlog: Partial<NormalizedPayload> | null;
		jira: Partial<NormalizedPayload> | null;
	};
	/** Current task frontmatter and Jira issue, for the actual values */
	frontmatter: Record<string, unknown>;
	issue: JiraIssue;
}

function sideChanges(state: MappedFieldState, target: string) {
	const backlogNow = payloadValue(state.current.backlog, target);
	const jiraNow = payloadValue(state.current.jira, target);
	return {
		backlogChanged: backlogNow !== payloadValue(state.base.backlog, target),
		jiraChanged: jiraNow !== payloadValue(state.base.jira, target),
		differ: backlogNow !== jiraNow,
	};
}

/**
 * Mapped fields changed on both sides since the last sync to different
 * values. Only `both` mappings can conflict: the owner side of a one-way
 * mapping always wins.
 */
export function detectMappedFieldConflicts(
	state: MappedFieldState,
	mappings: FieldMapping[],
): MappedFieldConflict[] {
	const conflicts: MappedFieldConflict[] = [];
	if (!state.base.backlog || !state.base.jira) return conflicts;

	for (const mapping of mappings) {
		if (mapping.direction !== "both") continue;
		const target = mapping.backlog;
		const { backlogChanged, jiraChanged, differ } = sideChanges(state, target);
		if (!backlogChanged || !jiraChanged || !differ) continue;

		conflicts.push({
			field: target,
			backlogValue: getBacklogTargetValue(state.frontmatter, target),
			jiraValue: getMappedJiraValue(state.issue, mapping),
			baseValue: fromCanonical(
				payloadValue(state.base.backlog, target),
				target,
			),
			mapping,
		});
	}

	return conflicts;
}

/**
 * Parse a manually entered conflict resolution for a mapped field
 */
export function parseManualMappedValue(
	value: unknown,
	mapping: FieldMapping,
): MappedValue {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) {
		return coerceForTarget(value.map(String), mapping.backlog);
	}
	const text = String(value).trim();
	if (!text) return null;
	const isList =
		mapping.type === "multi-option" ||
		mapping.type === "array" ||
		Array.isArray(coerceForTarget(text, mapping.backlog));
	return isList
		? text
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean)
		: text;
}

/**
 * Resolve every mapped field to its merged value after a conflict:
 * - pull mappings take Jira's value, push mappings take Backlog's
 * - both mappings take the side that changed, or the chosen resolution when
 *   both changed
 * Fields with nothing to merge are omitted.
 */
export function planMappedFieldMerge(
	state: MappedFieldState,
	mappings: FieldMapping[],
	resolutions: Map<string, MappedValue>,
): Array<{ mapping: FieldMapping; value: MappedValue }> {
	const plan: Array<{ mapping: FieldMapping; value: MappedValue }> = [];

	for (const mapping of mappings) {
		const target = mapping.backlog;
		const backlogValue = getBacklogTargetValue(state.frontmatter, target);
		const jiraValue = getMappedJiraValue(state.issue, mapping);

		if (resolutions.has(target) && mapping.direction === "both") {
			plan.push({ mapping, value: resolutions.get(target) ?? null });
			continue;
		}

		const { backlogChanged, jiraChanged, differ } = sideChanges(state, target);
		if (!differ) continue;

		if (mapping.direction === "pull") {
			plan.push({ mapping, value: jiraValue });
		} else if (mapping.direction === "push") {
			plan.push({ mapping, value: backlogValue });
		} else if (backlogChanged && !jiraChanged) {
			plan.push({ mapping, value: backlogValue });
		} else if (jiraChanged && !backlogChanged) {
			plan.push({ mapping, value: jiraValue });
		}
	}

	return plan;
}

/**
 * Apply merged mapped values to both sides, honouring direction.
 * Returns the Jira fields that could not be written.
 */
export async function applyMappedFieldMerge(
	plan: Array<{ mapping: FieldMapping; value: MappedValue }>,
	context: {
		taskId: string;
		issueKey: string;
		backlog: Pick<BacklogClient, "updateTask">;
		jira: Pick<JiraClient, "updateIssue">;
		frontmatter: Record<string, unknown>;
		issue: JiraIssue;
	},
): Promise<MappedFieldFailure[]> {
	const { taskId, issueKey, backlog, jira, frontmatter, issue } = context;

	await writeBacklogMappedValues(
		backlog,
		taskId,
		plan.filter((p) => p.mapping.direction !== "push"),
		frontmatter,
	);

	const jiraUpdates = buildJiraValueUpdates(
		plan.filter((p) => p.mapping.direction !== "pull"),
		issue,
	);
	return updateIssueWithMappedFields(jira, issueKey, {}, jiraUpdates);
}

// ===== Display =====

function displayValue(value: MappedValue): string {
	if (value === null) return "(empty)";
	return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Plain-text section listing each mapped field's Backlog and Jira values.
 * `issue` is null when the task is not linked or Jira could not be reached.
 */
export function formatMappedFieldsSection(
	mappings: FieldMapping[],
	frontmatter: Record<string, unknown>,
	issue: JiraIssue | null,
	jiraUnavailableReason?: string,
): string[] {
	if (mappings.length === 0) return [];

	const lines = ["", "Mapped Fields:", "-".repeat(50)];
	for (const mapping of mappings) {
		const backlogValue = getBacklogTargetValue(frontmatter, mapping.backlog);
		lines.push(
			`${mapping.backlog} ↔ ${mapping.jira} (${mapping.type}, ${mapping.direction})`,
		);
		lines.push(`  Backlog: ${displayValue(backlogValue)}`);
		if (issue) {
			const jiraValue = getMappedJiraValue(issue, mapping);
			const inSync =
				canonicalMappedValue(backlogValue, mapping.backlog) ===
				canonicalMappedValue(jiraValue, mapping.backlog);
			lines.push(
				`  Jira:    ${displayValue(jiraValue)}${inSync ? "" : "  [differs]"}`,
			);
		} else {
			lines.push(`  Jira:    ${jiraUnavailableReason ?? "(unavailable)"}`);
		}
	}
	return lines;
}

// ===== Doctor =====

export interface FieldMappingCheck {
	mapping: FieldMapping;
	problems: string[];
}

/**
 * Check each mapping's Jira field exists, and that fields written to Jira
 * (push/both) are on the create/edit screen of the configured project and
 * issue type. `screenFieldIds` is null when screen metadata is unavailable.
 */
export function verifyFieldMappings(
	mappings: FieldMapping[],
	knownFields: Array<{ id: string; name?: string }>,
	screenFieldIds: Set<string> | null,
	scope: { projectKey: string; issueType: string },
): FieldMappingCheck[] {
	const known = new Set(knownFields.map((f) => f.id));
	return mappings.map((mapping) => {
		const problems: string[] = [];
		if (!known.has(mapping.jira)) {
			problems.push(`Jira field "${mapping.jira}" does not exist`);
		} else if (
			mapping.direction !== "pull" &&
			screenFieldIds &&
			!screenFieldIds.has(mapping.jira)
		) {
			problems.push(
				`Jira field "${mapping.jira}" is not editable for ${scope.projectKey} / ${scope.issueType} (not on the issue type's screen)`,
			);
		}
		return { mapping, problems };
	});
}

/**
 * Whether priority or labels are carried by a mapping rather than the
 * built-in Jira field
 */
export function getOverriddenCoreFields(mappings: FieldMapping[]): Set<string> {
	return new Set(
		withoutBuiltInMappings(mappings)
			.map((m) => m.backlog)
			.filter((t) => isCoreOverrideTarget(t)),
	);
}
