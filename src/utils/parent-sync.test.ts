import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { JiraParentRef } from "../integrations/jira-hierarchy.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import type { MappedFieldState } from "./mapped-field-sync.ts";
import type { NormalizedPayload } from "./normalizer.ts";
import {
	type ParentSyncContext,
	createParentSyncContext,
	detectParentConflict,
	findParentLinkProblems,
	formatParentSection,
	orderByParent,
	parentNeedsPull,
	planIssueCreation,
	planParentMerge,
	pullTaskParent,
	pushTaskParent,
} from "./parent-sync.ts";
import { readTaskLink } from "./task-links.ts";
import { linkedJiraKey, readTaskParents } from "./task-parents.ts";

let testDir: string;
let originalCwd: string;

function writeTask(
	id: string,
	options: { jiraKey?: string; parent?: string } = {},
): string {
	const tasksDir = join(testDir, "backlog", "tasks");
	mkdirSync(tasksDir, { recursive: true });
	const lines = [
		`id: ${id.toUpperCase()}`,
		`title: Task ${id}`,
		"status: To Do",
		"assignee: []",
		"labels: []",
		"dependencies: []",
		...(options.parent
			? [`parent_task_id: ${options.parent.toUpperCase()}`]
			: []),
		...(options.jiraKey ? [`jira_key: ${options.jiraKey}`] : []),
		"ordinal: 1000",
	];
	const path = join(tasksDir, `${id} - Task-${id}.md`);
	writeFileSync(
		path,
		`---\n${lines.join("\n")}\n---\n\n## Description\n\nBody of ${id}\n`,
		"utf-8",
	);
	return path;
}

function issue(
	key: string,
	issueType: string,
	parent: JiraParentRef | null = null,
): JiraIssue {
	return {
		key,
		id: key,
		summary: key,
		status: "To Do",
		issueType,
		created: "",
		updated: "",
		parent,
	};
}

const epic = (key: string): JiraParentRef => ({
	key,
	kind: "epic",
	issueType: "Epic",
	via: "parent",
});
const story = (key: string): JiraParentRef => ({
	key,
	kind: "standard",
	issueType: "Story",
	via: "parent",
});

function fakeJira(issues: JiraIssue[], epicLinkFieldId: string | null = null) {
	const byKey = new Map(issues.map((i) => [i.key, i]));
	return {
		getIssue: mock(async (key: string) => {
			const found = byKey.get(key);
			if (!found) throw new Error(`Issue ${key} does not exist`);
			return found;
		}),
		setIssueParent: mock(
			async (_key: string, _parent: string | null, _via: string) => {},
		),
		getEpicLinkFieldId: mock(async () => epicLinkFieldId),
	};
}

function context(
	jira: ReturnType<typeof fakeJira>,
	dryRun = false,
): ParentSyncContext {
	const ctx = createParentSyncContext(
		jira,
		new FrontmatterStore(join(testDir, ".backlog-jira")),
		{ dryRun, enabled: true },
	);
	if (!ctx) throw new Error("parent links disabled");
	return ctx;
}

beforeEach(() => {
	originalCwd = process.cwd();
	testDir = uniqueTestDir("parent-sync-test");
	process.chdir(testDir);
	writeJson(join(testDir, ".backlog-jira", "config.json"), {
		jira: { projectKey: "PROJ" },
	});
});

afterEach(() => {
	process.chdir(originalCwd);
	cleanupDir(testDir);
});

