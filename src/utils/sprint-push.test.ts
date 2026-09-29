import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import type { JiraSprint } from "../integrations/jira-sprints.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import type { SprintMapping } from "./field-mapping.ts";
import {
	MappedFieldPushError,
	formatMappedFieldFailures,
} from "./mapped-field-sync.ts";
import {
	type SprintPushContext,
	createSprintPushContext,
	isSubtaskIssue,
	pushTaskSprint,
	sprintNeedsPush,
} from "./sprint-push.ts";
import { readTaskLink, writeTaskLink } from "./task-links.ts";

const SPRINT_FIELD = "customfield_10020";

function sprintMapping(overrides: Partial<SprintMapping> = {}): SprintMapping {
	return {
		backlog: "milestone",
		jira: "sprint",
		type: "sprint",
		direction: "push",
		boardId: "5",
		createSprints: false,
		archiveClosedSprints: true,
		pullScope: "all",
		...overrides,
	};
}

const CLOSED: JiraSprint = {
	id: "1",
	name: "Sprint 1",
	state: "closed",
	completeDate: "2026-09-14T18:00:00.000Z",
};
const ACTIVE: JiraSprint = { id: "2", name: "Sprint 2", state: "active" };
const FUTURE: JiraSprint = { id: "3", name: "Sprint 3", state: "future" };

function issue(
	sprints: JiraSprint[] = [],
	overrides: Partial<JiraIssue> = {},
): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Issue",
		status: "To Do",
		issueType: "Task",
		created: "",
		updated: "",
		fields: { [SPRINT_FIELD]: { value: sprints, name: "Sprint" } },
		...overrides,
	};
}

describe("isSubtaskIssue", () => {
	it("recognises subtasks by name or issue type flags", () => {
		expect(isSubtaskIssue(issue([], { issueType: "Sub-task" }))).toBe(true);
		expect(isSubtaskIssue(issue([], { issueType: "Subtask" }))).toBe(true);
		expect(
			isSubtaskIssue(
				issue([], {
					issueType: "Teilaufgabe",
					fields: { issuetype: { name: "Teilaufgabe", subtask: true } },
				}),
			),
		).toBe(true);
		expect(
			isSubtaskIssue(
				issue([], {
					issueType: "Child",
					fields: { issue_type: { name: "Child", hierarchyLevel: -1 } },
				}),
			),
		).toBe(true);
		expect(isSubtaskIssue(issue([], { issueType: "Story" }))).toBe(false);
	});
});

describe("createSprintPushContext", () => {
	const jira = {
		getSprintFieldId: async () => SPRINT_FIELD,
		includeIssueFields: () => {},
		getBoardSprints: async () => [],
		moveIssueToSprint: async () => {},
		moveIssueToBacklog: async () => {},
		createSprint: async () => ACTIVE,
	};

	it("is disabled for pull-only or missing sprint mappings", async () => {
		expect(
			await createSprintPushContext(sprintMapping({ direction: "pull" }), jira),
		).toBeNull();
		expect(await createSprintPushContext(null, jira)).toBeNull();
	});

	it("fails without a Sprint field", async () => {
		await expect(
			createSprintPushContext(sprintMapping(), {
				...jira,
				getSprintFieldId: async () => null,
			}),
		).rejects.toThrow("no Sprint field");
	});
});

