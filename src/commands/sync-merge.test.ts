import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue, JiraTransition } from "../integrations/jira.ts";
import type { Snapshot } from "../state/types.ts";
import type { FieldMapping } from "../utils/field-mapping.ts";
import type { MappedFieldState } from "../utils/mapped-field-sync.ts";
import {
	type NormalizedPayload,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "../utils/normalizer.ts";
import { classifySyncState } from "../utils/sync-state.ts";
import {
	detectBuiltinFieldConflicts,
	planBuiltinFieldMerge,
} from "./sync-merge.ts";
import { applyFieldResolutions } from "./sync.ts";

const baseTask: BacklogTask = {
	id: "task-1",
	title: "Original title",
	description: "Original description",
	status: "To Do",
	assignee: "@alice",
	priority: "medium",
	labels: ["backend"],
	acceptanceCriteria: [{ index: 1, text: "Works", checked: false }],
};

const baseIssue: JiraIssue = {
	key: "PROJ-1",
	id: "10001",
	summary: "Original title",
	description: "Original description\n\nAcceptance Criteria:\n- [ ] Works",
	status: "To Do",
	issueType: "Task",
	assignee: "Alice Smith",
	priority: "Medium",
	labels: ["backend"],
	created: "",
	updated: "",
};

const transitions: JiraTransition[] = [
	{ id: "11", name: "To Do", to: { id: "1", name: "To Do" } },
	{ id: "21", name: "Start", to: { id: "3", name: "In Progress" } },
	{ id: "31", name: "Finish", to: { id: "5", name: "Done" } },
];

/** In-memory Backlog task edited like the Backlog CLI would */
function fakeBacklog(initial: BacklogTask) {
	let task = structuredClone(initial);
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		get task() {
			return task;
		},
		async getTask() {
			return structuredClone(task);
		},
		async updateTask(_id: string, updates: Record<string, unknown>) {
			calls.push(updates);
			const next = { ...task };
			for (const key of [
				"title",
				"description",
				"status",
				"assignee",
				"priority",
				"labels",
			] as const) {
				if (updates[key] !== undefined) {
					(next as Record<string, unknown>)[key] = updates[key];
				}
			}
			// Removals, then additions, then (re)checks, as the Backlog CLI does
			let criteria = [...(next.acceptanceCriteria ?? [])];
			for (const index of (updates.removeAc as number[]) ?? []) {
				criteria = criteria.filter((ac) => ac.index !== index);
			}
			for (const text of (updates.addAc as string[]) ?? []) {
				criteria.push({ index: 0, text, checked: false });
			}
			criteria = criteria.map((ac, i) => ({ ...ac, index: i + 1 }));
			for (const index of (updates.checkAc as number[]) ?? []) {
				criteria = criteria.map((ac) =>
					ac.index === index ? { ...ac, checked: true } : ac,
				);
			}
			for (const index of (updates.uncheckAc as number[]) ?? []) {
				criteria = criteria.map((ac) =>
					ac.index === index ? { ...ac, checked: false } : ac,
				);
			}
			next.acceptanceCriteria = criteria;
			task = next;
		},
	};
}

/** In-memory Jira issue with a simple workflow */
function fakeJira(initial: JiraIssue) {
	let issue = structuredClone(initial);
	const updates: Array<Record<string, unknown>> = [];
	const transitioned: string[] = [];
	return {
		updates,
		transitioned,
		get issue() {
			return issue;
		},
		async getIssue() {
			return structuredClone(issue);
		},
		async updateIssue(_key: string, fields: Record<string, unknown>) {
			updates.push(fields);
			issue = { ...issue, ...fields } as JiraIssue;
		},
		async getTransitions() {
			return transitions;
		},
		async transitionIssue(_key: string, id: string) {
			transitioned.push(id);
			const target = transitions.find((t) => t.id === id);
			if (target) issue = { ...issue, status: target.to.name };
		},
	};
}

function fakeStore() {
	const snapshots: Record<string, Snapshot> = {};
	return {
		snapshots,
		getMapping() {
			return null;
		},
		setSnapshot(
			backlogId: string,
			side: "backlog" | "jira",
			hash: string,
			payload: unknown,
		) {
			snapshots[side] = {
				backlogId,
				side,
				hash,
				payload: JSON.stringify(payload),
				updatedAt: new Date().toISOString(),
			};
		},
		updateSyncState() {},
	};
}

function payloads(
	task: BacklogTask,
	issue: JiraIssue,
	fieldMappings: FieldMapping[] = [],
) {
	return {
		backlog: normalizeBacklogTask(task, { fieldMappings, frontmatter: {} }),
		jira: normalizeJiraIssue(issue, { fieldMappings }),
	};
}

/** Conflict state: both sides edited since they were synced at the base */
function conflictState(
	task: BacklogTask,
	issue: JiraIssue,
	fieldMappings: FieldMapping[] = [],
): MappedFieldState {
	const base = payloads(baseTask, baseIssue, fieldMappings);
	return {
		current: payloads(task, issue, fieldMappings),
		base: { backlog: base.backlog, jira: base.jira },
		frontmatter: {},
		issue,
	};
}

