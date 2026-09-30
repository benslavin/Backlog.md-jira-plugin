import {
	type JiraParentRef,
	parseIssueParent,
} from "../integrations/jira-hierarchy.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { loadHierarchyConfig } from "./hierarchy-config.ts";
import { normalizeTaskId } from "./task-links.ts";
import { linkedJiraKey } from "./task-parents.ts";

/**
 * The parent in sync payloads and snapshots.
 *
 * Both sides carry the parent as a Jira key under `parent`: Jira the key of
 * the issue's parent or epic, Backlog the key linked to the task's parent
 * task. Parents are thereby compared by linked Jira key. A parent task not
 * linked to Jira is represented as `task:<id>`, so choosing it is a Backlog
 * change. "" means no parent. The key is left out when parent links are
 * turned off (sync.parentLinks: false).
 */

/** Payload key and conflict prompt field name of the parent */
export const PARENT_PAYLOAD_KEY = "parent";

/** Prefix of a payload parent that is a task not linked to Jira */
export const UNLINKED_TASK_PREFIX = "task:";

/**
 * An issue's parent: as fetched, else read from its raw fields (the
 * `parent` field only, as the Epic Link field id is not known here)
 */
export function getIssueParent(issue: JiraIssue): JiraParentRef | null {
	if (issue.parent !== undefined) return issue.parent;
	return parseIssueParent(issue.fields);
}

/** Payload value of an issue's parent: its key, or "" */
export function jiraParentValue(issue: JiraIssue): string {
	return getIssueParent(issue)?.key.toUpperCase() ?? "";
}

/**
 * Payload value of a task's parent: the Jira key linked to the parent task,
 * `task:<id>` when that task is not linked, or "" when there is no parent
 */
export function backlogParentValue(parentTaskId: string | undefined): string {
	if (!parentTaskId?.trim()) return "";
	const parent = normalizeTaskId(parentTaskId);
	const key = linkedJiraKey(parent);
	return key ? key.toUpperCase() : `${UNLINKED_TASK_PREFIX}${parent}`;
}

/** The task ID of a `task:<id>` payload value, else null */
export function unlinkedParentTask(value: string): string | null {
	return value.startsWith(UNLINKED_TASK_PREFIX)
		? value.slice(UNLINKED_TASK_PREFIX.length)
		: null;
}

/** Whether payloads carry parents (sync.parentLinks is not false) */
export function parentLinksEnabled(): boolean {
	return loadHierarchyConfig().parentLinks;
}

/**
 * Stand-in field mapping for the parent, so parent push problems are
 * reported, kept pending and retried like mapped field failures
 */
export interface ParentLinkMapping {
	backlog: typeof PARENT_PAYLOAD_KEY;
	jira: typeof PARENT_PAYLOAD_KEY;
	type: "parent";
	direction: "both";
}

export const PARENT_LINK_MAPPING: Readonly<ParentLinkMapping> = Object.freeze({
	backlog: PARENT_PAYLOAD_KEY,
	jira: PARENT_PAYLOAD_KEY,
	type: "parent",
	direction: "both",
});
