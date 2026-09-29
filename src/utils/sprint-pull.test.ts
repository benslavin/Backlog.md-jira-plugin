import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import { BacklogClient } from "../integrations/backlog.ts";
import type { JiraSprint } from "../integrations/jira-sprints.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import type { SprintMapping } from "./field-mapping.ts";
import {
	type SprintPullContext,
	applySprintPullScope,
	createSprintPullContext,
	pullTaskSprint,
	refreshRegisteredSprints,
	selectDisplayedSprint,
	sprintDueDate,
	sprintNeedsPull,
} from "./sprint-pull.ts";
import { readTaskLink } from "./task-links.ts";

const SPRINT_FIELD = "customfield_10020";

function sprintMapping(overrides: Partial<SprintMapping> = {}): SprintMapping {
	return {
		backlog: "milestone",
		jira: "sprint",
		type: "sprint",
		direction: "pull",
		boardId: "5",
		createSprints: false,
		archiveClosedSprints: true,
		pullScope: "all",
		...overrides,
	};
}

const S1: JiraSprint = {
	id: "1",
	name: "Sprint 1",
	state: "closed",
	startDate: "2026-09-01T09:00:00.000Z",
	endDate: "2026-09-14T17:00:00.000Z",
	completeDate: "2026-09-14T18:00:00.000Z",
	goal: "First goal",
	boardId: "5",
};
const S2: JiraSprint = {
	id: "2",
	name: "Sprint 2",
	state: "active",
	startDate: "2026-09-15T09:00:00.000Z",
	endDate: "2026-09-28T17:00:00.000+10:00",
	goal: "Second goal",
	boardId: "5",
};
const S3: JiraSprint = { id: "3", name: "Sprint 3", state: "future" };

describe("selectDisplayedSprint", () => {
	it("prefers the open sprint, active before future", () => {
		expect(selectDisplayedSprint([S1, S3, S2])?.id).toBe("2");
		expect(selectDisplayedSprint([S1, S3])?.id).toBe("3");
	});

	it("falls back to the most recently completed sprint, else none", () => {
		const older = { ...S1, id: "0", completeDate: "2026-08-01T00:00:00Z" };
		expect(selectDisplayedSprint([S1, older])?.id).toBe("1");
		expect(selectDisplayedSprint([older, S1])?.id).toBe("1");
		expect(selectDisplayedSprint([])).toBeNull();
	});
});

describe("sprintDueDate", () => {
	it("uses the calendar date of the end date as Jira wrote it", () => {
		expect(sprintDueDate(S2)).toBe("2026-09-28");
		expect(sprintDueDate(S3)).toBeNull();
	});
});

describe("applySprintPullScope", () => {
	const open = sprintMapping({ pullScope: "open" });

	it("restricts JQL to open sprints, keeping ORDER BY last", () => {
		expect(
			applySprintPullScope(
				"project = PROJ OR labels = x ORDER BY created DESC",
				open,
			),
		).toBe(
			"(project = PROJ OR labels = x) AND sprint in openSprints() ORDER BY created DESC",
		);
		expect(applySprintPullScope("project = PROJ", open)).toBe(
			"(project = PROJ) AND sprint in openSprints()",
		);
		expect(applySprintPullScope("order by rank", open)).toBe(
			"sprint in openSprints() order by rank",
		);
	});

	it("leaves JQL alone for pullScope all or without sprint pulls", () => {
		expect(applySprintPullScope("project = PROJ", sprintMapping())).toBe(
			"project = PROJ",
		);
		expect(
			applySprintPullScope(
				"project = PROJ",
				sprintMapping({ pullScope: "open", direction: "push" }),
			),
		).toBe("project = PROJ");
		expect(applySprintPullScope("project = PROJ", null)).toBe("project = PROJ");
	});
});

