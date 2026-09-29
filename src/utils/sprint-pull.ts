import type { BacklogClient } from "../integrations/backlog.ts";
import {
	type JiraSprint,
	parseSprintFieldValue,
} from "../integrations/jira-sprints.ts";
import type { JiraClient, JiraIssue } from "../integrations/jira.ts";
import { MilestoneAdapter } from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import {
	type SprintMapping,
	getJiraFieldValue,
	readTaskFrontmatter,
} from "./field-mapping.ts";
import { logger } from "./logger.ts";
import {
	type SprintHistoryEntry,
	type TaskLink,
	readTaskLink,
	writeTaskLink,
} from "./task-links.ts";

/**
 * Pull side of sprint sync: Jira sprints of the configured board become
 * Backlog milestones, and each task's milestone follows its issue's sprint.
 */

export interface SprintPullContext {
	mapping: SprintMapping;
	sprintFieldId: string;
	jira: Pick<JiraClient, "getBoardSprints">;
	backlog: Pick<BacklogClient, "updateTask">;
	milestones: MilestoneAdapter;
	registry: SprintRegistry;
	/** Sprint id → milestone id, resolved once per run */
	resolved: Map<string, Promise<string>>;
	/** Milestone CLI calls run one at a time (tasks are pulled in parallel) */
	queue: Promise<unknown>;
	warnings: string[];
	dryRun: boolean;
}

export interface TaskSprintPullResult {
	/** Milestone the task now has (null when cleared) */
	milestoneId: string | null;
	changed: boolean;
	/** Set when the pull left the task alone */
	skipped?: "local-change" | "dry-run";
}

/**
 * Prepare sprint pulls: discover the Sprint field and make sure fetched
 * issues include it. Returns null when sprints are not pulled.
 */
export async function createSprintPullContext(
	mapping: SprintMapping | null,
	clients: {
		jira: Pick<
			JiraClient,
			"getBoardSprints" | "getSprintFieldId" | "includeIssueFields"
		>;
		backlog: Pick<BacklogClient, "updateTask">;
	},
	options: {
		cwd?: string;
		dryRun?: boolean;
		milestones?: MilestoneAdapter;
		registry?: SprintRegistry;
	} = {},
): Promise<SprintPullContext | null> {
	if (!mapping || mapping.direction === "push") return null;

	const sprintFieldId = await clients.jira.getSprintFieldId();
	if (!sprintFieldId) {
		throw new Error(
			"Sprint sync is configured but this Jira site has no Sprint field (Jira Software). Remove the sprint fieldMappings entry or check the site.",
		);
	}
	clients.jira.includeIssueFields([sprintFieldId]);

	const cwd = options.cwd ?? process.cwd();
	const registry = options.registry ?? SprintRegistry.load(cwd);
	return {
		mapping,
		sprintFieldId,
		jira: clients.jira,
		backlog: clients.backlog,
		registry,
		milestones: options.milestones ?? new MilestoneAdapter({ cwd, registry }),
		resolved: new Map(),
		queue: Promise.resolve(),
		warnings: [],
		dryRun: options.dryRun ?? false,
	};
}

/**
 * Typed sprints on an issue's Sprint field
 */
export function getIssueSprints(
	ctx: Pick<SprintPullContext, "sprintFieldId">,
	issue: JiraIssue,
): JiraSprint[] {
	return parseSprintFieldValue(getJiraFieldValue(issue, ctx.sprintFieldId));
}

