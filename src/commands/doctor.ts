import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JiraSprint } from "../integrations/jira-sprints.ts";
import { JiraClient } from "../integrations/jira.ts";
import {
	MilestoneAdapter,
	readMilestoneRefusals,
} from "../integrations/milestones.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import { FrontmatterStore } from "../state/store.ts";
import {
	loadFieldMappings,
	loadSprintMapping,
	readTaskFrontmatter,
} from "../utils/field-mapping.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";
import {
	type FieldMappingCheck,
	verifyFieldMappings,
} from "../utils/mapped-field-sync.ts";

async function exec(command: string, args: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data;
		});
		proc.stderr.on("data", (data) => {
			stderr += data;
		});

		proc.on("close", (code) => {
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`${command} failed: ${stderr}`));
			}
		});
	});
}

async function checkNodeRuntime(): Promise<void> {
	const version = process.versions.node;
	const major = Number.parseInt(version.split(".")[0], 10);
	if (major < 20) {
		throw new Error(`Node.js 20+ required, found: ${version}`);
	}
	const runtime = process.versions.bun
		? `Bun ${process.versions.bun} (Node.js ${version} compatible)`
		: `Node.js ${version}`;
	logger.info(`  ✓ Runtime: ${runtime}`);
}

async function checkBacklogCLI(): Promise<void> {
	const version = await exec("backlog", ["--version"]);
	logger.info(`  ✓ Backlog CLI: ${version}`);
}

async function checkMCPServer(): Promise<void> {
	// We'll actually test the MCP connection in the connect command
	// For now, just check if we're in a project with tasks
	const result = await exec("backlog", ["task", "list", "--plain"]);
	if (!result) {
		logger.warn(
			"  ⚠ No tasks found. Make sure you're in a Backlog.md project directory.",
		);
	} else {
		logger.info("  ✓ Backlog.md project detected");
	}
}

async function checkDatabasePerms(): Promise<void> {
	const configDir = join(process.cwd(), ".backlog-jira");
	if (!existsSync(configDir)) {
		throw new Error(".backlog-jira/ not found. Run 'backlog-jira init' first.");
	}

	const store = new FrontmatterStore();
	store.testWriteAccess();
	store.close();
	logger.info("  ✓ Database permissions OK");
}

async function checkGitStatus(): Promise<void> {
	try {
		const status = await exec("git", ["status", "--porcelain"]);
		if (status.trim()) {
			logger.warn("  ⚠ Working directory has uncommitted changes");
		} else {
			logger.info("  ✓ Git working directory clean");
		}
	} catch (error) {
		logger.warn("  ⚠ Not a git repository");
	}
}

async function checkMCPConnectivity(): Promise<void> {
	try {
		// Try to list tasks via MCP (which uses the backlog CLI)
		const startTime = Date.now();
		const result = await exec("backlog", [
			"task",
			"list",
			"--plain",
			"-s",
			"To Do",
		]);
		const duration = Date.now() - startTime;

		if (duration > 5000) {
			logger.warn(
				`  ⚠ MCP response slow (${duration}ms). Consider optimizing task count.`,
			);
		} else {
			logger.info(`  ✓ MCP connectivity OK (${duration}ms)`);
		}
	} catch (error) {
		throw new Error(
			"Failed to connect to MCP server. Ensure backlog CLI is working.",
		);
	}
}

async function checkNodeModules(): Promise<void> {
	const nodeModulesPath = join(process.cwd(), "node_modules");
	if (!existsSync(nodeModulesPath)) {
		throw new Error(
			"node_modules not found. Install dependencies first (npm, pnpm or bun install).",
		);
	}
	logger.info("  ✓ Dependencies installed");
}

