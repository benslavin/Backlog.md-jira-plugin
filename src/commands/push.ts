import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import { JiraClient, type JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/store.ts";
import { mapBacklogAssigneeToJira } from "../utils/assignee-mapping.ts";
import {
	type FieldMapping,
	type SprintMapping,
	buildMappedJiraFields,
	loadFieldMappings,
	loadSprintMapping,
	readTaskFrontmatter,
} from "../utils/field-mapping.ts";
import { getTaskFilePath, updateJiraMetadata } from "../utils/frontmatter.ts";
import { resolveTaskArgs } from "../utils/id-resolver.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";
import {
	type MappedFieldFailure,
	MappedFieldPushError,
	createIssueWithMappedFields,
	getOverriddenCoreFields,
	recordPartialPush,
	recordSyncedSnapshots,
	updateIssueWithMappedFields,
} from "../utils/mapped-field-sync.ts";
import {
	computeHash,
	mergeDescriptionWithAc,
	normalizeBacklogTask,
	normalizeJiraIssue,
	stripAcceptanceCriteriaFromDescription,
} from "../utils/normalizer.ts";
import { mapBacklogPriorityToJira } from "../utils/priority-mapping.ts";
import {
	type SprintPushContext,
	createSprintPushContext,
	pushTaskSprint,
	sprintNeedsPush,
} from "../utils/sprint-push.ts";
import { findTransitionForStatus } from "../utils/status-mapping.ts";
import { classifySyncState } from "../utils/sync-state.ts";

export interface PushOptions {
	taskIds?: string[];
	all?: boolean;
	force?: boolean;
	dryRun?: boolean;
	verbose?: boolean;
	/**
	 * Sprint push state shared across calls (sync pushes tasks one at a time
	 * in parallel and must not create a sprint twice); created per call when
	 * omitted
	 */
	sprintContext?: SprintPushContext | null;
}

export interface PushResult {
	success: boolean;
	pushed: string[];
	failed: Array<{
		taskId: string;
		error: string;
		/** Set when only mapped fields failed; names each field */
		mappedFieldError?: MappedFieldPushError;
	}>;
	skipped: string[];
}

/**
 * Push Backlog tasks to Jira
 * Updates existing mapped issues or creates new ones
 */
export async function push(options: PushOptions = {}): Promise<PushResult> {
	// Set log level based on verbose flag
	const originalLevel = logger.level;
	if (!options.verbose) {
		logger.level = "error"; // Suppress info/debug logs in non-verbose mode
	}

	logger.info({ options }, "Starting push operation");

	// Validate field mappings up front so config errors are reported clearly
	let fieldMappings: FieldMapping[];
	let sprintMapping: SprintMapping | null;
	try {
		fieldMappings = loadFieldMappings();
		sprintMapping = loadSprintMapping();
	} catch (error) {
		logger.level = originalLevel;
		throw error;
	}

	const store = new FrontmatterStore();
	const backlog = new BacklogClient();
	const jira = new JiraClient(getJiraClientOptions());

	// Load configuration
	const config = loadConfig();
	const projectKey = config.jira?.projectKey;
	const issueType = config.jira?.issueType || "Task";

	if (!projectKey) {
		throw new Error(
			"Jira project key not configured in .backlog-jira/config.json",
		);
	}

	const result: PushResult = {
		success: true,
		pushed: [],
		failed: [],
		skipped: [],
	};

	try {
		const sprints =
			options.sprintContext !== undefined
				? options.sprintContext
				: await createSprintPushContext(sprintMapping, jira, {
						dryRun: options.dryRun,
					});
		if (sprints && options.sprintContext) {
			jira.includeIssueFields([sprints.sprintFieldId]);
		}

		// Get list of tasks to push; given IDs may be Jira keys of linked tasks
		const requested = options.taskIds?.length
			? resolveTaskArgs(options.taskIds, store)
			: null;
		for (const { input, error } of requested?.errors ?? []) {
			result.failed.push({ taskId: input, error });
			result.success = false;
		}
		const taskIds =
			requested?.taskIds ??
			(await getTaskIds(options, backlog, jira, store, sprints));

		logger.info({ count: taskIds.length }, "Tasks to process");

		// Process in parallel batches for better performance (max 10 concurrent)
		const batchSize = 10;
		for (let i = 0; i < taskIds.length; i += batchSize) {
			const batch = taskIds.slice(i, i + batchSize);
			const promises = batch.map(async (taskId) => {
				try {
					await pushTask(taskId, {
						store,
						backlog,
						jira,
						projectKey,
						issueType,
						fieldMappings,
						sprints,
						force: options.force || false,
						dryRun: options.dryRun || false,
					});

					result.pushed.push(taskId);
					logger.info({ taskId }, "Successfully pushed task");
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					result.failed.push({
						taskId,
						error: errorMsg,
						...(error instanceof MappedFieldPushError
							? { mappedFieldError: error }
							: {}),
					});
					logger.error({ taskId, error: errorMsg }, "Failed to push task");
					result.success = false;
				}
			});

			await Promise.all(promises);
		}

		store.logOperation(
			"push",
			null,
			null,
			result.success ? "success" : "partial",
			JSON.stringify(result),
		);
	} finally {
		try {
			await jira.close();
		} catch (e) {
			// ignore close errors
		}
		store.close();
		// Restore original log level
		logger.level = originalLevel;
	}

	logger.info({ result }, "Push operation completed");
	return result;
}

/**
 * Get list of task IDs to push
 */
async function getTaskIds(
	options: PushOptions,
	backlog: BacklogClient,
	jira: JiraClient,
	store: FrontmatterStore,
	sprints: SprintPushContext | null,
): Promise<string[]> {
	if (options.all) {
		// Get all tasks that have mappings
		const mappings = store.getAllMappings();
		return Array.from(mappings.keys());
	}

	// Default: get tasks that need push (changed on Backlog side)
	const mappings = store.getAllMappings();
	const needsPush: string[] = [];

	for (const [taskId, jiraKey] of mappings) {
		try {
			const task = await backlog.getTask(taskId);
			const issue = await jira.getIssue(jiraKey);

			const backlogPayload = normalizeBacklogTask(task);
			const jiraPayload = normalizeJiraIssue(issue);
			const backlogHash = computeHash(backlogPayload);
			const jiraHash = computeHash(jiraPayload);

			const snapshots = store.getSnapshots(taskId);
			const state = classifySyncState(
				backlogHash,
				jiraHash,
				snapshots.backlog,
				snapshots.jira,
				{ backlog: backlogPayload, jira: jiraPayload },
			);

			if (
				state.state === "NeedsPush" ||
				// Milestones are not part of the synced payload
				(state.state === "InSync" && sprints && sprintNeedsPush(taskId))
			) {
				needsPush.push(taskId);
			}
		} catch (error) {
			logger.warn({ taskId, jiraKey, error }, "Failed to check sync state");
		}
	}

	return needsPush;
}

/**
 * Push a single task to Jira
 */
async function pushTask(
	taskId: string,
	context: {
		store: FrontmatterStore;
		backlog: BacklogClient;
		jira: JiraClient;
		projectKey: string;
		issueType: string;
		fieldMappings: FieldMapping[];
		sprints: SprintPushContext | null;
		force: boolean;
		dryRun: boolean;
	},
): Promise<void> {
	const {
		store,
		backlog,
		jira,
		projectKey,
		issueType,
		fieldMappings,
		sprints,
		force,
		dryRun,
	} = context;
	const overridden = getOverriddenCoreFields(fieldMappings);

	// Get current task
	const task = await backlog.getTask(taskId);
	const backlogPayload = normalizeBacklogTask(task);
	const backlogHash = computeHash(backlogPayload);

	// Check if task is already mapped
	const mapping = store.getMapping(taskId);

	if (mapping) {
		// Update existing issue
		const issue = await jira.getIssue(mapping.jiraKey);
		const jiraPayload = normalizeJiraIssue(issue);
		const jiraHash = computeHash(jiraPayload);

		// Check sync state unless force is enabled
		if (!force) {
			const snapshots = store.getSnapshots(taskId);
			const state = classifySyncState(
				backlogHash,
				jiraHash,
				snapshots.backlog,
				snapshots.jira,
				{ backlog: backlogPayload, jira: jiraPayload },
			);

			if (state.state === "Conflict") {
				throw new Error(
					`Conflict detected. Use --force to override or run 'backlog-jira sync' to resolve`,
				);
			}
		}

		// Build updates
		const updates = await buildJiraUpdates(
			task,
			issue,
			jira,
			projectKey,
			overridden,
		);
		const mappedUpdates = buildMappedJiraFields(
			readTaskFrontmatter(taskId),
			issue,
			fieldMappings,
		);

		if (dryRun) {
			logger.info(
				{
					taskId,
					jiraKey: mapping.jiraKey,
					updates,
					mappedFields: mappedUpdates.fields,
				},
				"DRY RUN: Would update Jira issue",
			);
			if (sprints) await pushSprint(sprints, taskId, issue);
		} else {
			// Update issue fields; mapped fields that Jira rejects are reported
			// individually after the rest of the push completes
			const failures = await updateIssueWithMappedFields(
				jira,
				mapping.jiraKey,
				updates.fields,
				mappedUpdates,
			);

			// Handle status transitions
			if (updates.transition) {
				await jira.transitionIssue(mapping.jiraKey, updates.transition.id, {
					comment: updates.transition.comment,
				});
			}

			// The milestone moves the issue between sprints; sprint problems are
			// reported like mapped field failures after the rest is pushed
			const sprintFailures = sprints
				? await pushSprint(sprints, taskId, issue, force)
				: [];

			// Update snapshots with re-fetched data
			const updatedIssue = await jira.getIssue(mapping.jiraKey);
			if (failures.length > 0) {
				recordPartialPush(
					store,
					taskId,
					task,
					updatedIssue,
					failures,
					fieldMappings,
				);
				throw new MappedFieldPushError(mapping.jiraKey, [
					...failures,
					...sprintFailures,
				]);
			}
			recordSyncedSnapshots(
				store,
				taskId,
				{
					backlog: normalizeBacklogTask(task),
					jira: normalizeJiraIssue(updatedIssue),
				},
				"backlog",
				fieldMappings,
			);

			store.updateSyncState(taskId, {
				lastSyncAt: new Date().toISOString(),
			});

			// Update frontmatter with Jira metadata
			try {
				const filePath = getTaskFilePath(taskId);
				const jiraUrl = process.env.JIRA_URL
					? `${process.env.JIRA_URL}/browse/${mapping.jiraKey}`
					: undefined;

				updateJiraMetadata(filePath, {
					jiraKey: mapping.jiraKey,
					jiraUrl,
					jiraLastSync: new Date().toISOString(),
					jiraSyncState: "InSync",
				});

				logger.debug(
					{ taskId, jiraKey: mapping.jiraKey },
					"Updated frontmatter with Jira metadata",
				);
			} catch (error) {
				logger.error(
					{ taskId, error },
					"Failed to update frontmatter, but push was successful",
				);
			}

			if (sprintFailures.length > 0) {
				throw new MappedFieldPushError(mapping.jiraKey, sprintFailures);
			}
		}
	} else {
		// Create new issue
		const mappedUpdates = buildMappedJiraFields(
			readTaskFrontmatter(taskId),
			null,
			fieldMappings,
		);

		if (dryRun) {
			logger.info(
				{ taskId, projectKey, issueType, mappedFields: mappedUpdates.fields },
				"DRY RUN: Would create new Jira issue",
			);
		} else {
			// Merge description with AC, plan, and notes for new issue creation
			const descriptionWithAc = task.acceptanceCriteria
				? mergeDescriptionWithAc(
						task.description || "",
						task.acceptanceCriteria,
						task.implementationPlan,
						task.implementationNotes,
					)
				: task.description;

			// Map assignee using assignee mapping
			const mappedAssignee = task.assignee
				? mapBacklogAssigneeToJira(task.assignee)
				: undefined;

			if (task.assignee && !mappedAssignee) {
				logger.warn(
					{ taskId, assignee: task.assignee },
					"No Jira user mapping found for Backlog assignee. Configure mapping with: backlog-jira map-assignees add",
				);
			}

			const { issue, failures } = await createIssueWithMappedFields(
				jira,
				projectKey,
				issueType,
				task.title,
				{
					description: descriptionWithAc,
					assignee: mappedAssignee || undefined,
					priority:
						task.priority && !overridden.has("priority")
							? mapBacklogPriorityToJira(task.priority)
							: undefined,
					labels: overridden.has("labels") ? undefined : task.labels,
				},
				mappedUpdates,
			);

			// Create mapping
			store.addMapping(taskId, issue.key);

			const sprintFailures = sprints
				? await pushSprint(sprints, taskId, issue)
				: [];

			// Store initial snapshots
			if (failures.length > 0) {
				const createdIssue = await jira.getIssue(issue.key);
				recordPartialPush(
					store,
					taskId,
					task,
					createdIssue,
					failures,
					fieldMappings,
				);
			} else {
				store.setSnapshot(
					taskId,
					"backlog",
					backlogHash,
					normalizeBacklogTask(task),
				);
				store.setSnapshot(
					taskId,
					"jira",
					backlogHash,
					normalizeJiraIssue(issue),
				);
			}

			store.updateSyncState(taskId, {
				lastSyncAt: new Date().toISOString(),
			});

			// Update frontmatter with Jira metadata for new issue
			try {
				const filePath = getTaskFilePath(taskId);
				const jiraUrl = process.env.JIRA_URL
					? `${process.env.JIRA_URL}/browse/${issue.key}`
					: undefined;

				updateJiraMetadata(filePath, {
					jiraKey: issue.key,
					jiraUrl,
					jiraLastSync: new Date().toISOString(),
					jiraSyncState: failures.length > 0 ? "NeedsPush" : "InSync",
				});

				logger.debug(
					{ taskId, jiraKey: issue.key },
					"Updated frontmatter with Jira metadata for new issue",
				);
			} catch (error) {
				logger.error(
					{ taskId, error },
					"Failed to update frontmatter, but push was successful",
				);
			}

			if (failures.length > 0 || sprintFailures.length > 0) {
				throw new MappedFieldPushError(issue.key, [
					...failures,
					...sprintFailures,
				]);
			}

			logger.info({ taskId, jiraKey: issue.key }, "Created new Jira issue");
		}
	}
}

/**
 * Push a task's milestone as the issue's sprint; problems come back as
 * failures of the sprint mapping so the rest of the task still pushes
 */
async function pushSprint(
	sprints: SprintPushContext,
	taskId: string,
	issue: JiraIssue,
	force = false,
): Promise<MappedFieldFailure[]> {
	try {
		const result = await pushTaskSprint(sprints, taskId, issue, { force });
		if (result.status === "skipped") {
			logger.debug({ taskId, reason: result.reason }, "Sprint not pushed");
		}
		return result.status === "failed"
			? [{ mapping: sprints.mapping, error: result.reason ?? "unknown error" }]
			: [];
	} catch (error) {
		return [
			{
				mapping: sprints.mapping,
				error: error instanceof Error ? error.message : String(error),
			},
		];
	}
}

/**
 * Build Jira updates from Backlog task
 */
export async function buildJiraUpdates(
	task: BacklogTask,
	currentIssue: JiraIssue,
	jiraClient: Pick<JiraClient, "getTransitions">,
	projectKey: string,
	overridden: Set<string> = new Set(),
): Promise<{
	fields: {
		summary?: string;
		description?: string;
		assignee?: string;
		priority?: string;
		labels?: string[];
	};
	transition?: {
		id: string;
		comment?: string;
	};
}> {
	const fields: Record<string, unknown> = {};

	// Title -> Summary
	if (task.title !== currentIssue.summary) {
		fields.summary = task.title;
	}

	// Description with AC, plan, and notes
	// Always merge description with AC when task has AC
	const taskDescriptionWithAc = task.acceptanceCriteria
		? mergeDescriptionWithAc(
				task.description || "",
				task.acceptanceCriteria,
				task.implementationPlan,
				task.implementationNotes,
			)
		: task.description || "";

	// Compare with current Jira description (also strip AC for fair comparison)
	const currentJiraDescClean = stripAcceptanceCriteriaFromDescription(
		currentIssue.description || "",
	);
	const taskDescClean = stripAcceptanceCriteriaFromDescription(
		task.description || "",
	);

	// Update description if either the base description changed OR the AC changed
	if (
		taskDescClean !== currentJiraDescClean ||
		JSON.stringify(task.acceptanceCriteria) !==
			JSON.stringify(normalizeBacklogTask(task).acceptanceCriteria)
	) {
		fields.description = taskDescriptionWithAc;
		logger.debug({ taskId: task.id }, "Updating Jira description with AC");
	}

	// Assignee (with mapping)
	if (task.assignee) {
		const mappedAssignee = mapBacklogAssigneeToJira(task.assignee);

		if (!mappedAssignee) {
			logger.warn(
				{ taskId: task.id, assignee: task.assignee },
				"No Jira user mapping found for Backlog assignee. Configure mapping with: backlog-jira map-assignees add",
			);
		} else if (mappedAssignee !== currentIssue.assignee) {
			fields.assignee = mappedAssignee;
			logger.debug(
				{
					taskId: task.id,
					backlogAssignee: task.assignee,
					jiraAssignee: mappedAssignee,
				},
				"Mapped Backlog assignee to Jira user",
			);
		}
	}

	// Priority (needs mapping from Backlog priority to Jira priority).
	// Skipped when a field mapping carries priority instead.
	if (task.priority && !overridden.has("priority")) {
		const mappedPriority = mapBacklogPriorityToJira(task.priority);
		if (mappedPriority && mappedPriority !== currentIssue.priority) {
			fields.priority = mappedPriority;
			logger.debug(
				{
					taskId: task.id,
					backlogPriority: task.priority,
					jiraPriority: mappedPriority,
				},
				"Mapped Backlog priority to Jira priority",
			);
		}
	}

	// Labels (skipped when a field mapping carries labels instead)
	if (
		!overridden.has("labels") &&
		task.labels &&
		JSON.stringify(task.labels) !== JSON.stringify(currentIssue.labels)
	) {
		fields.labels = task.labels;
	}

	// Status transition (query available transitions and map)
	let transition: { id: string; comment?: string } | undefined;

	// Handle status changes by querying available transitions
	if (task.status && task.status !== currentIssue.status) {
		const transitionResult = await findTransitionForStatus(
			jiraClient,
			currentIssue.key,
			task.status,
			projectKey,
		);

		if (transitionResult.success && transitionResult.transitionId) {
			transition = {
				id: transitionResult.transitionId,
				comment: `Status updated from Backlog: ${currentIssue.status} → ${task.status}`,
			};
			logger.info(
				{
					taskId: task.id,
					from: currentIssue.status,
					to: task.status,
					transitionId: transitionResult.transitionId,
					transitionName: transitionResult.transitionName,
				},
				"Status transition found",
			);
		} else {
			logger.warn(
				{
					taskId: task.id,
					from: currentIssue.status,
					to: task.status,
					error: transitionResult.error,
				},
				"Failed to find status transition",
			);
			// Don't throw - log the warning and continue with other field updates
		}
	}

	return { fields, transition };
}

/**
 * Load configuration from .backlog-jira/config.json
 */
function loadConfig(): {
	jira?: {
		baseUrl?: string;
		projectKey?: string;
		issueType?: string;
	};
} {
	try {
		const configPath = join(process.cwd(), ".backlog-jira", "config.json");
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		logger.warn({ error }, "Failed to load config, using defaults");
		return {};
	}
}
