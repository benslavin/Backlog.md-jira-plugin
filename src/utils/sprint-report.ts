import type { SprintRegistry } from "../state/sprint-registry.ts";
import type { TaskLink } from "./task-links.ts";

/**
 * Human-readable sprint information for view and status
 */

function day(value?: string): string | null {
	return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/**
 * Lines describing a task's sprint history from its link record, oldest
 * first as Jira lists them; the sprint the task shows is marked with "*"
 */
export function formatSprintHistory(link: TaskLink | null): string[] {
	const sprints = link?.sprints ?? [];
	if (sprints.length === 0) {
		return [
			"",
			"Sprint History:",
			"  (no sprints recorded; run backlog-jira pull)",
		];
	}
	const shown = link?.sprintSync?.sprintId ?? null;
	const lines = ["", "Sprint History:"];
	for (const sprint of sprints) {
		const start = day(sprint.startDate);
		const end = day(sprint.endDate);
		const completed = day(sprint.completeDate);
		const dates = [
			start || end ? `${start ?? "?"} → ${end ?? "?"}` : null,
			completed ? `completed ${completed}` : null,
		]
			.filter(Boolean)
			.join(", ");
		const marker = sprint.id === shown ? "*" : " ";
		lines.push(
			` ${marker} ${sprint.name} (sprint ${sprint.id}, ${sprint.state})${dates ? ` ${dates}` : ""}`,
		);
	}
	if (shown) lines.push("  * shown as the task's milestone");
	return lines;
}

/**
 * Task counts per displayed sprint (payload sprint ids; "" for none),
 * in order of first appearance with "no sprint" last
 */
export function countTasksPerSprint(
	sprintIds: string[],
	registry: Pick<SprintRegistry, "get">,
): Array<{ label: string; count: number }> {
	const counts = new Map<string, number>();
	for (const id of sprintIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	const rows = [...counts.entries()]
		.filter(([id]) => id !== "")
		.map(([id, count]) => {
			const entry = registry.get(id);
			return {
				label: entry
					? `${entry.name} (sprint ${id}, ${entry.state})`
					: `sprint ${id}`,
				count,
			};
		});
	const none = counts.get("") ?? 0;
	if (none > 0) rows.push({ label: "(no sprint)", count: none });
	return rows;
}
