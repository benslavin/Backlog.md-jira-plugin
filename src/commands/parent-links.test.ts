/**
 * Parent and epic links end to end: pull, push and sync against the
 * installed Backlog.md CLI and an in-memory Jira (JiraClient methods are
 * replaced on its prototype). Skipped when `backlog` is not on the PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { BacklogClient } from "../integrations/backlog.ts";
import { parseIssueParent } from "../integrations/jira-hierarchy.ts";
import { JiraClient, type JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import { getTaskFilePath } from "../utils/frontmatter.ts";
import { computeHash, normalizeBacklogTask } from "../utils/normalizer.ts";
import { readTaskLink } from "../utils/task-links.ts";
import { readTaskParents, setTaskParent } from "../utils/task-parents.ts";
import { createIssue } from "./create-issue.ts";
import { pull } from "./pull.ts";
import { push } from "./push.ts";
import { sync } from "./sync.ts";

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

function backlogCli(...args: string[]): string {
	const result = spawnSync("backlog", args, { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

interface FakeIssue {
	summary: string;
	description?: string;
	issueType: string;
	parent: string | null;
}

/** In-memory Jira: issues by key */
const jiraIssues = new Map<string, FakeIssue>();
let nextKey = 100;

/** Change an issue's parent in Jira */
function setJiraParent(key: string, parent: string | null): void {
	const found = jiraIssues.get(key);
	if (!found) throw new Error(`Issue does not exist: ${key}`);
	found.parent = parent;
}

function toJiraIssue(key: string): JiraIssue {
	const found = jiraIssues.get(key);
	if (!found) throw new Error(`Issue does not exist: ${key}`);
	const parent = found.parent ? jiraIssues.get(found.parent) : undefined;
	const fields: Record<string, unknown> = {
		summary: found.summary,
		description: found.description ?? `About ${found.summary}`,
		...(found.parent
			? {
					parent: {
						key: found.parent,
						fields: { issuetype: { name: parent?.issueType ?? "Story" } },
					},
				}
			: {}),
	};
	return {
		key,
		id: key,
		summary: found.summary,
		description: found.description ?? `About ${found.summary}`,
		status: "To Do",
		issueType: found.issueType,
		labels: [],
		created: "",
		updated: "",
		fields,
		parent: parseIssueParent(fields),
	};
}

const fakeMethods: Partial<Record<keyof JiraClient, unknown>> = {
	getIssue: async (key: string) => toJiraIssue(key),
	searchAllIssues: async () => ({
		// Children first, so the import has to reorder them
		issues: [...jiraIssues.keys()].reverse().map(toJiraIssue),
		truncated: false,
	}),
	updateIssue: async (
		key: string,
		updates: {
			summary?: string;
			description?: string;
			fields?: Record<string, unknown>;
		},
	) => {
		const found = jiraIssues.get(key);
		if (!found) throw new Error(`Issue does not exist: ${key}`);
		if (updates.summary) found.summary = updates.summary;
		if (updates.description) found.description = updates.description;
	},
	setIssueParent: async (key: string, parentKey: string | null) => {
		const found = jiraIssues.get(key);
		if (!found) throw new Error(`Issue does not exist: ${key}`);
		found.parent = parentKey;
	},
	createIssue: async (
		_project: string,
		issueType: string,
		summary: string,
		options?: { description?: string; fields?: Record<string, unknown> },
	) => {
		const key = `PROJ-${nextKey++}`;
		const parent = options?.fields?.parent;
		jiraIssues.set(key, {
			summary,
			description: options?.description,
			issueType,
			parent: typeof parent === "string" ? parent : null,
		});
		return { ...toJiraIssue(key), parent: undefined };
	},
	getTransitions: async () => [],
	transitionIssue: async () => {},
	getEpicLinkFieldId: async () => null,
	includeIssueFields: () => {},
	close: async () => {},
};

