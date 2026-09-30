import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getJiraMetadata,
	getTaskFilePath,
	parseFrontmatter,
} from "./frontmatter.ts";
import { logger } from "./logger.ts";
import {
	normalizeTaskId,
	readTaskLink,
	taskIdFromFilePath,
	writeTaskLink,
} from "./task-links.ts";

/**
 * Task parents in Backlog.md.
 *
 * Backlog.md 1.53 only sets a parent at creation (`backlog task create -p`);
 * `backlog task edit` cannot change it. The plugin therefore changes the
 * parent of an existing task by editing the one `parent_task_id` line of its
 * frontmatter, leaving the rest of the file as it is. Backlog.md keeps the
 * key on later edits because it is one of its own.
 */

/** Frontmatter key Backlog.md stores a task's parent under */
export const PARENT_FRONTMATTER_KEY = "parent_task_id";

const PARENT_LINE = /^parent_task_id:[^\n]*\n/m;
const FRONTMATTER = /^---\n([\s\S]*?\n)---\n/;

/**
 * The ID of a task as written in its own file (e.g. TASK-3), which is how
 * Backlog.md refers to parents. Falls back to the upper-cased ID.
 */
export function taskFileId(taskId: string): string {
	try {
		const { frontmatter } = parseFrontmatter(
			readFileSync(getTaskFilePath(taskId), "utf-8"),
		);
		if (typeof frontmatter.id === "string" && frontmatter.id.trim()) {
			return frontmatter.id.trim();
		}
	} catch (error) {
		logger.debug({ error, taskId }, "Could not read task ID from its file");
	}
	return taskId.toUpperCase();
}

/**
 * Set (or with null, remove) the parent of an existing task by rewriting the
 * `parent_task_id` line of its frontmatter only. Returns whether the file
 * changed.
 */
export function setTaskParent(
	taskId: string,
	parentTaskId: string | null,
): boolean {
	const filePath = getTaskFilePath(taskId);
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(FRONTMATTER);
	if (!match) {
		throw new Error(`Task file of ${taskId} has no frontmatter`);
	}

	const yaml = match[1];
	const line = parentTaskId
		? `${PARENT_FRONTMATTER_KEY}: ${taskFileId(parentTaskId)}\n`
		: "";
	let updated: string;
	if (PARENT_LINE.test(yaml)) {
		updated = yaml.replace(PARENT_LINE, line);
	} else if (!line) {
		return false;
	} else {
		// Where Backlog.md writes it: before ordinal, else at the end
		const ordinal = yaml.match(/^ordinal:/m);
		updated =
			ordinal?.index !== undefined
				? `${yaml.slice(0, ordinal.index)}${line}${yaml.slice(ordinal.index)}`
				: `${yaml}${line}`;
	}
	if (updated === yaml) return false;

	writeFileSync(
		filePath,
		`---\n${updated}---\n${content.slice(match[0].length)}`,
		"utf-8",
	);
	logger.debug({ taskId, parentTaskId }, "Set task parent");
	return true;
}

/**
 * The parent task ID of every task in backlog/tasks, by task ID (all IDs
 * normalized); tasks without a parent map to null
 */
export function readTaskParents(
	cwd = process.cwd(),
): Map<string, string | null> {
	const parents = new Map<string, string | null>();
	const tasksDir = join(cwd, "backlog", "tasks");
	if (!existsSync(tasksDir)) return parents;

	for (const file of readdirSync(tasksDir)) {
		const taskId = taskIdFromFilePath(file);
		if (!taskId || !file.endsWith(".md")) continue;
		try {
			const { frontmatter } = parseFrontmatter(
				readFileSync(join(tasksDir, file), "utf-8"),
			);
			const parent = frontmatter[PARENT_FRONTMATTER_KEY];
			parents.set(
				taskId,
				typeof parent === "string" && parent.trim()
					? normalizeTaskId(parent)
					: null,
			);
		} catch (error) {
			logger.debug({ error, file }, "Could not read task parent");
		}
	}
	return parents;
}

/**
 * The Jira key linked to a task, or null when it is not linked (or has no
 * task file)
 */
export function linkedJiraKey(taskId: string): string | null {
	try {
		return getJiraMetadata(getTaskFilePath(taskId)).jiraKey ?? null;
	} catch {
		return readTaskLink(taskId)?.jiraKey ?? null;
	}
}

/**
 * Record why a task's parent could not be synced (null clears it). The
 * record is kept with the task's Jira link, for view and doctor.
 */
export function recordParentProblem(
	taskId: string,
	problem: string | null,
): void {
	const link = readTaskLink(taskId);
	if (!link && !problem) return;
	if ((link?.parentProblem ?? null) === problem) return;
	try {
		writeTaskLink(taskId, {
			...(link ?? {}),
			parentProblem: problem ?? undefined,
		});
	} catch (error) {
		logger.warn({ error, taskId }, "Could not record parent link problem");
	}
}