describe("pullTaskParent", () => {
	it("sets parent_task_id from the Jira parent, changing only that line", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const path = writeTask("task-2", { jiraKey: "PROJ-2" });
		const before = readFileSync(path, "utf-8");

		const result = pullTaskParent(
			context(fakeJira([])),
			"task-2",
			{},
			issue("PROJ-2", "Sub-task", story("PROJ-1")),
		);

		expect(result).toEqual({ changed: true, applied: true });
		const after = readFileSync(path, "utf-8");
		expect(after).toBe(
			before.replace("ordinal: 1000", "parent_task_id: TASK-1\nordinal: 1000"),
		);
	});

	it("follows a change of Jira parent and clears a removed one", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-3", { jiraKey: "PROJ-3" });
		const path = writeTask("task-2", { jiraKey: "PROJ-2", parent: "task-1" });
		const ctx = context(fakeJira([]));

		pullTaskParent(
			ctx,
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story", epic("PROJ-3")),
		);
		expect(readTaskParents().get("task-2")).toBe("task-3");

		const result = pullTaskParent(
			ctx,
			"task-2",
			{ parent: "task-3" },
			issue("PROJ-2", "Story", null),
		);
		expect(result.changed).toBe(true);
		expect(readTaskParents().get("task-2")).toBeNull();
		expect(readFileSync(path, "utf-8")).not.toContain("parent_task_id");
	});

	it("reports and records a Jira parent linked to no task, keeping the task's parent", () => {
		writeTask("task-2", { jiraKey: "PROJ-2" });
		const ctx = context(fakeJira([]));

		const result = pullTaskParent(
			ctx,
			"task-2",
			{},
			issue("PROJ-2", "Story", epic("PROJ-99")),
		);

		expect(result.applied).toBe(false);
		expect(result.problem).toContain("PROJ-99 is not linked");
		expect(ctx.warnings[0]).toContain("TASK-2 ⇄ PROJ-2: parent not pulled");
		expect(readTaskLink("task-2")?.parentProblem).toContain("PROJ-99");
		expect(readTaskParents().get("task-2")).toBeNull();
	});

	it("refuses a parent that is a subtask of the task in Backlog", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-2", { jiraKey: "PROJ-2", parent: "task-1" });

		const result = pullTaskParent(
			context(fakeJira([])),
			"task-1",
			{},
			issue("PROJ-1", "Sub-task", story("PROJ-2")),
		);

		expect(result.applied).toBe(false);
		expect(readTaskParents().get("task-1")).toBeNull();
	});

	it("writes nothing in a dry run", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const path = writeTask("task-2", { jiraKey: "PROJ-2" });
		const before = readFileSync(path, "utf-8");
		pullTaskParent(
			context(fakeJira([]), true),
			"task-2",
			{},
			issue("PROJ-2", "Sub-task", story("PROJ-1")),
		);
		expect(readFileSync(path, "utf-8")).toBe(before);
	});
});

describe("parentNeedsPull", () => {
	const snapshot = (parent: string) => ({
		backlogId: "task-2",
		side: "backlog" as const,
		hash: "h",
		payload: JSON.stringify({ parent }),
		updatedAt: "",
	});

	it("is true once a Jira parent that was not linked is linked", () => {
		writeTask("task-2", { jiraKey: "PROJ-2" });
		const ctx = context(fakeJira([]));
		const child = issue("PROJ-2", "Story", epic("PROJ-1"));

		expect(parentNeedsPull(ctx, {}, child, snapshot(""))).toBe(false);
		writeTask("task-1", { jiraKey: "PROJ-1" });
		expect(parentNeedsPull(ctx, {}, child, snapshot(""))).toBe(true);
		expect(
			parentNeedsPull(ctx, { parent: "task-1" }, child, snapshot("")),
		).toBe(false);
	});

	it("is false when the task's parent was changed in Backlog since", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-3");
		const ctx = context(fakeJira([]));
		expect(
			parentNeedsPull(
				ctx,
				{ parent: "task-3" },
				issue("PROJ-2", "Story", epic("PROJ-1")),
				snapshot(""),
			),
		).toBe(false);
	});
});

