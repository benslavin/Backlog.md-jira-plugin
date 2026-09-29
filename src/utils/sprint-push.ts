import type { JiraSprint } from "../integrations/jira-sprints.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import {
	type Milestone,
	MilestoneAdapter,
} from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import {
	type SprintMapping,
	getJiraFieldValue,
	readTaskFrontmatter,
} from "./field-mapping.ts";
import { logger } from "./logger.ts";
import {
	getIssueSprints,
	sameMilestone,
	selectDisplayedSprint,
} from "./sprint-pull.ts";
import { readTaskLink, writeTaskLink } from "./task-links.ts";

/**
 * Push side of sprint sync: a task's milestone decides which sprint of the
 * configured board its Jira issue is in.
 */

export type SprintPushJira = Pick<
	JiraClient,
	| "getSprintFieldId"
	| "includeIssueFields"
	| "getBoardSprints"
	| "moveIssueToSprint"
	| "moveIssueToBacklog"
	| "createSprint"
>;

export interface SprintPushContext {
	mapping: SprintMapping;
	sprintFieldId: string;
	jira: SprintPushJira;
	milestones: MilestoneAdapter;
	registry: SprintRegistry;
	/** Board sprints, fetched once per run */
	boardSprints: Promise<JiraSprint[]> | null;
	/** Milestone id → resolved sprint, so parallel pushes create one sprint */
	targets: Map<string, Promise<SprintTarget>>;
	dryRun: boolean;
}

export type SprintTarget =
	| { sprint: JiraSprint; created: boolean }
	| { error: string };

export interface TaskSprintPushResult {
	status: "moved" | "unchanged" | "skipped" | "failed";
	/** Why the sprint was not pushed (skipped or failed) */
	reason?: string;
	/** Sprint the issue is now in (null: backlog) */
	sprintId?: string | null;
}

const OPEN_STATES = new Set(["active", "future"]);

/**
 * Prepare sprint pushes; null when sprints are not pushed
 */
export async function createSprintPushContext(
	mapping: SprintMapping | null,
	jira: SprintPushJira,
	options: {
		cwd?: string;
		dryRun?: boolean;
		milestones?: MilestoneAdapter;
		registry?: SprintRegistry;
	} = {},
): Promise<SprintPushContext | null> {
	if (!mapping || mapping.direction === "pull") return null;

	const sprintFieldId = await jira.getSprintFieldId();
	if (!sprintFieldId) {
		throw new Error(
			"Sprint sync is configured but this Jira site has no Sprint field (Jira Software). Remove the sprint fieldMappings entry or check the site.",
		);
	}
	jira.includeIssueFields([sprintFieldId]);

	const cwd = options.cwd ?? process.cwd();
	const registry = options.registry ?? SprintRegistry.load(cwd);
	return {
		mapping,
		sprintFieldId,
		jira,
		registry,
		milestones: options.milestones ?? new MilestoneAdapter({ cwd, registry }),
		boardSprints: null,
		targets: new Map(),
		dryRun: options.dryRun ?? false,
	};
}

/**
 * Whether a Jira issue is a subtask; subtasks follow their parent's sprint
 */
export function isSubtaskIssue(issue: JiraIssue): boolean {
	if (/^sub-?task$/i.test(issue.issueType.trim())) return true;
	for (const key of ["issuetype", "issue_type"]) {
		const type = getJiraFieldValue(issue, key) as
			| { subtask?: unknown; hierarchyLevel?: unknown }
			| undefined;
		if (type?.subtask === true || type?.hierarchyLevel === -1) return true;
	}
	return false;
}

/**
 * Whether a task's milestone changed since its last sprint sync
 */
export function sprintNeedsPush(taskId: string): boolean {
	const current = readTaskFrontmatter(taskId).milestone;
	const synced = readTaskLink(taskId)?.sprintSync;
	return synced
		? !sameMilestone(current, synced.milestoneId)
		: typeof current === "string" && current.trim() !== "";
}

function boardSprints(ctx: SprintPushContext): Promise<JiraSprint[]> {
	if (!ctx.boardSprints) {
		ctx.boardSprints = ctx.jira.getBoardSprints(ctx.mapping.boardId);
		// A failed fetch is retried by the next task
		ctx.boardSprints.catch(() => {
			ctx.boardSprints = null;
		});
	}
	return ctx.boardSprints;
}

/** Sprint end date for a milestone due date (end of that day, UTC) */
function sprintEndDate(dueDate?: string): string | undefined {
	return dueDate ? `${dueDate}T23:59:59.000Z` : undefined;
}

/** Sprint goal from a milestone description; the CLI default is not a goal */
function sprintGoal(milestone: Milestone): string | undefined {
	const description = milestone.description?.trim();
	if (!description || description === `Milestone: ${milestone.title}`) {
		return undefined;
	}
	return description;
}

/**
 * The sprint a milestone stands for: via the registry, else an open sprint
 * of the board with the milestone's title, else a new sprint when
 * createSprints is on. Resolved once per milestone per run.
 */
export function resolveMilestoneSprint(
	ctx: SprintPushContext,
	milestone: Milestone,
): Promise<SprintTarget> {
	const key = milestone.id.toLowerCase();
	let pending = ctx.targets.get(key);
	if (!pending) {
		pending = findOrCreateSprint(ctx, milestone);
		ctx.targets.set(key, pending);
	}
	return pending;
}

