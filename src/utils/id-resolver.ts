import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FrontmatterStore } from "../state/frontmatter-store.ts";
import { readConfigFile } from "./config-file.ts";
import { normalizeTaskId, taskIdFromFilePath } from "./task-links.ts";

/**
 * Backlog task IDs (TASK-1) and Jira keys (CR2-77) are allocated
 * independently, so either may appear where the other is meant. Each ID
 * keeps its owner; commands resolve whichever one they are given.
 */

export type IdKind = "task" | "jira" | "unknown";

export interface ResolvedId {
	/** The ID as given */
	input: string;
	/** Which system owns the ID; "unknown" when neither does */
	kind: IdKind;
	/** The Backlog task: the input itself, or the task linked to a Jira key */
	taskId?: string;
	/** The Jira issue: the input itself, or the issue linked to a task */
	jiraKey?: string;
	/** A task ID in the task prefix that has no task file */
	missing?: boolean;
}

/** What resolution needs to know about the project */
export interface IdIndex {
	taskIds: Set<string>;
	/** Normalized task ID -> Jira key */
	jiraKeyByTask: Map<string, string>;
	/** Upper-case Jira key -> normalized task ID */
	taskByJiraKey: Map<string, string>;
	/** Backlog task prefix (task_prefix in backlog/config.yml) */
	taskPrefix: string;
	/** Configured Jira project key, when set */
	projectKey?: string;
}

const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-\d+(?:\.\d+)*$/;

/**
 * Build the resolution index from the task files and their Jira links
 */
export function createIdIndex(
	store: Pick<FrontmatterStore, "getAllMappings">,
	cwd = process.cwd(),
): IdIndex {
	const taskIds = listTaskIds(cwd);

	const jiraKeyByTask = new Map<string, string>();
	const taskByJiraKey = new Map<string, string>();
	for (const [taskId, jiraKey] of store.getAllMappings()) {
		const id = normalizeTaskId(taskId);
		jiraKeyByTask.set(id, jiraKey);
		taskByJiraKey.set(jiraKey.toUpperCase(), id);
	}

	const projectKey = readConfigFile(cwd)?.jira as
		| { projectKey?: unknown }
		| undefined;
	return {
		taskIds,
		jiraKeyByTask,
		taskByJiraKey,
		taskPrefix: readTaskPrefix(cwd),
		projectKey:
			typeof projectKey?.projectKey === "string" && projectKey.projectKey
				? projectKey.projectKey
				: undefined,
	};
}

/** Normalized IDs of the task files in backlog/tasks */
function listTaskIds(cwd: string): Set<string> {
	const taskIds = new Set<string>();
	const tasksDir = join(cwd, "backlog", "tasks");
	if (existsSync(tasksDir)) {
		for (const file of readdirSync(tasksDir)) {
			const id = file.endsWith(".md") ? taskIdFromFilePath(file) : null;
			if (id) taskIds.add(id);
		}
	}
	return taskIds;
}

function readTaskPrefix(cwd: string): string {
	try {
		const content = readFileSync(join(cwd, "backlog", "config.yml"), "utf-8");
		const match = content.match(/^task_prefix:\s*["']?([^"'\s#]+)["']?/m);
		if (match) return match[1];
	} catch {
		// No Backlog config: Backlog.md defaults to "task"
	}
	return "task";
}

/**
 * Resolve one task ID or Jira key. An existing task wins over a Jira key
 * with the same spelling.
 */
export function resolveId(input: string, index: IdIndex): ResolvedId {
	const trimmed = input.trim();
	const normalized = normalizeTaskId(trimmed);

	if (index.taskIds.has(normalized)) {
		return {
			input: trimmed,
			kind: "task",
			taskId: trimmed,
			jiraKey: index.jiraKeyByTask.get(normalized),
		};
	}

	const upper = trimmed.toUpperCase();
	const linkedTask = index.taskByJiraKey.get(upper);
	if (linkedTask) {
		const jiraKey = index.jiraKeyByTask.get(linkedTask) ?? upper;
		return { input: trimmed, kind: "jira", taskId: linkedTask, jiraKey };
	}

	const prefix = trimmed.match(KEY_PATTERN)?.[1];
	if (prefix) {
		const isProjectKey =
			index.projectKey !== undefined &&
			prefix.toUpperCase() === index.projectKey.toUpperCase();
		if (
			!isProjectKey &&
			prefix.toLowerCase() === index.taskPrefix.toLowerCase()
		) {
			return { input: trimmed, kind: "task", taskId: trimmed, missing: true };
		}
		if (!trimmed.includes(".")) {
			return { input: trimmed, kind: "jira", jiraKey: upper };
		}
	}

	return { input: trimmed, kind: "unknown" };
}

