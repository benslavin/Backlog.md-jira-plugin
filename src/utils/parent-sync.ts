import type { BacklogTask } from "../integrations/backlog.ts";
import {
	type IssueKind,
	type ParentLinkVia,
	kindOfIssue,
} from "../integrations/jira-hierarchy.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import type { FrontmatterStore, Snapshot } from "../state/store.ts";
import { displayTaskId, formatIdPair } from "./id-resolver.ts";
import { logger } from "./logger.ts";
import type {
	MappedFieldFailure,
	MappedFieldState,
} from "./mapped-field-sync.ts";
import type { NormalizedPayload } from "./normalizer.ts";
import {
	PARENT_LINK_MAPPING,
	PARENT_PAYLOAD_KEY,
	backlogParentValue,
	getIssueParent,
	jiraParentValue,
	parentLinksEnabled,
	unlinkedParentTask,
} from "./parent-payload.ts";
import { normalizeTaskId } from "./task-links.ts";
import {
	readTaskParents,
	recordParentProblem,
	setTaskParent,
} from "./task-parents.ts";

/**
 * Parent and epic links between Backlog tasks and Jira issues.
 *
 * A task's parent is compared with its issue's parent by linked Jira key
 * (see parent-payload.ts). Pull sets the task's parent_task_id from the
 * issue's parent or epic; push sets the issue's parent (or Epic Link) from
 * the task's parent. Jira only allows epic > standard issue > subtask and
 * never changes an issue's type here, so some Backlog hierarchies cannot be
 * pushed: they are reported and left pending instead.
 */

export interface ParentSyncContext {
	jira: Pick<JiraClient, "getIssue" | "setIssueParent"> &
		Partial<Pick<JiraClient, "getEpicLinkFieldId">>;
	/** Task linked to a Jira key, or null */
	taskForJiraKey: (jiraKey: string) => string | null;
	/** Parent issues fetched while planning, by key */
	issues: Map<string, Promise<JiraIssue>>;
	warnings: string[];
	dryRun: boolean;
}

/**
 * Parent sync state for one command run; null when parent links are off
 * (sync.parentLinks: false)
 */
