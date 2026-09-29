import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import { JiraClient, type JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/store.ts";
import { promptForConflictResolution } from "../ui/conflict-resolver.ts";
import {
	type FieldMapping,
	type MappedValue,
	type SprintMapping,
	loadFieldMappings,
	loadSprintMapping,
	readTaskFrontmatter,
} from "../utils/field-mapping.ts";
import { getTaskFilePath, updateJiraMetadata } from "../utils/frontmatter.ts";
import { formatIdPair, resolveTaskArgs } from "../utils/id-resolver.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";
import {
	MappedFieldPushError,
	type MappedFieldState,
	applyMappedFieldMerge,
	detectMappedFieldConflicts,
	getOverriddenCoreFields,
	parseManualMappedValue,
	planMappedFieldMerge,
} from "../utils/mapped-field-sync.ts";
import {
	type NormalizedPayload,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "../utils/normalizer.ts";
import { SPRINT_CONFLICT_FIELD } from "../utils/sprint-payload.ts";
import {
	type SprintSyncContext,
	applySprintMerge,
	createSprintSyncContext,
	detectSprintConflict,
	planSprintMerge,
} from "../utils/sprint-sync.ts";
import { type SyncState, classifySyncState } from "../utils/sync-state.ts";
import { pull } from "./pull.ts";
import { push } from "./push.ts";
import {
	BUILTIN_CONFLICT_FIELDS,
	applyBuiltinFieldMerge,
	detectBuiltinFieldConflicts,
	planBuiltinFieldMerge,
} from "./sync-merge.ts";

export type ConflictStrategy =
	| "prefer-backlog"
	| "prefer-jira"
	| "prompt"
	| "manual";

export interface SyncOptions {
	taskIds?: string[];
	all?: boolean;
	strategy?: ConflictStrategy;
	dryRun?: boolean;
	verbose?: boolean;
}

export interface SyncResult {
	success: boolean;
	synced: string[];
	conflicts: Array<{
		taskId: string;
		resolution: string;
	}>;
	failed: Array<{ taskId: string; error: string }>;
	skipped: string[];
	// Optional user-facing hints to display (e.g., proxy login guidance)
	hints?: string[];
	/** Problems that did not fail a task (e.g. sprint milestone updates) */
	warnings?: string[];
}

export interface Conflict {
	taskId: string;
	jiraKey: string;
	fields: FieldConflict[];
	backlogTask: BacklogTask;
	jiraIssue: JiraIssue;
	baseBacklog: unknown;
	baseJira: unknown;
	/** State of mapped fields when the conflict was detected */
	mappedState?: MappedFieldState;
}

export interface FieldConflict {
	field: string;
	backlogValue: unknown;
	jiraValue: unknown;
	baseValue: unknown;
	/** Set when the field is a user-defined field mapping */
	mapping?: FieldMapping;
}

/**
 * Bidirectional sync with 3-way merge and conflict resolution
 */
export async function sync(options: SyncOptions = {}): Promise<SyncResult> {
	// In non-verbose mode, filter noisy FastMCP stderr/stdout chatter from console
	let restoreIo: (() => void) | null = null;
	if (!options.verbose) {
		const patterns = [
			/\bFastMCP\b/,
			/\bmcp-jira\b/,
			/\batlassian\.rest_client\b/,
			/\btool_manager\.py:/,
			/Traceback \(most recent call last\):/,
			/Unexpected return value type from `jira\.get_issue`/,
			/Starting MCP server/,
			/ERROR\s-\s/,
			/INFO\s-\s/,
		];
		const shouldFilter = (s: string) => patterns.some((p) => p.test(s));
		type Write = NodeJS.WriteStream["write"];
		const filtered = (stream: NodeJS.WriteStream, orig: Write): Write =>
			((chunk: string | Uint8Array, ...rest: unknown[]) => {
				try {
					const s =
						typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
					if (s && shouldFilter(s)) return true;
				} catch {}
				return Reflect.apply(orig, stream, [chunk, ...rest]);
			}) as Write;
		const origStdout = process.stdout.write;
		const origStderr = process.stderr.write;
		process.stdout.write = filtered(process.stdout, origStdout);
		process.stderr.write = filtered(process.stderr, origStderr);
		restoreIo = () => {
			process.stdout.write = origStdout;
			process.stderr.write = origStderr;
		};
	}
	// Set log level based on verbose flag
	const originalLevel = logger.level;
	if (!options.verbose) {
		logger.level = "error"; // Suppress info/debug logs in non-verbose mode
	}

	if (options.verbose) {
		logger.info({ options }, "Starting sync operation");
	}

	// Validate field mappings up front so config errors are reported clearly
	let fieldMappings: FieldMapping[];
	let sprintMapping: SprintMapping | null;
	try {
		fieldMappings = loadFieldMappings();
		sprintMapping = loadSprintMapping();
	} catch (error) {
		if (restoreIo) restoreIo();
		logger.level = originalLevel;
		throw error;
	}

	const store = new FrontmatterStore();
	const backlog = new BacklogClient();
	// Build Jira client options separately (readability + allows silent mode)
	const jiraClientOptions = getJiraClientOptions();
	jiraClientOptions.silentMode = !options.verbose;
	const jira = new JiraClient(jiraClientOptions);

	const config = loadConfig();
	const defaultStrategy =
		(config.sync?.conflictStrategy as ConflictStrategy) || "prompt";
	const strategy = options.strategy || defaultStrategy;

	const result: SyncResult = {
		success: true,
		synced: [],
		conflicts: [],
		failed: [],
		skipped: [],
		hints: [],
		warnings: [],
	};

	let sprints: SprintSyncContext | null = null;
	try {
		// Shared by every task so parallel syncs agree on sprints and milestones
		sprints = await createSprintSyncContext(sprintMapping, { jira, backlog });

		// Get list of tasks to sync; given IDs may be Jira keys of linked tasks
		const requested = options.taskIds?.length
			? resolveTaskArgs(options.taskIds, store)
			: null;
		for (const { input, error } of requested?.errors ?? []) {
			result.failed.push({ taskId: input, error });
			result.success = false;
		}
		const taskIds = requested?.taskIds ?? getTaskIds(options, store);

		logger.info({ count: taskIds.length, strategy }, "Tasks to process");

		// Process in parallel batches for better performance (max 10 concurrent)
		const batchSize = 10;
		for (let i = 0; i < taskIds.length; i += batchSize) {
			const batch = taskIds.slice(i, i + batchSize);
			const promises = batch.map(async (taskId) => {
				try {
					const outcome = await syncTask(taskId, {
						store,
						backlog,
						jira,
						strategy,
						fieldMappings,
						sprints,
						dryRun: options.dryRun || false,
					});

					if (outcome.type === "synced") {
						result.synced.push(taskId);
					} else if (outcome.type === "conflict") {
						result.conflicts.push({
							taskId,
							resolution: outcome.resolution,
						});
					} else if (outcome.type === "skipped") {
						result.skipped.push(taskId);
					}

					logger.info({ taskId, outcome }, "Sync task completed");
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					// Get jira key for nicer message
					const m = store.getMapping(taskId);
					const jiraKey = m?.jiraKey;
					const minimal = `${formatIdPair(taskId, jiraKey)} sync failed`;
					// Push minimal message for user-friendly output; mapped field
					// failures name the fields so they can be fixed
					result.failed.push({
						taskId,
						error:
							error instanceof MappedFieldPushError
								? `${minimal}\n${error.message}`
								: minimal,
					});
					// Smart proxy hint detection
					const em = errorMsg.toLowerCase();
					if (
						em.includes("expecting value") ||
						em.includes("jsondecodeerror") ||
						em.includes("proxy authentication") ||
						(em.includes("login") && em.includes("html"))
					) {
						const jiraUrl = process.env.JIRA_URL || "your Jira URL";
						const hint = `Hint: If you're behind a corporate proxy, open ${jiraUrl} in your browser, sign in, then retry. Use --verbose for details.`;
						result.hints ??= [];
						if (!result.hints.includes(hint)) result.hints.push(hint);
					}
					// Only log detailed error when verbose
					if (options.verbose) {
						logger.error({ taskId, error: errorMsg }, "Failed to sync task");
					}
					result.success = false;
				}
			});

			await Promise.all(promises);
		}

		store.logOperation(
			"sync",
			null,
			null,
			result.success ? "success" : "partial",
			JSON.stringify(result),
		);
	} finally {
		if (sprints?.pull) result.warnings?.push(...sprints.pull.warnings);
		store.close();
		// Restore IO filters if applied
		if (restoreIo) restoreIo();
		// Restore original log level
		logger.level = originalLevel;
	}

	if (options.verbose) {
		logger.info({ result }, "Sync operation completed");
	}
	return result;
}

/**
 * Get list of task IDs to sync
 */
function getTaskIds(options: SyncOptions, store: FrontmatterStore): string[] {
	if (options.all) {
		const mappings = store.getAllMappings();
		return Array.from(mappings.keys());
	}

	// Default: all mapped tasks
	const mappings = store.getAllMappings();
	return Array.from(mappings.keys());
}

/**
 * Sync a single task with 3-way merge
 */
async function syncTask(
	taskId: string,
	context: {
		store: FrontmatterStore;
		backlog: BacklogClient;
		jira: JiraClient;
		strategy: ConflictStrategy;
		fieldMappings: FieldMapping[];
		sprints: SprintSyncContext | null;
		dryRun: boolean;
	},
): Promise<
	| { type: "synced"; direction: "push" | "pull" | "none" }
	| { type: "conflict"; resolution: string }
	| { type: "skipped"; reason: string }
> {
	const { store, backlog, jira, strategy, fieldMappings, sprints, dryRun } =
		context;

	// Get mapping
	const mapping = store.getMapping(taskId);
	if (!mapping) {
		return { type: "skipped", reason: "No Jira mapping" };
	}

	// Get current state
	const task = await backlog.getTask(taskId);
	const issue = await jira.getIssue(mapping.jiraKey);

	const frontmatter = readTaskFrontmatter(taskId);
	const backlogPayload = normalizeBacklogTask(task, {
		fieldMappings,
		frontmatter,
	});
	const jiraPayload = normalizeJiraIssue(issue, { fieldMappings });
	const backlogHash = computeHash(backlogPayload);
	const jiraHash = computeHash(jiraPayload);

	// Get snapshots and classify state
	const snapshots = store.getSnapshots(taskId);
	const state = classifySyncState(
		backlogHash,
		jiraHash,
		snapshots.backlog,
		snapshots.jira,
		{ backlog: backlogPayload, jira: jiraPayload },
		{ fieldMappings, sprintMapping: sprints?.mapping ?? null },
	);

	logger.debug({ taskId, state: state.state }, "Sync state classified");

	// Handle based on state
	switch (state.state) {
		case "InSync":
			logger.info({ taskId }, "Already in sync");
			return { type: "skipped", reason: "Already in sync" };

		case "NeedsPush":
			// Backlog changed, push to Jira
			if (!dryRun) {
				assertSucceeded(
					await push({
						taskIds: [taskId],
						sprintContext: sprints?.push ?? null,
					}),
				);
			}
			return { type: "synced", direction: "push" };

		case "NeedsPull":
			// Jira changed, pull to Backlog
			if (!dryRun) {
				assertSucceeded(
					await pull({
						taskIds: [taskId],
						sprintContext: sprints?.pull ?? null,
					}),
				);
			}
			return { type: "synced", direction: "pull" };

		case "Conflict": {
			// Both changed - resolve conflict
			const mappedState: MappedFieldState = {
				current: { backlog: backlogPayload, jira: jiraPayload },
				base: {
					backlog: parsePayload(snapshots.backlog?.payload),
					jira: parsePayload(snapshots.jira?.payload),
				},
				frontmatter,
				issue,
			};
			return await resolveConflict(
				{
					taskId,
					jiraKey: mapping.jiraKey,
					fields: [
						...detectBuiltinFieldConflicts(mappedState, task, fieldMappings),
						...detectMappedFieldConflicts(mappedState, fieldMappings),
						...[detectSprintConflict(mappedState, sprints)].filter(
							(c): c is NonNullable<typeof c> => c !== null,
						),
					],
					backlogTask: task,
					jiraIssue: issue,
					baseBacklog: snapshots.backlog
						? JSON.parse(snapshots.backlog.payload)
						: null,
					baseJira: snapshots.jira ? JSON.parse(snapshots.jira.payload) : null,
					mappedState,
				},
				strategy,
				{ store, backlog, jira, fieldMappings, sprints, dryRun },
			);
		}

		case "Unknown":
			// No baseline - treat as first sync
			logger.info({ taskId }, "No baseline snapshot, creating initial sync");
			if (!dryRun) {
				// Store current state as baseline
				store.setSnapshot(taskId, "backlog", backlogHash, backlogPayload);
				store.setSnapshot(taskId, "jira", jiraHash, jiraPayload);
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
						"Failed to update frontmatter during initial sync",
					);
				}
			}
			return { type: "synced", direction: "none" };
	}
}

