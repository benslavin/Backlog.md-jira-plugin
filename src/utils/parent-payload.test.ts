import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import type { Snapshot } from "../state/types.ts";
import {
	type NormalizedPayload,
	comparePayloads,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "./normalizer.ts";
import { backlogParentValue, jiraParentValue } from "./parent-payload.ts";
import { classifySyncState } from "./sync-state.ts";

let testDir: string;
let originalCwd: string;

function writeTask(id: string, jiraKey?: string): void {
	const tasksDir = join(testDir, "backlog", "tasks");
	mkdirSync(tasksDir, { recursive: true });
	writeFileSync(
		join(tasksDir, `${id} - Task.md`),
		`---\nid: ${id.toUpperCase()}\ntitle: Task\nstatus: To Do\n${jiraKey ? `jira_key: ${jiraKey}\n` : ""}---\n`,
		"utf-8",
	);
}

const task: BacklogTask = {
	id: "task-2",
	title: "Child",
	description: "About it",
	status: "To Do",
	labels: [],
	acceptanceCriteria: [],
};

const jiraIssue = (parent?: string): JiraIssue => ({
	key: "PROJ-2",
	id: "2",
	summary: "Child",
	description: "About it",
	status: "To Do",
	issueType: "Story",
	labels: [],
	created: "",
	updated: "",
	fields: parent ? { parent: { key: parent } } : {},
});

const options = { fieldMappings: [], sprint: null, parentLinks: true };

beforeEach(() => {
	originalCwd = process.cwd();
	testDir = uniqueTestDir("parent-payload-test");
	process.chdir(testDir);
	writeJson(join(testDir, ".backlog-jira", "config.json"), {
		jira: { projectKey: "PROJ" },
	});
});

afterEach(() => {
	process.chdir(originalCwd);
	cleanupDir(testDir);
});

describe("parent payload values", () => {
	it("compares parents by linked Jira key", () => {
		writeTask("task-1", "PROJ-1");
		writeTask("task-3");
		expect(backlogParentValue("task-1")).toBe("PROJ-1");
		expect(backlogParentValue("TASK-1")).toBe("PROJ-1");
		expect(backlogParentValue("task-3")).toBe("task:task-3");
		expect(backlogParentValue(undefined)).toBe("");
		expect(jiraParentValue(jiraIssue("proj-1"))).toBe("PROJ-1");
		expect(jiraParentValue(jiraIssue())).toBe("");
	});

	it("reads an issue's fetched parent, including epic links", () => {
		expect(
			jiraParentValue({
				...jiraIssue(),
				parent: { key: "PROJ-7", via: "epicLink" },
			}),
		).toBe("PROJ-7");
	});

	it("hashes payloads without a parent as before parents were synced", () => {
		const withParentKey = normalizeBacklogTask(task, options);
		expect(withParentKey.parent).toBe("");
		const { parent: _, ...legacy } = withParentKey;
		expect(computeHash(withParentKey)).toBe(computeHash(legacy));

		writeTask("task-1", "PROJ-1");
		const child = normalizeBacklogTask({ ...task, parent: "task-1" }, options);
		expect(child.parent).toBe("PROJ-1");
		expect(computeHash(child)).not.toBe(computeHash(legacy));
		expect(computeHash(child)).toBe(
			computeHash(normalizeJiraIssue(jiraIssue("PROJ-1"), options)),
		);
		expect(comparePayloads(child, withParentKey)).toEqual(["parent"]);
	});

	it("leaves the parent out when parent links are off", () => {
		expect(
			normalizeBacklogTask(task, { ...options, parentLinks: false }),
		).not.toHaveProperty("parent");
		expect(
			normalizeJiraIssue(jiraIssue("PROJ-1"), {
				...options,
				parentLinks: false,
			}),
		).not.toHaveProperty("parent");
	});
});

describe("classification against snapshots without parents", () => {
	function legacySnapshot(
		side: "backlog" | "jira",
		payload: NormalizedPayload,
	): Snapshot {
		const { parent: _, ...legacy } = payload;
		return {
			backlogId: "task-2",
			side,
			hash: computeHash(legacy),
			payload: JSON.stringify(legacy),
			updatedAt: "",
		};
	}

	function classify(backlogParent: string, jiraParent: string, title?: string) {
		const base = normalizeBacklogTask(task, options);
		const backlog = {
			...base,
			parent: backlogParent,
			...(title ? { title } : {}),
		};
		const jira = { ...base, parent: jiraParent };
		return classifySyncState(
			computeHash(backlog),
			computeHash(jira),
			legacySnapshot("backlog", base),
			legacySnapshot("jira", base),
			{ backlog, jira },
			{ fieldMappings: [], sprintMapping: null },
		).state;
	}

	it("sees matching parents as in sync", () => {
		expect(classify("", "")).toBe("InSync");
		expect(classify("PROJ-1", "PROJ-1")).toBe("InSync");
	});

	it("counts a parent on one side only as a change on that side", () => {
		expect(classify("PROJ-1", "")).toBe("NeedsPush");
		expect(classify("", "PROJ-1")).toBe("NeedsPull");
		expect(classify("PROJ-1", "PROJ-7")).toBe("Conflict");
	});

	it("still detects other changes", () => {
		expect(classify("PROJ-1", "PROJ-1", "Renamed")).toBe("NeedsPush");
		expect(classify("", "PROJ-1", "Renamed")).toBe("Conflict");
	});
});

describe("BacklogClient task detail", () => {
	it("reads the parent task ID from the Parent line", () => {
		const parse = (
			new BacklogClient() as unknown as {
				parseTaskDetail: (output: string) => BacklogTask;
			}
		).parseTaskDetail;
		const parsed = parse.call(
			new BacklogClient(),
			"Task TASK-1.1 - Child\n==========\n\nStatus: ○ To Do\nParent: TASK-1 - Parent one\n",
		);
		expect(parsed.parent).toBe("task-1");
	});
});
