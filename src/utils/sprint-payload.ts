import { parseSprintFieldValue } from "../integrations/jira-sprints.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import {
	type SprintMapping,
	getJiraFieldValue,
	loadSprintMapping,
} from "./field-mapping.ts";
import { logger } from "./logger.ts";
import { selectDisplayedSprint } from "./sprint-pull.ts";

/**
 * The sprint in sync payloads and snapshots.
 *
 * Both sides carry the displayed sprint as its Jira sprint id under
 * `mappedFields.milestone`: Jira the id of the issue's displayed sprint,
 * Backlog the id of the sprint registered for the task's milestone. Ids are
 * stable across renames, so renaming a sprint (and with it the milestone) is
 * not a change on either side. A milestone not registered to any sprint is
 * represented as `milestone:<id>` so that choosing it is a Backlog change.
 */

/** Payload key of the sprint (the Backlog target of the sprint mapping) */
export const SPRINT_PAYLOAD_KEY = "milestone";

/** Field name of a sprint conflict in the conflict prompt */
export const SPRINT_CONFLICT_FIELD = "sprint";

export interface SprintPayloadSource {
	mapping: SprintMapping;
	sprintFieldId: string;
	registry: SprintRegistry;
	milestones: MilestoneAdapter;
}

/**
 * What sync payloads need to carry the sprint, or null when sprint sync is
 * not configured or the Sprint field has not been discovered yet
 */
export function loadSprintPayloadSource(
	cwd = process.cwd(),
): SprintPayloadSource | null {
	try {
		const mapping = loadSprintMapping(cwd);
		if (!mapping) return null;
		const registry = SprintRegistry.load(cwd);
		const sprintFieldId = registry.sprintFieldId;
		if (!sprintFieldId) return null;
		return {
			mapping,
			sprintFieldId,
			registry,
			milestones: new MilestoneAdapter({ cwd, registry }),
		};
	} catch (error) {
		// Invalid config or registry are reported by the commands using them
		logger.debug({ error }, "Sprint payload values unavailable");
		return null;
	}
}

/**
 * Payload value of an issue's sprint: its displayed sprint id, or ""
 */
export function jiraSprintValue(
	source: Pick<SprintPayloadSource, "sprintFieldId">,
	issue: JiraIssue,
): string {
	const sprints = parseSprintFieldValue(
		getJiraFieldValue(issue, source.sprintFieldId),
	);
	return selectDisplayedSprint(sprints)?.id ?? "";
}

/**
 * Payload value of a task's milestone: the id of the sprint registered for
 * it, `milestone:<id>` when it stands for no sprint yet, or "" when unset
 */
export function backlogSprintValue(
	source: Pick<SprintPayloadSource, "registry" | "milestones">,
	milestone: unknown,
): string {
	if (typeof milestone !== "string" || !milestone.trim()) return "";
	const value = milestone.trim();
	const entry =
		source.registry.findByMilestone(value) ??
		(() => {
			// Older tasks may reference a milestone by title
			const found = source.milestones.findByTitle(value);
			return found ? source.registry.findByMilestone(found.id) : undefined;
		})();
	return entry ? entry.sprintId : `milestone:${value.toLowerCase()}`;
}
