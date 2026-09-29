import { describe, expect, it } from "bun:test";
import { countTasksPerSprint, formatSprintHistory } from "./sprint-report.ts";

describe("formatSprintHistory", () => {
	it("lists every sprint with state and dates, marking the shown one", () => {
		expect(
			formatSprintHistory({
				sprints: [
					{
						id: "1",
						name: "Sprint 1",
						state: "closed",
						startDate: "2026-09-01T09:00:00.000Z",
						endDate: "2026-09-14T17:00:00.000Z",
						completeDate: "2026-09-14T18:00:00.000Z",
					},
					{
						id: "2",
						name: "Sprint 2",
						state: "active",
						startDate: "2026-09-15T09:00:00.000Z",
					},
					{ id: "3", name: "Sprint 3", state: "future" },
				],
				sprintSync: { sprintId: "2", milestoneId: "m-2" },
			}),
		).toEqual([
			"",
			"Sprint History:",
			"   Sprint 1 (sprint 1, closed) 2026-09-01 → 2026-09-14, completed 2026-09-14",
			" * Sprint 2 (sprint 2, active) 2026-09-15 → ?",
			"   Sprint 3 (sprint 3, future)",
			"  * shown as the task's milestone",
		]);
	});

	it("says when no sprints are recorded", () => {
		expect(formatSprintHistory(null)).toEqual([
			"",
			"Sprint History:",
			"  (no sprints recorded; run backlog-jira pull)",
		]);
	});
});

describe("countTasksPerSprint", () => {
	it("counts tasks per displayed sprint with names from the registry", () => {
		const registry = {
			get: (id: string | number) =>
				String(id) === "2"
					? {
							sprintId: "2",
							milestoneId: "m-2",
							name: "Sprint 2",
							state: "active" as const,
						}
					: undefined,
		};
		expect(countTasksPerSprint(["2", "", "9", "2"], registry)).toEqual([
			{ label: "Sprint 2 (sprint 2, active)", count: 2 },
			{ label: "sprint 9", count: 1 },
			{ label: "(no sprint)", count: 1 },
		]);
	});
});