export function resolveIds(inputs: string[], index: IdIndex): ResolvedId[] {
	return inputs.map((input) => resolveId(input, index));
}

/** Task IDs as Backlog.md prints them (TASK-1) */
export function displayTaskId(taskId: string): string {
	return taskId.toUpperCase();
}

/**
 * A task and its linked issue as one label: "TASK-1 ⇄ CR2-77", or just the
 * task ID when it is not linked
 */
export function formatIdPair(taskId: string, jiraKey?: string | null): string {
	const task = displayTaskId(taskId);
	return jiraKey ? `${task} ⇄ ${jiraKey}` : task;
}

/**
 * Why an ID cannot be used where a Backlog task is expected; null when it
 * resolves to an existing task
 */
export function taskResolutionError(resolved: ResolvedId): string | null {
	if (resolved.taskId && !resolved.missing) return null;
	if (resolved.kind === "task") {
		return `Task ${resolved.input} not found`;
	}
	if (resolved.kind === "jira") {
		return `${resolved.jiraKey} is a Jira key not linked to any Backlog task (link it with 'backlog-jira map link <taskId> ${resolved.jiraKey}' or import it with 'backlog-jira pull --import')`;
	}
	return `${resolved.input} is neither a Backlog task ID nor a linked Jira key`;
}

/**
 * Resolve command arguments that name Backlog tasks, accepting the Jira key
 * of a linked issue in place of its task. Duplicates (a task and its key)
 * are dropped; IDs that do not name a task are returned as errors.
 */
export function resolveTaskArgs(
	inputs: string[],
	store: Pick<FrontmatterStore, "getAllMappings">,
): { taskIds: string[]; errors: Array<{ input: string; error: string }> } {
	// Task IDs need only the file listing; reading every task's link (as
	// Jira keys need) would make sync's per-task pushes and pulls quadratic
	const files = listTaskIds(process.cwd());
	const index = inputs.every((input) => files.has(normalizeTaskId(input)))
		? {
				taskIds: files,
				jiraKeyByTask: new Map<string, string>(),
				taskByJiraKey: new Map<string, string>(),
				taskPrefix: "",
			}
		: createIdIndex(store);
	const taskIds: string[] = [];
	const errors: Array<{ input: string; error: string }> = [];
	const seen = new Set<string>();

	for (const input of inputs) {
		const resolved = resolveId(input, index);
		const error = taskResolutionError(resolved);
		if (error || !resolved.taskId) {
			errors.push({ input: resolved.input, error: error ?? "Unresolved" });
			continue;
		}
		const key = normalizeTaskId(resolved.taskId);
		if (seen.has(key)) continue;
		seen.add(key);
		taskIds.push(resolved.taskId);
	}

	return { taskIds, errors };
}

/**
 * Resolve a single task argument: the Jira key of a linked issue becomes its
 * task, and a Jira key linked to no task throws. Anything else is returned
 * as given for the command's own task lookup to report.
 */
export function resolveTaskArg(
	input: string,
	store: Pick<FrontmatterStore, "getAllMappings">,
): string {
	const { taskIds, errors } = resolveTaskArgs([input], store);
	if (taskIds.length > 0) return taskIds[0];
	if (resolveId(input, createIdIndex(store)).kind === "jira") {
		throw new Error(errors[0].error);
	}
	return input.trim();
}

/**
 * One line describing a resolution, for people or (plain) for agents
 */
export function describeResolution(
	resolved: ResolvedId,
	plain = false,
): string {
	const task = resolved.taskId ? displayTaskId(resolved.taskId) : "-";
	const jira = resolved.jiraKey ?? "-";
	const state = resolutionState(resolved);

	if (plain) {
		return `${resolved.input}\t${state === "unknown" ? "-" : task}\t${jira}\t${state}`;
	}

	switch (state) {
		case "linked":
			return formatIdPair(resolved.taskId as string, resolved.jiraKey);
		case "unlinked-task":
			return `${task} (Backlog task, not linked to Jira)`;
		case "unlinked-jira":
			return `${jira} (Jira key, not linked to a Backlog task)`;
		default:
			return `${resolved.input} (unknown: no Backlog task or linked Jira issue)`;
	}
}

export type ResolutionState =
	| "linked"
	| "unlinked-task"
	| "unlinked-jira"
	| "unknown";

export function resolutionState(resolved: ResolvedId): ResolutionState {
	if (resolved.missing || resolved.kind === "unknown") return "unknown";
	if (resolved.taskId && resolved.jiraKey) return "linked";
	return resolved.kind === "task" ? "unlinked-task" : "unlinked-jira";
}