type Resolution = Parameters<typeof applyFieldResolutions>[2][number];

/** Resolve a conflict between the edited task and issue */
async function resolve(
	task: BacklogTask,
	issue: JiraIssue,
	resolutions: Resolution[] = [],
) {
	const backlog = fakeBacklog(task);
	const jira = fakeJira(issue);
	const store = fakeStore();
	await applyFieldResolutions("task-1", "PROJ-1", resolutions, {
		backlog,
		jira,
		store,
		fieldMappings: [],
		backlogTask: task,
		mappedState: conflictState(task, issue),
	});
	return { backlog, jira, store };
}

function stateAfter(result: Awaited<ReturnType<typeof resolve>>) {
	const current = payloads(result.backlog.task, result.jira.issue);
	return classifySyncState(
		computeHash(current.backlog),
		computeHash(current.jira),
		result.store.snapshots.backlog,
		result.store.snapshots.jira,
		current,
		{ fieldMappings: [] },
	).state;
}

let testDir: string;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	testDir = uniqueTestDir("sync-merge-test");
	writeJson(join(testDir, ".backlog-jira", "config.json"), {
		jira: { projectKey: "PROJ" },
		backlog: {
			assigneeMapping: { alice: "Alice Smith", bob: "Bob Jones" },
		},
	});
	process.chdir(testDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	cleanupDir(testDir);
});

describe("detectBuiltinFieldConflicts", () => {
	it("reports only fields changed on both sides to different values", () => {
		const task = {
			...baseTask,
			title: "Backlog title",
			status: "In Progress",
			labels: ["backend", "api"],
		};
		const issue = {
			...baseIssue,
			summary: "Jira title",
			status: "In Progress",
			priority: "High",
		};
		const conflicts = detectBuiltinFieldConflicts(
			conflictState(task, issue),
			task,
		);
		expect(conflicts).toEqual([
			{
				field: "title/summary",
				backlogValue: "Backlog title",
				jiraValue: "Jira title",
				baseValue: "Original title",
			},
		]);
	});

	it("compares descriptions without Jira's acceptance criteria section", () => {
		// Jira checked a criterion; Backlog edited the description
		const task = { ...baseTask, description: "New description" };
		const issue = {
			...baseIssue,
			description: "Original description\n\nAcceptance Criteria:\n- [x] Works",
		};
		expect(
			detectBuiltinFieldConflicts(conflictState(task, issue), task),
		).toEqual([]);
	});

	it("reports acceptance criteria changed on both sides", () => {
		const task = {
			...baseTask,
			acceptanceCriteria: [{ index: 1, text: "Works", checked: true }],
		};
		const issue = {
			...baseIssue,
			description:
				"Original description\n\nAcceptance Criteria:\n- [ ] Works well",
		};
		const [conflict] = detectBuiltinFieldConflicts(
			conflictState(task, issue),
			task,
		);
		expect(conflict).toMatchObject({
			field: "acceptanceCriteria",
			backlogValue: ["[x] Works"],
			jiraValue: ["[ ] Works well"],
			baseValue: ["[ ] Works"],
		});
	});

	it("leaves priority to a field mapping that carries it", () => {
		const mappings: FieldMapping[] = [
			{
				backlog: "priority",
				jira: "customfield_10020",
				type: "option",
				direction: "both",
			},
		];
		const task = { ...baseTask, priority: "high" };
		const issue = { ...baseIssue, priority: "Low" };
		const state = conflictState(task, issue, mappings);
		expect(detectBuiltinFieldConflicts(state, task, mappings)).toEqual([]);
		expect(planBuiltinFieldMerge(state, mappings, [])).toEqual([]);
	});
});

describe("planBuiltinFieldMerge", () => {
	it("takes the changed side for one-sided changes and the choice for conflicts", () => {
		const task = { ...baseTask, title: "Backlog title", labels: ["api"] };
		const issue = { ...baseIssue, summary: "Jira title", status: "Done" };
		const plan = planBuiltinFieldMerge(
			conflictState(task, issue),
			[],
			[{ field: "title/summary", source: "jira", value: "Jira title" }],
		);
		expect(plan).toEqual([
			{ field: "title", source: "jira", value: "Jira title" },
			{ field: "status", source: "jira" },
			{ field: "labels", source: "backlog" },
		]);
	});

	it("skips fields edited to the same value on both sides", () => {
		const task = { ...baseTask, status: "Done" };
		const issue = { ...baseIssue, status: "Done" };
		expect(planBuiltinFieldMerge(conflictState(task, issue), [], [])).toEqual(
			[],
		);
	});
});

