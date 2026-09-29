import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import {
	type IdIndex,
	createIdIndex,
	describeResolution,
	formatIdPair,
	resolutionState,
	resolveId,
	resolveTaskArg,
	resolveTaskArgs,
} from "./id-resolver.ts";

function index(overrides: Partial<IdIndex> = {}): IdIndex {
	return {
		taskIds: new Set(["task-1", "task-2", "task-3.1"]),
		jiraKeyByTask: new Map([
			["task-1", "CR2-77"],
			["task-3.1", "CR2-80"],
		]),
		taskByJiraKey: new Map([
			["CR2-77", "task-1"],
			["CR2-80", "task-3.1"],
		]),
		taskPrefix: "task",
		projectKey: "CR2",
		...overrides,
	};
}

describe("resolveId", () => {
	it("resolves a linked task to its Jira key", () => {
		expect(resolveId("TASK-1", index())).toEqual({
			input: "TASK-1",
			kind: "task",
			taskId: "TASK-1",
			jiraKey: "CR2-77",
		});
	});

	it("resolves a linked Jira key to its task, ignoring case", () => {
		expect(resolveId("cr2-77", index())).toEqual({
			input: "cr2-77",
			kind: "jira",
			taskId: "task-1",
			jiraKey: "CR2-77",
		});
		expect(resolveId("CR2-80", index()).taskId).toBe("task-3.1");
	});

	it("reports unlinked tasks and Jira keys", () => {
		expect(resolutionState(resolveId("task-2", index()))).toBe("unlinked-task");
		const jira = resolveId("CR2-99", index());
		expect(jira).toEqual({ input: "CR2-99", kind: "jira", jiraKey: "CR2-99" });
		expect(resolutionState(jira)).toBe("unlinked-jira");
	});

	it("reports task IDs without a task file as unknown", () => {
		const missing = resolveId("TASK-404", index());
		expect(missing.missing).toBe(true);
		expect(resolutionState(missing)).toBe("unknown");
		expect(resolutionState(resolveId("not an id", index()))).toBe("unknown");
	});

	it("uses the configured task prefix", () => {
		const custom = index({ taskPrefix: "back" });
		expect(resolveId("BACK-9", custom).missing).toBe(true);
		expect(resolveId("TASK-9", custom).kind).toBe("jira");
	});

	it("prefers an existing task over a Jira key spelled the same", () => {
		const same = index({
			taskIds: new Set(["cr2-77"]),
			taskByJiraKey: new Map([["CR2-77", "task-1"]]),
		});
		expect(resolveId("CR2-77", same).kind).toBe("task");
	});

	it("treats keys of the Jira project as Jira keys when it shares the task prefix", () => {
		const shared = index({ taskPrefix: "cr2" });
		expect(resolveId("CR2-99", shared).kind).toBe("jira");
	});
});

describe("formatting", () => {
	it("shows linked tasks as a pair", () => {
		expect(formatIdPair("task-1", "CR2-77")).toBe("TASK-1 ⇄ CR2-77");
		expect(formatIdPair("task-2")).toBe("TASK-2");
	});

	it("describes each resolution for people and agents", () => {
		const idx = index();
		const lines = ["CR2-77", "task-2", "CR2-99", "task-404"].map((id) =>
			resolveId(id, idx),
		);
		expect(lines.map((r) => describeResolution(r))).toEqual([
			"TASK-1 ⇄ CR2-77",
			"TASK-2 (Backlog task, not linked to Jira)",
			"CR2-99 (Jira key, not linked to a Backlog task)",
			"task-404 (unknown: no Backlog task or linked Jira issue)",
		]);
		expect(lines.map((r) => describeResolution(r, true))).toEqual([
			"CR2-77\tTASK-1\tCR2-77\tlinked",
			"task-2\tTASK-2\t-\tunlinked-task",
			"CR2-99\t-\tCR2-99\tunlinked-jira",
			"task-404\t-\t-\tunknown",
		]);
	});
});

describe("resolving task arguments", () => {
	let testDir: string;
	let originalCwd: string;
	let store: FrontmatterStore;

	function createTask(id: string, jiraKey?: string): void {
		const tasksDir = join(testDir, "backlog", "tasks");
		mkdirSync(tasksDir, { recursive: true });
		const lines = [`id: ${id.toUpperCase()}`, `title: Task ${id}`];
		if (jiraKey) lines.push(`jira_key: ${jiraKey}`);
		writeFileSync(
			join(tasksDir, `${id} - Task-${id}.md`),
			`---\n${lines.join("\n")}\n---\n\n## Description\n\nSee CR2-77\n`,
		);
	}

	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("id-resolver-test");
		process.chdir(testDir);
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			jira: { projectKey: "CR2" },
		});
		createTask("task-1", "CR2-77");
		createTask("task-2");
		writeFileSync(
			join(testDir, "backlog", "config.yml"),
			'task_prefix: "task"\n',
		);
		store = new FrontmatterStore(join(testDir, ".backlog-jira"));
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("builds the index from task files and their links", () => {
		const idx = createIdIndex(store);
		expect([...idx.taskIds].sort()).toEqual(["task-1", "task-2"]);
		expect(idx.taskByJiraKey.get("CR2-77")).toBe("task-1");
		expect(idx.projectKey).toBe("CR2");
		expect(idx.taskPrefix).toBe("task");
	});

	it("maps Jira keys of linked issues to their tasks and drops duplicates", () => {
		expect(resolveTaskArgs(["CR2-77", "task-1", "TASK-2"], store)).toEqual({
			taskIds: ["task-1", "TASK-2"],
			errors: [],
		});
	});

	it("reports IDs that name no task", () => {
		const { taskIds, errors } = resolveTaskArgs(
			["CR2-99", "task-9", "task-2"],
			store,
		);
		expect(taskIds).toEqual(["task-2"]);
		expect(errors.map((e) => e.input)).toEqual(["CR2-99", "task-9"]);
		expect(errors[0].error).toContain("not linked to any Backlog task");
		expect(errors[1].error).toBe("Task task-9 not found");
	});

	it("resolves a single argument, passing unknown IDs through", () => {
		expect(resolveTaskArg("CR2-77", store)).toBe("task-1");
		expect(resolveTaskArg("task-9", store)).toBe("task-9");
		expect(() => resolveTaskArg("CR2-99", store)).toThrow(
			"CR2-99 is a Jira key not linked",
		);
	});
});
