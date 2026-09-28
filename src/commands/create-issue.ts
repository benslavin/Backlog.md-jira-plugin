import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import { JiraClient, type JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/store.ts";
import {
	type FieldMapping,
	FieldMappingConfigError,
	buildMappedJiraFields,
	readTaskFrontmatter,
	resolvePriorityMapping,
	validateFieldMappings,
	withoutBuiltInMappings,
} from "../utils/field-mapping.ts";
import { getTaskFilePath, updateJiraMetadata } from "../utils/frontmatter.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";
import {
	createIssueWithMappedFields,
	formatMappedFieldFailures,
	getOverriddenCoreFields,
	recordPartialPush,
} from "../utils/mapped-field-sync.ts";
import {
	computeHash,
	mergeDescriptionWithAc,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "../utils/normalizer.ts";
import { mapBacklogPriorityToJira } from "../utils/priority-mapping.ts";

export interface CreateIssueOptions {
	taskId: string;
	issueType?: string;
	dryRun?: boolean;
	configDir?: string;
}

export interface CreateIssueResult {
	success: boolean;
	taskId: string;
	jiraKey?: string;
	error?: string;
	/** Problems that did not prevent creation, e.g. mapped fields Jira rejected */
	warnings?: string[];
}

/**
 * Create a Jira issue from an unmapped Backlog task
 */
export async function createIssue(
	options: CreateIssueOptions,
): Promise<CreateIssueResult> {
	logger.info({ options }, "Starting create-issue operation");

	const { taskId, issueType, dryRun, configDir } = options;

	const store = new FrontmatterStore(configDir);
	const backlog = new BacklogClient();
	const jira = new JiraClient(getJiraClientOptions());

	try {
		// Validation: Check if task exists
		logger.debug({ taskId }, "Validating task exists");
		let task: BacklogTask;
		try {
			task = await backlog.getTask(taskId);
		} catch (error) {
			const errorMsg = `Task ${taskId} not found in Backlog`;
			logger.error({ taskId, error }, errorMsg);
			return {
				success: false,
				taskId,
				error: errorMsg,
			};
		}

		// Validation: Check if task is already mapped
		logger.debug({ taskId }, "Checking if task is already mapped");
		const existingMapping = store.getMapping(taskId);
		if (existingMapping) {
			const errorMsg = `Task ${taskId} is already mapped to Jira issue ${existingMapping.jiraKey}`;
			logger.warn({ taskId, jiraKey: existingMapping.jiraKey }, errorMsg);
			return {
				success: false,
				taskId,
				error: errorMsg,
			};
		}

		// Load configuration
		const config = loadConfig(options.configDir);
		const projectKey = config.jira?.projectKey;
		const defaultIssueType = config.jira?.issueType || "Task";
		const finalIssueType = issueType || defaultIssueType;

		if (!projectKey) {
			throw new Error(
				"Jira project key not configured in .backlog-jira/config.json",
			);
		}

		const { mappings: allFieldMappings, errors: mappingErrors } =
			validateFieldMappings(config.fieldMappings);
		if (mappingErrors.length > 0) {
			throw new FieldMappingConfigError(mappingErrors);
		}
		// A built-in priority override is applied by the core priority mapping
		const fieldMappings = withoutBuiltInMappings(allFieldMappings);
		const overridden = getOverriddenCoreFields(fieldMappings);

		// Build Jira issue from Backlog task
		logger.debug({ taskId }, "Building Jira issue from Backlog task");
		const issueData = buildJiraIssueFromBacklogTask(
			task,
			resolvePriorityMapping(allFieldMappings),
		);
		if (overridden.has("priority")) issueData.priority = undefined;
		if (overridden.has("labels")) issueData.labels = undefined;

		// Mapped fields (push/both) with a value in Backlog
		const mappedUpdates = buildMappedJiraFields(
			readTaskFrontmatter(taskId),
			null,
			fieldMappings,
		);

		if (dryRun) {
			logger.info(
				{
					taskId,
					projectKey,
					issueType: finalIssueType,
					issueData,
				},
				"DRY RUN: Would create Jira issue",
			);
			console.log("\n🔍 DRY RUN - Would create Jira issue:");
			console.log(`  Project: ${projectKey}`);
			console.log(`  Issue Type: ${finalIssueType}`);
			console.log(`  Summary: ${issueData.summary}`);
			console.log(
				`  Description: ${issueData.description?.substring(0, 100)}...`,
			);
			console.log(`  Status: ${issueData.status || "Default"}`);
			console.log(`  Assignee: ${issueData.assignee || "Unassigned"}`);
			console.log(`  Priority: ${issueData.priority || "Default"}`);
			console.log(`  Labels: ${issueData.labels?.join(", ") || "None"}`);
			for (const change of mappedUpdates.changes) {
				const value = change.backlogValue;
				console.log(
					`  ${change.mapping.jira} (${change.mapping.backlog}): ${Array.isArray(value) ? value.join(", ") : value}`,
				);
			}
			for (const { mapping, error } of mappedUpdates.errors) {
				console.log(`  ${mapping.jira} (${mapping.backlog}): ⚠ ${error}`);
			}

			return {
				success: true,
				taskId,
			};
		}

		// Create Jira issue
		logger.info(
			{ taskId, projectKey, issueType: finalIssueType },
			"Creating Jira issue",
		);
		const { issue: createdIssue, failures } = await createIssueWithMappedFields(
			jira,
			projectKey,
			finalIssueType,
			issueData.summary,
			{
				description: issueData.description,
				assignee: issueData.assignee,
				priority: issueData.priority,
				labels: issueData.labels,
			},
			mappedUpdates,
		);

		logger.info(
			{ taskId, jiraKey: createdIssue.key },
			"Successfully created Jira issue",
		);

		// Create mapping
		store.addMapping(taskId, createdIssue.key);
		logger.debug(
			{ taskId, jiraKey: createdIssue.key },
			"Created task-Jira mapping",
		);

		// Create initial snapshots. Mapped fields Jira rejected stay pending
		// so the next push retries them.
		if (failures.length > 0) {
			recordPartialPush(
				store,
				taskId,
				task,
				await jira.getIssue(createdIssue.key),
				failures,
			);
		} else {
			const backlogHash = computeHash(normalizeBacklogTask(task));
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
				normalizeJiraIssue(createdIssue),
			);

			// Update sync state
			store.updateSyncState(taskId, {
				lastSyncAt: new Date().toISOString(),
			});
		}
		logger.debug({ taskId }, "Created initial snapshots");

		// Update task frontmatter with Jira metadata
		try {
			const filePath = getTaskFilePath(taskId);
			const jiraUrl = process.env.JIRA_URL
				? `${process.env.JIRA_URL}/browse/${createdIssue.key}`
				: undefined;

			updateJiraMetadata(filePath, {
				jiraKey: createdIssue.key,
				jiraUrl,
				jiraLastSync: new Date().toISOString(),
				jiraSyncState: failures.length > 0 ? "NeedsPush" : "InSync",
			});

			logger.debug(
				{ taskId, jiraKey: createdIssue.key },
				"Updated frontmatter with Jira metadata",
			);
		} catch (error) {
			logger.error(
				{ taskId, error },
				"Failed to update frontmatter, but issue was created successfully",
			);
		}

		// Log operation
		store.logOperation(
			"create-issue",
			taskId,
			createdIssue.key,
			"success",
			JSON.stringify({ jiraKey: createdIssue.key }),
		);

		return {
			success: true,
			taskId,
			jiraKey: createdIssue.key,
			...(failures.length > 0
				? {
						warnings: [formatMappedFieldFailures(createdIssue.key, failures)],
					}
				: {}),
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error({ taskId, error: errorMsg }, "Failed to create Jira issue");

		store.logOperation(
			"create-issue",
			taskId,
			null,
			"error",
			JSON.stringify({ error: errorMsg }),
		);

		return {
			success: false,
			taskId,
			error: errorMsg,
		};
	} finally {
		store.close();
		await jira.close();
	}
}

/**
 * Build Jira issue data from Backlog task
 */
function buildJiraIssueFromBacklogTask(
	task: BacklogTask,
	priorityMapping: FieldMapping,
): {
	summary: string;
	description?: string;
	status?: string;
	assignee?: string;
	priority?: string;
	labels?: string[];
} {
	// Title -> Summary
	const summary = task.title;

	// Description with AC merged
	const description = task.acceptanceCriteria
		? mergeDescriptionWithAc(task.description || "", task.acceptanceCriteria)
		: task.description;

	// Status (will be handled by status mapping if needed)
	const status = task.status;

	// Assignee (remove @ prefix if present)
	const assignee = task.assignee?.replace(/^@/, "");

	// Priority (map from Backlog to Jira)
	const priority = task.priority
		? mapBacklogPriorityToJira(task.priority, priorityMapping)
		: undefined;

	// Labels
	const labels = task.labels;

	return {
		summary,
		description,
		status,
		assignee,
		priority,
		labels,
	};
}

/**
 * Load configuration from .backlog-jira/config.json
 */
function loadConfig(configDir?: string): {
	jira?: {
		baseUrl?: string;
		projectKey?: string;
		issueType?: string;
	};
	fieldMappings?: unknown;
} {
	try {
		const baseDir = configDir || join(process.cwd(), ".backlog-jira");
		const configPath = join(baseDir, "config.json");
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		logger.warn({ error }, "Failed to load config, using defaults");
		return {};
	}
}
