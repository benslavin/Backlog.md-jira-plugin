import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JiraClient } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/store.ts";
import { loadFieldMappings } from "../utils/field-mapping.ts";
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

async function checkConfigFile(): Promise<void> {
	const configPath = join(process.cwd(), ".backlog-jira", "config.json");
	if (!existsSync(configPath)) {
		throw new Error("Config file not found. Run 'backlog-jira init' first.");
	}

	// Validate config structure
	try {
		const configContent = await readFile(configPath, "utf8");
		const config = JSON.parse(configContent);

		const requiredFields = ["jiraProjectKey", "mcpServerName"];
		const missingFields = requiredFields.filter((field) => !config[field]);

		if (missingFields.length > 0) {
			throw new Error(
				`Missing required config fields: ${missingFields.join(", ")}`,
			);
		}

		logger.info("  ✓ Configuration file valid");
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Config file contains invalid JSON");
		}
		throw error;
	}
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

	const checks = [
		{ name: "Node.js runtime", fn: checkNodeRuntime, critical: true },
		{ name: "Backlog CLI", fn: checkBacklogCLI, critical: true },
		{ name: "Dependencies", fn: checkNodeModules, critical: true },
		{ name: "Configuration", fn: checkConfigFile, critical: true },
		{ name: "Database", fn: checkDatabasePerms, critical: true },
		{ name: "MCP Connectivity", fn: checkMCPConnectivity, critical: true },
		{ name: "Field mappings", fn: checkFieldMappingsWithJira, critical: true },
		{ name: "Backlog.md project", fn: checkMCPServer, critical: false },
		{ name: "Git status", fn: checkGitStatus, critical: false },
		{ name: "Disk space", fn: checkDiskSpace, critical: false },
	];

	let criticalFailed = false;
	let warningCount = 0;

	for (const check of checks) {
		try {
			await check.fn();
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
