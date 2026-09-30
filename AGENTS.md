<!-- BACKLOG-JIRA GUIDELINES START -->
# Backlog-Jira Plugin Guidelines

## Overview

The `backlog-jira` plugin provides bidirectional synchronization between Backlog.md tasks and Jira issues.
It allows you to work locally with Backlog.md's task management while staying synchronized with your team's Jira project.

## Core Commands

### Initialization
```bash
backlog-jira init           # Initialize plugin configuration, then offer the guided setup
backlog-jira configure      # Guided setup wizard (credentials to import filter)
backlog-jira connect        # Verify Jira connection
backlog-jira doctor         # Check environment setup
```

### Synchronization
```bash
backlog-jira pull           # Pull updates from Jira to Backlog.md
backlog-jira push           # Push Backlog.md changes to Jira
backlog-jira sync           # Bidirectional sync (pull + push)
backlog-jira watch          # Continuous sync mode
```

### Status & Configuration
```bash
backlog-jira status         # View sync status
backlog-jira configure --step <step> # Revisit one setup step (credentials, connection, project, status, sprints, fields, conflict, filter)
backlog-jira map            # Link Backlog tasks to Jira issues
backlog-jira map-fields     # Map extra Jira fields (or a board's sprints) onto Backlog tasks
backlog-jira view <task-id> # View task sync details
backlog-jira resolve <id>... # Show the task ID or Jira key each ID pairs with
```

## Task IDs and Jira Keys

Backlog task IDs (`TASK-12`) and Jira keys (`<PROJECT>-<n>`, e.g. `PROJ-77`, where `<PROJECT>` is `jira.projectKey` in `.backlog-jira/config.json`) are numbered independently, so their numbers do not correspond. Task descriptions, notes and Jira comments may mention either, and the plugin never rewrites them.

- A `<PROJECT>-<n>` in task text is a Jira key, not a task ID. Resolve it before acting on it:
  ```bash
  backlog-jira resolve PROJ-77 --plain   # columns: input, task, jira, state (linked, unlinked-task, unlinked-jira, unknown)
  backlog-jira resolve TASK-12 PROJ-77   # any mix of IDs; linked pairs print as TASK-12 ⇄ PROJ-77
  ```
- `backlog-jira` commands that take a task (`view`, `push`, `pull`, `sync`, `map link`, `create-issue`) also accept the Jira key of its linked issue.
- `backlog` commands take task IDs only: never pass a Jira key where a task ID is expected (`backlog task edit <id>`, `--dep`, `-p`). Resolve it to its task ID first.
- When writing task text, refer to tasks by task ID and to Jira issues by Jira key.

## Configuration

The plugin stores configuration in `.backlog-jira/config.json`:

```json
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
```

## Sprint Sync

A `fieldMappings` entry of type `sprint` represents the Jira sprints of one board as Backlog milestones:

```json
{ "backlog": "milestone", "jira": "sprint", "type": "sprint", "direction": "both",
  "boardId": 12, "createSprints": false, "archiveClosedSprints": true, "pullScope": "all" }
```

- **Pull**: task milestone = the issue's open sprint, else its most recently completed sprint, else none. Missing milestones are created (due date from the end date, description from the goal). Renames, date and goal changes follow Jira, and closed sprints archive their milestone (`archiveClosedSprints`).
- **Push**: changing a task's milestone moves the issue into the matching future or active sprint (by registry, then by name on the board). Clearing it moves the issue to the backlog. An unmatched milestone is reported, or creates a sprint with `createSprints: true`. Closed sprints are never targeted and subtasks are skipped.
- **Sync**: sprints are compared by Jira sprint id, so renames are not changes. One-sided changes propagate, and changes on both sides follow the conflict strategy (`sprint` in the prompt).
- `pullScope: "open"` limits `pull --import` to `sprint in openSprints()`.

Set up with `backlog-jira configure --step sprints` (or `backlog-jira map-fields boards` and `backlog-jira map-fields add milestone sprint --type sprint --board <id>`), then check with `backlog-jira doctor`. `backlog-jira view <task-id>` shows a task's sprint history and `backlog-jira status` counts tasks per sprint.

To move a task to another sprint, change its milestone with `backlog task edit <id> -m <milestone>` and push. Do not create, rename or delete sprint milestones by hand: the plugin keeps them in step with Jira.