export function createParentSyncContext(
	jira: ParentSyncContext["jira"],
	store: Pick<FrontmatterStore, "getMappingByJiraKey">,
	options: { dryRun?: boolean; enabled?: boolean } = {},
): ParentSyncContext | null {
	if (!(options.enabled ?? parentLinksEnabled())) return null;
	return {
		jira,
		taskForJiraKey: (jiraKey) =>
			store.getMappingByJiraKey(jiraKey)?.backlogId ??
			store.getMappingByJiraKey(jiraKey.toUpperCase())?.backlogId ??
			null,
		issues: new Map(),
		warnings: [],
		dryRun: options.dryRun ?? false,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/** Fetch an issue once per run */
function fetchIssue(ctx: ParentSyncContext, key: string): Promise<JiraIssue> {
	let issue = ctx.issues.get(key);
	if (!issue) {
		issue = ctx.jira.getIssue(key);
		ctx.issues.set(key, issue);
		issue.catch(() => ctx.issues.delete(key));
	}
	return issue;
}

/** A payload parent value as shown to people */
export function describeParentValue(
	value: string,
	taskForJiraKey: (jiraKey: string) => string | null,
): string {
	if (!value) return "(no parent)";
	const unlinked = unlinkedParentTask(value);
	if (unlinked) return `${displayTaskId(unlinked)} (not linked to Jira)`;
	const task = taskForJiraKey(value);
	return task ? formatIdPair(task, value) : `${value} (not linked to a task)`;
}

// ===== Pull =====

export interface ParentPullResult {
	/** The task's parent was set or cleared */
	changed: boolean;
	/** The task's parent now matches the issue's parent */
	applied: boolean;
	problem?: string;
}

/**
 * Whether making `parentId` the parent of `taskId` would create a cycle in
 * Backlog (the parent is the task or one of its subtasks)
 */
export function wouldCycle(taskId: string, parentId: string): boolean {
	const parents = readTaskParents();
	let current: string | null | undefined = normalizeTaskId(parentId);
	const seen = new Set<string>();
	while (current && !seen.has(current)) {
		if (current === normalizeTaskId(taskId)) return true;
		seen.add(current);
		current = parents.get(current);
	}
	return false;
}

/**
 * Set or clear a task's parent from its issue's Jira parent or epic. A Jira
 * parent linked to no task is reported and recorded; the task keeps its
 * parent until a later pull finds the parent linked.
 */
export function pullTaskParent(
	ctx: ParentSyncContext,
	taskId: string,
	task: Pick<BacklogTask, "parent">,
	issue: JiraIssue,
): ParentPullResult {
	const jiraKey = jiraParentValue(issue);
	const current = task.parent ? normalizeTaskId(task.parent) : null;
	const pair = formatIdPair(taskId, issue.key);
	let result: ParentPullResult;

	if (!jiraKey) {
		result = { changed: current !== null, applied: true };
		if (current && !ctx.dryRun) setTaskParent(taskId, null);
	} else {
		const linked = ctx.taskForJiraKey(jiraKey);
		const target = linked ? normalizeTaskId(linked) : null;
		if (!target) {
			result = {
				changed: false,
				applied: false,
				problem: `Jira parent ${jiraKey} is not linked to a Backlog task; import it (backlog-jira pull --import) or link it (backlog-jira map link <task> ${jiraKey}), then pull again`,
			};
		} else if (target === current) {
			result = { changed: false, applied: true };
		} else if (wouldCycle(taskId, target)) {
			result = {
				changed: false,
				applied: false,
				problem: `Jira parent ${formatIdPair(target, jiraKey)} is a subtask of ${displayTaskId(taskId)} in Backlog, so it cannot become its parent`,
			};
		} else {
			result = { changed: true, applied: true };
			if (!ctx.dryRun) setTaskParent(taskId, target);
		}
	}

	if (result.problem) {
		ctx.warnings.push(`${pair}: parent not pulled: ${result.problem}`);
	}
	if (!ctx.dryRun) recordParentProblem(taskId, result.problem ?? null);
	logger.debug({ taskId, jiraKey, current, result }, "Pulled task parent");
	return result;
}

/**
 * Whether a pull should set the task's parent although nothing else
 * changed: the issue's Jira parent was not linked to a task when it was
 * last pulled and is now, and the task's parent was not changed since.
 */
export function parentNeedsPull(
	ctx: Pick<ParentSyncContext, "taskForJiraKey">,
	task: Pick<BacklogTask, "parent">,
	issue: JiraIssue,
	backlogSnapshot: Snapshot | null,
): boolean {
	const jiraKey = jiraParentValue(issue);
	if (!jiraKey) return false;
	const linked = ctx.taskForJiraKey(jiraKey);
	if (!linked) return false;
	const current = task.parent ? normalizeTaskId(task.parent) : null;
	if (normalizeTaskId(linked) === current) return false;

	let base = "";
	try {
		base =
			(JSON.parse(backlogSnapshot?.payload ?? "{}") as { parent?: string })
				.parent ?? "";
	} catch {
		return false;
	}
	return base === backlogParentValue(task.parent);
}

// ===== Push =====

export type ParentPlan =
	| { ok: true; parentKey: string | null; via: ParentLinkVia }
	| { ok: false; reason: string };

/** How epics are linked on this site: the Epic Link field, or parent */
async function epicLinkVia(ctx: ParentSyncContext): Promise<ParentLinkVia> {
	const fieldId = ctx.jira.getEpicLinkFieldId
		? await ctx.jira.getEpicLinkFieldId()
		: null;
	return fieldId ? "epicLink" : "parent";
}

/** Kind of a parent issue, fetching it; a failure is a reason */
async function parentIssueKind(
	ctx: ParentSyncContext,
	parentKey: string,
): Promise<{ kind: IssueKind } | { reason: string }> {
	try {
		return { kind: kindOfIssue(await fetchIssue(ctx, parentKey)) };
	} catch (error) {
		return {
			reason: `Jira parent ${parentKey} could not be fetched: ${errorMessage(error)}`,
		};
	}
}

/**
 * How to give an existing issue the parent `desired` (a payload value), or
 * why Jira cannot represent it without changing the issue's type
 */
export async function planParentChange(
	ctx: ParentSyncContext,
	issue: JiraIssue,
	desired: string,
): Promise<ParentPlan> {
	const unlinked = unlinkedParentTask(desired);
	if (unlinked) {
		return {
			ok: false,
			reason: `parent ${displayTaskId(unlinked)} is not linked to Jira; create its issue (backlog-jira create-issue ${displayTaskId(unlinked)}), then push again`,
		};
	}

	const childKind = kindOfIssue({ ...issue, parent: getIssueParent(issue) });
	if (!desired) {
		if (childKind === "subtask") {
			return {
				ok: false,
				reason: `${issue.key} is a Jira subtask and cannot lose its parent; convert it to a standard issue in Jira, or give the task a parent again`,
			};
		}
		return {
			ok: true,
			parentKey: null,
			via: getIssueParent(issue)?.via ?? "parent",
		};
	}

	if (desired === issue.key.toUpperCase()) {
		return { ok: false, reason: `${issue.key} cannot be its own parent` };
	}
	if (childKind === "epic") {
		return {
			ok: false,
			reason: `${issue.key} is an epic, and Jira epics cannot have a parent`,
		};
	}
	const parent = await parentIssueKind(ctx, desired);
	if ("reason" in parent) return { ok: false, reason: parent.reason };

	switch (parent.kind) {
		case "subtask":
			return {
				ok: false,
				reason: `${desired} is a Jira subtask, and Jira cannot nest issues under a subtask`,
			};
		case "epic":
			if (childKind === "subtask") {
				return {
					ok: false,
					reason: `${issue.key} is a Jira subtask; convert it to a standard issue in Jira before putting it under epic ${desired}`,
				};
			}
			return { ok: true, parentKey: desired, via: await epicLinkVia(ctx) };
		default:
			if (childKind !== "subtask") {
				return {
					ok: false,
					reason: `${issue.key} is a standard issue; change its type to a subtask type in Jira before putting it under ${desired}`,
				};
			}
			return { ok: true, parentKey: desired, via: "parent" };
	}
}

export interface ParentPushResult {
	status: "unchanged" | "updated" | "failed" | "dry-run";
	reason?: string;
}

/**
 * Give the issue the task's parent. Hierarchies Jira cannot represent and
 * parents not linked to Jira are recorded and reported, never pushed.
 */
export async function pushTaskParent(
	ctx: ParentSyncContext,
	taskId: string,
	task: Pick<BacklogTask, "parent">,
	issue: JiraIssue,
): Promise<ParentPushResult> {
	const desired = backlogParentValue(task.parent);
	if (desired === jiraParentValue(issue)) {
		if (!ctx.dryRun) recordParentProblem(taskId, null);
		return { status: "unchanged" };
	}

	const plan = await planParentChange(ctx, issue, desired);
	if (!plan.ok) {
		if (!ctx.dryRun) recordParentProblem(taskId, plan.reason);
		return { status: "failed", reason: plan.reason };
	}
	if (ctx.dryRun) return { status: "dry-run" };

	try {
		await ctx.jira.setIssueParent(issue.key, plan.parentKey, plan.via);
	} catch (error) {
		const reason = `Jira did not accept the parent change: ${errorMessage(error)}`;
		recordParentProblem(taskId, reason);
		return { status: "failed", reason };
	}
	recordParentProblem(taskId, null);
	logger.info(
		{ taskId, issueKey: issue.key, parent: plan.parentKey, via: plan.via },
		"Pushed task parent",
	);
	return { status: "updated" };
}

/**
 * Push a task's parent, returning a failure of the parent (like a mapped
 * field failure) when it could not be pushed
 */
export async function pushParentFailures(
	ctx: ParentSyncContext | null,
	taskId: string,
	task: Pick<BacklogTask, "parent">,
	issue: JiraIssue,
): Promise<MappedFieldFailure[]> {
	if (!ctx) return [];
	const result = await pushTaskParent(ctx, taskId, task, issue);
	return result.status === "failed"
		? [{ mapping: PARENT_LINK_MAPPING, error: result.reason ?? "unknown" }]
		: [];
}

// ===== Creating issues =====

export type CreationPlan =
	| {
			ok: true;
			issueType: string;
			/** Jira key of the parent, or null for a top-level issue */
			parentKey: string | null;
			parentKind?: IssueKind;
			/** Fields to create the issue with (parent or Epic Link) */
			fields: Record<string, unknown>;
	  }
	| { ok: false; reason: string };

/** Issue type MCP Atlassian resolves to the project's subtask type */
export const SUBTASK_ISSUE_TYPE = "Subtask";

/**
 * Where to create a task's issue: a parent linked to an epic gives a
 * standard issue under the epic, a parent linked to a standard issue gives
 * a subtask, and a parent that is a subtask (or not linked to Jira) cannot
 * be represented. `parentKey` is the Jira key of the parent, if any.
 */
export async function planIssueCreation(
	ctx: ParentSyncContext,
	parentKey: string | null,
	issueType: { requested?: string; default: string },
): Promise<CreationPlan> {
	const type = issueType.requested ?? issueType.default;
	if (!parentKey) {
		return { ok: true, issueType: type, parentKey: null, fields: {} };
	}
	if (/^epic$/i.test(type)) {
		return {
			ok: false,
			reason: `an epic cannot have a parent in Jira (parent ${parentKey})`,
		};
	}

	const parent = await parentIssueKind(ctx, parentKey);
	if ("reason" in parent) return { ok: false, reason: parent.reason };

	switch (parent.kind) {
		case "subtask":
			return {
				ok: false,
				reason: `${parentKey} is a Jira subtask, and Jira cannot nest issues under a subtask`,
			};
		case "epic": {
			if (/^sub-?task$/i.test(type)) {
				return {
					ok: false,
					reason: `${parentKey} is an epic; issues under an epic are standard issues, not subtasks`,
				};
			}
			const fieldId = ctx.jira.getEpicLinkFieldId
				? await ctx.jira.getEpicLinkFieldId()
				: null;
			return {
				ok: true,
				issueType: type,
				parentKey,
				parentKind: "epic",
				fields: fieldId ? { [fieldId]: parentKey } : { parent: parentKey },
			};
		}
		default:
			return {
				ok: true,
				issueType: issueType.requested ?? SUBTASK_ISSUE_TYPE,
				parentKey,
				parentKind: "standard",
				fields: { parent: parentKey },
			};
	}
}

/**
 * The Jira key a task's parent is linked to; a reason when the parent task
 * is not linked. Null when the task has no parent.
 */
export function parentKeyOfTask(
	task: Pick<BacklogTask, "parent">,
): { key: string | null } | { reason: string } {
	const value = backlogParentValue(task.parent);
	const unlinked = unlinkedParentTask(value);
	if (unlinked) {
		return {
			reason: `parent task ${displayTaskId(unlinked)} is not linked to a Jira issue; create its issue first (backlog-jira create-issue ${displayTaskId(unlinked)})`,
		};
	}
	return { key: value || null };
}

// ===== Sync conflicts =====

function parentValue(
	payload: Partial<NormalizedPayload> | null | undefined,
): string {
	return payload?.parent ?? "";
}

function sideChanges(state: MappedFieldState) {
	const backlogNow = parentValue(state.current.backlog);
	const jiraNow = parentValue(state.current.jira);
	return {
		backlogChanged: backlogNow !== parentValue(state.base.backlog),
		jiraChanged: jiraNow !== parentValue(state.base.jira),
		differ: backlogNow !== jiraNow,
	};
}

/**
 * The parent conflict, when the parent changed on both sides since the last
 * sync to different parents
 */
export function detectParentConflict(
	state: MappedFieldState,
	ctx: Pick<ParentSyncContext, "taskForJiraKey"> | null,
): {
	field: string;
	backlogValue: unknown;
	jiraValue: unknown;
	baseValue: unknown;
} | null {
	if (!ctx || state.current.backlog.parent === undefined) return null;
	if (!state.base.backlog || !state.base.jira) return null;
	const { backlogChanged, jiraChanged, differ } = sideChanges(state);
	if (!backlogChanged || !jiraChanged || !differ) return null;

	const describe = (value: string) =>
		describeParentValue(value, ctx.taskForJiraKey);
	return {
		field: PARENT_PAYLOAD_KEY,
		backlogValue: describe(parentValue(state.current.backlog)),
		jiraValue: describe(parentValue(state.current.jira)),
		baseValue: describe(parentValue(state.base.backlog)),
	};
}

/**
 * Which side's parent wins when merging: a chosen resolution, else the side
 * that changed. Null when there is nothing to merge.
 */
export function planParentMerge(
	state: MappedFieldState,
	resolution?: "backlog" | "jira",
): "backlog" | "jira" | null {
	if (state.current.backlog.parent === undefined) return null;
	const { backlogChanged, jiraChanged, differ } = sideChanges(state);
	if (!differ) return null;
	if (resolution) return resolution;
	if (backlogChanged && !jiraChanged) return "backlog";
	if (jiraChanged && !backlogChanged) return "jira";
	return null;
}

/**
 * Apply a parent merge decision: Jira's parent becomes the task's, or the
 * task's parent is pushed. Returns push failures.
 */
export async function applyParentMerge(
	side: "backlog" | "jira",
	ctx: ParentSyncContext,
	taskId: string,
	task: Pick<BacklogTask, "parent">,
	issue: JiraIssue,
): Promise<MappedFieldFailure[]> {
	if (side === "jira") {
		pullTaskParent(ctx, taskId, task, issue);
		return [];
	}
	return pushParentFailures(ctx, taskId, task, issue);
}

// ===== Import order =====

/**
 * Group issues so that parents come before their children: each group holds
 * issues whose parent is outside the set or in an earlier group
 */
export function orderByParent(
	keys: string[],
	parentOf: Map<string, string | null>,
): string[][] {
	const inSet = new Set(keys.map((k) => k.toUpperCase()));
	const depths = new Map<string, number>();
	const depth = (key: string, seen: Set<string>): number => {
		const known = depths.get(key);
		if (known !== undefined) return known;
		const parent = parentOf.get(key)?.toUpperCase();
		const value =
			parent && inSet.has(parent) && !seen.has(parent)
				? depth(parent, new Set([...seen, key])) + 1
				: 0;
		depths.set(key, value);
		return value;
	};

	const groups: string[][] = [];
	for (const key of keys) {
		const d = depth(key.toUpperCase(), new Set([key.toUpperCase()]));
		if (!groups[d]) groups[d] = [];
		groups[d].push(key);
	}
	return groups.filter((group) => group && group.length > 0);
}

// ===== Doctor and view =====

export interface ParentLinkProblem {
	taskId: string;
	jiraKey?: string;
	problem: string;
}

/**
 * Parent links of linked tasks that cannot be synced, found without Jira:
 * parents not linked to Jira, chains deeper than Jira's three levels, and
 * problems recorded by the last pull or push
 */
export function findParentLinkProblems(
	parents: Map<string, string | null>,
	jiraKeyOf: (taskId: string) => string | null,
	recordedProblem: (taskId: string) => string | undefined,
): ParentLinkProblem[] {
	const problems: ParentLinkProblem[] = [];
	for (const [taskId, parent] of parents) {
		const jiraKey = jiraKeyOf(taskId) ?? undefined;
		if (!jiraKey) continue;
		const recorded = recordedProblem(taskId);
		if (recorded) {
			problems.push({ taskId, jiraKey, problem: recorded });
			continue;
		}
		if (!parent) continue;
		if (!jiraKeyOf(parent)) {
			problems.push({
				taskId,
				jiraKey,
				problem: `parent ${displayTaskId(parent)} is not linked to Jira (backlog-jira create-issue ${displayTaskId(parent)})`,
			});
			continue;
		}
		// Jira has at most three levels: epic > standard issue > subtask
		let depth = 1;
		let current = parents.get(parent);
		const seen = new Set([taskId, parent]);
		while (current && !seen.has(current)) {
			depth++;
			seen.add(current);
			current = parents.get(current);
		}
		if (depth >= 3) {
			problems.push({
				taskId,
				jiraKey,
				problem: `nested ${depth + 1} levels deep in Backlog; Jira allows at most epic > issue > subtask`,
			});
		}
	}
	return problems.sort((a, b) =>
		a.taskId.localeCompare(b.taskId, undefined, { numeric: true }),
	);
}

/**
 * Lines describing a task's parent and subtasks as TASK ⇄ KEY pairs
 */
export function formatParentSection(
	taskId: string,
	parents: Map<string, string | null>,
	jiraKeyOf: (taskId: string) => string | null,
	problem?: string,
): string[] {
	const id = normalizeTaskId(taskId);
	const parent = parents.get(id) ?? null;
	const children = [...parents]
		.filter(([, p]) => p === id)
		.map(([child]) => child)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!parent && children.length === 0 && !problem) return [];

	const label = (task: string) => formatIdPair(task, jiraKeyOf(task));
	const lines = ["", "Parent Links:", "-".repeat(50)];
	lines.push(`Parent: ${parent ? label(parent) : "(none)"}`);
	if (children.length > 0) {
		lines.push(`Subtasks (${children.length}):`);
		for (const child of children) lines.push(`  - ${label(child)}`);
	}
	if (problem) lines.push(`⚠ Not synced: ${problem}`);
	return lines;
}
