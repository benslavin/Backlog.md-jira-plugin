#!/usr/bin/env node

// Note: Keep this shebang as 'node'. With a 'bun' shebang, `bun build` adds a
// `// @bun` pragma to dist/cli.js, which makes Bun mis-decode UTF-8 when it runs
// the Node-targeted build.

import { Command } from "commander";
import packageJson from "../package.json";
import { configureCommand } from "./commands/configure.ts";
import { connectCommand } from "./commands/connect.ts";
import { createIssue } from "./commands/create-issue.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { registerMapAssigneesCommand } from "./commands/map-assignees.ts";
import { registerMapFieldsCommand } from "./commands/map-fields.ts";
import { registerMapCommand } from "./commands/map.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { formatImportedLines, pull } from "./commands/pull.ts";
import { push } from "./commands/push.ts";
import { registerResolveCommand } from "./commands/resolve.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { sync } from "./commands/sync.ts";
import { registerViewCommand } from "./commands/view.ts";
import { watch } from "./commands/watch.ts";

const program = new Command();

program
	.name("backlog-jira")
	.description("Bidirectional sync plugin between Backlog.md and Jira")
	.version(packageJson.version);

program
	.command("init")
	.description(
		"Initialize .backlog-jira/ and optionally start the guided setup",
	)
	.action(async () => {
		try {
			await initCommand();
			// prompts keeps stdin open, so exit explicitly
			process.exit(process.exitCode ?? 0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("configure")
	.description(
		"Guided setup: credentials, connection, project, statuses, sprints, fields, conflicts and import filter",
	)
	.option(
		"--step <step>",
		"Run one step: credentials, connection, project, status, sprints, fields, conflict or filter",
	)
	.option(
		"--non-interactive",
		"Write settings from options and JIRA_URL without prompts (CI)",
	)
	.option("--project-key <key>", "Non-interactive: Jira project key")
	.option("--issue-type <type>", "Non-interactive: Jira issue type")
	.option(
		"--conflict-strategy <strategy>",
		"Non-interactive: prompt, prefer-backlog or prefer-jira",
	)
	.option("--jql-filter <jql>", "Non-interactive: JQL of issues to import")
	.option("--enable-annotations", "Non-interactive: enable annotations")
	.option("-v, --verbose", "Show detailed logging output")
	.action(async (options) => {
		try {
			await configureCommand(options);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("connect")
	.description("Verify connectivity to Backlog CLI and MCP Atlassian server")
	.action(async () => {
		try {
			await connectCommand();
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("doctor")
	.description("Run environment health checks")
	.action(async () => {
		try {
			await doctorCommand();
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

// Phase 3: Mapping, Status, and MCP Commands
registerMapCommand(program);
registerMapAssigneesCommand(program);
registerMapFieldsCommand(program);
registerMcpCommand(program);
registerResolveCommand(program);
registerStatusCommand(program);
registerViewCommand(program);

program
	.command("create-issue <taskId>")
	.description(
		"Create a Jira issue from an unmapped Backlog task; a task whose parent is linked to Jira becomes a subtask (or, under an epic, a standard issue in the epic)",
	)
	.option(
		"--issue-type <type>",
		"Override default issue type (e.g., Task, Bug, Story)",
	)
	.option(
		"--parent <id>",
		"Create the issue under this Jira issue or epic (a Jira key, or a task ID whose linked issue is meant); defaults to the issue linked to the task's parent",
	)
	.option("--dry-run", "Show what would be created without creating the issue")
	.addHelpText(
		"after",
		`
Examples:
  backlog-jira create-issue TASK-12                  # under the issue linked to TASK-12's parent, if any
  backlog-jira create-issue TASK-12 --parent PROJ-40 # subtask of PROJ-40, or a standard issue if PROJ-40 is an epic
  backlog-jira create-issue TASK-12 --parent TASK-3  # under the issue linked to TASK-3`,
	)
	.action(async (taskId, options) => {
		try {
			const result = await createIssue({
				taskId,
				issueType: options.issueType,
				parent: options.parent,
				dryRun: options.dryRun,
			});

			if (result.success) {
				if (result.jiraKey) {
					const under = result.parentKey
						? ` (${result.issueType} under ${result.parentKey})`
						: "";
					console.log(
						`\n✅ Successfully created Jira issue ${result.jiraKey}${under} for task ${result.taskId}`,
					);
				}
				for (const warning of result.warnings ?? []) {
					console.warn(`\n⚠️  ${warning}`);
				}
				process.exit(0);
			} else {
				console.error(`\n❌ Failed to create Jira issue: ${result.error}`);
				process.exit(1);
			}
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("push [taskIds...]")
	.description("Push Backlog changes to Jira (tasks by ID or linked Jira key)")
	.option("--all", "Push all mapped tasks")
	.option("--force", "Force push even if conflicts detected")
	.option("--dry-run", "Show what would be pushed without making changes")
	.option("-v, --verbose", "Show detailed logging output")
	.action(async (taskIds, options) => {
		try {
			const result = await push({
				taskIds: taskIds && taskIds.length > 0 ? taskIds : undefined,
				all: options.all,
				force: options.force,
				dryRun: options.dryRun,
				verbose: options.verbose,
			});
			console.log("\nPush Results:");
			console.log(`  Pushed: ${result.pushed.length}`);
			console.log(`  Failed: ${result.failed.length}`);
			console.log(`  Skipped: ${result.skipped.length}`);
			if (result.failed.length > 0) {
				console.log("\nFailures:");
				for (const fail of result.failed) {
					console.log(`  ${fail.taskId}: ${fail.error}`);
				}
				process.exit(1);
			}
			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("pull [taskIds...]")
	.description("Pull Jira changes to Backlog (tasks by ID or linked Jira key)")
	.option("--all", "Pull all mapped tasks")
	.option("--import", "Import unmapped Jira issues as new Backlog tasks")
	.option("--jql <jql>", "JQL filter for importing issues (requires --import)")
	.option("--force", "Force pull even if conflicts detected")
	.option("--dry-run", "Show what would be pulled without making changes")
	.option("-v, --verbose", "Show detailed logging output")
	.action(async (taskIds, options) => {
		try {
			const result = await pull({
				taskIds: taskIds && taskIds.length > 0 ? taskIds : undefined,
				all: options.all,
				import: options.import,
				jql: options.jql,
				force: options.force,
				dryRun: options.dryRun,
				verbose: options.verbose,
			});
			console.log("\nPull Results:");
			console.log(`  Pulled: ${result.pulled.length}`);
			if (result.imported.length > 0) {
				console.log(`  Imported: ${result.imported.length}`);
				for (const line of formatImportedLines(result)) {
					console.log(`    ${line}`);
				}
			}
			console.log(`  Failed: ${result.failed.length}`);
			console.log(`  Skipped: ${result.skipped.length}`);
			if (result.warnings.length > 0) {
				console.log("\nWarnings:");
				for (const warning of result.warnings) {
					console.log(`  ${warning}`);
				}
			}
			if (result.failed.length > 0) {
				console.log("\nFailures:");
				for (const fail of result.failed) {
					console.log(`  ${fail.taskId}: ${fail.error}`);
				}
				process.exit(1);
			}
			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("sync [taskIds...]")
	.description(
		"Bidirectional sync with conflict resolution (tasks by ID or linked Jira key)",
	)
	.option("--all", "Sync all mapped tasks")
	.option(
		"--strategy <strategy>",
		"Conflict resolution strategy: prefer-backlog|prefer-jira|prompt|manual",
	)
	.option("--dry-run", "Show what would be synced without making changes")
	.option("-v, --verbose", "Show detailed logging output")
	.action(async (taskIds, options) => {
		try {
			const result = await sync({
				taskIds: taskIds && taskIds.length > 0 ? taskIds : undefined,
				all: options.all,
				strategy: options.strategy,
				dryRun: options.dryRun,
				verbose: options.verbose,
			});
			console.log("\nSync Results:");
			console.log(`  Synced: ${result.synced.length}`);
			console.log(`  Conflicts: ${result.conflicts.length}`);
			console.log(`  Failed: ${result.failed.length}`);
			console.log(`  Skipped: ${result.skipped.length}`);
			if (result.conflicts.length > 0) {
				console.log("\nConflicts:");
				for (const conflict of result.conflicts) {
					console.log(`  ${conflict.taskId}: ${conflict.resolution}`);
				}
			}
			if (result.warnings && result.warnings.length > 0) {
				console.log("\nWarnings:");
				for (const warning of result.warnings) {
					console.log(`  ${warning}`);
				}
			}
			if (result.failed.length > 0) {
				console.log("\nFailures:");
				// Print minimal, user-friendly failure lines
				for (const fail of result.failed) {
					console.log(`  ${fail.error}`);
				}
				// Optional smart hints (e.g., proxy/login)
				if (result.hints && result.hints.length > 0) {
					console.log("\nHints:");
					for (const h of result.hints) console.log(`  ${h}`);
				}
				if (!options.verbose) {
					console.log("\nTip: run with --verbose to see additional logs.");
				}
				process.exit(1);
			}
			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program
	.command("watch")
	.description("Watch for changes and auto-sync")
	.option("--interval <interval>", "Polling interval (e.g., 60s, 5m)", "60s")
	.option(
		"--strategy <strategy>",
		"Conflict resolution strategy: prefer-backlog|prefer-jira|prompt|manual",
		"prefer-backlog",
	)
	.option("--stop-on-error", "Stop watch mode if an error occurs")
	.option("-v, --verbose", "Show detailed logging output")
	.action(async (options) => {
		try {
			await watch({
				interval: options.interval,
				strategy: options.strategy,
				stopOnError: options.stopOnError,
				verbose: options.verbose,
			});
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

program.parse();
