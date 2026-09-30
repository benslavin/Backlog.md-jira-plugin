import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.ts";

/**
 * Marker types for wrapping agent instruction content
 */
export interface Markers {
	start: string;
	end: string;
}

/**
 * Mode for agent instructions: CLI (embedded content) or MCP (reference to MCP resources)
 */
export type InstructionMode = "cli" | "mcp";

/**
 * Get HTML comment markers for wrapping content based on file type
 */
export function getMarkers(filePath: string): Markers {
	const fileName = filePath.toLowerCase();

	// For markdown files, use HTML comments
	if (fileName.endsWith(".md")) {
		return {
			start: "<!-- BACKLOG-JIRA GUIDELINES START -->",
			end: "<!-- BACKLOG-JIRA GUIDELINES END -->",
		};
	}

	// Default to HTML comments (works in most documentation formats)
	return {
		start: "<!-- BACKLOG-JIRA GUIDELINES START -->",
		end: "<!-- BACKLOG-JIRA GUIDELINES END -->",
	};
}

/**
 * Check if a file already has backlog-jira guidelines
 */
export function hasBacklogJiraGuidelines(content: string): boolean {
	const markers = getMarkers("dummy.md"); // File type doesn't matter for detection
	return content.includes(markers.start) && content.includes(markers.end);
}

/**
 * Wrap content with markers
 */
export function wrapWithMarkers(content: string, filePath: string): string {
	const markers = getMarkers(filePath);
	return `${markers.start}\n${content}\n${markers.end}`;
}

/**
 * Strip existing guideline section from content
 */
export function stripGuidelineSection(
	content: string,
	filePath: string,
): string {
	const markers = getMarkers(filePath);
	const startIndex = content.indexOf(markers.start);
	const endIndex = content.indexOf(markers.end);

	if (startIndex === -1 || endIndex === -1) {
		return content;
	}

	// Remove the section including the markers and surrounding newlines
	const before = content.substring(0, startIndex).trimEnd();
	const after = content.substring(endIndex + markers.end.length).trimStart();

	return `${before}\n\n${after}`;
}

/**
 * Get CLI mode content - comprehensive plugin guidelines
 */