describe("formatMappedFieldFailures for sprints", () => {
	it("names the sprint mapping with a sprint-specific hint", () => {
		const message = formatMappedFieldFailures("PROJ-1", [
			{ mapping: sprintMapping(), error: "sprint closed" },
		]);
		expect(message).toContain("sprint (mapped to milestone): sprint closed");
		expect(message).toContain("future or active sprint");
		expect(message).not.toContain("edit screen");
	});
});

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBacklogCli)("sprint push with the Backlog CLI", () => {
	let testDir: string;
	let originalCwd: string;
	let boardSprints: JiraSprint[];
	let jira: {
		getSprintFieldId: () => Promise<string>;
		includeIssueFields: () => void;
		getBoardSprints: ReturnType<typeof mock>;
		moveIssueToSprint: ReturnType<typeof mock>;
		moveIssueToBacklog: ReturnType<typeof mock>;
		createSprint: ReturnType<typeof mock>;
	};

	function backlog(...args: string[]): string {
		const result = spawnSync("backlog", args, { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	function addMilestone(title: string, ...args: string[]): string {
		const output = backlog("milestone", "add", ...args, "--", title);
		const id = output.match(/\((m-\d+)\)/)?.[1];
		if (!id) throw new Error(output);
		return id;
	}

	function setMilestone(taskId: string, milestoneId: string | null): void {
		if (milestoneId)
			backlog("task", "edit", taskId, "--milestone", milestoneId);
		else backlog("task", "edit", taskId, "--clear-milestone");
	}

	function register(sprint: JiraSprint, milestoneId: string): void {
		const registry = SprintRegistry.load(testDir);
		registry.upsert(sprint, milestoneId);
		registry.save();
	}

	async function context(
		overrides: Partial<SprintMapping> = {},
		dryRun = false,
	): Promise<SprintPushContext> {
		const ctx = await createSprintPushContext(
			sprintMapping(overrides),
			jira as never,
			{ dryRun },
		);
		if (!ctx) throw new Error("no context");
		return ctx;
	}

	beforeEach(() => {
		testDir = uniqueTestDir("sprint-push-cli");
		originalCwd = process.cwd();
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlog("init", "sprint-push", "--defaults", "--integration-mode", "none");
		backlog("task", "create", "One");
		backlog("task", "create", "Two");
		boardSprints = [CLOSED, ACTIVE, FUTURE];
		let created = 100;
		jira = {
			getSprintFieldId: async () => SPRINT_FIELD,
			includeIssueFields: () => {},
			getBoardSprints: mock(async () => boardSprints),
			moveIssueToSprint: mock(async () => {}),
			moveIssueToBacklog: mock(async () => {}),
			createSprint: mock(
				async (
					_board: string,
					s: { name: string; endDate?: string; goal?: string },
				): Promise<JiraSprint> => ({
					id: String(++created),
					name: s.name,
					state: "future",
					...(s.endDate ? { endDate: s.endDate } : {}),
					...(s.goal ? { goal: s.goal } : {}),
				}),
			),
		};
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("moves the issue into the sprint registered for the milestone", async () => {
		const id = addMilestone("Renamed locally");
		register(FUTURE, id);
		setMilestone("task-1", id);

		const result = await pushTaskSprint(
			await context(),
			"task-1",
			issue([ACTIVE]),
		);

		expect(result).toEqual({ status: "moved", sprintId: "3" });
		expect(jira.moveIssueToSprint).toHaveBeenCalledWith("PROJ-1", "3");
		expect(readTaskLink("task-1")?.sprintSync).toEqual({
			sprintId: "3",
			milestoneId: id,
		});
	});

	it("matches an unregistered milestone to an open sprint by name, preferring the active one", async () => {
		boardSprints = [
			CLOSED,
			{ id: "7", name: "Sprint 2", state: "future" },
			ACTIVE,
		];
		const id = addMilestone("sprint 2");
		setMilestone("task-1", id);

		const result = await pushTaskSprint(await context(), "task-1", issue());

		expect(result).toEqual({ status: "moved", sprintId: "2" });
		expect(SprintRegistry.load(testDir).get("2")?.milestoneId).toBe(id);
	});

	it("leaves an issue alone when it is already in the sprint", async () => {
		const id = addMilestone("Sprint 2");
		setMilestone("task-1", id);
		const result = await pushTaskSprint(
			await context(),
			"task-1",
			issue([CLOSED, ACTIVE]),
		);
		expect(result).toEqual({ status: "unchanged", sprintId: "2" });
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();
	});

	it("moves an issue in an open sprint back to the backlog when the milestone is cleared", async () => {
		const result = await pushTaskSprint(
			await context(),
			"task-1",
			issue([CLOSED, ACTIVE]),
		);
		expect(result).toEqual({ status: "moved", sprintId: null });
		expect(jira.moveIssueToBacklog).toHaveBeenCalledWith("PROJ-1");
		// The issue now shows its last completed sprint
		expect(readTaskLink("task-1")?.sprintSync).toEqual({
			sprintId: "1",
			milestoneId: null,
		});

		const notInSprint = await pushTaskSprint(
			await context(),
			"task-2",
			issue([CLOSED]),
		);
		expect(notInSprint).toEqual({ status: "unchanged", sprintId: null });
		expect(jira.moveIssueToBacklog).toHaveBeenCalledTimes(1);
	});

	it("refuses to target a closed sprint unless it is already the issue's sprint", async () => {
		const id = addMilestone("Sprint 1");
		register(CLOSED, id);
		setMilestone("task-1", id);
		setMilestone("task-2", id);

		const refused = await pushTaskSprint(
			await context(),
			"task-1",
			issue([ACTIVE]),
		);
		expect(refused.status).toBe("failed");
		expect(refused.reason).toContain('sprint "Sprint 1" is closed');
		expect(readTaskLink("task-1")?.sprintSync).toBeUndefined();

		const kept = await pushTaskSprint(
			await context(),
			"task-2",
			issue([CLOSED]),
		);
		expect(kept).toEqual({ status: "unchanged", sprintId: "1" });
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();
	});

	it("reports an unmatched milestone when createSprints is off", async () => {
		const id = addMilestone("Someday");
		setMilestone("task-1", id);

		const result = await pushTaskSprint(
			await context(),
			"task-1",
			issue([ACTIVE]),
		);

		expect(result.status).toBe("failed");
		expect(result.reason).toContain(
			'milestone "Someday" matches no future or active sprint on board 5',
		);
		expect(jira.createSprint).not.toHaveBeenCalled();
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();
	});

	it("creates, registers and assigns one sprint per milestone when createSprints is on", async () => {
		const id = addMilestone(
			"Sprint 9",
			"--due-date=2026-12-18",
			"--description=Ship the thing",
		);
		setMilestone("task-1", id);
		setMilestone("task-2", id);
		const ctx = await context({ createSprints: true });

		const results = await Promise.all([
			pushTaskSprint(ctx, "task-1", issue()),
			pushTaskSprint(ctx, "task-2", { ...issue(), key: "PROJ-2" }),
		]);

		expect(jira.createSprint).toHaveBeenCalledTimes(1);
		expect(jira.createSprint).toHaveBeenCalledWith("5", {
			name: "Sprint 9",
			endDate: "2026-12-18T23:59:59.000Z",
			goal: "Ship the thing",
		});
		expect(results).toEqual([
			{ status: "moved", sprintId: "101" },
			{ status: "moved", sprintId: "101" },
		]);
		expect(SprintRegistry.load(testDir).get("101")).toMatchObject({
			milestoneId: id,
			name: "Sprint 9",
			state: "future",
		});
		expect(jira.moveIssueToSprint).toHaveBeenCalledWith("PROJ-2", "101");
	});

	it("does not send Backlog's default milestone description as a sprint goal", async () => {
		const id = addMilestone("Sprint 10");
		expect(new MilestoneAdapter({ cwd: testDir }).get(id)?.description).toBe(
			"Milestone: Sprint 10",
		);
		setMilestone("task-1", id);
		await pushTaskSprint(
			await context({ createSprints: true }),
			"task-1",
			issue(),
		);
		expect(jira.createSprint).toHaveBeenCalledWith("5", {
			name: "Sprint 10",
			endDate: undefined,
			goal: undefined,
		});
	});

	it("reports sprint creation errors as failures", async () => {
		jira.createSprint = mock(async () => {
			throw new Error("end date must be after its start date");
		});
		const id = addMilestone("Sprint 11");
		setMilestone("task-1", id);
		const result = await pushTaskSprint(
			await context({ createSprints: true }),
			"task-1",
			issue(),
		);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("could not create sprint");
	});

	it("skips subtasks", async () => {
		const id = addMilestone("Sprint 2");
		setMilestone("task-1", id);
		const result = await pushTaskSprint(
			await context(),
			"task-1",
			issue([], { issueType: "Sub-task" }),
		);
		expect(result.status).toBe("skipped");
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();
	});

	it("pushes only Backlog-side milestone changes when syncing both ways", async () => {
		const id = addMilestone("Sprint 3");
		setMilestone("task-1", id);
		writeTaskLink("task-1", { sprintSync: { sprintId: "2", milestoneId: id } });

		// Jira moved the issue; the milestone is unchanged since the last sync
		const unchanged = await pushTaskSprint(
			await context({ direction: "both" }),
			"task-1",
			issue([ACTIVE]),
		);
		expect(unchanged).toEqual({ status: "unchanged" });
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();

		const other = addMilestone("Sprint 2");
		setMilestone("task-1", other);
		const moved = await pushTaskSprint(
			await context({ direction: "both" }),
			"task-1",
			issue([FUTURE]),
		);
		expect(moved).toEqual({ status: "moved", sprintId: "2" });
	});

	it("knows when a milestone changed since the last sprint sync", () => {
		expect(sprintNeedsPush("task-1")).toBe(false);
		const id = addMilestone("Sprint 2");
		setMilestone("task-1", id);
		expect(sprintNeedsPush("task-1")).toBe(true);
		writeTaskLink("task-1", { sprintSync: { sprintId: "2", milestoneId: id } });
		expect(sprintNeedsPush("task-1")).toBe(false);
		setMilestone("task-1", null);
		expect(sprintNeedsPush("task-1")).toBe(true);
	});

	it("changes nothing in a dry run", async () => {
		const id = addMilestone("Sprint 12");
		setMilestone("task-1", id);
		const result = await pushTaskSprint(
			await context({ createSprints: true }, true),
			"task-1",
			issue(),
		);
		expect(result.status).toBe("moved");
		expect(jira.createSprint).not.toHaveBeenCalled();
		expect(jira.moveIssueToSprint).not.toHaveBeenCalled();
		expect(SprintRegistry.load(testDir).list()).toEqual([]);
		expect(readTaskLink("task-1")).toBeNull();
	});

	it("builds a push error naming the sprint mapping", () => {
		const error = new MappedFieldPushError("PROJ-1", [
			{ mapping: sprintMapping(), error: "no sprint" },
		]);
		expect(error.message).toContain("sprint (mapped to milestone)");
	});
});
