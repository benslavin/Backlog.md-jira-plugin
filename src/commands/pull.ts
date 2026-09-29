import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import {
	JiraClient,
	type JiraClientOptions,
	type JiraIssue,
} from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/store.ts";
import {
	autoDiscoverAndSaveMapping,
	mapJiraUserToBacklog,
} from "../utils/assignee-mapping.ts";
import {
	type FieldMapping,
	type MappedCliUpdates,
	type SprintMapping,
	buildMappedFieldUpdates,
	hasMappedFieldUpdates,
	isCoreOverrideTarget,
	loadFieldMappings,
	loadSprintMapping,
	readTaskFrontmatter,
} from "../utils/field-mapping.ts";
import {
	getTaskFilePath,
	updateFrontmatterFields,
	updateJiraMetadata,
} from "../utils/frontmatter.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";
import { recordSyncedSnapshots } from "../utils/mapped-field-sync.ts";
import {
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
	stripAcceptanceCriteriaFromDescription,
} from "../utils/normalizer.ts";
import { mapJiraPriorityToBacklog } from "../utils/priority-mapping.ts";
import {
	type SprintPullContext,
	applySprintPullScope,
	createSprintPullContext,
	pullTaskSprint,
	refreshRegisteredSprints,
	sprintNeedsPull,
} from "../utils/sprint-pull.ts";
import { mapJiraStatusToBacklog } from "../utils/status-mapping.ts";
import { classifySyncState } from "../utils/sync-state.ts";
import { sanitizeTitle } from "../utils/title-sanitizer.ts";

export interface PullOptions {
	taskIds?: string[];
	all?: boolean;
	import?: boolean;
	jql?: string;
	force?: boolean;
	dryRun?: boolean;
	verbose?: boolean;
	/**
	 * Sprint pull state shared across calls (sync pulls tasks one at a time
	 * in parallel and must not create a sprint's milestone twice); created
	 * per call when omitted
	 */
	sprintContext?: SprintPullContext | null;
}

export interface PullResult {
	success: boolean;
	pulled: string[];
	imported: string[];
	failed: Array<{ taskId: string; error: string }>;
	skipped: string[];
	/** Problems that did not fail a task (e.g. sprint milestone updates) */
	warnings: string[];
}

/**
 * Pull Jira issues to Backlog tasks
 * Updates existing mapped tasks via CLI only (no direct file writes)
 */
