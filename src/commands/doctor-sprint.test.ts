import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { JiraBoard, JiraSprint } from "../integrations/jira-sprints.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import { logger } from "../utils/logger.ts";
import { checkSprintSync } from "./doctor.ts";

const SCRUM: JiraBoard = {
	id: "5",
	name: "Team board",
	type: "scrum",
	supportsSprints: true,
};
const SPRINTS: JiraSprint[] = [
	{ id: "1", name: "Sprint 1", state: "closed" },
	{ id: "2", name: "Sprint 2", state: "active" },
	{ id: "3", name: "Sprint 3", state: "future" },
];

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBacklogCli)("doctor: sprint sync", () => {
	let testDir: string;
	let originalCwd: string;
	let lines: { info: string[]; warn: string[]; error: string[] };

	function backlog(...args: string[]): string {
		const result = spawnSync("backlog", args, { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	function addMilestone(title: string): string {
		const id = backlog("milestone", "add", "--", title).match(
			/\((m-\d+)\)/,
		)?.[1];
		if (!id) throw new Error("milestone not created");
		return id;
	}

	function configure(overrides: Record<string, unknown> = {}): void {
		writeJson(".backlog-jira/config.json", {
			jira: { projectKey: "PROJ" },
			fieldMappings: [
				{
					backlog: "milestone",
					jira: "sprint",
					type: "sprint",
					direction: "both",
					boardId: 5,
					...overrides,
				},
			],
		});
	}

	function jira(overrides: Record<string, unknown> = {}) {
		return {
			getSprintFieldId: mock(async () => "customfield_10020"),
			getBoard: mock(async () => SCRUM),
			getBoardSprints: mock(async () => SPRINTS),
			...overrides,
		} as never;
	}

	beforeEach(() => {
		testDir = uniqueTestDir("doctor-sprint");
		originalCwd = process.cwd();
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlog(
			"init",
			"doctor-sprint",
			"--defaults",
			"--integration-mode",
			"none",
		);
		backlog("task", "create", "One");
		backlog("task", "create", "Two");
		lines = { info: [], warn: [], error: [] };
		for (const level of ["info", "warn", "error"] as const) {
			spyOn(logger, level).mockImplementation(((message: unknown) => {
				lines[level].push(String(message));
			}) as never);
		}
	});

	afterEach(() => {
		mock.restore();
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("passes quietly when sprint sync is not configured", async () => {
		writeJson(".backlog-jira/config.json", { jira: { projectKey: "PROJ" } });
		expect(await checkSprintSync(jira(), { cwd: testDir, taskIds: [] })).toBe(
			0,
		);
		expect(lines.info).toContain("  ✓ Sprint sync not configured");
	});

	it("passes for a reachable scrum board", async () => {
		configure();
		expect(await checkSprintSync(jira(), { cwd: testDir, taskIds: [] })).toBe(
			0,
		);
		expect(lines.info).toContain("  ✓ Sprint field customfield_10020");
		expect(lines.info).toContain(
			"  ✓ Board 5 (Team board, scrum) with 3 sprints",
		);
	});

	it("errors when the Sprint field cannot be discovered", async () => {
		configure();
		await expect(
			checkSprintSync(jira({ getSprintFieldId: async () => null }), {
				cwd: testDir,
				taskIds: [],
			}),
		).rejects.toThrow("1 sprint sync problem");
		expect(lines.error.join("\n")).toContain("Sprint field not found");
	});

	it("errors when the board is missing, unreachable or has no sprints", async () => {
		configure();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ getBoard: async () => null }, "was not found or is not accessible"],
			[
				{
					getBoard: async () => {
						throw new Error("MCP tool jira_get_agile_boards is not available");
					},
				},
				"Board 5 is unreachable: MCP tool jira_get_agile_boards is not available",
			],
			[
				{
					getBoard: async () => ({
						id: "5",
						name: "Flow",
						type: "kanban",
						supportsSprints: false,
					}),
				},
				"Board 5 (Flow) is a kanban board without sprints",
			],
		];
		for (const [overrides, message] of cases) {
			lines.error = [];
			await expect(
				checkSprintSync(jira(overrides), { cwd: testDir, taskIds: [] }),
			).rejects.toThrow("sprint sync problem");
			expect(lines.error.join("\n")).toContain(message);
		}
	});

	it("warns about linked tasks whose milestone matches no sprint while createSprints is off", async () => {
		configure();
		const registered = addMilestone("Renamed");
		const byName = addMilestone("sprint 3");
		const unmatched = addMilestone("Someday");
		const registry = SprintRegistry.load(testDir);
		registry.upsert(SPRINTS[1], registered);
		registry.save();
		backlog("task", "edit", "task-1", "--milestone", unmatched);
		backlog("task", "edit", "task-2", "--milestone", byName);
		backlog("task", "create", "Three", "--milestone", registered);

		const warnings = await checkSprintSync(jira(), {
			cwd: testDir,
			taskIds: ["task-1", "task-2", "task-3"],
		});

		expect(warnings).toBe(1);
		expect(lines.warn[0]).toContain(
			"1 linked task has a milestone matching no future or active sprint on board 5",
		);
		expect(lines.warn[1]).toBe(`      task-1: Someday (${unmatched})`);
		expect(lines.warn).toHaveLength(2);
	});

	it("notes that pushes may create sprints when createSprints is on", async () => {
		configure({ createSprints: true });
		const unmatched = addMilestone("Someday");
		backlog("task", "edit", "task-1", "--milestone", unmatched);

		expect(
			await checkSprintSync(jira(), { cwd: testDir, taskIds: ["task-1"] }),
		).toBe(0);
		expect(lines.info.join("\n")).toContain(
			"createSprints is on: pushing a task whose milestone matches no sprint creates a future sprint on board 5",
		);
		expect(lines.warn).toEqual([]);
	});

	it("warns about sprint milestones the adapter refused to update", async () => {
		configure();
		writeJson(".backlog-jira/milestone-refusals.json", {
			"m-4": {
				milestoneId: "m-4",
				title: "Sprint 4",
				fields: ["description"],
				reason: "file does not match the expected milestone format",
				at: "2026-09-29T00:00:00.000Z",
			},
		});

		expect(await checkSprintSync(jira(), { cwd: testDir, taskIds: [] })).toBe(
			1,
		);
		expect(lines.warn).toEqual([
			"  ⚠ Milestone m-4 (Sprint 4) was not updated (description): file does not match the expected milestone format",
		]);
	});

	it("warns when the recorded Sprint field differs from Jira's", async () => {
		configure();
		const registry = SprintRegistry.load(testDir);
		registry.sprintFieldId = "customfield_99999";
		registry.save();
		expect(await checkSprintSync(jira(), { cwd: testDir, taskIds: [] })).toBe(
			1,
		);
		expect(lines.warn[0]).toContain("records Sprint field customfield_99999");
	});
});