describe("pushTaskParent", () => {
	it("puts a standard issue under an epic through the parent field on Cloud", async () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-2", { jiraKey: "PROJ-2", parent: "task-1" });
		const jira = fakeJira([issue("PROJ-1", "Epic")]);

		const result = await pushTaskParent(
			context(jira),
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story"),
		);

		expect(result.status).toBe("updated");
		expect(jira.setIssueParent).toHaveBeenCalledWith(
			"PROJ-2",
			"PROJ-1",
			"parent",
		);
	});

	it("uses the Epic Link field where epics are linked through it", async () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const jira = fakeJira([issue("PROJ-1", "Epic")], "customfield_10100");

		await pushTaskParent(
			context(jira),
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story"),
		);

		expect(jira.setIssueParent).toHaveBeenCalledWith(
			"PROJ-2",
			"PROJ-1",
			"epicLink",
		);
	});

	it("moves a subtask to another standard parent", async () => {
		writeTask("task-3", { jiraKey: "PROJ-3" });
		const jira = fakeJira([issue("PROJ-3", "Story")]);

		const result = await pushTaskParent(
			context(jira),
			"task-2",
			{ parent: "task-3" },
			issue("PROJ-2", "Sub-task", story("PROJ-1")),
		);

		expect(result.status).toBe("updated");
		expect(jira.setIssueParent).toHaveBeenCalledWith(
			"PROJ-2",
			"PROJ-3",
			"parent",
		);
	});

	it("clears an epic link", async () => {
		const jira = fakeJira([]);
		await pushTaskParent(
			context(jira),
			"task-2",
			{},
			issue("PROJ-2", "Story", {
				key: "PROJ-1",
				kind: "epic",
				via: "epicLink",
			}),
		);
		expect(jira.setIssueParent).toHaveBeenCalledWith(
			"PROJ-2",
			null,
			"epicLink",
		);
	});

	it("does nothing when the parents already match", async () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const jira = fakeJira([]);
		const result = await pushTaskParent(
			context(jira),
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story", epic("PROJ-1")),
		);
		expect(result.status).toBe("unchanged");
		expect(jira.getIssue).not.toHaveBeenCalled();
	});

	const refused: Array<{
		name: string;
		parentIssue?: JiraIssue;
		parentTask?: { jiraKey?: string };
		child: JiraIssue;
		reason: string;
	}> = [
		{
			name: "a parent task not linked to Jira",
			parentTask: {},
			child: issue("PROJ-2", "Story"),
			reason: "create-issue TASK-1",
		},
		{
			name: "a subtask of a subtask",
			parentTask: { jiraKey: "PROJ-1" },
			parentIssue: issue("PROJ-1", "Sub-task", story("PROJ-9")),
			child: issue("PROJ-2", "Sub-task", story("PROJ-8")),
			reason: "cannot nest issues under a subtask",
		},
		{
			name: "a standard issue under a standard issue (type change)",
			parentTask: { jiraKey: "PROJ-1" },
			parentIssue: issue("PROJ-1", "Story"),
			child: issue("PROJ-2", "Task"),
			reason: "change its type to a subtask type",
		},
		{
			name: "a subtask under an epic (type change)",
			parentTask: { jiraKey: "PROJ-1" },
			parentIssue: issue("PROJ-1", "Epic"),
			child: issue("PROJ-2", "Sub-task", story("PROJ-8")),
			reason: "convert it to a standard issue",
		},
		{
			name: "an epic with a parent",
			parentTask: { jiraKey: "PROJ-1" },
			parentIssue: issue("PROJ-1", "Story"),
			child: issue("PROJ-2", "Epic"),
			reason: "epics cannot have a parent",
		},
	];
	for (const { name, parentIssue, parentTask, child, reason } of refused) {
		it(`reports and skips ${name}`, async () => {
			if (parentTask) writeTask("task-1", parentTask);
			writeTask("task-2", { jiraKey: child.key, parent: "task-1" });
			const jira = fakeJira(parentIssue ? [parentIssue] : []);

			const result = await pushTaskParent(
				context(jira),
				"task-2",
				{ parent: "task-1" },
				child,
			);

			expect(result.status).toBe("failed");
			expect(result.reason).toContain(reason);
			expect(jira.setIssueParent).not.toHaveBeenCalled();
			expect(readTaskLink("task-2")?.parentProblem).toBe(result.reason);
		});
	}

	it("refuses to take a subtask's parent away", async () => {
		writeTask("task-2", { jiraKey: "PROJ-2" });
		const jira = fakeJira([]);
		const result = await pushTaskParent(
			context(jira),
			"task-2",
			{},
			issue("PROJ-2", "Sub-task", story("PROJ-1")),
		);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("cannot lose its parent");
		expect(jira.setIssueParent).not.toHaveBeenCalled();
	});

	it("reports a parent change Jira rejects", async () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-2", { jiraKey: "PROJ-2" });
		const jira = fakeJira([issue("PROJ-1", "Epic")]);
		jira.setIssueParent.mockImplementation(async () => {
			throw new Error("Field 'parent' cannot be set");
		});
		const result = await pushTaskParent(
			context(jira),
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story"),
		);
		expect(result).toEqual({
			status: "failed",
			reason:
				"Jira did not accept the parent change: Field 'parent' cannot be set",
		});
	});

	it("changes nothing in a dry run", async () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const jira = fakeJira([issue("PROJ-1", "Epic")]);
		const result = await pushTaskParent(
			context(jira, true),
			"task-2",
			{ parent: "task-1" },
			issue("PROJ-2", "Story"),
		);
		expect(result.status).toBe("dry-run");
		expect(jira.setIssueParent).not.toHaveBeenCalled();
	});
});