describe("applyFieldResolutions", () => {
	it("propagates built-in fields changed on only one side", async () => {
		const task = { ...baseTask, title: "Renamed in Backlog", priority: "high" };
		const issue = { ...baseIssue, status: "In Progress", labels: ["ops"] };

		const result = await resolve(task, issue);

		expect(result.jira.issue.summary).toBe("Renamed in Backlog");
		expect(result.jira.issue.priority).toBe("High");
		expect(result.backlog.task.status).toBe("In Progress");
		expect(result.backlog.task.labels).toEqual(["ops"]);
		// Neither side's one-sided edit is overwritten by the other side
		expect(result.backlog.task.title).toBe("Renamed in Backlog");
		expect(result.jira.issue.status).toBe("In Progress");
		expect(result.jira.transitioned).toEqual([]);
		expect(stateAfter(result)).toBe("InSync");
	});

	it("keeps every choice when different sources win different fields", async () => {
		const task = {
			...baseTask,
			title: "Backlog title",
			status: "Done",
			assignee: "@bob",
		};
		const issue = {
			...baseIssue,
			summary: "Jira title",
			status: "In Progress",
			labels: ["frontend"],
		};

		const result = await resolve(task, issue, [
			{ field: "title/summary", source: "jira", value: "Jira title" },
			{ field: "status", source: "backlog", value: "Done" },
		]);

		// Jira's title and Backlog's status both survive
		expect(result.backlog.task.title).toBe("Jira title");
		expect(result.jira.issue.summary).toBe("Jira title");
		expect(result.jira.issue.status).toBe("Done");
		expect(result.backlog.task.status).toBe("Done");
		expect(result.jira.transitioned).toEqual(["31"]);
		// One-sided changes still propagate alongside the choices
		expect(result.jira.issue.assignee).toBe("Bob Jones");
		expect(result.backlog.task.labels).toEqual(["frontend"]);
		// Backlog is not rewritten with Jira's status, nor Jira with Backlog's title
		expect(result.backlog.calls).toEqual([
			{ title: "Jira title", labels: ["frontend"] },
		]);
		expect(result.jira.updates).toEqual([{ assignee: "Bob Jones" }]);
		expect(stateAfter(result)).toBe("InSync");
	});

	it("writes manually entered values to both sides", async () => {
		const task = { ...baseTask, title: "Backlog title", labels: ["a"] };
		const issue = { ...baseIssue, summary: "Jira title", labels: ["b"] };

		const result = await resolve(task, issue, [
			{ field: "title/summary", source: "manual", value: "Agreed title" },
			{ field: "labels", source: "manual", value: "a, b" },
		]);

		expect(result.backlog.task.title).toBe("Agreed title");
		expect(result.jira.issue.summary).toBe("Agreed title");
		expect(result.backlog.task.labels).toEqual(["a", "b"]);
		expect(result.jira.issue.labels).toEqual(["a", "b"]);
		expect(stateAfter(result)).toBe("InSync");
	});

	it("combines a Jira description with Backlog acceptance criteria", async () => {
		const task = {
			...baseTask,
			acceptanceCriteria: [{ index: 1, text: "Works", checked: true }],
		};
		const issue = {
			...baseIssue,
			description: "Jira description\n\nAcceptance Criteria:\n- [ ] Works",
		};

		const result = await resolve(task, issue);

		expect(result.backlog.task.description).toBe("Jira description");
		expect(result.backlog.task.acceptanceCriteria).toEqual([
			{ index: 1, text: "Works", checked: true },
		]);
		expect(result.jira.issue.description).toBe(
			"Jira description\n\nAcceptance Criteria:\n- [x] Works",
		);
		expect(stateAfter(result)).toBe("InSync");
	});

	it("pulls acceptance criteria changed only in Jira", async () => {
		const task = { ...baseTask, title: "Renamed" };
		const issue = {
			...baseIssue,
			description:
				"Original description\n\nAcceptance Criteria:\n- [x] Works\n- [ ] Is fast",
		};

		const result = await resolve(task, issue);

		expect(result.backlog.task.acceptanceCriteria).toEqual([
			{ index: 1, text: "Works", checked: true },
			{ index: 2, text: "Is fast", checked: false },
		]);
		expect(result.jira.issue.summary).toBe("Renamed");
		expect(result.jira.issue.description).toBe(issue.description);
		expect(stateAfter(result)).toBe("InSync");
	});

	it("records snapshots that classify the merged task as InSync", async () => {
		const task = { ...baseTask, title: "Backlog title" };
		const issue = { ...baseIssue, summary: "Jira title" };

		const result = await resolve(task, issue, [
			{ field: "title/summary", source: "backlog", value: "Backlog title" },
		]);

		const stored = JSON.parse(
			result.store.snapshots.backlog.payload,
		) as NormalizedPayload;
		expect(stored.title).toBe("Backlog title");
		expect(result.store.snapshots.backlog.hash).toBe(
			computeHash(payloads(result.backlog.task, result.jira.issue).backlog),
		);
		expect(stateAfter(result)).toBe("InSync");
	});
});