async function checkDiskSpace(): Promise<void> {
	try {
		// Check available disk space (macOS/Linux)
		const result = await exec("df", ["-h", process.cwd()]);
		const lines = result.split("\n");
		if (lines.length > 1) {
			const parts = lines[1].split(/\s+/);
			const available = parts[3];
			logger.info(`  ✓ Disk space: ${available} available`);
		}
	} catch (error) {
		// Non-critical check, just log warning
		logger.warn("  ⚠ Could not check disk space");
	}
}

/**
 * Validate .backlog-jira/config.json against the shape `backlog-jira init`
 * writes. The project key is the only value init leaves for the user to fill.
 */
export async function checkConfigFile(cwd = process.cwd()): Promise<void> {
	const configPath = join(cwd, ".backlog-jira", "config.json");
	if (!existsSync(configPath)) {
		throw new Error("Config file not found. Run 'backlog-jira init' first.");
	}

	let config: { jira?: { projectKey?: unknown } };
	try {
		config = JSON.parse(await readFile(configPath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Config file contains invalid JSON");
		}
		throw error;
	}

	const projectKey = config?.jira?.projectKey;
	if (typeof projectKey !== "string" || projectKey.trim() === "") {
		throw new Error(
			"Missing required config field: jira.projectKey (set it in .backlog-jira/config.json)",
		);
	}

	logger.info("  ✓ Configuration file valid");
}

/**
 * Verify each mapped Jira field exists, and that fields written to Jira
 * (push/both mappings) are editable for the configured project and issue
 * type. Editability is checked against the issue type's create screen, the
 * screen metadata MCP Atlassian exposes.
 */
export async function checkFieldMappings(
	jira: Pick<
		JiraClient,
		"searchFields" | "getProjectIssueTypes" | "getCreateFieldIds"
	>,
	cwd = process.cwd(),
): Promise<FieldMappingCheck[]> {
	// Throws FieldMappingConfigError for invalid entries
	const mappings = loadFieldMappings(cwd);
	if (mappings.length === 0) {
		logger.info("  ✓ No field mappings configured");
		return [];
	}

	const config = JSON.parse(
		await readFile(join(cwd, ".backlog-jira", "config.json"), "utf8"),
	) as { jira?: { projectKey?: string; issueType?: string } };
	const projectKey = config.jira?.projectKey || process.env.JIRA_PROJECT || "";
	const issueType = config.jira?.issueType || "Task";

	let knownFields: Array<{ id: string; name?: string }>;
	try {
		knownFields = await jira.searchFields("", 1000);
	} catch (error) {
		throw new Error(
			`Could not list Jira fields to verify field mappings: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Screen metadata is only needed for mappings that write to Jira
	let screenFieldIds: Set<string> | null = null;
	const writesToJira = mappings.some((m) => m.direction !== "pull");
	if (writesToJira) {
		if (!projectKey) {
			logger.warn(
				"  ⚠ jira.projectKey is not configured; cannot check mapped fields are editable",
			);
		} else {
			try {
				const types = await jira.getProjectIssueTypes(projectKey);
				const type = types.find(
					(t) => t.name.toLowerCase() === issueType.toLowerCase(),
				);
				if (!type) {
					throw new Error(
						`issue type "${issueType}" not found in project ${projectKey}`,
					);
				}
				screenFieldIds = new Set(
					await jira.getCreateFieldIds(projectKey, type.id),
				);
			} catch (error) {
				logger.warn(
					`  ⚠ Could not read screen fields for ${projectKey} / ${issueType}, skipping editability check: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	const results = verifyFieldMappings(mappings, knownFields, screenFieldIds, {
		projectKey,
		issueType,
	});
	for (const { mapping, problems } of results) {
		const label = `${mapping.backlog} ↔ ${mapping.jira} (${mapping.direction})`;
		if (problems.length === 0) {
			logger.info(`  ✓ Field mapping ${label}`);
		} else {
			for (const problem of problems) {
				logger.error(`  ✗ Field mapping ${label}: ${problem}`);
			}
		}
	}

	const failed = results.filter((r) => r.problems.length > 0);
	if (failed.length > 0) {
		throw new Error(
			`${failed.length} field mapping${failed.length === 1 ? "" : "s"} failed verification (${failed.map((r) => r.mapping.jira).join(", ")})`,
		);
	}
	return results;
}

/**
 * Verify sprint sync can work: the Sprint field exists and the board is
 * reachable and has sprints (errors); flag linked tasks whose milestone
 * matches no sprint when sprints are not created, and milestones the
 * adapter refused to update (warnings). Returns the number of warnings.
 */
export async function checkSprintSync(
	jira: Pick<JiraClient, "getSprintFieldId" | "getBoard" | "getBoardSprints">,
	options: { cwd?: string; taskIds?: string[] } = {},
): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	// Throws FieldMappingConfigError for invalid entries
	const mapping = loadSprintMapping(cwd);
	if (!mapping) {
		logger.info("  ✓ Sprint sync not configured");
		return 0;
	}

	const errors: string[] = [];
	let warnings = 0;
	const describe = (error: unknown) =>
		error instanceof Error ? error.message.split("\n")[0] : String(error);

	try {
		const fieldId = await jira.getSprintFieldId();
		if (fieldId) {
			logger.info(`  ✓ Sprint field ${fieldId}`);
			const stored = SprintRegistry.load(cwd).sprintFieldId;
			if (stored && stored !== fieldId) {
				logger.warn(
					`  ⚠ .backlog-jira/sprints.json records Sprint field ${stored} but Jira reports ${fieldId}; remove "sprintFieldId" from sprints.json so it is rediscovered`,
				);
				warnings++;
			}
		} else {
			errors.push(
				"Sprint field not found: this Jira site has no Jira Software Sprint field",
			);
		}
	} catch (error) {
		errors.push(`Could not discover the Sprint field: ${describe(error)}`);
	}

	let sprints: JiraSprint[] | null = null;
	try {
		const board = await jira.getBoard(mapping.boardId);
		if (!board) {
			errors.push(
				`Board ${mapping.boardId} was not found or is not accessible (check "boardId" and board permissions)`,
			);
		} else if (!board.supportsSprints) {
			errors.push(
				`Board ${mapping.boardId} (${board.name}) is a ${board.type} board without sprints; sprint sync needs a scrum board`,
			);
		} else {
			sprints = await jira.getBoardSprints(mapping.boardId);
			logger.info(
				`  ✓ Board ${board.id} (${board.name}, ${board.type}) with ${sprints.length} sprint${sprints.length === 1 ? "" : "s"}`,
			);
		}
	} catch (error) {
		errors.push(`Board ${mapping.boardId} is unreachable: ${describe(error)}`);
	}

	if (mapping.direction !== "pull") {
		if (mapping.createSprints) {
			logger.info(
				`  ℹ createSprints is on: pushing a task whose milestone matches no sprint creates a future sprint on board ${mapping.boardId}`,
			);
		} else if (sprints) {
			const unmatched = findUnmatchedMilestones(
				options.taskIds ?? new FrontmatterStore().getAllMappings().keys(),
				sprints,
				cwd,
			);
			if (unmatched.length > 0) {
				logger.warn(
					`  ⚠ ${unmatched.length} linked task${unmatched.length === 1 ? "" : "s"} ha${unmatched.length === 1 ? "s a milestone" : "ve milestones"} matching no future or active sprint on board ${mapping.boardId} (createSprints is off, so push will report them):`,
				);
				for (const { taskId, milestone } of unmatched) {
					logger.warn(`      ${taskId}: ${milestone}`);
				}
				warnings++;
			}
		}
	}

	for (const refusal of readMilestoneRefusals(cwd)) {
		logger.warn(
			`  ⚠ Milestone ${refusal.milestoneId}${refusal.title ? ` (${refusal.title})` : ""} was not updated (${refusal.fields.join(", ")}): ${refusal.reason}`,
		);
		warnings++;
	}

	if (errors.length > 0) {
		for (const error of errors) logger.error(`  ✗ ${error}`);
		throw new Error(
			`${errors.length} sprint sync problem${errors.length === 1 ? "" : "s"}`,
		);
	}
	return warnings;
}

/**
 * Linked tasks whose milestone stands for no registered sprint and matches
 * no open sprint of the board by name
 */
function findUnmatchedMilestones(
	taskIds: Iterable<string>,
	sprints: JiraSprint[],
	cwd: string,
): Array<{ taskId: string; milestone: string }> {
	const registry = SprintRegistry.load(cwd);
	const milestones = new MilestoneAdapter({ cwd, registry });
	const openNames = new Set(
		sprints
			.filter((s) => s.state !== "closed")
			.map((s) => s.name.trim().toLowerCase()),
	);
	const unmatched: Array<{ taskId: string; milestone: string }> = [];
	for (const taskId of taskIds) {
		const value = readTaskFrontmatter(taskId).milestone;
		if (typeof value !== "string" || !value.trim()) continue;
		const milestone = milestones.get(value) ?? milestones.findByTitle(value);
		if (milestone && registry.findByMilestone(milestone.id)) continue;
		const title = (milestone?.title ?? value).trim().toLowerCase();
		if (openNames.has(title)) continue;
		unmatched.push({
			taskId,
			milestone: milestone ? `${milestone.title} (${milestone.id})` : value,
		});
	}
	return unmatched;
}

async function checkSprintSyncWithJira(): Promise<number> {
	const jira = new JiraClient({ ...getJiraClientOptions(), silentMode: true });
	try {
		return await checkSprintSync(jira);
	} finally {
		await jira.close().catch(() => {});
	}
}

async function checkFieldMappingsWithJira(): Promise<void> {
	const jira = new JiraClient({ ...getJiraClientOptions(), silentMode: true });
	try {
		await checkFieldMappings(jira);
	} finally {
		await jira.close().catch(() => {});
	}
}

export async function doctorCommand(): Promise<void> {
	logger.info("Running environment checks...\n");

	const checks: Array<{
		name: string;
		fn: () => Promise<unknown>;
		critical: boolean;
	}> = [
		{ name: "Node.js runtime", fn: checkNodeRuntime, critical: true },
		{ name: "Backlog CLI", fn: checkBacklogCLI, critical: true },
		{ name: "Dependencies", fn: checkNodeModules, critical: true },
		{ name: "Configuration", fn: () => checkConfigFile(), critical: true },
		{ name: "Database", fn: checkDatabasePerms, critical: true },
		{ name: "MCP Connectivity", fn: checkMCPConnectivity, critical: true },
		{ name: "Field mappings", fn: checkFieldMappingsWithJira, critical: true },
		{ name: "Sprint sync", fn: checkSprintSyncWithJira, critical: true },
		{ name: "Backlog.md project", fn: checkMCPServer, critical: false },
		{ name: "Git status", fn: checkGitStatus, critical: false },
		{ name: "Disk space", fn: checkDiskSpace, critical: false },
	];

	let criticalFailed = false;
	let warningCount = 0;

	for (const check of checks) {
		try {
			// Checks may report warnings they logged themselves
			const warnings = await check.fn();
			if (typeof warnings === "number") warningCount += warnings;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (check.critical) {
				logger.error(`  ✗ ${check.name}: ${errorMsg}`);
				criticalFailed = true;
			} else {
				logger.warn(`  ⚠ ${check.name}: ${errorMsg}`);
				warningCount++;
			}
		}
	}

	logger.info("");

	if (criticalFailed) {
		logger.error(
			"Critical checks failed. Please fix the issues above before proceeding.",
		);
		process.exit(1);
	}

	if (warningCount > 0) {
		logger.info(
			`✓ All critical checks passed! (${warningCount} warning${warningCount > 1 ? "s" : ""})`,
		);
	} else {
		logger.info("✓ All checks passed! Ready to sync.");
	}
}
