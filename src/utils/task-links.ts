import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { JiraSprintState } from "../integrations/jira-sprints.ts";
import { SPRINTS_GITIGNORE_RULE } from "../state/sprint-registry.ts";
import { logger } from "./logger.ts";

/**
 * Plugin-owned metadata for one task, kept outside the task file.
 *
 * Backlog.md 1.5x rebuilds task frontmatter from a fixed set of keys on every
 * `backlog task edit`, dropping jira_* keys and mapped frontmatter fields.
 * This record lives in .backlog-jira/links/<task-id>.json, which Backlog.md
 * never touches, and is used to fall back to and restore those keys.
 */
export interface TaskLink {
	jiraKey?: string;
	jiraUrl?: string;
	jiraLastSync?: string;
	jiraSyncState?: string;
	/** Mapped frontmatter fields written by the plugin (frontmatter:<key>) */
	frontmatter?: Record<string, string | string[]>;
	/** Sprint history of the linked Jira issue, in Jira's order */
	sprints?: SprintHistoryEntry[];
	/** Displayed sprint and its milestone as of the last sprint sync */
	sprintSync?: { sprintId: string | null; milestoneId: string | null };
}

export interface SprintHistoryEntry {
	id: string;
	name: string;
	state: JiraSprintState;
	startDate?: string;
	endDate?: string;
	completeDate?: string;
}

/** Frontmatter key for each Jira link field */
export const LINK_FRONTMATTER_KEYS = {
	jiraKey: "jira_key",
	jiraUrl: "jira_url",
	jiraLastSync: "jira_last_sync",
	jiraSyncState: "jira_sync_state",
} as const;

const TASK_ID_PATTERN = /^([A-Za-z][A-Za-z0-9_]*-\d+(?:\.\d+)*)$/;
const TASK_FILE_PATTERN = /^([A-Za-z][A-Za-z0-9_]*-\d+(?:\.\d+)*)\s+-\s+/;

/**
 * Normalize a task ID for storage and comparison.
 * Backlog.md 1.5x prints TASK-1 while file names use task-1.
 */
export function normalizeTaskId(taskId: string): string {
	return taskId.trim().toLowerCase();
}

/**
 * Whether a string looks like a Backlog.md task ID (task-1, TASK-1.2)
 */
export function isTaskId(value: string): boolean {
	return TASK_ID_PATTERN.test(value.trim());
}

/**
 * Extract the normalized task ID from a task file name or path
 * ("task-12 - Title.md" -> "task-12"); null when the name does not match
 */
export function taskIdFromFilePath(filePath: string): string | null {
	const match = basename(filePath).match(TASK_FILE_PATTERN);
	return match ? normalizeTaskId(match[1]) : null;
}

export function getLinksDir(): string {
	return join(process.cwd(), ".backlog-jira", "links");
}

function getLinkPath(taskId: string): string {
	return join(getLinksDir(), `${normalizeTaskId(taskId)}.json`);
}

/**
 * Read the stored link record for a task; null when none exists
 */
export function readTaskLink(taskId: string): TaskLink | null {
	const linkPath = getLinkPath(taskId);
	if (!existsSync(linkPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(linkPath, "utf-8")) as TaskLink;
	} catch (error) {
		logger.warn({ error, taskId, linkPath }, "Failed to read task link");
		return null;
	}
}

/**
 * Write the link record for a task; an empty record removes the file
 */
export function writeTaskLink(taskId: string, link: TaskLink): void {
	const linkPath = getLinkPath(taskId);
	const cleaned = cleanLink(link);

	if (Object.keys(cleaned).length === 0) {
		if (existsSync(linkPath)) {
			unlinkSync(linkPath);
		}
		return;
	}

	mkdirSync(getLinksDir(), { recursive: true });
	ensureLinksTracked();
	writeFileSync(linkPath, `${JSON.stringify(cleaned, null, 2)}\n`, "utf-8");
}

function cleanLink(link: TaskLink): TaskLink {
	const cleaned: TaskLink = {};
	for (const field of Object.keys(LINK_FRONTMATTER_KEYS) as Array<
		keyof typeof LINK_FRONTMATTER_KEYS
	>) {
		const value = link[field];
		if (value !== undefined && value !== null && value !== "") {
			cleaned[field] = value;
		}
	}
	if (link.frontmatter && Object.keys(link.frontmatter).length > 0) {
		cleaned.frontmatter = link.frontmatter;
	}
	if (link.sprints && link.sprints.length > 0) {
		cleaned.sprints = link.sprints;
	}
	if (link.sprintSync) {
		cleaned.sprintSync = link.sprintSync;
	}
	return cleaned;
}

/**
 * Frontmatter keys and values the plugin owns for a task, per its link record
 */
export function linkToFrontmatter(
	link: TaskLink | null,
): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	if (!link) return result;

	for (const [field, key] of Object.entries(LINK_FRONTMATTER_KEYS)) {
		const value = link[field as keyof typeof LINK_FRONTMATTER_KEYS];
		if (value) {
			result[key] = value;
		}
	}
	for (const [key, value] of Object.entries(link.frontmatter ?? {})) {
		result[key] = value;
	}
	return result;
}

/**
 * The generated .backlog-jira/.gitignore ignores everything; link records are
 * shared project metadata, so re-include the links/ folder for git.
 */
export const LINKS_GITIGNORE_RULES = "!links/\n!links/*.json\n";

/** Content of a freshly generated .backlog-jira/.gitignore */
export const CONFIG_DIR_GITIGNORE = `# Ignore all files in .backlog-jira/ except Jira link records and the sprint registry
*
!.gitignore
${LINKS_GITIGNORE_RULES}${SPRINTS_GITIGNORE_RULE}
`;

function ensureLinksTracked(): void {
	const gitignorePath = join(process.cwd(), ".backlog-jira", ".gitignore");
	if (!existsSync(gitignorePath)) return;

	try {
		const content = readFileSync(gitignorePath, "utf-8");
		if (content.includes("!links/")) return;
		const separator = content.endsWith("\n") || content === "" ? "" : "\n";
		writeFileSync(
			gitignorePath,
			`${content}${separator}${LINKS_GITIGNORE_RULES}`,
			"utf-8",
		);
	} catch (error) {
		logger.debug({ error }, "Could not update .backlog-jira/.gitignore");
	}
}
