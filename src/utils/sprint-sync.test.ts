import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { applyFieldResolutions } from "../commands/sync.ts";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import type { JiraSprint } from "../integrations/jira-sprints.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import type { Snapshot } from "../state/types.ts";
import type { SprintMapping } from "./field-mapping.ts";
import type { MappedFieldState } from "./mapped-field-sync.ts";
import {
	type NormalizedPayload,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "./normalizer.ts";
import {
	SPRINT_CONFLICT_FIELD,
	loadSprintPayloadSource,
} from "./sprint-payload.ts";
import {
	type SprintSyncContext,
	createSprintSyncContext,
	detectSprintConflict,
	planSprintMerge,
} from "./sprint-sync.ts";
import { classifySyncState } from "./sync-state.ts";
import { readTaskLink, writeTaskLink } from "./task-links.ts";

const SPRINT_FIELD = "customfield_10020";

const S1: JiraSprint = {
	id: "1",
	name: "Sprint 1",
	state: "closed",
	completeDate: "2026-09-14T18:00:00.000Z",
};
const S2: JiraSprint = { id: "2", name: "Sprint 2", state: "active" };
const S3: JiraSprint = { id: "3", name: "Sprint 3", state: "future" };

function sprintMapping(overrides: Partial<SprintMapping> = {}): SprintMapping {
	return {
		backlog: "milestone",
		jira: "sprint",
		type: "sprint",
		direction: "both",
		boardId: "5",
		createSprints: false,
		archiveClosedSprints: false,
		pullScope: "all",
		...overrides,
	};
}

const task: BacklogTask = {
	id: "task-1",
	title: "One",
	description: "",
	status: "To Do",
	labels: [],
	acceptanceCriteria: [],
};

function issue(sprints: JiraSprint[]): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "One",
		description: "",
		status: "To Do",
		issueType: "Task",
		labels: [],
		created: "",
		updated: "",
		fields: {
			[SPRINT_FIELD]: { value: sprints.map((s) => ({ ...s })), name: "Sprint" },
		},
	};
}

function payload(sprint: string): NormalizedPayload {
	return {
		title: "One",
		description: "",
		status: "To Do",
		labels: [],
		acceptanceCriteria: [],
		mappedFields: { milestone: sprint },
	};
}

function snapshot(
	side: "backlog" | "jira",
	p: Partial<NormalizedPayload>,
): Snapshot {
	return {
		backlogId: "task-1",
		side,
		hash: computeHash(p as NormalizedPayload),
		payload: JSON.stringify(p),
		updatedAt: new Date().toISOString(),
	};
}

function classify(
	base: string,
	backlog: string,
	jira: string,
	mapping: SprintMapping = sprintMapping(),
) {
	const current = { backlog: payload(backlog), jira: payload(jira) };
	return classifySyncState(
		computeHash(current.backlog),
		computeHash(current.jira),
		snapshot("backlog", payload(base)),
		snapshot("jira", payload(base)),
		current,
		{ fieldMappings: [], sprintMapping: mapping },
	).state;
}

describe("sprint change classification", () => {
	it("propagates a sprint change made on one side only", () => {
		expect(classify("2", "3", "2")).toBe("NeedsPush");
		expect(classify("2", "2", "3")).toBe("NeedsPull");
		expect(classify("2", "milestone:m-7", "2")).toBe("NeedsPush");
		expect(classify("2", "", "2")).toBe("NeedsPush");
	});

	it("reports a conflict when both sides changed the sprint", () => {
		expect(classify("1", "2", "3")).toBe("Conflict");
		expect(classify("2", "2", "2")).toBe("InSync");
	});

	it("honours one-way sprint mappings", () => {
		// Backlog edits of a pull-only sprint are restored from Jira
		expect(classify("2", "3", "2", sprintMapping({ direction: "pull" }))).toBe(
			"NeedsPull",
		);
		// Jira edits of a push-only sprint are restored from Backlog
		expect(classify("2", "2", "3", sprintMapping({ direction: "push" }))).toBe(
			"NeedsPush",
		);
		expect(classify("1", "2", "3", sprintMapping({ direction: "pull" }))).toBe(
			"NeedsPull",
		);
	});

	it("does not see a change when a sprint mapping is added to in-sync tasks", () => {
		const base = { ...payload(""), mappedFields: undefined };
		const current = { backlog: payload("2"), jira: payload("2") };
		expect(
			classifySyncState(
				computeHash(current.backlog),
				computeHash(current.jira),
				snapshot("backlog", base),
				snapshot("jira", base),
				current,
				{ fieldMappings: [], sprintMapping: sprintMapping() },
			).state,
		).toBe("InSync");
	});
});