export function getCliModeContent(): string {
	return `# Backlog-Jira Plugin Guidelines

## Overview

The \`backlog-jira\` plugin provides bidirectional synchronization between Backlog.md tasks and Jira issues.
It allows you to work locally with Backlog.md's task management while staying synchronized with your team's Jira project.

## Core Commands

### Initialization
\`\`\`bash
backlog-jira init           # Initialize plugin configuration, then offer the guided setup
backlog-jira configure      # Guided setup wizard (credentials to import filter)
backlog-jira connect        # Verify Jira connection
backlog-jira doctor         # Check environment setup
\`\`\`

### Synchronization
\`\`\`bash
backlog-jira pull           # Pull updates from Jira to Backlog.md
backlog-jira push           # Push Backlog.md changes to Jira
backlog-jira sync           # Bidirectional sync (pull + push)
backlog-jira watch          # Continuous sync mode
\`\`\`

### Status & Configuration
\`\`\`bash
backlog-jira status         # View sync status
backlog-jira configure --step <step> # Revisit one setup step (credentials, connection, project, status, sprints, fields, conflict, filter)
backlog-jira view <task-id> # View task sync details
backlog-jira resolve <id>... # Show the task ID or Jira key each ID pairs with
\`\`\`

## Task IDs and Jira Keys

Backlog task IDs (\`TASK-12\`) and Jira keys (\`<PROJECT>-<n>\`, e.g. \`PROJ-77\`, where \`<PROJECT>\` is \`jira.projectKey\` in \`.backlog-jira/config.json\`) are numbered independently, so their numbers do not correspond. Task descriptions, notes and Jira comments may mention either, and the plugin never rewrites them.

- A \`<PROJECT>-<n>\` in task text is a Jira key, not a task ID. Resolve it before acting on it:
  \`\`\`bash
  backlog-jira resolve PROJ-77 --plain   # columns: input, task, jira, state (linked, unlinked-task, unlinked-jira, unknown)
  backlog-jira resolve TASK-12 PROJ-77   # any mix of IDs; linked pairs print as TASK-12 ⇄ PROJ-77
  \`\`\`
- \`backlog-jira\` commands that take a task (\`view\`, \`push\`, \`pull\`, \`sync\`, \`map link\`, \`create-issue\`) also accept the Jira key of its linked issue.
- \`backlog\` commands take task IDs only: never pass a Jira key where a task ID is expected (\`backlog task edit <id>\`, \`--dep\`, \`-p\`). Resolve it to its task ID first.
- When writing task text, refer to tasks by task ID and to Jira issues by Jira key.

## Parent and Epic Links

Task parents (\`parent_task_id\`, shown by Backlog.md as subtasks) are synced with Jira parents and epics, compared by linked Jira key:

- **Pull**: a task's parent follows its issue's parent or epic (Epic Link on Jira Server/Data Center). \`pull --import\` imports parents before children and creates children as subtasks of their parent's task. An issue whose Jira parent is not linked to a task is reported, and a later pull sets the parent once it is linked.
- **Push**: a change of the task's parent sets, changes or clears the issue's parent. Jira only allows epic > standard issue > subtask and the plugin never changes issue types, so a subtask of a subtask, a standard issue under a standard issue, or a parent task not linked to Jira is reported and left pending.
- **Sync**: one-sided changes propagate; changes on both sides follow the conflict strategy (\`parent\` in the prompt).
- **create-issue**: a task whose parent is linked becomes a subtask of the parent's issue, or a standard issue when that parent is an epic. \`--parent <JIRA-KEY|TASK-ID>\` picks the parent; a parent task not linked yet needs its own issue first (\`backlog-jira create-issue <parent-task>\`).

Create subtasks with \`backlog task create "Title" -p <parent-task-id>\`. \`backlog task edit\` cannot change an existing task's parent, so change it in Jira and pull; do not edit \`parent_task_id\` in task files. \`backlog-jira view <task-id>\` shows a task's parent and subtasks as \`TASK ⇄ KEY\` pairs and \`backlog-jira doctor\` lists parent links that cannot be synced. Turn off with \`"sync": { "parentLinks": false }\`; set \`jira.epicLinkField\` when the Epic Link field is not found. See \`docs/parent-sync.md\`.

## Configuration

The plugin stores configuration in \`.backlog-jira/config.json\`:

\`\`\`json
{
  "jira": {
    "baseUrl": "https://your-domain.atlassian.net",
    "projectKey": "PROJ",
    "issueType": "Task",
    "jqlFilter": ""
  },
  "backlog": {
    "statusMapping": {
      "To Do": ["To Do", "Open", "Backlog"],
      "In Progress": ["In Progress"],
      "Done": ["Done", "Closed", "Resolved"]
    }
  },
  "sync": {
    "conflictStrategy": "prompt",
    "enableAnnotations": false,
    "watchInterval": 60
  }
}
\`\`\`

## Authentication

Set your Jira credentials via environment variables:

\`\`\`bash
export JIRA_URL="https://your-domain.atlassian.net"
export JIRA_EMAIL="your-email@example.com"
export JIRA_API_TOKEN="your-api-token"
\`\`\`

Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens

For Jira Server/Data Center, export \`JIRA_URL\` and \`JIRA_PERSONAL_TOKEN\` instead. The variables must be exported to the process: the plugin does not read \`.env\` files (load one with direnv or \`set -a; . ./.env; set +a\`). \`backlog-jira configure --step credentials\` checks them. Tokens are never stored in \`.backlog-jira/config.json\`.

## Workflow Integration

### Starting Work on a Task

1. **Pull latest from Jira**:
   \`\`\`bash
   backlog-jira pull
   \`\`\`

2. **Start your task using Backlog.md**:
   \`\`\`bash
   backlog task edit <id> -s "In Progress" -a @yourself
   \`\`\`

3. **Push status to Jira**:
   \`\`\`bash
   backlog-jira push
   \`\`\`

### Completing a Task

1. **Update locally**:
   \`\`\`bash
   backlog task edit <id> -s "Done"
   \`\`\`

2. **Sync with Jira**:
   \`\`\`bash
   backlog-jira push
   \`\`\`

### Continuous Sync

For active development, use watch mode:

\`\`\`bash
backlog-jira watch
\`\`\`

This will automatically sync changes every 60 seconds (configurable).

## Conflict Resolution

When conflicts occur (both sides modified), the plugin will:

- **prompt mode** (default): Ask you to choose which version to keep
- **prefer-backlog**: Always use Backlog.md version
- **prefer-jira**: Always use Jira version

Configure via:
\`\`\`bash
backlog-jira configure --step conflict                                  # interactive
backlog-jira configure --non-interactive --conflict-strategy <strategy>  # scripts and CI
\`\`\`

## Status Mapping

The plugin maps Backlog.md task statuses to Jira issue statuses. Configure mappings with (lists the project's Jira statuses per issue type):

\`\`\`bash
backlog-jira configure --step status
\`\`\`

## Acceptance Criteria Sync

The plugin can sync acceptance criteria between Backlog.md and Jira:

- Backlog.md uses \`- [ ] #N criterion\` format
- Jira uses subtasks or checklist custom field (if available)
- Enable with: \`backlog-jira configure --non-interactive --enable-annotations\`

## Best Practices

1. **Always pull before pushing**: Avoid conflicts by staying up-to-date
2. **Use watch mode during active work**: Automatic sync reduces manual steps
3. **Configure status mappings**: Match your team's Jira workflow
4. **Handle conflicts promptly**: Don't let conflicting states linger
5. **Use \`backlog-jira status\`**: Check sync state before critical operations

## Troubleshooting

### Connection Issues
\`\`\`bash
backlog-jira connect  # Test connection
backlog-jira doctor   # Check environment
\`\`\`

### Sync Issues
\`\`\`bash
backlog-jira status           # View current state
backlog-jira view <task-id>   # Check specific task
\`\`\`

### Reset Configuration
\`\`\`bash
rm -rf .backlog-jira
backlog-jira init
\`\`\`

## Storage

The plugin uses file-based storage for sync state:
- **Task frontmatter**: Jira metadata (\`jira_key\`, \`jira_last_sync\`, \`jira_sync_state\`) stored in the task file
- **Snapshots**: Stored as JSON files in \`.backlog-jira/snapshots/<task-id>-<side>.json\` for conflict detection via content hashing
- **Operations log**: Append-only log in \`.backlog-jira/ops-log.jsonl\`

These files are automatically managed and should not be modified manually.`;
}

