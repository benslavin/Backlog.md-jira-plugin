import type { BacklogClient } from "../integrations/backlog.ts";
import { parseSprintFieldValue } from "../integrations/jira-sprints.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import { type SprintMapping, getJiraFieldValue } from "./field-mapping.ts";
import type {
	MappedFieldFailure,
	MappedFieldState,
} from "./mapped-field-sync.ts";
import { SPRINT_CONFLICT_FIELD, SPRINT_PAYLOAD_KEY } from "./sprint-payload.ts";
import {
	type SprintPullContext,
	createSprintPullContext,
	pullTaskSprint,
	selectDisplayedSprint,
} from "./sprint-pull.ts";
import {
	type SprintPushContext,
	createSprintPushContext,
	pushTaskSprint,
} from "./sprint-push.ts";

/**
 * Sprint handling for `backlog-jira sync`: the sprint is one more field of
 * the payload (see sprint-payload.ts), so one-sided changes propagate and
 * changes on both sides go through the configured conflict strategy.
 */

export interface SprintSyncContext {
	mapping: SprintMapping;
	/** Null when the mapping does not pull (direction push) */
	pull: SprintPullContext | null;
	/** Null when the mapping does not push (direction pull) */
	push: SprintPushContext | null;
	registry: SprintRegistry;
	milestones: MilestoneAdapter;
}

/**
 * Pull and push sprint contexts sharing one registry and milestone adapter,
 * so parallel task syncs agree on sprints and milestones
 */
export async function createSprintSyncContext(
	mapping: SprintMapping | null,
	clients: {
		jira: JiraClient;
		backlog: Pick<BacklogClient, "updateTask">;
	},
	options: { cwd?: string } = {},
): Promise<SprintSyncContext | null> {
	if (!mapping) return null;
	const cwd = options.cwd ?? process.cwd();
	const registry = SprintRegistry.load(cwd);
	const milestones = new MilestoneAdapter({ cwd, registry });
	const shared = { cwd, registry, milestones };
	return {
		mapping,
		registry,
		milestones,
		pull: await createSprintPullContext(mapping, clients, shared),
		push: await createSprintPushContext(mapping, clients.jira, shared),
	};
}

function sprintValue(
	state: MappedFieldState,
	side: "backlog" | "jira",
	which: "current" | "base",
): string {
	const payload = state[which][side];
	return payload?.mappedFields?.[SPRINT_PAYLOAD_KEY] ?? "";
}

function sideChanges(state: MappedFieldState) {
	const backlogNow = sprintValue(state, "backlog", "current");
	const jiraNow = sprintValue(state, "jira", "current");
	return {
		backlogChanged: backlogNow !== sprintValue(state, "backlog", "base"),
		jiraChanged: jiraNow !== sprintValue(state, "jira", "base"),
		differ: backlogNow !== jiraNow,
	};
}

/** A payload sprint value as shown to the user */
function describeSprintValue(ctx: SprintSyncContext, value: string): string {
	if (!value) return "(no sprint)";
	if (value.startsWith("milestone:")) {
		const id = value.slice("milestone:".length);
		const milestone = ctx.milestones.get(id);
		return `${milestone?.title ?? id} (milestone ${id}, no sprint yet)`;
	}
	const name = ctx.registry.get(value)?.name;
	return name ? `${name} (sprint ${value})` : `sprint ${value}`;
}

/**
 * The sprint conflict, when the sprint changed on both sides since the last
 * sync to different sprints. Only `both` mappings can conflict.
 */
export function detectSprintConflict(
	state: MappedFieldState,
	ctx: SprintSyncContext | null,
): {
	field: string;
	backlogValue: unknown;
	jiraValue: unknown;
	baseValue: unknown;
} | null {
	if (!ctx || ctx.mapping.direction !== "both") return null;
	if (!state.base.backlog || !state.base.jira) return null;
	const { backlogChanged, jiraChanged, differ } = sideChanges(state);
	if (!backlogChanged || !jiraChanged || !differ) return null;

	const milestone = state.frontmatter.milestone;
	const milestoneTitle =
		typeof milestone === "string" && milestone
			? (ctx.milestones.get(milestone)?.title ?? milestone)
			: null;
	const jiraSprint = selectDisplayedSprint(
		parseSprintFieldValue(
			getJiraFieldValue(state.issue, ctx.pull?.sprintFieldId ?? ""),
		),
	);

	return {
		field: SPRINT_CONFLICT_FIELD,
		backlogValue: milestoneTitle
			? `${milestoneTitle} → ${describeSprintValue(ctx, sprintValue(state, "backlog", "current"))}`
			: "(no milestone)",
		jiraValue: jiraSprint
			? `${jiraSprint.name} (sprint ${jiraSprint.id}, ${jiraSprint.state})`
			: "(no sprint)",
		baseValue: describeSprintValue(ctx, sprintValue(state, "backlog", "base")),
	};
}

/**
 * Which side's sprint wins when merging a conflict: a chosen resolution,
 * else the side that changed (or the mapping's owner side for one-way
 * mappings). Null when there is nothing to merge.
 */
export function planSprintMerge(
	state: MappedFieldState,
	mapping: SprintMapping,
	resolution?: "backlog" | "jira",
): "backlog" | "jira" | null {
	if (resolution && mapping.direction === "both") return resolution;
	const { backlogChanged, jiraChanged, differ } = sideChanges(state);
	if (!differ) return null;
	if (mapping.direction === "pull") return "jira";
	if (mapping.direction === "push") return "backlog";
	if (backlogChanged && !jiraChanged) return "backlog";
	if (jiraChanged && !backlogChanged) return "jira";
	return null;
}

/**
 * Apply a sprint merge decision: pull Jira's sprint into the milestone, or
 * push the milestone as the issue's sprint. Returns push failures.
 */
export async function applySprintMerge(
	side: "backlog" | "jira",
	ctx: SprintSyncContext,
	taskId: string,
	issue: JiraIssue,
): Promise<MappedFieldFailure[]> {
	if (side === "jira") {
		if (ctx.pull)
			await pullTaskSprint(ctx.pull, taskId, issue, { force: true });
		return [];
	}
	if (!ctx.push) return [];
	try {
		const result = await pushTaskSprint(ctx.push, taskId, issue, {
			force: true,
		});
		return result.status === "failed"
			? [{ mapping: ctx.mapping, error: result.reason ?? "unknown error" }]
			: [];
	} catch (error) {
		return [
			{
				mapping: ctx.mapping,
				error: error instanceof Error ? error.message : String(error),
			},
		];
	}
}