describe("createSprintPullContext", () => {
	it("discovers the Sprint field and requests it on fetched issues", async () => {
		const includeIssueFields = mock((_ids: string[]) => {});
		const ctx = await createSprintPullContext(
			sprintMapping(),
			{
				jira: {
					getSprintFieldId: async () => SPRINT_FIELD,
					getBoardSprints: async () => [],
					includeIssueFields,
				},
				backlog: { updateTask: async () => {} },
			},
			{ cwd: uniqueTestDir("sprint-pull-ctx") },
		);
		expect(ctx?.sprintFieldId).toBe(SPRINT_FIELD);
		expect(includeIssueFields).toHaveBeenCalledWith([SPRINT_FIELD]);
	});

	it("is disabled for push-only mappings and fails without a Sprint field", async () => {
		const clients = {
			jira: {
				getSprintFieldId: async () => null,
				getBoardSprints: async () => [],
				includeIssueFields: () => {},
			},
			backlog: { updateTask: async () => {} },
		};
		expect(
			await createSprintPullContext(
				sprintMapping({ direction: "push" }),
				clients,
			),
		).toBeNull();
		expect(await createSprintPullContext(null, clients)).toBeNull();
		await expect(
			createSprintPullContext(sprintMapping(), clients),
		).rejects.toThrow("no Sprint field");
	});
});

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBacklogCli)("sprint pull with the Backlog CLI", () => {
	let testDir: string;
	let originalCwd: string;
	let boardSprints: JiraSprint[];
	const backlogClient = new BacklogClient();

	function backlog(...args: string[]): string {
		const result = spawnSync("backlog", args, { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	function issue(sprints: JiraSprint[] | null): JiraIssue {
		return {
			key: "PROJ-1",
			id: "10001",
			summary: "Issue",
			status: "To Do",
			issueType: "Task",
			created: "",
			updated: "",
			fields: {
				[SPRINT_FIELD]: sprints && {
					value: sprints.map((s) => ({ ...s })),
					name: "Sprint",
				},
			},
		};
	}

	async function context(
		overrides: Partial<SprintMapping> = {},
	): Promise<SprintPullContext> {
		const ctx = await createSprintPullContext(sprintMapping(overrides), {
			jira: {
				getSprintFieldId: async () => SPRINT_FIELD,
				getBoardSprints: async () => boardSprints,
				includeIssueFields: () => {},
			},
			backlog: backlogClient,
		});
		if (!ctx) throw new Error("no context");
		return ctx;
	}

	function milestones() {
		return new MilestoneAdapter({ cwd: testDir }).list();
	}

	function taskMilestone(taskId: string): string | undefined {
		return backlog("task", taskId, "--plain").match(/^Milestone: (.*)$/m)?.[1];
	}

	beforeEach(() => {
		testDir = uniqueTestDir("sprint-pull-cli");
		originalCwd = process.cwd();
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlog("init", "sprint-pull", "--defaults", "--integration-mode", "none");
		backlog("task", "create", "One");
		backlog("task", "create", "Two");
		boardSprints = [];
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("sets the milestone from the open sprint, creating it with due date and goal", async () => {
		const ctx = await context();
		const result = await pullTaskSprint(ctx, "task-1", issue([S1, S2]));

		const created = milestones().find((m) => m.title === "Sprint 2");
		expect(created).toMatchObject({
			dueDate: "2026-09-28",
			description: "Second goal",
			archived: false,
		});
		expect(result).toEqual({ milestoneId: created?.id ?? "", changed: true });
		expect(taskMilestone("task-1")).toBe(created?.id);
		// The closed sprint is only history; no milestone is made for it
		expect(milestones().map((m) => m.title)).toEqual(["Sprint 2"]);

		expect(SprintRegistry.load(testDir).get("2")).toMatchObject({
			milestoneId: created?.id,
			name: "Sprint 2",
			state: "active",
			goal: "Second goal",
		});
		expect(readTaskLink("task-1")).toMatchObject({
			sprints: [
				{
					id: "1",
					name: "Sprint 1",
					state: "closed",
					startDate: S1.startDate,
					endDate: S1.endDate,
					completeDate: S1.completeDate,
				},
				{ id: "2", name: "Sprint 2", state: "active" },
			],
			sprintSync: { sprintId: "2", milestoneId: created?.id },
		});
	});

	it("archives the milestone of a closed sprint and keeps the task pointing at it", async () => {
		const ctx = await context();
		await pullTaskSprint(ctx, "task-1", issue([S1]));

		const [archived] = milestones();
		expect(archived).toMatchObject({ title: "Sprint 1", archived: true });
		expect(taskMilestone("task-1")).toBe(archived.id);
		expect(existsSync(join(testDir, "backlog", "archive", "milestones"))).toBe(
			true,
		);
	});

	it("keeps milestones when archiveClosedSprints is false", async () => {
		const ctx = await context({ archiveClosedSprints: false });
		await pullTaskSprint(ctx, "task-1", issue([S1]));
		expect(milestones()[0]).toMatchObject({
			title: "Sprint 1",
			archived: false,
		});
	});

	it("clears the milestone when the issue leaves all sprints", async () => {
		await pullTaskSprint(await context(), "task-1", issue([S2]));
		expect(taskMilestone("task-1")).toBeDefined();

		const result = await pullTaskSprint(await context(), "task-1", issue(null));
		expect(result).toEqual({ milestoneId: null, changed: true });
		expect(taskMilestone("task-1")).toBeUndefined();
		expect(readTaskLink("task-1")?.sprints).toBeUndefined();
		expect(readTaskLink("task-1")?.sprintSync).toEqual({
			sprintId: null,
			milestoneId: null,
		});
		// Milestones are never removed
		expect(milestones()).toHaveLength(1);
	});

	it("reuses one milestone for tasks pulled in parallel", async () => {
		const ctx = await context();
		await Promise.all([
			pullTaskSprint(ctx, "task-1", issue([S2])),
			pullTaskSprint(ctx, "task-2", issue([S2])),
		]);
		expect(milestones()).toHaveLength(1);
		expect(taskMilestone("task-1")).toBe(taskMilestone("task-2"));
	});

	it("adopts an existing milestone with the sprint's title", async () => {
		backlog("milestone", "add", "Sprint 3");
		const [existing] = milestones();

		await pullTaskSprint(await context(), "task-1", issue([S3]));

		expect(milestones()).toHaveLength(1);
		expect(taskMilestone("task-1")).toBe(existing.id);
		expect(SprintRegistry.load(testDir).get("3")?.milestoneId).toBe(
			existing.id,
		);
	});

	it("keeps sprints with the same name on separate milestones", async () => {
		await pullTaskSprint(
			await context({ archiveClosedSprints: false }),
			"task-1",
			issue([S1]),
		);
		const again: JiraSprint = { id: "9", name: "Sprint 1", state: "future" };
		await pullTaskSprint(
			await context({ archiveClosedSprints: false }),
			"task-2",
			issue([again]),
		);

		const titles = milestones().map((m) => m.title);
		expect(titles).toEqual(["Sprint 1", "Sprint 1 (sprint 9)"]);
		expect(taskMilestone("task-1")).not.toBe(taskMilestone("task-2"));
	});

	it("renames and updates sprint milestones from the board, then archives on close", async () => {
		await pullTaskSprint(await context(), "task-1", issue([S2]));
		const id = milestones()[0].id;

		boardSprints = [
			{
				...S2,
				name: "Sprint 2 (extended)",
				endDate: "2026-10-05T17:00:00.000Z",
				goal: "Revised goal",
			},
		];
		await refreshRegisteredSprints(await context());
		expect(milestones()[0]).toMatchObject({
			id,
			title: "Sprint 2 (extended)",
			dueDate: "2026-10-05",
			description: "Revised goal",
			archived: false,
		});

		boardSprints = [{ ...boardSprints[0], state: "closed", goal: undefined }];
		await refreshRegisteredSprints(await context());
		expect(milestones()[0]).toMatchObject({ id, archived: true });
		expect(milestones()[0].description).toBeUndefined();
		expect(taskMilestone("task-1")).toBe(id);
		expect(SprintRegistry.load(testDir).get("2")?.state).toBe("closed");
	});

	it("does not create milestones for unregistered board sprints", async () => {
		boardSprints = [S2, S3];
		await refreshRegisteredSprints(await context());
		expect(milestones()).toEqual([]);
	});

	it("knows when an issue's sprints changed since the last pull", async () => {
		const ctx = await context();
		expect(sprintNeedsPull(ctx, "task-1", issue([S2]))).toBe(true);
		await pullTaskSprint(ctx, "task-1", issue([S2]));
		expect(sprintNeedsPull(ctx, "task-1", issue([S2]))).toBe(false);
		expect(sprintNeedsPull(ctx, "task-1", issue([S2, S3]))).toBe(true);
		expect(
			sprintNeedsPull(ctx, "task-1", issue([{ ...S2, state: "closed" }])),
		).toBe(true);
	});

	it("leaves a Backlog-side milestone change for push when syncing both ways", async () => {
		await pullTaskSprint(
			await context({ direction: "both" }),
			"task-1",
			issue([S2]),
		);
		backlog("milestone", "add", "Local plan");
		const local = milestones().find((m) => m.title === "Local plan");
		backlog("task", "edit", "task-1", "--milestone", local?.id ?? "");

		const result = await pullTaskSprint(
			await context({ direction: "both" }),
			"task-1",
			issue([S2]),
		);
		expect(result.skipped).toBe("local-change");
		expect(taskMilestone("task-1")).toBe(local?.id);

		// With direction pull, Jira wins
		await pullTaskSprint(await context(), "task-1", issue([S2]));
		expect(taskMilestone("task-1")).not.toBe(local?.id);
	});

	it("changes nothing in a dry run", async () => {
		const ctx = await createSprintPullContext(
			sprintMapping(),
			{
				jira: {
					getSprintFieldId: async () => SPRINT_FIELD,
					getBoardSprints: async () => [S2],
					includeIssueFields: () => {},
				},
				backlog: backlogClient,
			},
			{ dryRun: true },
		);
		if (!ctx) throw new Error("no context");
		expect((await pullTaskSprint(ctx, "task-1", issue([S2]))).skipped).toBe(
			"dry-run",
		);
		expect(milestones()).toEqual([]);
		expect(readTaskLink("task-1")).toBeNull();
	});
});
