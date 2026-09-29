import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	type PullResult,
	buildBacklogUpdates,
	formatImportedLines,
	pull,
} from "./pull.ts";
import { buildJiraUpdates, push } from "./push.ts";
import { PLAIN_HEADER, resolveCommand } from "./resolve.ts";
import { sync } from "./sync.ts";

let testDir: string;
let originalCwd: string;

function createTask(id: string, jiraKey?: string): void {
	const tasksDir = join(testDir, "backlog", "tasks");
	mkdirSync(tasksDir, { recursive: true });
	const lines = [`id: ${id.toUpperCase()}`, `title: Task ${id}`];
	if (jiraKey) lines.push(`jira_key: ${jiraKey}`);
	writeFileSync(
		join(tasksDir, `${id} - Task-${id}.md`),
		`---\n${lines.join("\n")}\n---\n\n## Description\n\nDepends on CR2-78\n`,
	);
}

beforeEach(() => {
	originalCwd = process.cwd();
	testDir = uniqueTestDir("task-id-args-test");
	process.chdir(testDir);
	writeJson(join(testDir, ".backlog-jira", "config.json"), {
		jira: { projectKey: "CR2", issueType: "Task" },
		sync: { conflictStrategy: "prefer-backlog" },
	});
	createTask("task-1", "CR2-77");
	createTask("task-2");
});

afterEach(() => {
	process.chdir(originalCwd);
	cleanupDir(testDir);
});

describe("resolve command", () => {
	it("prints each ID with its counterpart", () => {
		const { lines } = resolveCommand(["CR2-77", "task-1", "task-2", "CR2-99"]);
		expect(lines).toEqual([
			"✓ TASK-1 ⇄ CR2-77",
			"✓ TASK-1 ⇄ CR2-77",
			"○ TASK-2 (Backlog task, not linked to Jira)",
			"○ CR2-99 (Jira key, not linked to a Backlog task)",
		]);
	});

	it("prints tab-separated rows with --plain, reporting unknown IDs", () => {
		const { lines } = resolveCommand(["cr2-77", "task-404", "hello"], {
			plain: true,
		});
		expect(lines).toEqual([
			PLAIN_HEADER,
			"cr2-77\tTASK-1\tCR2-77\tlinked",
			"task-404\t-\t-\tunknown",
			"hello\t-\t-\tunknown",
		]);
	});
});

describe("task arguments that are not tasks", () => {
	// No Jira client is started: the IDs fail before any task is processed,
	// and must not fall back to processing every mapped task
	it("push reports an unlinked Jira key", async () => {
		const result = await push({ taskIds: ["CR2-99"] });
		expect(result.pushed).toEqual([]);
		expect(result.failed).toEqual([
			{
				taskId: "CR2-99",
				error: expect.stringContaining("not linked to any Backlog task"),
			},
		]);
	});

	it("pull reports an unknown task", async () => {
		const result = await pull({ taskIds: ["task-404"] });
		expect(result.pulled).toEqual([]);
		expect(result.failed).toEqual([
			{ taskId: "task-404", error: "Task task-404 not found" },
		]);
	});

	it("sync reports an unlinked Jira key", async () => {
		const result = await sync({ taskIds: ["CR2-99"] });
		expect(result.synced).toEqual([]);
		expect(result.failed.map((f) => f.taskId)).toEqual(["CR2-99"]);
		expect(result.failed[0].error).toContain("not linked to any Backlog task");
	});
});

describe("import summary", () => {
	it("lists imported tasks as pairs", () => {
		const result = {
			importedLinks: [
				{ taskId: "task-12", jiraKey: "CR2-100" },
				{ taskId: "task-11", jiraKey: "CR2-9" },
				{ taskId: "dry-run-CR2-5", jiraKey: "CR2-5" },
			],
		} as PullResult;
		expect(formatImportedLines(result)).toEqual([
			"CR2-5 (dry run: would import)",
			"TASK-11 ⇄ CR2-9",
			"TASK-12 ⇄ CR2-100",
		]);
	});
});

describe("IDs in text are never translated", () => {
	const text = "Blocked by CR2-78 and TASK-2; follow-up of cr2-77 (task-1)";

	const task: BacklogTask = {
		id: "task-1",
		title: "Fix CR2-77 regression",
		description: text,
		status: "To Do",
		labels: [],
		acceptanceCriteria: [],
	};

	const issue: JiraIssue = {
		key: "CR2-77",
		id: "10077",
		summary: "Fix CR2-77 regression",
		description: "Old text",
		status: "To Do",
		issueType: "Task",
		labels: [],
		created: "",
		updated: "",
	};

	it("push sends descriptions to Jira as written", async () => {
		const updates = await buildJiraUpdates(
			task,
			issue,
			{ getTransitions: async () => [] },
			"CR2",
		);
		expect(updates.fields.description).toBe(text);
		expect(updates.fields.summary).toBeUndefined();
	});

	it("pull writes Jira descriptions to Backlog as written", () => {
		const updates = buildBacklogUpdates(
			{ ...issue, description: text, summary: "About TASK-2 and CR2-78" },
			{ ...task, description: "Old text" },
			"CR2",
		);
		expect(updates.description).toBe(text);
		expect(updates.title).toBe("About TASK-2 and CR2-78");
	});
});