describe("planIssueCreation", () => {
	it("creates a standard issue under an epic", async () => {
		const plan = await planIssueCreation(
			context(fakeJira([issue("PROJ-1", "Epic")])),
			"PROJ-1",
			{ default: "Task" },
		);
		expect(plan).toEqual({
			ok: true,
			issueType: "Task",
			parentKey: "PROJ-1",
			parentKind: "epic",
			fields: { parent: "PROJ-1" },
		});
	});

	it("links the epic through the Epic Link field on Server/Data Center", async () => {
		const plan = await planIssueCreation(
			context(fakeJira([issue("PROJ-1", "Epic")], "customfield_10100")),
			"PROJ-1",
			{ requested: "Bug", default: "Task" },
		);
		expect(plan).toMatchObject({
			ok: true,
			issueType: "Bug",
			fields: { customfield_10100: "PROJ-1" },
		});
	});

	it("creates a Subtask under a standard issue", async () => {
		const plan = await planIssueCreation(
			context(fakeJira([issue("PROJ-1", "Story")])),
			"PROJ-1",
			{ default: "Task" },
		);
		expect(plan).toMatchObject({
			ok: true,
			issueType: "Subtask",
			parentKind: "standard",
			fields: { parent: "PROJ-1" },
		});
	});

	it("creates a top-level issue without a parent", async () => {
		const jira = fakeJira([]);
		expect(
			await planIssueCreation(context(jira), null, { default: "Task" }),
		).toEqual({ ok: true, issueType: "Task", parentKey: null, fields: {} });
		expect(jira.getIssue).not.toHaveBeenCalled();
	});

	it("refuses parents Jira cannot hold the issue under", async () => {
		const ctx = context(
			fakeJira([
				issue("PROJ-1", "Sub-task", story("PROJ-9")),
				issue("PROJ-2", "Epic"),
			]),
		);
		expect(
			await planIssueCreation(ctx, "PROJ-1", { default: "Task" }),
		).toMatchObject({ ok: false, reason: expect.stringContaining("subtask") });
		expect(
			await planIssueCreation(ctx, "PROJ-404", { default: "Task" }),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("PROJ-404 could not be fetched"),
		});
		expect(
			await planIssueCreation(ctx, "PROJ-2", {
				requested: "Sub-task",
				default: "Task",
			}),
		).toMatchObject({ ok: false });
		expect(
			await planIssueCreation(ctx, "PROJ-2", {
				requested: "Epic",
				default: "Task",
			}),
		).toMatchObject({ ok: false });
	});
});