/**
 * Get MCP mode content - nudge to read MCP resources
 */
export function getMcpModeContent(): string {
	return `# Backlog-Jira Plugin Integration

## MCP Server Integration

This project uses the \`backlog-jira\` MCP server for bidirectional synchronization with Jira.

**For comprehensive documentation about the backlog-jira plugin, please read the MCP resources:**

- Check available MCP resources for detailed plugin documentation
- Resources include: configuration guides, command reference, workflow patterns, and troubleshooting
- Use MCP tools to interact with Jira: search issues, update tasks, configure mappings

## Quick Reference

### Core Commands
- \`backlog-jira init\` - Initialize configuration
- \`backlog-jira configure\` - Guided setup (\`--step <step>\` to revisit one step)
- \`backlog-jira pull\` - Pull from Jira
- \`backlog-jira push\` - Push to Jira
- \`backlog-jira sync\` - Bidirectional sync
- \`backlog-jira watch\` - Continuous sync mode
- \`backlog-jira resolve <id>... --plain\` - Pair task IDs with Jira keys

### Task IDs and Jira Keys
Backlog task IDs (\`TASK-12\`) and Jira keys (\`<PROJECT>-<n>\`) are numbered independently. A \`<PROJECT>-<n>\` in task text is a Jira key: resolve it with \`backlog-jira resolve\` and never pass it to \`backlog\` commands where a task ID is expected. \`backlog-jira\` commands accept either ID for a linked task.

### Environment Setup
\`\`\`bash
export JIRA_URL="https://your-domain.atlassian.net"
export JIRA_EMAIL="your-email@example.com"
export JIRA_API_TOKEN="your-api-token"
\`\`\`

**For detailed usage, workflows, and troubleshooting, please consult the MCP resources provided by the backlog-jira server.**`;
}

/**
 * Add agent instructions to a file (CLI mode)
 */
export function addAgentInstructions(
	filePath: string,
	mode: InstructionMode = "cli",
): { success: boolean; message: string } {
	try {
		// Check if file exists
		if (!existsSync(filePath)) {
			return {
				success: false,
				message: `File not found: ${filePath}`,
			};
		}

		// Read current content
		const currentContent = readFileSync(filePath, "utf-8");

		// Get appropriate content based on mode
		const guidelinesContent =
			mode === "cli" ? getCliModeContent() : getMcpModeContent();

		// If guidelines already exist, remove them first
		let newContent = currentContent;
		if (hasBacklogJiraGuidelines(currentContent)) {
			newContent = stripGuidelineSection(currentContent, filePath);
		}

		// Add new guidelines at the beginning
		const wrappedContent = wrapWithMarkers(guidelinesContent, filePath);
		newContent = `${wrappedContent}\n\n${newContent.trimStart()}`;

		// Write back
		writeFileSync(filePath, newContent, "utf-8");

		return {
			success: true,
			message: `Successfully added ${mode.toUpperCase()} mode guidelines to ${filePath}`,
		};
	} catch (error) {
		return {
			success: false,
			message: `Error updating file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Ensure MCP guidelines are present in a file
 * This is a convenience wrapper for MCP mode
 */
export function ensureMcpGuidelines(filePath: string): {
	success: boolean;
	message: string;
} {
	return addAgentInstructions(filePath, "mcp");
}

/**
 * Switch mode between CLI and MCP
 */
export function switchInstructionMode(
	filePath: string,
	newMode: InstructionMode,
): { success: boolean; message: string } {
	return addAgentInstructions(filePath, newMode);
}