function time(value?: string): number {
	const t = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * The sprint a task shows: its open sprint (active before future), else the
 * most recently completed sprint, else none
 */
export function selectDisplayedSprint(
	sprints: JiraSprint[],
): JiraSprint | null {
	const byRecency = (a: JiraSprint, b: JiraSprint) =>
		time(b.completeDate ?? b.endDate) - time(a.completeDate ?? a.endDate) ||
		Number(b.id) - Number(a.id);
	const active = sprints.filter((s) => s.state === "active");
	if (active.length > 0) return [...active].sort(byRecency)[0];
	const future = sprints
		.filter((s) => s.state === "future")
		.sort(
			(a, b) =>
				time(a.startDate) - time(b.startDate) || Number(a.id) - Number(b.id),
		);
	if (future.length > 0) return future[0];
	const closed = sprints.filter((s) => s.state === "closed").sort(byRecency);
	return closed[0] ?? null;
}

/**
 * Milestone due date for a sprint: the calendar date of its end date as
 * Jira wrote it (keeps the site's local date)
 */
export function sprintDueDate(sprint: JiraSprint): string | null {
	return sprint.endDate?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/**
 * Restrict a JQL query to issues in open sprints when pullScope is "open",
 * keeping any ORDER BY clause at the end
 */
export function applySprintPullScope(
	jql: string,
	mapping: SprintMapping | null,
): string {
	if (!mapping || mapping.direction === "push" || mapping.pullScope !== "open")
		return jql;
	const match = jql.match(/^(.*?)(\s*\bORDER\s+BY\b.*)?$/is);
	const where = (match?.[1] ?? jql).trim();
	const order = match?.[2] ? ` ${match[2].trim()}` : "";
	const scope = "sprint in openSprints()";
	return where ? `(${where}) AND ${scope}${order}` : `${scope}${order}`;
}

function serialize<T>(
	ctx: SprintPullContext,
	work: () => Promise<T>,
): Promise<T> {
	const run = ctx.queue.then(work, work);
	ctx.queue = run.catch(() => undefined);
	return run;
}

function warn(ctx: SprintPullContext, message: string): void {
	ctx.warnings.push(message);
	logger.warn(message);
}

/**
 * Find or create the milestone for a sprint and bring it in step with Jira
 * (title, due date, goal, archived when closed). Runs once per sprint per
 * pull; returns the milestone id.
 */
export function resolveSprintMilestone(
	ctx: SprintPullContext,
	sprint: JiraSprint,
): Promise<string> {
	let pending = ctx.resolved.get(sprint.id);
	if (!pending) {
		pending = serialize(ctx, () => reconcileSprintMilestone(ctx, sprint));
		ctx.resolved.set(sprint.id, pending);
	}
	return pending;
}

async function reconcileSprintMilestone(
	ctx: SprintPullContext,
	sprint: JiraSprint,
): Promise<string> {
	const { milestones, registry, mapping } = ctx;
	const dueDate = sprintDueDate(sprint);
	const description = sprint.goal ?? null;
	const uniqueTitle = `${sprint.name} (sprint ${sprint.id})`;

	const entry = registry.get(sprint.id);
	let milestone = entry ? milestones.get(entry.milestoneId) : undefined;

	if (!milestone) {
		// Adopt a same-title milestone unless it already stands for another sprint
		const linked = new Set(
			registry
				.list()
				.filter((e) => e.sprintId !== sprint.id)
				.map((e) => e.milestoneId.toLowerCase()),
		);
		const isAdoptable = (m: { id: string }) => !linked.has(m.id.toLowerCase());
		const fields = {
			dueDate: dueDate ?? undefined,
			description: description ?? undefined,
		};
		try {
			milestone = (
				await milestones.ensure(
					{ title: sprint.name, ...fields },
					{ isAdoptable },
				)
			).milestone;
		} catch (error) {
			// Another sprint's milestone already has this title; keep both apart
			logger.debug(
				{ error, title: uniqueTitle },
				"Retrying milestone with a unique title",
			);
			milestone = (
				await milestones.ensure(
					{ title: uniqueTitle, ...fields },
					{ isAdoptable },
				)
			).milestone;
		}
	}

	registry.upsert(sprint, milestone.id);
	registry.save();

	if (
		milestone.title !== sprint.name &&
		milestone.title !== uniqueTitle &&
		!milestone.archived
	) {
		try {
			await milestones.rename(milestone.id, sprint.name);
		} catch (error) {
			warn(
				ctx,
				`Could not rename milestone ${milestone.id} to sprint name "${sprint.name}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const update = await milestones.update(milestone.id, {
		dueDate,
		description,
	});
	if (update.status === "refused") {
		warn(
			ctx,
			`Milestone ${milestone.id} (sprint "${sprint.name}") was not updated: ${update.reason}`,
		);
	}

	if (sprint.state === "closed" && mapping.archiveClosedSprints) {
		await milestones.archive(milestone.id);
	} else if (sprint.state !== "closed" && milestone.archived) {
		warn(
			ctx,
			`Sprint "${sprint.name}" is ${sprint.state} again but its milestone ${milestone.id} is archived; restore it in Backlog.md`,
		);
	}

	return milestone.id;
}

/**
 * Bring milestones of registered sprints in step with the board, so renames,
 * date and goal changes and closures reach milestones even when none of
 * their issues are pulled in this run
 */
export async function refreshRegisteredSprints(
	ctx: SprintPullContext,
): Promise<void> {
	if (ctx.dryRun || ctx.registry.list().length === 0) return;
	const sprints = await ctx.jira.getBoardSprints(ctx.mapping.boardId);
	for (const sprint of sprints) {
		if (!ctx.registry.get(sprint.id)) continue;
		const known = ctx.registry.get(sprint.id);
		// The board listing omits complete dates; keep the one we know
		const merged =
			sprint.state === "closed" && !sprint.completeDate && known?.completeDate
				? { ...sprint, completeDate: known.completeDate }
				: sprint;
		await resolveSprintMilestone(ctx, merged);
	}
}

function history(sprints: JiraSprint[]): SprintHistoryEntry[] {
	return sprints.map((s) => {
		const entry: SprintHistoryEntry = {
			id: s.id,
			name: s.name,
			state: s.state,
		};
		if (s.startDate) entry.startDate = s.startDate;
		if (s.endDate) entry.endDate = s.endDate;
		if (s.completeDate) entry.completeDate = s.completeDate;
		return entry;
	});
}

/**
 * Whether a task's milestone value and a milestone id are the same
 * (both empty counts as the same)
 */
export function sameMilestone(
	a: unknown,
	b: string | null | undefined,
): boolean {
	const left =
		typeof a === "string" && a.trim() ? a.trim().toLowerCase() : null;
	const right = b ? b.toLowerCase() : null;
	return left === right;
}

/**
 * Whether an issue's sprints changed since the task's last sprint pull
 */
export function sprintNeedsPull(
	ctx: SprintPullContext,
	taskId: string,
	issue: JiraIssue,
): boolean {
	const link = readTaskLink(taskId);
	const sprints = getIssueSprints(ctx, issue);
	const displayed = selectDisplayedSprint(sprints);
	return (
		!link?.sprintSync ||
		link.sprintSync.sprintId !== (displayed?.id ?? null) ||
		JSON.stringify(link.sprints ?? []) !== JSON.stringify(history(sprints))
	);
}

/**
 * Set a task's milestone from its issue's sprint and store the issue's
 * sprint history in the task link record.
 *
 * With direction "both", a milestone changed in Backlog since the last sync
 * while the issue's sprint did not change is left for push.
 */
export async function pullTaskSprint(
	ctx: SprintPullContext,
	taskId: string,
	issue: JiraIssue,
): Promise<TaskSprintPullResult> {
	const sprints = getIssueSprints(ctx, issue);
	const displayed = selectDisplayedSprint(sprints);
	const current = readTaskFrontmatter(taskId).milestone;
	const link: TaskLink = readTaskLink(taskId) ?? {};

	if (ctx.dryRun) {
		logger.info(
			{ taskId, sprint: displayed?.name ?? null },
			"DRY RUN: Would set task milestone from Jira sprint",
		);
		return { milestoneId: null, changed: false, skipped: "dry-run" };
	}

	const localChange =
		ctx.mapping.direction === "both" &&
		link.sprintSync !== undefined &&
		!sameMilestone(current, link.sprintSync.milestoneId) &&
		link.sprintSync.sprintId === (displayed?.id ?? null);

	let milestoneId: string | null = null;
	let changed = false;
	if (localChange) {
		milestoneId = typeof current === "string" ? current : null;
		logger.info(
			{ taskId, milestone: current },
			"Milestone changed in Backlog; leaving it for push",
		);
	} else {
		milestoneId = displayed
			? await resolveSprintMilestone(ctx, displayed)
			: null;
		if (!sameMilestone(current, milestoneId)) {
			await serialize(ctx, () =>
				ctx.backlog.updateTask(
					taskId,
					milestoneId ? { milestone: milestoneId } : { clearMilestone: true },
				),
			);
			changed = true;
		}
	}

	const next: TaskLink = {
		...(readTaskLink(taskId) ?? {}),
		sprints: history(sprints),
	};
	if (!localChange) {
		next.sprintSync = { sprintId: displayed?.id ?? null, milestoneId };
	}
	writeTaskLink(taskId, next);

	return localChange
		? { milestoneId, changed, skipped: "local-change" }
		: { milestoneId, changed };
}