describe("parent conflicts", () => {
	function state(
		current: { backlog: string; jira: string },
		base: { backlog: string; jira: string },
	): MappedFieldState {
		const payload = (parent: string) =>
			({ parent }) as unknown as NormalizedPayload;
		return {
			current: {
				backlog: payload(current.backlog),
				jira: payload(current.jira),
			},
			base: { backlog: payload(base.backlog), jira: payload(base.jira) },
			frontmatter: {},
			issue: issue("PROJ-2", "Story"),
		};
	}

	it("detects parents changed on both sides to different parents", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		const ctx = context(fakeJira([]));
		const conflict = detectParentConflict(
			state({ backlog: "PROJ-1", jira: "PROJ-7" }, { backlog: "", jira: "" }),
			ctx,
		);
		expect(conflict).toEqual({
			field: "parent",
			backlogValue: "TASK-1 ⇄ PROJ-1",
			jiraValue: "PROJ-7 (not linked to a task)",
			baseValue: "(no parent)",
		});
		expect(
			detectParentConflict(
				state({ backlog: "PROJ-1", jira: "" }, { backlog: "", jira: "" }),
				ctx,
			),
		).toBeNull();
	});

	it("merges the side that changed, or the chosen one", () => {
		const oneSided = state(
			{ backlog: "PROJ-1", jira: "" },
			{ backlog: "", jira: "" },
		);
		expect(planParentMerge(oneSided)).toBe("backlog");
		const jiraSided = state(
			{ backlog: "", jira: "PROJ-1" },
			{ backlog: "", jira: "" },
		);
		expect(planParentMerge(jiraSided)).toBe("jira");
		const both = state(
			{ backlog: "PROJ-1", jira: "PROJ-7" },
			{ backlog: "", jira: "" },
		);
		expect(planParentMerge(both)).toBeNull();
		expect(planParentMerge(both, "jira")).toBe("jira");
		const same = state(
			{ backlog: "PROJ-1", jira: "PROJ-1" },
			{ backlog: "", jira: "" },
		);
		expect(planParentMerge(same, "jira")).toBeNull();
	});
});

describe("orderByParent", () => {
	it("imports parents before their children", () => {
		const parents = new Map<string, string | null>([
			["PROJ-3", "PROJ-2"],
			["PROJ-2", "PROJ-1"],
			["PROJ-1", null],
			["PROJ-4", "PROJ-99"],
		]);
		expect(
			orderByParent(["PROJ-3", "PROJ-2", "PROJ-4", "PROJ-1"], parents),
		).toEqual([["PROJ-4", "PROJ-1"], ["PROJ-2"], ["PROJ-3"]]);
	});

	it("survives a parent cycle", () => {
		const parents = new Map([
			["PROJ-1", "PROJ-2"],
			["PROJ-2", "PROJ-1"],
		]);
		expect(orderByParent(["PROJ-1", "PROJ-2"], parents).flat().sort()).toEqual([
			"PROJ-1",
			"PROJ-2",
		]);
	});
});

describe("doctor and view helpers", () => {
	it("finds unlinked parents, too deep hierarchies and recorded problems", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-2", { jiraKey: "PROJ-2", parent: "task-1" });
		writeTask("task-3", { jiraKey: "PROJ-3", parent: "task-2" });
		writeTask("task-4", { jiraKey: "PROJ-4", parent: "task-3" });
		writeTask("task-5");
		writeTask("task-6", { jiraKey: "PROJ-6", parent: "task-5" });
		writeTask("task-7", { parent: "task-5" });

		const problems = findParentLinkProblems(
			readTaskParents(),
			linkedJiraKey,
			(taskId) => (taskId === "task-1" ? "recorded problem" : undefined),
		);

		expect(problems.map((p) => [p.taskId, p.problem])).toEqual([
			["task-1", "recorded problem"],
			["task-4", expect.stringContaining("4 levels deep")],
			["task-6", expect.stringContaining("TASK-5 is not linked")],
		]);
	});

	it("shows a task's parent and subtasks as pairs", () => {
		writeTask("task-1", { jiraKey: "PROJ-1" });
		writeTask("task-2", { jiraKey: "PROJ-2", parent: "task-1" });
		writeTask("task-3", { parent: "task-1" });

		expect(
			formatParentSection("task-1", readTaskParents(), linkedJiraKey),
		).toEqual([
			"",
			"Parent Links:",
			"-".repeat(50),
			"Parent: (none)",
			"Subtasks (2):",
			"  - TASK-2 ⇄ PROJ-2",
			"  - TASK-3",
		]);
		expect(
			formatParentSection("task-2", readTaskParents(), linkedJiraKey, "oops"),
		).toContain("⚠ Not synced: oops");
		expect(
			formatParentSection("task-9", readTaskParents(), linkedJiraKey),
		).toEqual([]);
	});
});