Limitations: one board per config; Jira Software and the MCP Atlassian `jira_agile` toolset are required; archived milestones cannot be renamed or unarchived; created sprints get a start date just after creation (MCP Atlassian requires one). See `docs/sprint-sync.md`.

## Parent and Epic Links

Task parents (`parent_task_id`, shown by Backlog.md as subtasks) are synced with Jira parents and epics, compared by linked Jira key:

- **Pull**: a task's parent follows its issue's parent or epic (Epic Link on Jira Server/Data Center). `pull --import` imports parents before children and creates children as subtasks of their parent's task. An issue whose Jira parent is not linked to a task is reported, and a later pull sets the parent once it is linked.
- **Push**: a change of the task's parent sets, changes or clears the issue's parent. Jira only allows epic > standard issue > subtask and the plugin never changes issue types, so a subtask of a subtask, a standard issue under a standard issue, or a parent task not linked to Jira is reported and left pending.
- **Sync**: one-sided changes propagate; changes on both sides follow the conflict strategy (`parent` in the prompt).
- **create-issue**: a task whose parent is linked becomes a subtask of the parent's issue, or a standard issue when that parent is an epic. `--parent <JIRA-KEY|TASK-ID>` picks the parent; a parent task not linked yet needs its own issue first (`backlog-jira create-issue <parent-task>`).

Create subtasks with `backlog task create "Title" -p <parent-task-id>`. `backlog task edit` cannot change an existing task's parent, so change it in Jira and pull; do not edit `parent_task_id` in task files. `backlog-jira view <task-id>` shows a task's parent and subtasks as `TASK ⇄ KEY` pairs and `backlog-jira doctor` lists parent links that cannot be synced. Turn off with `"sync": { "parentLinks": false }`; set `jira.epicLinkField` when the Epic Link field is not found. See `docs/parent-sync.md`.

## Authentication

Set your Jira credentials via environment variables:

```bash
export JIRA_URL="https://your-domain.atlassian.net"
export JIRA_EMAIL="your-email@example.com"
export JIRA_API_TOKEN="your-api-token"
```

Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens

For Jira Server/Data Center, export `JIRA_URL` and `JIRA_PERSONAL_TOKEN` instead. The variables must be exported to the process: the plugin does not read `.env` files (load one with direnv or `set -a; . ./.env; set +a`). `backlog-jira configure --step credentials` checks them. Tokens are never stored in `.backlog-jira/config.json`.

## Workflow Integration

### Starting Work on a Task

1. **Pull latest from Jira**:
   ```bash
   backlog-jira pull
   ```

2. **Start your task using Backlog.md**:
   ```bash
   backlog task edit <id> -s "In Progress" -a @yourself
   ```

3. **Push status to Jira**:
   ```bash
   backlog-jira push
   ```

### Completing a Task

1. **Update locally**:
   ```bash
   backlog task edit <id> -s "Done"
   ```

2. **Sync with Jira**:
   ```bash
   backlog-jira push
   ```

### Continuous Sync

For active development, use watch mode:

```bash
backlog-jira watch
```

This will automatically sync changes every 60 seconds (configurable).

## Conflict Resolution

When conflicts occur (both sides modified), the plugin will:

- **prompt mode** (default): Ask you to choose which version to keep for each field changed on both sides; fields changed on only one side are merged automatically
- **prefer-backlog**: Always use Backlog.md version
- **prefer-jira**: Always use Jira version

Configure via:
```bash
backlog-jira configure --step conflict                                  # interactive
backlog-jira configure --non-interactive --conflict-strategy <strategy>  # scripts and CI
```

## Status Mapping