export async function pull(options: PullOptions = {}): Promise<PullResult> {
	// Set log level based on verbose flag
	const originalLevel = logger.level;
	if (!options.verbose) {
		logger.level = "error"; // Suppress info/debug logs in non-verbose mode
	}

	logger.info({ options }, "Starting pull operation");

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

	const result: PullResult = {
		success: true,
		pulled: [],
		imported: [],
		failed: [],
		skipped: [],
		warnings: [],
	};

	let sprints: SprintPullContext | null = null;
	let warningsFrom = 0;
	try {
		sprints =
			options.sprintContext !== undefined
				? options.sprintContext
				: await createSprintPullContext(
						sprintMapping,
						{ jira, backlog },
						{ dryRun: options.dryRun },
					);
		if (sprints && options.sprintContext) {
			// The shared context's client may differ from this call's
			jira.includeIssueFields([sprints.sprintFieldId]);
		}
		warningsFrom = sprints?.warnings.length ?? 0;
		// Bulk pulls also bring milestones of registered sprints in step with
		// the board; pulls of given tasks (as from sync) reconcile only the
		// sprints of those tasks
		if (sprints && !options.taskIds?.length) {
			try {
				await refreshRegisteredSprints(sprints);
			} catch (error) {
				sprints.warnings.push(
					`Could not refresh sprints of board ${sprints.mapping.boardId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Get list of tasks to pull and issues to import
		const { mapped, unmapped } = await getTaskIds(
			options,
			backlog,
			jira,
			store,
			sprints,
		);

		logger.info(
			{ mappedCount: mapped.length, unmappedCount: unmapped.length },
			"Tasks to process",
		);

		// First, import unmapped issues if in import mode
		if (options.import && unmapped.length > 0) {
			logger.info({ count: unmapped.length }, "Importing unmapped issues");
			const batchSize = 10;
			for (let i = 0; i < unmapped.length; i += batchSize) {
				const batch = unmapped.slice(i, i + batchSize);
				const promises = batch.map(async (jiraKey) => {
					try {
						const taskId = await importJiraIssue(jiraKey, {
							store,
							backlog,
							jira,
							fieldMappings,
							sprints,
							dryRun: options.dryRun || false,
						});

						result.imported.push(taskId);
						logger.info({ taskId, jiraKey }, "Successfully imported issue");
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						result.failed.push({ taskId: jiraKey, error: errorMsg });
						logger.error(
							{ jiraKey, error: errorMsg },
							"Failed to import issue",
						);
						result.success = false;
					}
				});

				await Promise.all(promises);
			}
		}

		// Then, pull mapped tasks
		if (mapped.length > 0) {
			logger.info({ count: mapped.length }, "Pulling mapped tasks");
			const batchSize = 10;
			for (let i = 0; i < mapped.length; i += batchSize) {
				const batch = mapped.slice(i, i + batchSize);
				const promises = batch.map(async (taskId) => {
					try {
						await pullTask(taskId, {
							store,
							backlog,
							jira,
							fieldMappings,
							sprints,
							force: options.force || false,
							dryRun: options.dryRun || false,
						});

						result.pulled.push(taskId);
						logger.info({ taskId }, "Successfully pulled task");
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						result.failed.push({ taskId, error: errorMsg });
						logger.error({ taskId, error: errorMsg }, "Failed to pull task");
						result.success = false;
					}
				});

				await Promise.all(promises);
			}
		}

		store.logOperation(
			"pull",
			null,
			null,
			result.success ? "success" : "partial",
			JSON.stringify(result),
		);
	} finally {
		if (sprints) result.warnings.push(...sprints.warnings.slice(warningsFrom));
		store.close();
		await jira.close();
		// Restore original log level
		logger.level = originalLevel;
	}

	logger.info({ result }, "Pull operation completed");
	return result;
}

/**
 * Get list of task IDs to pull
 * Returns { mapped: taskIds, unmapped: jiraKeys }
 */
async function getTaskIds(
	options: PullOptions,
	backlog: BacklogClient,
	jira: JiraClient,
	store: FrontmatterStore,
	sprints: SprintPullContext | null,
): Promise<{ mapped: string[]; unmapped: string[] }> {
	if (options.taskIds && options.taskIds.length > 0) {
		return { mapped: options.taskIds, unmapped: [] };
	}

	if (options.all) {
		// Get all tasks that have mappings
		const mappings = store.getAllMappings();
		return { mapped: Array.from(mappings.keys()), unmapped: [] };
	}

	// Import mode: fetch Jira issues via JQL
	if (options.import) {
		return await getIssuesForImport(
			options,
			jira,
			store,
			sprints?.mapping ?? null,
		);
	}

	// Default: get tasks that need pull (changed on Jira side)
	const mappings = store.getAllMappings();
	const needsPull: string[] = [];

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
				state.state === "NeedsPull" ||
				// Sprint changes are not part of the synced payload
				(state.state === "InSync" &&
					sprints &&
					sprintNeedsPull(sprints, taskId, issue))
			) {
				needsPull.push(taskId);
			}
		} catch (error) {
			logger.warn({ taskId, jiraKey, error }, "Failed to check sync state");
		}
	}

	return { mapped: needsPull, unmapped: [] };
}

/**
 * Get Jira issues for import using JQL filter
 */
async function getIssuesForImport(
	options: PullOptions,
	jira: JiraClient,
	store: FrontmatterStore,
	sprintMapping: SprintMapping | null,
): Promise<{ mapped: string[]; unmapped: string[] }> {
	// Get JQL from options or config
	let jql = options.jql;

	if (!jql) {
		// Try to load from config
		try {
			const configPath = join(process.cwd(), ".backlog-jira", "config.json");
			if (existsSync(configPath)) {
				const config = JSON.parse(readFileSync(configPath, "utf-8"));
				jql = config.jira?.jqlFilter;
			}
		} catch (error) {
			logger.warn({ error }, "Failed to load JQL from config");
		}
	}

	if (!jql) {
		// Default JQL: project = PROJECTKEY
		const projectKey = process.env.JIRA_PROJECT;
		if (projectKey) {
			jql = `project = ${projectKey} ORDER BY created DESC`;
		} else {
			throw new Error(
				"No JQL filter provided. Use --jql option or configure jqlFilter in config.json",
			);
		}
	}

	// pullScope "open" limits pulled issues to open sprints
	jql = applySprintPullScope(jql, sprintMapping);

	logger.info({ jql }, "Fetching Jira issues for import");

	// Search for issues
	const result = await jira.searchIssues(jql, { maxResults: 50 });
	logger.info(
		{ count: result.issues.length, total: result.total },
		"Found Jira issues",
	);

	// Separate mapped and unmapped issues
	const mapped: string[] = [];
	const unmapped: string[] = [];

	for (const issue of result.issues) {
		const mapping = store.getMappingByJiraKey(issue.key);
		if (mapping) {
			// Already mapped - will be pulled
			mapped.push(mapping.backlogId);
		} else {
			// Unmapped - will be imported
			unmapped.push(issue.key);
		}
	}

	logger.info(
		{ mappedCount: mapped.length, unmappedCount: unmapped.length },
		"Categorized issues for import",
	);

	return { mapped, unmapped };
}

/**
 * Get a list of unique assignees from existing Backlog tasks
 * This is used for automatic assignee discovery
 */
async function getAvailableBacklogAssignees(
	backlog: BacklogClient,
): Promise<string[]> {
	try {
		const tasks = await backlog.listTasks();
		const assignees = new Set<string>();

		for (const task of tasks) {
			if (task.assignee) {
				assignees.add(task.assignee);
			}
		}

		logger.debug(
			{ count: assignees.size, assignees: Array.from(assignees) },
			"Retrieved available Backlog assignees for auto-discovery",
		);

		return Array.from(assignees);
	} catch (error) {
		logger.warn(
			{ error },
			"Failed to retrieve Backlog assignees for auto-discovery",
		);
		return [];
	}
}

/**
 * Pull a single Jira issue to Backlog task
 */
async function pullTask(
	taskId: string,
	context: {
		store: FrontmatterStore;
		backlog: BacklogClient;
		jira: JiraClient;
		fieldMappings: FieldMapping[];
		sprints: SprintPullContext | null;
		force: boolean;
		dryRun: boolean;
	},
): Promise<void> {
	const { store, backlog, jira, fieldMappings, sprints, force, dryRun } =
		context;

	// Get mapping
	const mapping = store.getMapping(taskId);
	logger.info({ taskId, mapping }, "Retrieved mapping from store");
	if (!mapping) {
		throw new Error(`No Jira mapping found for task ${taskId}`);
	}

	// Get current state
	const task = await backlog.getTask(taskId);
	logger.info(
		{ mappingJiraKey: mapping.jiraKey, mappingKeys: Object.keys(mapping) },
		"Accessing mapping.jiraKey",
	);
	const issue = await jira.getIssue(mapping.jiraKey);

	const backlogPayload = normalizeBacklogTask(task);
	const jiraPayload = normalizeJiraIssue(issue);
	const backlogHash = computeHash(backlogPayload);
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

		if (state.state === "InSync") {
			// Sprint changes are not part of the synced payload
			if (sprints) await pullSprint(sprints, taskId, issue, force);
			logger.info({ taskId }, "Task already in sync, skipping");
			return;
		}
	}

	// Build CLI updates from Jira issue
	// Extract project key from Jira issue key (format: PROJECT-123)
	const projectKey = issue.key.split("-")[0];

	// Attempt auto-discovery for assignee if no mapping exists
	if (issue.assignee && !mapJiraUserToBacklog(issue.assignee)) {
		logger.info(
			{ taskId, jiraAssignee: issue.assignee },
			"No explicit mapping found for Jira user during pull, attempting auto-discovery...",
		);

		const availableAssignees = await getAvailableBacklogAssignees(backlog);
		if (availableAssignees.length > 0) {
			const discovered = autoDiscoverAndSaveMapping(
				issue.assignee,
				availableAssignees,
			);

			if (discovered) {
				logger.info(
					{ taskId, jiraAssignee: issue.assignee, backlogAssignee: discovered },
					"Successfully auto-discovered and saved assignee mapping during pull",
				);
			} else {
				logger.debug(
					{ taskId, jiraAssignee: issue.assignee },
					"No suitable match found during auto-discovery",
				);
			}
		}
	}

	const updates = buildBacklogUpdates(issue, task, projectKey, fieldMappings);
	const mappedUpdates = buildMappedFieldUpdates(
		issue,
		readTaskFrontmatter(taskId),
		fieldMappings,
	);
	Object.assign(updates, mappedUpdates.cli);

	if (dryRun) {
		logger.info(
			{ taskId, updates, frontmatter: mappedUpdates.frontmatter },
			"DRY RUN: Would update Backlog task",
		);
		if (sprints) await pullSprint(sprints, taskId, issue);
	} else {
		// Apply updates via Backlog CLI
		if (Object.keys(updates).length > 0) {
			await backlog.updateTask(taskId, updates);
		}

		// Plugin-owned frontmatter fields are written after the CLI edit,
		// which may rewrite the task file
		applyMappedFrontmatter(taskId, issue, fieldMappings);

		if (sprints) await pullSprint(sprints, taskId, issue, force);

		// Update snapshots with freshly updated data
		const updatedTask = await backlog.getTask(taskId);
		recordSyncedSnapshots(
			store,
			taskId,
			{
				backlog: normalizeBacklogTask(updatedTask),
				jira: normalizeJiraIssue(issue),
			},
			"jira",
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
				"Failed to update frontmatter, but pull was successful",
			);
		}

		logger.info(
			{ taskId, jiraKey: mapping.jiraKey },
			"Updated Backlog task from Jira",
		);
	}
}

/**
 * Apply an issue's sprint to its task; a failure is reported as a warning
 * so the rest of the task still pulls
 */
async function pullSprint(
	sprints: SprintPullContext,
	taskId: string,
	issue: JiraIssue,
	force = false,
): Promise<void> {
	try {
		await pullTaskSprint(sprints, taskId, issue, { force });
	} catch (error) {
		sprints.warnings.push(
			`${taskId}: sprint not pulled: ${error instanceof Error ? error.message : String(error)}`,
		);
		logger.warn({ taskId, error }, "Failed to pull sprint");
	}
}

/**
 * Build Backlog CLI updates from Jira issue
 * Returns updates compatible with BacklogClient.updateTask()
 */
export function buildBacklogUpdates(
	issue: JiraIssue,
	currentTask: BacklogTask,
	projectKey?: string,
	fieldMappings: FieldMapping[] = [],
): MappedCliUpdates & {
	title?: string;
	description?: string;
	status?: string;
	assignee?: string;
	labels?: string[];
	priority?: string;
	addAc?: string[];
	removeAc?: number[];
	checkAc?: number[];
	uncheckAc?: number[];
} {
	const updates: Record<string, unknown> = {};

	// Core fields replaced by a field mapping (in any direction) are handled
	// by the mapping; the built-in Jira field is then not synced
	const overridden = new Set(
		fieldMappings.map((m) => m.backlog).filter(isCoreOverrideTarget),
	);

	// Summary -> Title (sanitized for YAML safety)
	const sanitizedTitle = sanitizeTitle(issue.summary);
	if (sanitizedTitle !== currentTask.title) {
		updates.title = sanitizedTitle;
	}

	// Description (without AC section - AC synced separately)
	const cleanJiraDesc = stripAcceptanceCriteriaFromDescription(
		issue.description || "",
	);
	const cleanTaskDesc = stripAcceptanceCriteriaFromDescription(
		currentTask.description || "",
	);

	if (cleanJiraDesc !== cleanTaskDesc) {
		updates.description = cleanJiraDesc;
	}

	// Status (needs mapping from Jira status to Backlog status)
	if (issue.status !== currentTask.status) {
		updates.status = mapJiraStatusToBacklog(issue.status, projectKey);
		logger.debug(
			{
				taskId: currentTask.id,
				from: currentTask.status,
				to: updates.status,
				jiraStatus: issue.status,
			},
			"Mapped Jira status to Backlog status",
		);
	}

	// Assignee (with mapping)
	if (issue.assignee) {
		const mappedAssignee = mapJiraUserToBacklog(issue.assignee);

		if (!mappedAssignee) {
			logger.warn(
				{ taskId: currentTask.id, jiraAssignee: issue.assignee },
				"No Backlog assignee mapping found for Jira user. Configure mapping with: backlog-jira map-assignees add",
			);
			// Use Jira assignee directly as fallback
			if (issue.assignee !== currentTask.assignee) {
				updates.assignee = issue.assignee;
			}
		} else if (mappedAssignee !== currentTask.assignee) {
			updates.assignee = mappedAssignee;
			logger.debug(
				{
					taskId: currentTask.id,
					jiraAssignee: issue.assignee,
					backlogAssignee: mappedAssignee,
				},
				"Mapped Jira user to Backlog assignee",
			);
		}
	}

	// Labels
	if (
		!overridden.has("labels") &&
		issue.labels &&
		JSON.stringify(issue.labels) !== JSON.stringify(currentTask.labels)
	) {
		updates.labels = issue.labels;
	}

	// Priority (needs mapping from Jira priority to Backlog priority)
	if (issue.priority && !overridden.has("priority")) {
		const mappedPriority = mapJiraPriorityToBacklog(issue.priority);
		if (mappedPriority && mappedPriority !== currentTask.priority) {
			updates.priority = mappedPriority;
			logger.debug(
				{
					taskId: currentTask.id,
					from: currentTask.priority,
					to: mappedPriority,
					jiraPriority: issue.priority,
				},
				"Mapped Jira priority to Backlog priority",
			);
		}
	}

	// Acceptance Criteria synchronization
	const acUpdates = syncAcceptanceCriteria(issue, currentTask);
	if (acUpdates.addAc && acUpdates.addAc.length > 0) {
		updates.addAc = acUpdates.addAc;
	}
	if (acUpdates.removeAc && acUpdates.removeAc.length > 0) {
		updates.removeAc = acUpdates.removeAc;
	}
	if (acUpdates.checkAc && acUpdates.checkAc.length > 0) {
		updates.checkAc = acUpdates.checkAc;
	}
	if (acUpdates.uncheckAc && acUpdates.uncheckAc.length > 0) {
		updates.uncheckAc = acUpdates.uncheckAc;
	}

	return updates;
}

/**
 * Write mapped Jira values to plugin-owned frontmatter:<key> fields.
 * Compares against the file as it is now, so values dropped by an earlier
 * CLI edit are restored.
 */
function applyMappedFrontmatter(
	taskId: string,
	issue: JiraIssue,
	fieldMappings: FieldMapping[],
): void {
	if (fieldMappings.length === 0) return;

	const { frontmatter } = buildMappedFieldUpdates(
		issue,
		readTaskFrontmatter(taskId),
		fieldMappings,
	);
	if (Object.keys(frontmatter).length > 0) {
		updateFrontmatterFields(getTaskFilePath(taskId), frontmatter);
		logger.debug(
			{ taskId, fields: Object.keys(frontmatter) },
			"Applied mapped frontmatter fields",
		);
	}
}

/**
 * Sync acceptance criteria from Jira to Backlog
 * Returns operations needed to align Backlog AC with Jira AC
 */
function syncAcceptanceCriteria(
	issue: JiraIssue,
	currentTask: BacklogTask,
): {
	addAc?: string[];
	removeAc?: number[];
	checkAc?: number[];
	uncheckAc?: number[];
} {
	// Extract AC from Jira description
	const jiraAc = normalizeJiraIssue(issue).acceptanceCriteria;
	const backlogAc = currentTask.acceptanceCriteria || [];

	// If AC are identical, no sync needed
	if (JSON.stringify(jiraAc) === JSON.stringify(backlogAc)) {
		return {};
	}

	const addAc: string[] = [];
	const removeAc: number[] = [];
	const checkAc: number[] = [];
	const uncheckAc: number[] = [];

	// Simple approach: If AC lists are different, replace entirely
	// Remove all existing AC and add new ones
	if (
		jiraAc.length !== backlogAc.length ||
		JSON.stringify(jiraAc) !== JSON.stringify(backlogAc)
	) {
		// Remove all existing AC (in reverse order to avoid index issues)
		for (let i = backlogAc.length; i > 0; i--) {
			removeAc.push(i);
		}

		// Add all Jira AC
		for (const ac of jiraAc) {
			addAc.push(ac.text);
		}

		// Note: The checked state will be handled after AC are added
		// We'll need to check the ones that should be checked
		for (let i = 0; i < jiraAc.length; i++) {
			if (jiraAc[i].checked) {
				// AC indices are 1-based, and they'll be added in order
				checkAc.push(i + 1);
			}
		}
	}

	logger.debug(
		{
			taskId: currentTask.id,
			jiraAcCount: jiraAc.length,
			backlogAcCount: backlogAc.length,
			operations: {
				addAc: addAc.length,
				removeAc: removeAc.length,
				checkAc: checkAc.length,
			},
		},
		"Syncing acceptance criteria from Jira",
	);

	return { addAc, removeAc, checkAc, uncheckAc };
}

/**
 * Import a Jira issue as a new Backlog task
 * Creates task, maps it, and syncs initial data
 */
async function importJiraIssue(
	jiraKey: string,
	context: {
		store: FrontmatterStore;
		backlog: BacklogClient;
		jira: JiraClient;
		fieldMappings: FieldMapping[];
		sprints: SprintPullContext | null;
		dryRun: boolean;
	},
): Promise<string> {
	const { store, backlog, jira, fieldMappings, sprints, dryRun } = context;

	// Get Jira issue
	const issue = await jira.getIssue(jiraKey);
	logger.info({ jiraKey, summary: issue.summary }, "Importing Jira issue");

	// Extract and normalize acceptance criteria from description
	const normalized = normalizeJiraIssue(issue);
	const acceptanceCriteria = normalized.acceptanceCriteria;
	const cleanDescription = stripAcceptanceCriteriaFromDescription(
		issue.description || "",
	);

	// Extract project key for status mapping
	const projectKey = issue.key.split("-")[0];

	if (dryRun) {
		logger.info(
			{
				jiraKey,
				title: issue.summary,
				status: mapJiraStatusToBacklog(issue.status, projectKey),
				assignee: issue.assignee,
				acCount: acceptanceCriteria.length,
			},
			"DRY RUN: Would import Jira issue",
		);
		return `dry-run-${jiraKey}`;
	}

	// Map assignee from Jira to Backlog format
	let mappedAssignee = issue.assignee
		? mapJiraUserToBacklog(issue.assignee)
		: undefined;

	// If no mapping exists, attempt automatic discovery
	if (issue.assignee && !mappedAssignee) {
		logger.info(
			{ jiraKey, jiraAssignee: issue.assignee },
			"No explicit mapping found for Jira user, attempting auto-discovery...",
		);

		// Get available Backlog assignees for matching
		const availableAssignees = await getAvailableBacklogAssignees(backlog);

		if (availableAssignees.length > 0) {
			// Attempt auto-discovery and save mapping if found
			const discovered = autoDiscoverAndSaveMapping(
				issue.assignee,
				availableAssignees,
			);

			if (discovered) {
				mappedAssignee = discovered;
				logger.info(
					{
						jiraKey,
						jiraAssignee: issue.assignee,
						backlogAssignee: discovered,
					},
					"Successfully auto-discovered and saved assignee mapping",
				);
			} else {
				logger.warn(
					{ jiraKey, jiraAssignee: issue.assignee },
					"No suitable match found during auto-discovery. Using Jira identifier as fallback. Configure explicit mapping with: backlog-jira map-assignees add",
				);
			}
		} else {
			logger.warn(
				{ jiraKey, jiraAssignee: issue.assignee },
				"No Backlog assignees available for auto-discovery. Using Jira identifier as fallback.",
			);
		}
	}

	// Built-in priority/labels are not synced when a mapping replaces them
	const overridden = new Set(
		fieldMappings.map((m) => m.backlog).filter(isCoreOverrideTarget),
	);

	// Create Backlog task with sanitized title
	const taskId = await backlog.createTask({
		title: sanitizeTitle(issue.summary),
		description: cleanDescription,
		status: mapJiraStatusToBacklog(issue.status, projectKey),
		assignee: mappedAssignee || issue.assignee,
		labels: overridden.has("labels") ? undefined : issue.labels,
		priority: overridden.has("priority")
			? undefined
			: mapJiraPriorityToBacklog(issue.priority),
		// Add acceptance criteria during creation
		ac: acceptanceCriteria.map((ac) => ac.text),
	});

	logger.info({ taskId, jiraKey }, "Created Backlog task from Jira issue");

	// If AC have checked states, update them
	const checkedIndices = acceptanceCriteria
		.map((ac, idx) => (ac.checked ? idx + 1 : -1))
		.filter((idx) => idx > 0);

	if (checkedIndices.length > 0) {
		await backlog.updateTask(taskId, {
			checkAc: checkedIndices,
		});
		logger.debug(
			{ taskId, checkedIndices },
			"Updated acceptance criteria checked states",
		);
	}

	// Apply mapped fields (native fields via CLI, then frontmatter fields)
	const mappedUpdates = buildMappedFieldUpdates(
		issue,
		readTaskFrontmatter(taskId),
		fieldMappings,
	);
	if (hasMappedFieldUpdates(mappedUpdates)) {
		if (Object.keys(mappedUpdates.cli).length > 0) {
			await backlog.updateTask(taskId, mappedUpdates.cli);
		}
		applyMappedFrontmatter(taskId, issue, fieldMappings);
		logger.debug({ taskId, jiraKey }, "Applied mapped fields to imported task");
	}

	if (sprints) await pullSprint(sprints, taskId, issue);

	// Create mapping
	store.addMapping(taskId, jiraKey);
	logger.info({ taskId, jiraKey }, "Created mapping");

	// Set initial snapshots
	const task = await backlog.getTask(taskId);
	const syncedHash = computeHash(normalizeJiraIssue(issue));
	store.setSnapshot(taskId, "backlog", syncedHash, normalizeBacklogTask(task));
	store.setSnapshot(taskId, "jira", syncedHash, normalizeJiraIssue(issue));

	store.updateSyncState(taskId, {
		lastSyncAt: new Date().toISOString(),
	});

	// Update frontmatter with Jira metadata
	try {
		const filePath = getTaskFilePath(taskId);
		const jiraUrl = process.env.JIRA_URL
			? `${process.env.JIRA_URL}/browse/${jiraKey}`
			: undefined;

		updateJiraMetadata(filePath, {
			jiraKey,
			jiraUrl,
			jiraLastSync: new Date().toISOString(),
			jiraSyncState: "InSync",
		});

		logger.debug({ taskId, jiraKey }, "Updated frontmatter with Jira metadata");
	} catch (error) {
		logger.error(
			{ taskId, error },
			"Failed to update frontmatter, but import was successful",
		);
	}

	logger.info({ taskId, jiraKey }, "Successfully imported Jira issue");
	return taskId;
}