describe.skipIf(!hasBacklogCli)("parent and epic links", () => {
	let testDir: string;
	let originalCwd: string;
	const originals = new Map<string, unknown>();
	const backlog = new BacklogClient();
	const store = () => new FrontmatterStore();
	const taskOf = (key: string) => {
		const id = store().getMappingByJiraKey(key)?.backlogId;
		if (!id) throw new Error(`${key} is not linked`);
		return id;
	};
	const parentOf = (taskId: string) => readTaskParents().get(taskId) ?? null;

	beforeAll(() => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("parent-links-test");
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlogCli("init", "parent-links", "--defaults");
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			jira: { projectKey: "PROJ", issueType: "Task" },
			backlog: {
				statusMapping: { "To Do": ["To Do"], Done: ["Done"] },
			},
			sync: { conflictStrategy: "prompt" },
		});
		for (const [name, fn] of Object.entries(fakeMethods)) {
			const proto = JiraClient.prototype as unknown as Record<string, unknown>;
			originals.set(name, proto[name]);
			proto[name] = fn;
		}

		jiraIssues.set("PROJ-1", {
			summary: "Epic",
			issueType: "Epic",
			parent: null,
		});
		jiraIssues.set("PROJ-2", {
			summary: "Story",
			issueType: "Story",
			parent: "PROJ-1",
		});
		jiraIssues.set("PROJ-3", {
			summary: "Step",
			issueType: "Sub-task",
			parent: "PROJ-2",
		});
		jiraIssues.set("PROJ-4", {
			summary: "Orphan",
			issueType: "Story",
			parent: "PROJ-50",
		});
	});

	afterAll(() => {
		const proto = JiraClient.prototype as unknown as Record<string, unknown>;
		for (const [name, fn] of originals) proto[name] = fn;
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("imports parents before children, under the tasks their parents became", async () => {
		const result = await pull({ import: true });

		expect(result.failed).toEqual([]);
		expect(result.imported).toHaveLength(4);
		expect(parentOf(taskOf("PROJ-1"))).toBeNull();
		expect(parentOf(taskOf("PROJ-2"))).toBe(taskOf("PROJ-1"));
		expect(parentOf(taskOf("PROJ-3"))).toBe(taskOf("PROJ-2"));
		// Backlog.md shows them as subtasks
		const epicView = backlogCli("task", taskOf("PROJ-1"), "--plain");
		expect(epicView).toContain("Subtasks (1):");
		expect((await backlog.getTask(taskOf("PROJ-3"))).parent).toBe(
			taskOf("PROJ-2"),
		);
	});

	it("reports an issue whose Jira parent is not linked to a task", async () => {
		const orphan = taskOf("PROJ-4");
		expect(parentOf(orphan)).toBeNull();
		expect(readTaskLink(orphan)?.parentProblem).toContain("PROJ-50");
		// Nothing else changed, so a pull leaves it alone
		const result = await pull();
		expect(result.pulled).toEqual([]);
	});

	it("sets the parent once the Jira parent is linked", async () => {
		jiraIssues.set("PROJ-50", {
			summary: "Late epic",
			issueType: "Epic",
			parent: null,
		});
		const result = await pull({ import: true });

		expect(result.failed).toEqual([]);
		const orphan = taskOf("PROJ-4");
		expect(parentOf(orphan)).toBe(taskOf("PROJ-50"));
		expect(readTaskLink(orphan)?.parentProblem).toBeUndefined();
		// And it stays in sync
		expect((await pull()).pulled).toEqual([]);
		expect((await push()).pushed).toEqual([]);
	});

	it("follows a Jira parent change on pull", async () => {
		setJiraParent("PROJ-2", "PROJ-50");
		const result = await pull();

		expect(result.pulled).toEqual([taskOf("PROJ-2")]);
		expect(parentOf(taskOf("PROJ-2"))).toBe(taskOf("PROJ-50"));
		expect((await push()).pushed).toEqual([]);
	});

	it("keeps a parent the plugin set through later backlog task edit calls", async () => {
		const story = taskOf("PROJ-2");
		backlogCli("task", "edit", story, "-s", "In Progress");
		expect(parentOf(story)).toBe(taskOf("PROJ-50"));
		backlogCli("task", "edit", story, "-s", "To Do");
		expect(readFileSync(getTaskFilePath(story), "utf-8")).toContain(
			"parent_task_id:",
		);
	});

	it("pushes a parent changed in Backlog", async () => {
		const story = taskOf("PROJ-2");
		setTaskParent(story, taskOf("PROJ-1"));

		const result = await push();
		expect(result.failed).toEqual([]);
		expect(result.pushed).toEqual([story]);
		expect(jiraIssues.get("PROJ-2")?.parent).toBe("PROJ-1");

		setTaskParent(story, null);
		await push();
		expect(jiraIssues.get("PROJ-2")?.parent).toBeNull();
		expect((await pull()).pulled).toEqual([]);
	});

	it("reports hierarchies Jira cannot represent and keeps them pending", async () => {
		const epicTask = taskOf("PROJ-1");
		setTaskParent(epicTask, taskOf("PROJ-50"));

		const first = await push();
		expect(first.failed).toHaveLength(1);
		expect(first.failed[0].error).toContain("epics cannot have a parent");
		expect(jiraIssues.get("PROJ-1")?.parent).toBeNull();
		// Retried (and reported) by the next push, never pulled over
		expect((await push()).failed).toHaveLength(1);
		expect((await pull()).pulled).toEqual([]);
		expect(parentOf(epicTask)).toBe(taskOf("PROJ-50"));

		setTaskParent(epicTask, null);
		expect((await push()).failed).toEqual([]);
	});

	it("merges a parent changed in Jira with a title changed in Backlog", async () => {
		const story = taskOf("PROJ-2");
		backlogCli("task", "edit", story, "-t", "Story renamed");
		setJiraParent("PROJ-2", "PROJ-1");

		const result = await sync();

		expect(result.failed).toEqual([]);
		expect(result.conflicts).toEqual([{ taskId: story, resolution: "merged" }]);
		expect(jiraIssues.get("PROJ-2")?.summary).toBe("Story renamed");
		expect(parentOf(story)).toBe(taskOf("PROJ-1"));
		expect((await sync()).skipped).toContain(story);
	});

	it("resolves parents changed on both sides by the conflict strategy", async () => {
		const story = taskOf("PROJ-2");
		setTaskParent(story, taskOf("PROJ-50"));
		setJiraParent("PROJ-2", null);

		const result = await sync({ strategy: "prefer-jira" });

		expect(result.failed).toEqual([]);
		expect(result.conflicts).toEqual([
			{ taskId: story, resolution: "preferred-jira" },
		]);
		expect(parentOf(story)).toBeNull();
	});

	it("creates a subtask from a task whose parent is linked", async () => {
		const story = taskOf("PROJ-2");
		const child = await backlog.createTask({
			title: "New step",
			parent: story.toUpperCase(),
		});

		const result = await createIssue({ taskId: child });

		expect(result).toMatchObject({
			success: true,
			issueType: "Subtask",
			parentKey: "PROJ-2",
		});
		const key = result.jiraKey as string;
		expect(jiraIssues.get(key)).toMatchObject({
			issueType: "Subtask",
			parent: "PROJ-2",
		});
		// Created in sync on both sides
		expect((await sync()).skipped).toContain(child);
	});

	it("creates a standard issue under an epic given by task ID", async () => {
		const loose = await backlog.createTask({ title: "Loose story" });

		const result = await createIssue({
			taskId: loose,
			parent: taskOf("PROJ-1"),
		});

		expect(result).toMatchObject({
			success: true,
			issueType: "Task",
			parentKey: "PROJ-1",
		});
		expect(parentOf(loose)).toBe(taskOf("PROJ-1"));
		expect((await sync()).skipped).toContain(loose);
	});

	it("refuses to create an issue under a subtask or an unlinked parent", async () => {
		const underSubtask = await backlog.createTask({
			title: "Too deep",
			parent: taskOf("PROJ-3").toUpperCase(),
		});
		const before = jiraIssues.size;
		const result = await createIssue({ taskId: underSubtask });
		expect(result.success).toBe(false);
		expect(result.error).toContain("cannot nest issues under a subtask");

		const unlinkedParent = await backlog.createTask({ title: "Unlinked" });
		const child = await backlog.createTask({
			title: "Child of unlinked",
			parent: unlinkedParent.toUpperCase(),
		});
		const unlinked = await createIssue({ taskId: child });
		expect(unlinked.success).toBe(false);
		expect(unlinked.error).toContain(
			`backlog-jira create-issue ${unlinkedParent.toUpperCase()}`,
		);
		expect(jiraIssues.size).toBe(before);
	});

	it("reads snapshots from before parent sync without seeing changes", async () => {
		const story = taskOf("PROJ-2");
		const epicTask = taskOf("PROJ-1");
		/** Snapshots as an earlier version wrote them: no parent, not hashed */
		const writeLegacySnapshots = async () => {
			const payload = normalizeBacklogTask(await backlog.getTask(story));
			payload.parent = undefined;
			const hash = computeHash(payload);
			for (const side of ["backlog", "jira"] as const) {
				store().setSnapshot(story, side, hash, payload);
			}
		};

		// Same parent on both sides: in sync
		setJiraParent("PROJ-2", "PROJ-1");
		setTaskParent(story, epicTask);
		await writeLegacySnapshots();
		expect((await sync()).skipped).toContain(story);

		// Parent only in Jira: pulled
		setTaskParent(story, null);
		await writeLegacySnapshots();
		const result = await sync();
		expect(result.failed).toEqual([]);
		expect(result.synced).toContain(story);
		expect(parentOf(story)).toBe(epicTask);
		expect(jiraIssues.get("PROJ-2")?.parent).toBe("PROJ-1");
	});
});