/**
 * Surface a failed inner push/pull so the task is reported as failed rather
 * than synced. Mapped field failures keep their per-field detail.
 */
function assertSucceeded(result: {
	failed: Array<{ error: string; mappedFieldError?: MappedFieldPushError }>;
}): void {
	const failure = result.failed[0];
	if (failure) {
		throw failure.mappedFieldError ?? new Error(failure.error);
	}
}

function parsePayload(
	payload: string | undefined,
): Partial<NormalizedPayload> | null {
	if (!payload) return null;
	try {
		return JSON.parse(payload) as Partial<NormalizedPayload>;
	} catch {
		return null;
	}
}

/**
 * Resolve a conflict using the specified strategy
 */
async function resolveConflict(
	conflict: Conflict,
	strategy: ConflictStrategy,
	context: {
		store: FrontmatterStore;
		backlog: BacklogClient;
		jira: JiraClient;
		fieldMappings: FieldMapping[];
		sprints: SprintSyncContext | null;
		dryRun: boolean;
	},
): Promise<{ type: "conflict"; resolution: string }> {
	const { store, backlog, jira, fieldMappings, sprints, dryRun } = context;

	logger.info(
		{ taskId: conflict.taskId, strategy, fieldCount: conflict.fields.length },
		"Resolving conflict",
	);

	switch (strategy) {
		case "prefer-backlog":
			// Push Backlog changes to Jira (push honours mapping direction:
			// pull-only mapped fields are left as they are)
			if (!dryRun) {
				assertSucceeded(
					await push({
						taskIds: [conflict.taskId],
						force: true,
						sprintContext: sprints?.push ?? null,
					}),
				);
			}
			return { type: "conflict", resolution: "preferred-backlog" };

		case "prefer-jira":
			// Pull Jira changes to Backlog (pull honours mapping direction:
			// push-only mapped fields are left as they are)
			if (!dryRun) {
				assertSucceeded(
					await pull({
						taskIds: [conflict.taskId],
						force: true,
						sprintContext: sprints?.pull ?? null,
					}),
				);
			}
			return { type: "conflict", resolution: "preferred-jira" };

		case "prompt":
			// Different fields changed on each side: merge without prompting
			if (conflict.fields.length === 0) {
				if (!dryRun) {
					await applyFieldResolutions(conflict.taskId, conflict.jiraKey, [], {
						backlog,
						jira,
						store,
						fieldMappings,
						sprints,
						backlogTask: conflict.backlogTask,
						mappedState: conflict.mappedState,
					});
				}
				return { type: "conflict", resolution: "merged" };
			}

			// Interactive resolution in terminal
			try {
				const resolution = await promptForConflictResolution(conflict);

				// Apply field-by-field resolutions
				if (!dryRun) {
					await applyFieldResolutions(
						conflict.taskId,
						conflict.jiraKey,
						resolution.resolutions,
						{
							backlog,
							jira,
							store,
							fieldMappings,
							sprints,
							backlogTask: conflict.backlogTask,
							mappedState: conflict.mappedState,
						},
					);

					// Save preference if requested
					if (resolution.savePreference) {
						const preferredSource = determinePreferredSource(
							resolution.resolutions,
						);
						if (preferredSource) {
							saveConflictPreference(preferredSource);
						}
					}
				}

				return { type: "conflict", resolution: "user-resolved" };
			} catch (error) {
				if (error instanceof MappedFieldPushError) {
					throw error;
				}
				logger.error(
					{ taskId: conflict.taskId, error },
					"Interactive resolution failed",
				);
				store.updateSyncState(conflict.taskId, {
					conflictState: "manual-resolution-required",
				});
				return { type: "conflict", resolution: "prompt-cancelled" };
			}

		case "manual":
			// Mark for manual resolution
			store.updateSyncState(conflict.taskId, {
				conflictState: "manual-resolution-required",
			});
			return { type: "conflict", resolution: "manual-marked" };

		default:
			throw new Error(`Unknown conflict strategy: ${strategy}`);
	}
}