describe("planSprintMerge", () => {
	function state(
		base: string,
		backlog: string,
		jira: string,
	): MappedFieldState {
		return {
			current: { backlog: payload(backlog), jira: payload(jira) },
			base: { backlog: payload(base), jira: payload(base) },
			frontmatter: {},
			issue: issue([]),
		};
	}

	it("takes the side that changed, or the chosen side on conflict", () => {
		const mapping = sprintMapping();
		expect(planSprintMerge(state("2", "3", "2"), mapping)).toBe("backlog");
		expect(planSprintMerge(state("2", "2", "3"), mapping)).toBe("jira");
		expect(planSprintMerge(state("2", "2", "2"), mapping)).toBeNull();
		expect(planSprintMerge(state("1", "2", "3"), mapping)).toBeNull();
		expect(planSprintMerge(state("1", "2", "3"), mapping, "jira")).toBe("jira");
		expect(planSprintMerge(state("1", "2", "3"), mapping, "backlog")).toBe(
			"backlog",
		);
	});

	it("uses the owner side of one-way mappings", () => {
		expect(
			planSprintMerge(
				state("1", "2", "3"),
				sprintMapping({ direction: "pull" }),
			),
		).toBe("jira");
		expect(
			planSprintMerge(
				state("1", "2", "3"),
				sprintMapping({ direction: "push" }),
				"jira",
			),
		).toBe("backlog");
	});
});

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBacklogCli)("sprint sync with the Backlog CLI", () => {
	let testDir: string;
	let originalCwd: string;
	let m1: string;
	let m2: string;
	let m3: string;
	let jiraIssue: JiraIssue;
	let moved: Array<[string, string]>;
	const backlogClient = new BacklogClient();

	function backlog(...args: string[]): string {
		const result = spawnSync("backlog", args, { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	function addMilestone(title: string): string {
		const id = backlog("milestone", "add", title).match(/\((m-\d+)\)/)?.[1];
		if (!id) throw new Error("milestone not created");
		return id;
	}

	function setMilestone(id: string | null): void {
		if (id) backlog("task", "edit", "task-1", "--milestone", id);
		else backlog("task", "edit", "task-1", "--clear-milestone");
	}

	function taskMilestone(): string | undefined {
		return backlog("task", "task-1", "--plain").match(
			/^Milestone: (.*)$/m,
		)?.[1];
	}

	const fakeJira = {
		getSprintFieldId: async () => SPRINT_FIELD,
		includeIssueFields: () => {},
		getBoardSprints: async () => [S1, S2, S3],
		moveIssueToSprint: async (key: string, sprintId: string) => {
			moved.push([key, sprintId]);
			const sprint = [S1, S2, S3].find((s) => s.id === sprintId);
			jiraIssue = issue(sprint ? [S1, sprint] : [S1]);
		},
		moveIssueToBacklog: async () => {
			jiraIssue = issue([S1]);
		},
		createSprint: async () => S3,
		getIssue: async () => structuredClone(jiraIssue),
		updateIssue: async () => {},
		getTransitions: async () => [],
		transitionIssue: async () => {},
	};

	function fakeStore() {
		const snapshots: Record<string, NormalizedPayload> = {};
		return {
			snapshots,
			getMapping: () => ({
				backlogId: "task-1",
				jiraKey: "PROJ-1",
				createdAt: "",
				updatedAt: "",
			}),
			setSnapshot: (
				_id: string,
				side: "backlog" | "jira",
				_hash: string,
				p: NormalizedPayload,
			) => {
				snapshots[side] = p;
			},
			updateSyncState: () => {},
		};
	}

	async function context(): Promise<SprintSyncContext> {
		const ctx = await createSprintSyncContext(sprintMapping(), {
			jira: fakeJira as never,
			backlog: backlogClient,
		});
		if (!ctx) throw new Error("no context");
		return ctx;
	}

	function currentState(base: string): MappedFieldState {
		const frontmatter = { milestone: taskMilestone() };
		return {
			current: {
				backlog: normalizeBacklogTask(task, { fieldMappings: [], frontmatter }),
				jira: normalizeJiraIssue(jiraIssue, { fieldMappings: [] }),
			},
			base: { backlog: payload(base), jira: payload(base) },
			frontmatter,
			issue: jiraIssue,
		};
	}

	beforeEach(() => {
		testDir = uniqueTestDir("sprint-sync-cli");
		originalCwd = process.cwd();
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlog("init", "sprint-sync", "--defaults", "--integration-mode", "none");
		backlog("task", "create", "One");
		m1 = addMilestone("Sprint 1");
		m2 = addMilestone("Sprint 2");
		m3 = addMilestone("Sprint 3");
		writeJson(".backlog-jira/config.json", {
			fieldMappings: [
				{
					backlog: "milestone",
					jira: "sprint",
					type: "sprint",
					direction: "both",
					boardId: 5,
				},
			],
		});
		const registry = SprintRegistry.load(testDir);
		registry.sprintFieldId = SPRINT_FIELD;
		registry.upsert(S1, m1);
		registry.upsert(S2, m2);
		registry.upsert(S3, m3);
		registry.save();
		jiraIssue = issue([S1, S2]);
		moved = [];
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("records the displayed sprint by Jira sprint id on both sides", () => {
		setMilestone(m2);
		const backlogPayload = normalizeBacklogTask(task);
		const jiraPayload = normalizeJiraIssue(jiraIssue);
		expect(backlogPayload.mappedFields).toEqual({ milestone: "2" });
		expect(jiraPayload.mappedFields).toEqual({ milestone: "2" });
		expect(computeHash(backlogPayload)).toBe(computeHash(jiraPayload));

		expect(normalizeJiraIssue(issue([S1])).mappedFields).toEqual({
			milestone: "1",
		});
		expect(normalizeJiraIssue(issue([])).mappedFields).toEqual({
			milestone: "",
		});
	});

	it("represents milestones without a sprint distinctly", () => {
		const local = addMilestone("Someday");
		setMilestone(local);
		expect(normalizeBacklogTask(task).mappedFields).toEqual({
			milestone: `milestone:${local}`,
		});
		setMilestone(null);
		expect(normalizeBacklogTask(task).mappedFields).toEqual({ milestone: "" });
	});

	it("does not treat a sprint rename in Jira as a change on either side", async () => {
		setMilestone(m2);
		const before = {
			backlog: computeHash(normalizeBacklogTask(task)),
			jira: computeHash(normalizeJiraIssue(jiraIssue)),
		};

		const renamed = { ...S2, name: "Sprint 2 (extended)" };
		jiraIssue = issue([S1, renamed]);
		await new MilestoneAdapter({ cwd: testDir }).rename(m2, renamed.name);

		expect(computeHash(normalizeBacklogTask(task))).toBe(before.backlog);
		expect(computeHash(normalizeJiraIssue(jiraIssue))).toBe(before.jira);
	});

	it("leaves payloads unchanged without sprint sync", () => {
		setMilestone(m2);
		expect(
			normalizeBacklogTask(task, { fieldMappings: [], sprint: null })
				.mappedFields,
		).toBeUndefined();
		expect(
			normalizeJiraIssue(jiraIssue, { fieldMappings: [], sprint: null })
				.mappedFields,
		).toBeUndefined();
	});

	it("loads the payload source only once the Sprint field is known", () => {
		expect(loadSprintPayloadSource(testDir)?.sprintFieldId).toBe(SPRINT_FIELD);
		const registry = SprintRegistry.load(testDir);
		registry.sprintFieldId = null;
		registry.save();
		expect(loadSprintPayloadSource(testDir)).toBeNull();
	});

	it("describes a sprint conflict with milestone and sprint names", async () => {
		setMilestone(m3);
		jiraIssue = issue([S1, S2]);
		// Base: both sides were in sprint 1; Backlog chose Sprint 3, Jira Sprint 2
		const conflict = detectSprintConflict(currentState("1"), await context());
		expect(conflict).toEqual({
			field: SPRINT_CONFLICT_FIELD,
			backlogValue: "Sprint 3 → Sprint 3 (sprint 3)",
			jiraValue: "Sprint 2 (sprint 2, active)",
			baseValue: "Sprint 1 (sprint 1)",
		});
		expect(detectSprintConflict(currentState("2"), await context())).toBeNull();
	});

	it("resolves a sprint conflict for Jira by setting the milestone", async () => {
		setMilestone(m3);
		writeTaskLink("task-1", { sprintSync: { sprintId: "1", milestoneId: m1 } });
		const store = fakeStore();

		await applyFieldResolutions(
			"task-1",
			"PROJ-1",
			[{ field: SPRINT_CONFLICT_FIELD, source: "jira", value: null }],
			{
				backlog: backlogClient,
				jira: fakeJira,
				store,
				sprints: await context(),
				mappedState: currentState("1"),
			},
		);

		expect(taskMilestone()).toBe(m2);
		expect(moved).toEqual([]);
		expect(store.snapshots.backlog.mappedFields?.milestone).toBe("2");
		expect(store.snapshots.jira.mappedFields?.milestone).toBe("2");
	});

	it("resolves a sprint conflict for Backlog by moving the issue", async () => {
		setMilestone(m3);
		// The last sync saw the same Backlog milestone: only force pushes it
		writeTaskLink("task-1", { sprintSync: { sprintId: "1", milestoneId: m3 } });
		const store = fakeStore();

		await applyFieldResolutions(
			"task-1",
			"PROJ-1",
			[{ field: SPRINT_CONFLICT_FIELD, source: "backlog", value: null }],
			{
				backlog: backlogClient,
				jira: fakeJira,
				store,
				sprints: await context(),
				mappedState: currentState("1"),
			},
		);

		expect(moved).toEqual([["PROJ-1", "3"]]);
		expect(taskMilestone()).toBe(m3);
		expect(store.snapshots.jira.mappedFields?.milestone).toBe("3");
		expect(readTaskLink("task-1")?.sprintSync).toEqual({
			sprintId: "3",
			milestoneId: m3,
		});
	});

	it("merges a one-sided sprint change while resolving other fields", async () => {
		// Only Jira moved the issue (sprint 2 → 3); Backlog still shows Sprint 2
		setMilestone(m2);
		jiraIssue = issue([S1, S3]);
		const store = fakeStore();

		await applyFieldResolutions("task-1", "PROJ-1", [], {
			backlog: backlogClient,
			jira: fakeJira,
			store,
			sprints: await context(),
			mappedState: currentState("2"),
		});

		expect(taskMilestone()).toBe(m3);
		expect(moved).toEqual([]);
		expect(store.snapshots.backlog.mappedFields?.milestone).toBe("3");
	});

	it("shares one registry between parallel pull and push", async () => {
		const ctx = await context();
		expect(ctx.pull?.registry).toBe(ctx.registry);
		expect(ctx.push?.registry).toBe(ctx.registry);
	});
});
