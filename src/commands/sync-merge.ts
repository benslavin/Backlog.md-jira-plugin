import type { BacklogClient, BacklogTask } from "../integrations/backlog.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import type { FieldMapping } from "../utils/field-mapping.ts";
import { logger } from "../utils/logger.ts";
import {
	type MappedFieldState,
	getOverriddenCoreFields,
} from "../utils/mapped-field-sync.ts";
import {
	type NormalizedPayload,
	mergeDescriptionWithAc,
	stripAcceptanceCriteriaFromDescription,
} from "../utils/normalizer.ts";
import { buildBacklogUpdates } from "./pull.ts";
import { buildJiraUpdates } from "./push.ts";
import type { FieldConflict } from "./sync.ts";

/**
 * Built-in fields merged individually when resolving a conflict. The value is
 * the field name shown in the conflict prompt.
 */
const BUILTIN_FIELDS = {
	title: "title/summary",
	description: "description",
	status: "status",
	assignee: "assignee",
	priority: "priority",
	labels: "labels",
	acceptanceCriteria: "acceptanceCriteria",
} as const;

export type BuiltinField = keyof typeof BUILTIN_FIELDS;

/** Conflict prompt field names of the built-in fields */
export const BUILTIN_CONFLICT_FIELDS = new Set<string>(
	Object.values(BUILTIN_FIELDS),
);

export interface BuiltinFieldChoice {
	field: BuiltinField;
	/** Side whose value wins; manual values are written to both sides */
	source: "backlog" | "jira" | "manual";
	value?: unknown;
}

export interface BuiltinResolution {
	field: string;
	source: "backlog" | "jira" | "manual";
	value: unknown;
}

/** Built-in fields not carried by a field mapping */
function mergeableFields(fieldMappings: FieldMapping[]): BuiltinField[] {
	const overridden = getOverriddenCoreFields(fieldMappings);
	return (Object.keys(BUILTIN_FIELDS) as BuiltinField[]).filter(
		(f) => !overridden.has(f),
	);
}

/**
 * A field's comparable value within a normalized payload. Descriptions are
 * compared without the acceptance criteria section Jira descriptions carry;
 * acceptance criteria are compared on their own.
 */
function comparable(
	payload: Partial<NormalizedPayload> | null | undefined,
	field: BuiltinField,
): string {
	if (!payload) return "";
	switch (field) {
		case "description":
			return stripAcceptanceCriteriaFromDescription(payload.description ?? "");
		case "labels":
			return JSON.stringify(payload.labels ?? []);
		case "acceptanceCriteria":
			return JSON.stringify(
				(payload.acceptanceCriteria ?? []).map((ac) => ({
					text: ac.text,
					checked: ac.checked,
				})),
			);
		default:
			return payload[field] ?? "";
	}
}

function sideChanges(state: MappedFieldState, field: BuiltinField) {
	const backlogNow = comparable(state.current.backlog, field);
	const jiraNow = comparable(state.current.jira, field);
	return {
		backlogChanged: backlogNow !== comparable(state.base.backlog, field),
		jiraChanged: jiraNow !== comparable(state.base.jira, field),
		differ: backlogNow !== jiraNow,
	};
}

function formatCriteria(
	criteria: Array<{ text: string; checked: boolean }> | undefined,
): string[] {
	return (criteria ?? []).map((ac) => `[${ac.checked ? "x" : " "}] ${ac.text}`);
}

/** Values of a field as shown in the conflict prompt */
function displayValues(
	field: BuiltinField,
	task: BacklogTask,
	issue: JiraIssue,
	state: MappedFieldState,
): { backlogValue: unknown; jiraValue: unknown; baseValue: unknown } {
	const base = state.base.backlog;
	switch (field) {
		case "title":
			return {
				backlogValue: task.title,
				jiraValue: issue.summary,
				baseValue: base?.title,
			};
		case "description":
			return {
				backlogValue: task.description,
				jiraValue: stripAcceptanceCriteriaFromDescription(
					issue.description ?? "",
				),
				baseValue: base?.description,
			};
		case "acceptanceCriteria":
			return {
				backlogValue: formatCriteria(task.acceptanceCriteria),
				jiraValue: formatCriteria(state.current.jira.acceptanceCriteria),
				baseValue: formatCriteria(base?.acceptanceCriteria),
			};
		default:
			return {
				backlogValue: task[field],
				jiraValue: issue[field],
				baseValue: base?.[field],
			};
	}
}

/**
 * Built-in fields changed on both sides since the last sync to different
 * values. Fields carried by a field mapping are left to
 * detectMappedFieldConflicts.
 */
export function detectBuiltinFieldConflicts(
	state: MappedFieldState,
	task: BacklogTask,
	fieldMappings: FieldMapping[] = [],
): FieldConflict[] {
	if (!state.base.backlog || !state.base.jira) return [];

	const conflicts: FieldConflict[] = [];
	for (const field of mergeableFields(fieldMappings)) {
		const { backlogChanged, jiraChanged, differ } = sideChanges(state, field);
		if (!backlogChanged || !jiraChanged || !differ) continue;
		conflicts.push({
			field: BUILTIN_FIELDS[field],
			...displayValues(field, task, state.issue, state),
		});
	}
	return conflicts;
}

/**
 * Decide which side wins each built-in field after a conflict:
 * - fields changed on one side only take that side's value
 * - fields changed on both sides take the chosen resolution
 * Fields with nothing to merge are omitted.
 */
