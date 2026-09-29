import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import type { JiraSprint } from "../integrations/jira-sprints.ts";
import {
	SprintRegistry,
	SprintRegistryError,
	getSprintRegistryPath,
} from "./sprint-registry.ts";

const sprint12: JiraSprint = {
	id: "37",
	name: "Sprint 12",
	state: "active",
	startDate: "2026-09-15T09:00:00.000Z",
	endDate: "2026-09-28T17:00:00.000Z",
	goal: "Ship sprint sync",
	boardId: "5",
};

describe("SprintRegistry", () => {
	let testDir: string;
	let path: string;

	beforeEach(() => {
		testDir = uniqueTestDir("sprint-registry-test");
		path = getSprintRegistryPath(testDir);
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	function writeRaw(text: string): void {
		mkdirSync(join(testDir, ".backlog-jira"), { recursive: true });
		writeFileSync(path, text, "utf-8");
	}

	it("starts empty and does not create a file until something is recorded", () => {
		const registry = SprintRegistry.load(testDir);
		expect(registry.list()).toEqual([]);
		expect(registry.save()).toBe(false);
	});

	it("stores sprint id, milestone id and last known sprint data as readable JSON", () => {
		const registry = SprintRegistry.load(testDir);
		registry.upsert(sprint12, "m-3");
		expect(registry.save()).toBe(true);

		expect(readFileSync(path, "utf-8")).toBe(`{
  "version": 1,
  "sprints": [
    {
      "sprintId": "37",
      "milestoneId": "m-3",
      "boardId": "5",
      "name": "Sprint 12",
      "state": "active",
      "startDate": "2026-09-15T09:00:00.000Z",
      "endDate": "2026-09-28T17:00:00.000Z",
      "goal": "Ship sprint sync"
    }
  ]
}
`);
		const reloaded = SprintRegistry.load(testDir);
		expect(reloaded.get(37)).toEqual({
			sprintId: "37",
			milestoneId: "m-3",
			...sprint12,
			id: undefined,
		} as never);
		expect(reloaded.findByMilestone("M-3")?.sprintId).toBe("37");
		expect(reloaded.findByMilestone("m-9")).toBeUndefined();
	});

	it("keeps the milestone link across sprint renames", () => {
		const registry = SprintRegistry.load(testDir);
		registry.upsert(sprint12, "m-3");
		registry.upsert({ ...sprint12, name: "Sprint 12 (hardening)" }, "m-3");
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("37")).toMatchObject({
			milestoneId: "m-3",
			name: "Sprint 12 (hardening)",
		});
	});

	it("tells sprints with duplicate names apart by id", () => {
		const registry = SprintRegistry.load(testDir);
		registry.upsert({ id: "1", name: "Sprint 1", state: "closed" }, "m-1");
		registry.upsert({ id: "2", name: "Sprint 1", state: "future" }, "m-2");
		expect(registry.get("1")?.milestoneId).toBe("m-1");
		expect(registry.get("2")?.milestoneId).toBe("m-2");
	});

	it("updates data that Jira cleared but keeps board id and complete date", () => {
		const registry = SprintRegistry.load(testDir);
		registry.upsert(
			{
				...sprint12,
				state: "closed",
				completeDate: "2026-09-29T08:00:00.000Z",
			},
			"m-3",
		);
		registry.upsert(
			{
				id: "37",
				name: "Sprint 12",
				state: "closed",
				startDate: sprint12.startDate,
			},
			"m-3",
		);
		expect(registry.get("37")).toEqual({
			sprintId: "37",
			milestoneId: "m-3",
			boardId: "5",
			name: "Sprint 12",
			state: "closed",
			startDate: "2026-09-15T09:00:00.000Z",
			completeDate: "2026-09-29T08:00:00.000Z",
		});
	});

	it("survives reads and writes without reordering or dropping unrelated content", () => {
		const original = `{
  "version": 1,
  "note": "kept",
  "sprints": [
    {
      "sprintId": "90",
      "milestoneId": "m-7",
      "name": "Sprint 90",
      "state": "future",
      "custom": { "owner": "team-a" }
    },
    {
      "sprintId": "4",
      "milestoneId": "m-1",
      "name": "Sprint 4",
      "state": "closed"
    }
  ]
}
`;
		writeRaw(original);

		const unchanged = SprintRegistry.load(testDir);
		expect(unchanged.isDirty()).toBe(false);
		expect(unchanged.save()).toBe(false);

		const registry = SprintRegistry.load(testDir);
		registry.upsert({ id: "4", name: "Sprint 4", state: "closed" }, "m-1");
		expect(registry.save()).toBe(false);
		registry.upsert({ id: "90", name: "Sprint 90!", state: "future" }, "m-7");
		registry.upsert({ id: "12", name: "Sprint 12", state: "future" }, "m-8");
		expect(registry.save()).toBe(true);

		const saved = JSON.parse(readFileSync(path, "utf-8"));
		expect(Object.keys(saved)).toEqual(["version", "note", "sprints"]);
		expect(saved.sprints.map((s: { sprintId: string }) => s.sprintId)).toEqual([
			"90",
			"4",
			"12",
		]);
		expect(saved.sprints[0]).toEqual({
			sprintId: "90",
			milestoneId: "m-7",
			name: "Sprint 90!",
			state: "future",
			custom: { owner: "team-a" },
		});
		expect(saved.sprints[1]).toEqual({
			sprintId: "4",
			milestoneId: "m-1",
			name: "Sprint 4",
			state: "closed",
		});
	});

	it("keeps entries written by another instance since it was loaded", () => {
		SprintRegistry.load(testDir).save();
		const first = SprintRegistry.load(testDir);
		const second = SprintRegistry.load(testDir);

		first.upsert({ id: "1", name: "Sprint 1", state: "active" }, "m-1");
		first.sprintFieldId = "customfield_10020";
		first.save();
		second.upsert({ id: "2", name: "Sprint 2", state: "future" }, "m-2");
		second.save();

		const merged = SprintRegistry.load(testDir);
		expect(merged.list().map((e) => e.sprintId)).toEqual(["1", "2"]);
		expect(merged.sprintFieldId).toBe("customfield_10020");

		// An instance's own changes win for the sprints it touched
		first.upsert(
			{ id: "2", name: "Sprint 2 (renamed)", state: "future" },
			"m-2",
		);
		first.save();
		expect(SprintRegistry.load(testDir).get("2")?.name).toBe(
			"Sprint 2 (renamed)",
		);
	});

	it("refuses to load a damaged registry instead of overwriting it", () => {
		const cases: Array<[string, string]> = [
			["{ nope", "not valid JSON"],
			["[]", "expected a JSON object"],
			['{ "sprints": {} }', '"sprints" must be an array'],
			[
				'{ "sprints": [ { "sprintId": "1" } ] }',
				'sprints[0] is missing "milestoneId"',
			],
			[
				'{ "sprints": [ { "sprintId": "1", "milestoneId": "m-1" }, { "sprintId": 1, "milestoneId": "m-2" } ] }',
				"sprints[1] repeats sprint 1",
			],
		];
		for (const [text, message] of cases) {
			writeRaw(text);
			expect(() => SprintRegistry.load(testDir)).toThrow(SprintRegistryError);
			expect(() => SprintRegistry.load(testDir)).toThrow(message);
		}
	});

	it("re-includes the registry in an existing .backlog-jira/.gitignore", () => {
		const gitignorePath = join(testDir, ".backlog-jira", ".gitignore");
		mkdirSync(join(testDir, ".backlog-jira"), { recursive: true });
		writeFileSync(gitignorePath, "*\n!.gitignore\n!links/\n!links/*.json\n");

		const registry = SprintRegistry.load(testDir);
		registry.upsert(sprint12, "m-3");
		registry.save();
		registry.upsert({ ...sprint12, name: "Renamed" }, "m-3");
		registry.save();

		expect(readFileSync(gitignorePath, "utf-8")).toBe(
			"*\n!.gitignore\n!links/\n!links/*.json\n!sprints.json\n",
		);
	});
});