async function findOrCreateSprint(
	ctx: SprintPushContext,
	milestone: Milestone,
): Promise<SprintTarget> {
	const { registry, mapping } = ctx;
	const sprints = await boardSprints(ctx);

	const entry = registry.findByMilestone(milestone.id);
	if (entry) {
		const sprint = sprints.find((s) => s.id === entry.sprintId) ?? {
			// Not listed on the board (e.g. listing failed): use what we know
			id: entry.sprintId,
			name: entry.name,
			state: entry.state,
			...(entry.boardId ? { boardId: entry.boardId } : {}),
		};
		return { sprint, created: false };
	}

	const title = milestone.title.trim().toLowerCase();
	const named = sprints.filter(
		(s) => OPEN_STATES.has(s.state) && s.name.trim().toLowerCase() === title,
	);
	const match =
		named.find((s) => s.state === "active") ??
		named.sort((a, b) => Number(a.id) - Number(b.id))[0];
	if (match) {
		if (!ctx.dryRun) {
			registry.upsert(match, milestone.id);
			registry.save();
		}
		return { sprint: match, created: false };
	}

	if (!mapping.createSprints) {
		return {
			error: `milestone "${milestone.title}" matches no future or active sprint on board ${mapping.boardId}; create the sprint in Jira or set "createSprints": true`,
		};
	}
	if (ctx.dryRun) {
		logger.info(
			{ milestone: milestone.title, boardId: mapping.boardId },
			"DRY RUN: Would create Jira sprint",
		);
		return {
			sprint: { id: "dry-run", name: milestone.title, state: "future" },
			created: true,
		};
	}

	try {
		const sprint = await ctx.jira.createSprint(mapping.boardId, {
			name: milestone.title.trim(),
			endDate: sprintEndDate(milestone.dueDate),
			goal: sprintGoal(milestone),
		});
		registry.upsert(sprint, milestone.id);
		registry.save();
		logger.info(
			{ sprintId: sprint.id, milestone: milestone.id },
			"Created Jira sprint for milestone",
		);
		return { sprint, created: true };
	} catch (error) {
		return {
			error: `could not create sprint "${milestone.title}" on board ${mapping.boardId}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function findMilestone(
	ctx: SprintPushContext,
	value: string,
): Milestone | undefined {
	return ctx.milestones.get(value) ?? ctx.milestones.findByTitle(value);
}

/**
 * Move a task's Jira issue into the sprint of its milestone, or back to the
 * backlog when the milestone was cleared.
 *
 * With direction "both" only a milestone changed in Backlog since the last
 * sprint sync is pushed; Jira-side sprint changes are pulled instead.
 */
export async function pushTaskSprint(
	ctx: SprintPushContext,
	taskId: string,
	issue: JiraIssue,
): Promise<TaskSprintPushResult> {
	if (isSubtaskIssue(issue)) {
		return {
			status: "skipped",
			reason: "subtasks follow their parent's sprint",
		};
	}

	const raw = readTaskFrontmatter(taskId).milestone;
	const current = typeof raw === "string" && raw.trim() ? raw.trim() : null;
	const link = readTaskLink(taskId) ?? {};
	if (
		ctx.mapping.direction === "both" &&
		link.sprintSync &&
		sameMilestone(current, link.sprintSync.milestoneId)
	) {
		return { status: "unchanged" };
	}

	const sprints = getIssueSprints(ctx, issue);
	const openSprint = sprints.find((s) => OPEN_STATES.has(s.state)) ?? null;
	const displayed = selectDisplayedSprint(sprints);

	let result: TaskSprintPushResult;

	if (!current) {
		if (!openSprint) {
			result = { status: "unchanged", sprintId: null };
		} else if (ctx.dryRun) {
			logger.info(
				{ taskId, issue: issue.key },
				"DRY RUN: Would move issue to backlog",
			);
			return { status: "moved", sprintId: null };
		} else {
			await ctx.jira.moveIssueToBacklog(issue.key);
			result = { status: "moved", sprintId: null };
		}
	} else {
		const milestone = findMilestone(ctx, current);
		if (!milestone) {
			return { status: "failed", reason: `milestone "${current}" not found` };
		}

		const target = await resolveMilestoneSprint(ctx, milestone);
		if ("error" in target) {
			return { status: "failed", reason: target.error };
		}
		const { sprint } = target;

		if (sprint.state === "closed") {
			if (displayed?.id !== sprint.id) {
				return {
					status: "failed",
					reason: `sprint "${sprint.name}" is closed; issues can only be moved into future or active sprints`,
				};
			}
			result = { status: "unchanged", sprintId: sprint.id };
		} else if (openSprint?.id === sprint.id) {
			result = { status: "unchanged", sprintId: sprint.id };
		} else if (ctx.dryRun) {
			logger.info(
				{ taskId, issue: issue.key, sprint: sprint.name },
				"DRY RUN: Would move issue to sprint",
			);
			return { status: "moved", sprintId: sprint.id };
		} else {
			await ctx.jira.moveIssueToSprint(issue.key, sprint.id);
			result = { status: "moved", sprintId: sprint.id };
		}
	}

	if (ctx.dryRun) return result;

	// Record the sprint the issue now shows, so the next pull does not treat
	// the pushed milestone as a Jira-side change
	const shown =
		result.sprintId ??
		selectDisplayedSprint(sprints.filter((s) => !OPEN_STATES.has(s.state)))
			?.id ??
		null;
	writeTaskLink(taskId, {
		...(readTaskLink(taskId) ?? {}),
		sprintSync: { sprintId: shown, milestoneId: current },
	});
	logger.info({ taskId, issue: issue.key, result }, "Pushed task sprint");
	return result;
}