export function planBuiltinFieldMerge(
	state: MappedFieldState,
	fieldMappings: FieldMapping[],
	resolutions: BuiltinResolution[],
): BuiltinFieldChoice[] {
	const byName = new Map(resolutions.map((r) => [r.field, r]));
	const plan: BuiltinFieldChoice[] = [];

	for (const field of mergeableFields(fieldMappings)) {
		const resolution = byName.get(BUILTIN_FIELDS[field]);
		if (resolution) {
			plan.push({
				field,
				source: resolution.source,
				value: resolution.value,
			});
			continue;
		}

		const { backlogChanged, jiraChanged, differ } = sideChanges(state, field);
		if (!differ) continue;
		if (backlogChanged && !jiraChanged) {
			plan.push({ field, source: "backlog" });
		} else if (jiraChanged && !backlogChanged) {
			plan.push({ field, source: "jira" });
		}
	}

	return plan;
}

type BacklogUpdates = Parameters<BacklogClient["updateTask"]>[1];

/** Backlog CLI update keys written for each built-in field */
const BACKLOG_UPDATE_KEYS: Record<BuiltinField, Array<keyof BacklogUpdates>> = {
	title: ["title"],
	description: ["description"],
	status: ["status"],
	assignee: ["assignee"],
	priority: ["priority"],
	labels: ["labels"],
	acceptanceCriteria: ["addAc", "removeAc", "checkAc", "uncheckAc"],
};

/** A manually entered value in the form the Backlog CLI accepts */
function manualBacklogValue(field: BuiltinField, value: unknown): unknown {
	if (field === "labels") {
		const list = Array.isArray(value) ? value : String(value ?? "").split(",");
		return list.map((l) => String(l).trim()).filter(Boolean);
	}
	return String(value ?? "").trim();
}

/**
 * Apply a built-in field merge. Jira-won and manual values are written to
 * Backlog first; Backlog-won and manual values are then pushed from the
 * merged task, so a Jira description and Backlog acceptance criteria (which
 * share Jira's description field) are combined rather than overwritten.
 */
export async function applyBuiltinFieldMerge(
	plan: BuiltinFieldChoice[],
	context: {
		taskId: string;
		issueKey: string;
		task: BacklogTask;
		issue: JiraIssue;
		backlog: Pick<BacklogClient, "getTask" | "updateTask">;
		jira: Pick<
			JiraClient,
			"updateIssue" | "getTransitions" | "transitionIssue"
		>;
		fieldMappings: FieldMapping[];
	},
): Promise<void> {
	const { taskId, issueKey, issue, backlog, jira, fieldMappings } = context;
	if (plan.length === 0) return;
	const projectKey = issueKey.split("-")[0];

	// Jira → Backlog
	const pulled = plan.filter((c) => c.source === "jira");
	const fromJira: Record<string, unknown> =
		pulled.length > 0
			? {
					...buildBacklogUpdates(
						issue,
						context.task,
						projectKey,
						fieldMappings,
					),
				}
			: {};
	const backlogUpdates: Record<string, unknown> = {};
	for (const choice of plan) {
		if (choice.source === "jira") {
			for (const key of BACKLOG_UPDATE_KEYS[choice.field]) {
				if (fromJira[key] !== undefined) backlogUpdates[key] = fromJira[key];
			}
		} else if (
			choice.source === "manual" &&
			choice.field !== "acceptanceCriteria"
		) {
			backlogUpdates[choice.field] = manualBacklogValue(
				choice.field,
				choice.value,
			);
		}
	}

	let task = context.task;
	if (Object.keys(backlogUpdates).length > 0) {
		logger.info(
			{ taskId, fields: Object.keys(backlogUpdates) },
			"Merging Jira fields into Backlog",
		);
		await backlog.updateTask(taskId, backlogUpdates as BacklogUpdates);
		task = await backlog.getTask(taskId);
	}

	// Backlog → Jira, from the merged task
	const pushed = new Set(
		plan.filter((c) => c.source !== "jira").map((c) => c.field),
	);
	if (pushed.size === 0) return;

	const updates = await buildJiraUpdates(
		task,
		issue,
		jira,
		projectKey,
		getOverriddenCoreFields(fieldMappings),
	);
	const fields: Record<string, unknown> = {};
	if (pushed.has("title") && updates.fields.summary !== undefined) {
		fields.summary = updates.fields.summary;
	}
	for (const field of ["assignee", "priority", "labels"] as const) {
		if (pushed.has(field) && updates.fields[field] !== undefined) {
			fields[field] = updates.fields[field];
		}
	}
	if (pushed.has("description") || pushed.has("acceptanceCriteria")) {
		// Jira's description carries both the description and the criteria
		const description = task.acceptanceCriteria
			? mergeDescriptionWithAc(
					task.description || "",
					task.acceptanceCriteria,
					task.implementationPlan,
					task.implementationNotes,
				)
			: task.description || "";
		if (description !== (issue.description || "")) {
			fields.description = description;
		}
	}

	if (Object.keys(fields).length > 0) {
		logger.info(
			{ issueKey, fields: Object.keys(fields) },
			"Merging Backlog fields into Jira",
		);
		await jira.updateIssue(issueKey, fields);
	}
	if (pushed.has("status") && updates.transition) {
		await jira.transitionIssue(issueKey, updates.transition.id, {
			comment: updates.transition.comment,
		});
	}
}