The plugin maps Backlog.md task statuses to Jira issue statuses. Configure mappings with (lists the project's Jira statuses per issue type):

```bash
backlog-jira configure --step status
```

## Acceptance Criteria Sync

The plugin can sync acceptance criteria between Backlog.md and Jira:

- Backlog.md uses `- [ ] #N criterion` format
- Jira uses subtasks or checklist custom field (if available)
- Enable with: `backlog-jira configure --non-interactive --enable-annotations`

## Best Practices

1. **Always pull before pushing**: Avoid conflicts by staying up-to-date
2. **Use watch mode during active work**: Automatic sync reduces manual steps
3. **Configure status mappings**: Match your team's Jira workflow
4. **Handle conflicts promptly**: Don't let conflicting states linger
5. **Use `backlog-jira status`**: Check sync state before critical operations

## Troubleshooting

### Connection Issues
```bash
backlog-jira connect  # Test connection
backlog-jira doctor   # Check environment
```

### Sync Issues
```bash
backlog-jira status           # View current state
backlog-jira view <task-id>   # Check specific task
```

### Reset Configuration
```bash
rm -rf .backlog-jira
backlog-jira init
```

## Storage

The plugin uses file-based storage for sync state:
- **Link records**: Jira metadata (jira_key, jira_url, jira_last_sync, jira_sync_state) and mapped `frontmatter:<key>` values stored in `.backlog-jira/links/<task-id>.json` and mirrored into task file frontmatter. `backlog task edit` drops these frontmatter keys; the plugin reads them back from the link record and restores them after its own edits
- **Snapshots**: Stored as JSON files in `.backlog-jira/snapshots/<task-id>-<side>.json`
- **Operations log**: Append-only log in `.backlog-jira/ops-log.jsonl`
- **Sprint registry**: `.backlog-jira/sprints.json` links Jira sprint ids to milestone ids with the last known sprint data and the discovered Sprint field id (version controlled). Link records also hold each issue's sprint history
- **Milestone refusals**: `.backlog-jira/milestone-refusals.json` lists sprint milestones the plugin refused to update directly (reported by `doctor`)
- **Parent problems**: link records also hold why a task's parent could not be synced at the last pull or push (shown by `view`, reported by `doctor`)

This approach:
- ✅ Git-friendly (all metadata is version controlled)
- ✅ Human-readable (no binary database files)
- ✅ Single source of truth (metadata lives with the task)
- ✅ No external dependencies (no SQLite required)
<!-- BACKLOG-JIRA GUIDELINES END -->

<!-- BACKLOG.MD GUIDELINES START -->
# Instructions for the usage of Backlog.md CLI Tool

## Backlog.md: Comprehensive Project Management Tool via CLI

### Assistant Objective

Efficiently manage all project tasks, status, and documentation using the Backlog.md CLI, ensuring all project metadata
remains fully synchronized and up-to-date.

### Core Capabilities

- ✅ **Task Management**: Create, edit, assign, prioritize, and track tasks with full metadata
- ✅ **Search**: Fuzzy search across tasks, documents, and decisions with `backlog search`
- ✅ **Acceptance Criteria**: Granular control with add/remove/check/uncheck by index
- ✅ **Board Visualization**: Terminal-based Kanban board (`backlog board`) and web UI (`backlog browser`)
- ✅ **Git Integration**: Automatic tracking of task states across branches
- ✅ **Dependencies**: Task relationships and subtask hierarchies
- ✅ **Documentation & Decisions**: Structured docs and architectural decision records
- ✅ **Export & Reporting**: Generate markdown reports and board snapshots
- ✅ **AI-Optimized**: `--plain` flag provides clean text output for AI processing

### Why This Matters to You (AI Agent)

1. **Comprehensive system** - Full project management capabilities through CLI
2. **The CLI is the interface** - All operations go through `backlog` commands
3. **Unified interaction model** - You can use CLI for both reading (`backlog task 1 --plain`) and writing (
   `backlog task edit 1`)
4. **Metadata stays synchronized** - The CLI handles all the complex relationships

### Key Understanding

- **Tasks** live in `backlog/tasks/` as `task-<id> - <title>.md` files
- **You interact via CLI only**: `backlog task create`, `backlog task edit`, etc.
- **Use `--plain` flag** for AI-friendly output when viewing/listing
- **Never bypass the CLI** - It handles Git, metadata, file naming, and relationships

---

# ⚠️ CRITICAL: NEVER EDIT TASK FILES DIRECTLY. Edit Only via CLI

**ALL task operations MUST use the Backlog.md CLI commands**

- ✅ **DO**: Use `backlog task edit` and other CLI commands
- ✅ **DO**: Use `backlog task create` to create new tasks
- ✅ **DO**: Use `backlog task edit <id> --check-ac <index>` to mark acceptance criteria
- ❌ **DON'T**: Edit markdown files directly
- ❌ **DON'T**: Manually change checkboxes in files
- ❌ **DON'T**: Add or modify text in task files without using CLI

**Why?** Direct file editing breaks metadata synchronization, Git tracking, and task relationships.

---

## 1. Source of Truth & File Structure

### 📖 **UNDERSTANDING** (What you'll see when reading)

- Markdown task files live under **`backlog/tasks/`** (drafts under **`backlog/drafts/`**)
- Files are named: `task-<id> - <title>.md` (e.g., `task-42 - Add GraphQL resolver.md`)
- Project documentation is in **`backlog/docs/`**
- Project decisions are in **`backlog/decisions/`**

### 🔧 **ACTING** (How to change things)

- **All task operations MUST use the Backlog.md CLI tool**
- This ensures metadata is correctly updated and the project stays in sync
- **Always use `--plain` flag** when listing or viewing tasks for AI-friendly text output

---

## 2. Common Mistakes to Avoid

### ❌ **WRONG: Direct File Editing**

```markdown
# DON'T DO THIS:

1. Open backlog/tasks/task-7 - Feature.md in editor
2. Change "- [ ]" to "- [x]" manually
3. Add notes directly to the file
4. Save the file
```

### ✅ **CORRECT: Using CLI Commands**

```bash
# DO THIS INSTEAD:
backlog task edit 7 --check-ac 1  # Mark AC #1 as complete
backlog task edit 7 --notes "Implementation complete"  # Add notes
backlog task edit 7 -s "In Progress" -a @agent-k  # Multiple commands: change status and assign the task when you start working on the task
```

---

## 3. Understanding Task Format (Read-Only Reference)

⚠️ **FORMAT REFERENCE ONLY** - The following sections show what you'll SEE in task files.
**Never edit these directly! Use CLI commands to make changes.**

### Task Structure You'll See

```markdown
---
id: task-42
title: Add GraphQL resolver
status: To Do
assignee: [@sara]
labels: [backend, api]
---

## Description

Brief explanation of the task purpose.

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 First criterion
- [x] #2 Second criterion (completed)
- [ ] #3 Third criterion

<!-- AC:END -->

## Implementation Plan

1. Research approach
2. Implement solution

## Implementation Notes

Summary of what was done.
```

### How to Modify Each Section

| What You Want to Change | CLI Command to Use                                       |
|-------------------------|----------------------------------------------------------|
| Title                   | `backlog task edit 42 -t "New Title"`                    |
| Status                  | `backlog task edit 42 -s "In Progress"`                  |
| Assignee                | `backlog task edit 42 -a @sara`                          |
| Labels                  | `backlog task edit 42 -l backend,api`                    |
| Description             | `backlog task edit 42 -d "New description"`              |
| Add AC                  | `backlog task edit 42 --ac "New criterion"`              |
| Check AC #1             | `backlog task edit 42 --check-ac 1`                      |
| Uncheck AC #2           | `backlog task edit 42 --uncheck-ac 2`                    |
| Remove AC #3            | `backlog task edit 42 --remove-ac 3`                     |
| Add Plan                | `backlog task edit 42 --plan "1. Step one\n2. Step two"` |
| Add Notes (replace)     | `backlog task edit 42 --notes "What I did"`              |
| Append Notes            | `backlog task edit 42 --append-notes "Another note"` |

---

## 4. Defining Tasks

### Creating New Tasks

**Always use CLI to create tasks:**

```bash
# Example
backlog task create "Task title" -d "Description" --ac "First criterion" --ac "Second criterion"
```

### Title (one liner)

Use a clear brief title that summarizes the task.

### Description (The "why")

Provide a concise summary of the task purpose and its goal. Explains the context without implementation details.

### Acceptance Criteria (The "what")

**Understanding the Format:**

- Acceptance criteria appear as numbered checkboxes in the markdown files
- Format: `- [ ] #1 Criterion text` (unchecked) or `- [x] #1 Criterion text` (checked)

**Managing Acceptance Criteria via CLI:**

⚠️ **IMPORTANT: How AC Commands Work**

- **Adding criteria (`--ac`)** accepts multiple flags: `--ac "First" --ac "Second"` ✅
- **Checking/unchecking/removing** accept multiple flags too: `--check-ac 1 --check-ac 2` ✅
- **Mixed operations** work in a single command: `--check-ac 1 --uncheck-ac 2 --remove-ac 3` ✅

```bash
# Examples

# Add new criteria (MULTIPLE values allowed)
backlog task edit 42 --ac "User can login" --ac "Session persists"

# Check specific criteria by index (MULTIPLE values supported)
backlog task edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check multiple ACs
# Or check them individually if you prefer:
backlog task edit 42 --check-ac 1    # Mark #1 as complete
backlog task edit 42 --check-ac 2    # Mark #2 as complete

# Mixed operations in single command
backlog task edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3

# ❌ STILL WRONG - These formats don't work:
# backlog task edit 42 --check-ac 1,2,3  # No comma-separated values
# backlog task edit 42 --check-ac 1-3    # No ranges
# backlog task edit 42 --check 1         # Wrong flag name

# Multiple operations of same type
backlog task edit 42 --uncheck-ac 1 --uncheck-ac 2  # Uncheck multiple ACs
backlog task edit 42 --remove-ac 2 --remove-ac 4    # Remove multiple ACs (processed high-to-low)
```

**Key Principles for Good ACs:**

- **Outcome-Oriented:** Focus on the result, not the method.
- **Testable/Verifiable:** Each criterion should be objectively testable
- **Clear and Concise:** Unambiguous language
- **Complete:** Collectively cover the task scope
- **User-Focused:** Frame from end-user or system behavior perspective

Good Examples:

- "User can successfully log in with valid credentials"
- "System processes 1000 requests per second without errors"
- "CLI preserves literal newlines in description/plan/notes; `\\n` sequences are not auto‑converted"

Bad Example (Implementation Step):

- "Add a new function handleLogin() in auth.ts"
- "Define expected behavior and document supported input patterns"

### Task Breakdown Strategy

1. Identify foundational components first
2. Create tasks in dependency order (foundations before features)
3. Ensure each task delivers value independently
4. Avoid creating tasks that block each other

### Task Requirements

- Tasks must be **atomic** and **testable** or **verifiable**
- Each task should represent a single unit of work for one PR
- **Never** reference future tasks (only tasks with id < current task id)
- Ensure tasks are **independent** and don't depend on future work

---

## 5. Implementing Tasks

### 5.1. First step when implementing a task

The very first things you must do when you take over a task are:

* set the task in progress
* assign it to yourself

```bash
# Example
backlog task edit 42 -s "In Progress" -a @{myself}
```

### 5.2. Create an Implementation Plan (The "how")

Previously created tasks contain the why and the what. Once you are familiar with that part you should think about a
plan on **HOW** to tackle the task and all its acceptance criteria. This is your **Implementation Plan**.
First do a quick check to see if all the tools that you are planning to use are available in the environment you are
working in.   
When you are ready, write it down in the task so that you can refer to it later.

```bash
# Example
backlog task edit 42 --plan "1. Research codebase for references\n2Research on internet for similar cases\n3. Implement\n4. Test"
```

## 5.3. Implementation

Once you have a plan, you can start implementing the task. This is where you write code, run tests, and make sure
everything works as expected. Follow the acceptance criteria one by one and MARK THEM AS COMPLETE as soon as you
finish them.

### 5.4 Implementation Notes (PR description)

When you are done implementing a tasks you need to prepare a PR description for it.
Because you cannot create PRs directly, write the PR as a clean description in the task notes.
Append notes progressively during implementation using `--append-notes`:

```
backlog task edit 42 --append-notes "Implemented X" --append-notes "Added tests"
```

```bash
# Example
backlog task edit 42 --notes "Implemented using pattern X because Reason Y, modified files Z and W"
```

**IMPORTANT**: Do NOT include an Implementation Plan when creating a task. The plan is added only after you start the
implementation.

- Creation phase: provide Title, Description, Acceptance Criteria, and optionally labels/priority/assignee.
- When you begin work, switch to edit, set the task in progress and assign to yourself
  `backlog task edit <id> -s "In Progress" -a "..."`.
- Think about how you would solve the task and add the plan: `backlog task edit <id> --plan "..."`.
- Add Implementation Notes only after completing the work: `backlog task edit <id> --notes "..."` (replace) or append progressively using `--append-notes`.

## Phase discipline: What goes where

- Creation: Title, Description, Acceptance Criteria, labels/priority/assignee.
- Implementation: Implementation Plan (after moving to In Progress and assigning to yourself).
- Wrap-up: Implementation Notes (Like a PR description), AC and Definition of Done checks.

**IMPORTANT**: Only implement what's in the Acceptance Criteria. If you need to do more, either:

1. Update the AC first: `backlog task edit 42 --ac "New requirement"`
2. Or create a new follow up task: `backlog task create "Additional feature"`

---

## 6. Typical Workflow

```bash
# 1. Identify work
backlog task list -s "To Do" --plain

# 2. Read task details
backlog task 42 --plain

# 3. Start work: assign yourself & change status
backlog task edit 42 -s "In Progress" -a @myself

# 4. Add implementation plan
backlog task edit 42 --plan "1. Analyze\n2. Refactor\n3. Test"

# 5. Work on the task (write code, test, etc.)

# 6. Mark acceptance criteria as complete (supports multiple in one command)
backlog task edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check all at once
# Or check them individually if preferred:
# backlog task edit 42 --check-ac 1
# backlog task edit 42 --check-ac 2
# backlog task edit 42 --check-ac 3

# 7. Add implementation notes (PR Description)
backlog task edit 42 --notes "Refactored using strategy pattern, updated tests"

# 8. Mark task as done
backlog task edit 42 -s Done
```

---

## 7. Definition of Done (DoD)

A task is **Done** only when **ALL** of the following are complete:

### ✅ Via CLI Commands:

1. **All acceptance criteria checked**: Use `backlog task edit <id> --check-ac <index>` for each
2. **Implementation notes added**: Use `backlog task edit <id> --notes "..."`
3. **Status set to Done**: Use `backlog task edit <id> -s Done`

### ✅ Via Code/Testing:

4. **Tests pass**: Run test suite and linting
5. **Documentation updated**: Update relevant docs if needed
6. **Code reviewed**: Self-review your changes
7. **No regressions**: Performance, security checks pass

⚠️ **NEVER mark a task as Done without completing ALL items above**

---

## 8. Finding Tasks and Content with Search

When users ask you to find tasks related to a topic, use the `backlog search` command with `--plain` flag:

```bash
# Search for tasks about authentication
backlog search "auth" --plain

# Search only in tasks (not docs/decisions)
backlog search "login" --type task --plain

# Search with filters
backlog search "api" --status "In Progress" --plain
backlog search "bug" --priority high --plain
```

**Key points:**
- Uses fuzzy matching - finds "authentication" when searching "auth"
- Searches task titles, descriptions, and content
- Also searches documents and decisions unless filtered with `--type task`
- Always use `--plain` flag for AI-readable output

---

## 9. Quick Reference: DO vs DON'T

### Viewing and Finding Tasks

| Task         | ✅ DO                        | ❌ DON'T                         |
|--------------|-----------------------------|---------------------------------|
| View task    | `backlog task 42 --plain`   | Open and read .md file directly |
| List tasks   | `backlog task list --plain` | Browse backlog/tasks folder     |
| Check status | `backlog task 42 --plain`   | Look at file content            |
| Find by topic| `backlog search "auth" --plain` | Manually grep through files |

### Modifying Tasks

| Task          | ✅ DO                                 | ❌ DON'T                           |
|---------------|--------------------------------------|-----------------------------------|
| Check AC      | `backlog task edit 42 --check-ac 1`  | Change `- [ ]` to `- [x]` in file |
| Add notes     | `backlog task edit 42 --notes "..."` | Type notes into .md file          |
| Change status | `backlog task edit 42 -s Done`       | Edit status in frontmatter        |
| Add AC        | `backlog task edit 42 --ac "New"`    | Add `- [ ] New` to file           |

---

## 10. Complete CLI Command Reference

### Task Creation

| Action           | Command                                                                             |
|------------------|-------------------------------------------------------------------------------------|
| Create task      | `backlog task create "Title"`                                                       |
| With description | `backlog task create "Title" -d "Description"`                                      |
| With AC          | `backlog task create "Title" --ac "Criterion 1" --ac "Criterion 2"`                 |
| With all options | `backlog task create "Title" -d "Desc" -a @sara -s "To Do" -l auth --priority high` |
| Create draft     | `backlog task create "Title" --draft`                                               |
| Create subtask   | `backlog task create "Title" -p 42`                                                 |

### Task Modification

| Action           | Command                                     |
|------------------|---------------------------------------------|
| Edit title       | `backlog task edit 42 -t "New Title"`       |
| Edit description | `backlog task edit 42 -d "New description"` |
| Change status    | `backlog task edit 42 -s "In Progress"`     |
| Assign           | `backlog task edit 42 -a @sara`             |
| Add labels       | `backlog task edit 42 -l backend,api`       |
| Set priority     | `backlog task edit 42 --priority high`      |

### Acceptance Criteria Management

| Action              | Command                                                                     |
|---------------------|-----------------------------------------------------------------------------|
| Add AC              | `backlog task edit 42 --ac "New criterion" --ac "Another"`                  |
| Remove AC #2        | `backlog task edit 42 --remove-ac 2`                                        |
| Remove multiple ACs | `backlog task edit 42 --remove-ac 2 --remove-ac 4`                          |
| Check AC #1         | `backlog task edit 42 --check-ac 1`                                         |
| Check multiple ACs  | `backlog task edit 42 --check-ac 1 --check-ac 3`                            |
| Uncheck AC #3       | `backlog task edit 42 --uncheck-ac 3`                                       |
| Mixed operations    | `backlog task edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3 --ac "New"` |

### Task Content

| Action           | Command                                                  |
|------------------|----------------------------------------------------------|
| Add plan         | `backlog task edit 42 --plan "1. Step one\n2. Step two"` |
| Add notes        | `backlog task edit 42 --notes "Implementation details"`  |
| Add dependencies | `backlog task edit 42 --dep task-1 --dep task-2`         |

### Multi‑line Input (Description/Plan/Notes)

The CLI preserves input literally. Shells do not convert `\n` inside normal quotes. Use one of the following to insert real newlines:

- Bash/Zsh (ANSI‑C quoting):
  - Description: `backlog task edit 42 --desc $'Line1\nLine2\n\nFinal'`
  - Plan: `backlog task edit 42 --plan $'1. A\n2. B'`
  - Notes: `backlog task edit 42 --notes $'Done A\nDoing B'`
  - Append notes: `backlog task edit 42 --append-notes $'Progress update line 1\nLine 2'`
- POSIX portable (printf):
  - `backlog task edit 42 --notes "$(printf 'Line1\nLine2')"`
- PowerShell (backtick n):
  - `backlog task edit 42 --notes "Line1`nLine2"`

Do not expect `"...\n..."` to become a newline. That passes the literal backslash + n to the CLI by design.

Descriptions support literal newlines; shell examples may show escaped `\\n`, but enter a single `\n` to create a newline.

### Implementation Notes Formatting

- Keep implementation notes human-friendly and PR-ready: use short paragraphs or
  bullet lists instead of a single long line.
- Lead with the outcome, then add supporting details (e.g., testing, follow-up
  actions) on separate lines or bullets.
- Prefer Markdown bullets (`-` for unordered, `1.` for ordered) so Maintainers
  can paste notes straight into GitHub without additional formatting.
- When using CLI flags like `--append-notes`, remember to include explicit
  newlines. Example:

  ```bash
  backlog task edit 42 --append-notes $'- Added new API endpoint\n- Updated tests\n- TODO: monitor staging deploy'
  ```

### Task Operations

| Action             | Command                                      |
|--------------------|----------------------------------------------|
| View task          | `backlog task 42 --plain`                    |
| List tasks         | `backlog task list --plain`                  |
| Search tasks       | `backlog search "topic" --plain`              |
| Search with filter | `backlog search "api" --status "To Do" --plain` |
| Filter by status   | `backlog task list -s "In Progress" --plain` |
| Filter by assignee | `backlog task list -a @sara --plain`         |
| Archive task       | `backlog task archive 42`                    |
| Demote to draft    | `backlog task demote 42`                     |

---

## Common Issues

| Problem              | Solution                                                           |
|----------------------|--------------------------------------------------------------------|
| Task not found       | Check task ID with `backlog task list --plain`                     |
| AC won't check       | Use correct index: `backlog task 42 --plain` to see AC numbers     |
| Changes not saving   | Ensure you're using CLI, not editing files                         |
| Metadata out of sync | Re-edit via CLI to fix: `backlog task edit 42 -s <current-status>` |

---

## Remember: The Golden Rule

**🎯 If you want to change ANYTHING in a task, use the `backlog task edit` command.**
**📖 Use CLI to read tasks, exceptionally READ task files directly, never WRITE to them.**

Full help available: `backlog --help`

<!-- BACKLOG.MD GUIDELINES END -->