/**
 * Load configuration
 */
function loadConfig(): {
	sync?: {
		conflictStrategy?: string;
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

/**
 * Apply field-by-field resolutions from interactive prompt. Every field is
 * merged individually: fields changed on one side propagate to the other,
 * conflicting fields take the chosen value.
 */
export async function applyFieldResolutions(
	taskId: string,
	jiraKey: string,
	resolutions: Array<{
		field: string;
		source: "backlog" | "jira" | "manual";
		value: unknown;
	}>,
	context: {
		backlog: Pick<BacklogClient, "getTask" | "updateTask">;
		jira: Pick<
			JiraClient,
			"getIssue" | "updateIssue" | "getTransitions" | "transitionIssue"
		>;
		store: Pick<
			FrontmatterStore,
			"getMapping" | "setSnapshot" | "updateSyncState"
		>;
		fieldMappings?: FieldMapping[];
		/** Sprint sync state, when a sprint mapping is configured */
		sprints?: SprintSyncContext | null;
		backlogTask?: BacklogTask;
		mappedState?: MappedFieldState;
	},
): Promise<void> {
	const {
		backlog,
		jira,
		store,
		fieldMappings = [],
		sprints = null,
		mappedState,
	} = context;

	// Mapped fields are resolved individually after the built-in fields
	const mappingsByTarget = new Map(fieldMappings.map((m) => [m.backlog, m]));
	const mappedResolutions = new Map<string, MappedValue>();
	const builtinResolutions: typeof resolutions = [];
	let sprintResolution: "backlog" | "jira" | undefined;

	for (const resolution of resolutions) {
		const fieldMapping = mappingsByTarget.get(resolution.field);
		if (resolution.field === SPRINT_CONFLICT_FIELD) {
			if (resolution.source !== "manual") sprintResolution = resolution.source;
		} else if (fieldMapping && fieldMapping.direction === "both") {
			mappedResolutions.set(
				resolution.field,
				resolution.source === "manual"
					? parseManualMappedValue(resolution.value, fieldMapping)
					: (resolution.value as MappedValue),
			);
		} else if (BUILTIN_CONFLICT_FIELDS.has(resolution.field)) {
			builtinResolutions.push(resolution);
		}
	}

	// Merge built-in fields
	if (mappedState) {
		const plan = planBuiltinFieldMerge(
			mappedState,
			fieldMappings,
			builtinResolutions,
		);
		await applyBuiltinFieldMerge(plan, {
			taskId,
			issueKey: jiraKey,
			task: context.backlogTask ?? (await backlog.getTask(taskId)),
			issue: mappedState.issue,
			backlog,
			jira,
			fieldMappings,
		});
	}

	// Merge mapped fields: one-sided changes propagate, conflicting ones take
	// the chosen value, and each mapping's direction is honoured. Applied last
	// so the built-in merge above cannot overwrite the choices.
	if (mappedState && fieldMappings.length > 0) {
		const plan = planMappedFieldMerge(
			mappedState,
			fieldMappings,
			mappedResolutions,
		);
		if (plan.length > 0) {
			const failures = await applyMappedFieldMerge(plan, {
				taskId,
				issueKey: jiraKey,
				backlog,
				jira,
				frontmatter: readTaskFrontmatter(taskId),
				issue: await jira.getIssue(jiraKey),
			});
			if (failures.length > 0) {
				throw new MappedFieldPushError(jiraKey, failures);
			}
		}
	}

	// Merge the sprint: the milestone moves the issue, or Jira's sprint sets
	// the milestone
	if (mappedState && sprints) {
		const side = planSprintMerge(
			mappedState,
			sprints.mapping,
			sprintResolution,
		);
		if (side) {
			const failures = await applySprintMerge(
				side,
				sprints,
				taskId,
				await jira.getIssue(jiraKey),
			);
			if (failures.length > 0) {
				throw new MappedFieldPushError(jiraKey, failures);
			}
		}
	}

	// Snapshot the merged state, normalized as sync classifies it, so the
	// next sync sees the task InSync
	const task = await backlog.getTask(taskId);
	const issue = await jira.getIssue(jiraKey);
	const backlogPayload = normalizeBacklogTask(task, { fieldMappings });
	const jiraPayload = normalizeJiraIssue(issue, { fieldMappings });
	const backlogHash = computeHash(backlogPayload);
	const jiraHash = computeHash(jiraPayload);

	store.setSnapshot(taskId, "backlog", backlogHash, backlogPayload);
	store.setSnapshot(taskId, "jira", jiraHash, jiraPayload);
	store.updateSyncState(taskId, {
		lastSyncAt: new Date().toISOString(),
		conflictState: null,
	});

	// Update frontmatter with Jira metadata after conflict resolution
	try {
		const mapping = store.getMapping(taskId);
		if (mapping) {
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

			logger.debug(
				{ taskId, jiraKey },
				"Updated frontmatter after conflict resolution",
			);
		}
	} catch (error) {
		logger.error(
			{ taskId, error },
			"Failed to update frontmatter after conflict resolution",
		);
	}
}

/**
 * Determine the preferred source based on user resolutions
 */
function determinePreferredSource(
	resolutions: Array<{ source: "backlog" | "jira" | "manual" }>,
): "prefer-backlog" | "prefer-jira" | null {
	const sources = resolutions
		.map((r) => r.source)
		.filter((s) => s !== "manual");

	if (sources.length === 0) {
		return null;
	}

	const backlogCount = sources.filter((s) => s === "backlog").length;
	const jiraCount = sources.filter((s) => s === "jira").length;

	// If user consistently chose one source, return that preference
	if (backlogCount > jiraCount * 2) {
		return "prefer-backlog";
	}
	if (jiraCount > backlogCount * 2) {
		return "prefer-jira";
	}

	return null;
}

/**
 * Save conflict preference to config
 */
function saveConflictPreference(
	preference: "prefer-backlog" | "prefer-jira",
): void {
	try {
		const configPath = join(process.cwd(), ".backlog-jira", "config.json");
		const config = loadConfig();

		config.sync = config.sync || {};
		config.sync.conflictStrategy = preference;

		writeFileSync(configPath, JSON.stringify(config, null, 2));

		logger.info({ preference }, "Saved conflict resolution preference");
	} catch (error) {
		logger.warn({ error }, "Failed to save conflict preference");
	}
}
