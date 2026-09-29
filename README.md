# Backlog.md Jira Plugin

**Bidirectional sync plugin between Backlog.md and Jira via [MCP Atlassian](https://github.com/sooperset/mcp-atlassian) server**

[![Status](https://img.shields.io/badge/status-Phase%205%20Complete-success)](https://github.com/MrLesk/Backlog.md/pull/394)

> This is a fork of [eciuca/Backlog.md-jira-plugin](https://github.com/eciuca/Backlog.md-jira-plugin), versioned independently from 0.3.0 on. See [CHANGELOG.md](CHANGELOG.md) for what changed since upstream 0.2.0.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Overview

The Backlog.md Jira plugin enables seamless bidirectional synchronization between [Backlog.md](https://github.com/MrLesk/Backlog.md) tasks and Jira issues. Built as a standalone plugin following the zero-coupling architecture introduced in [PR #394](https://github.com/MrLesk/Backlog.md/pull/394), it operates entirely through public APIs without requiring any modifications to Backlog.md core.

### What Does It Do?

- **🔄 Bidirectional Sync**: Keep Backlog tasks and Jira issues in sync automatically
- **✅ Acceptance Criteria**: Sync acceptance criteria with full checked/unchecked state
- **📊 Status Mapping**: Flexible status mapping with project-specific overrides
- **🔍 Conflict Detection**: Field-level conflict detection with multiple resolution strategies
- **📝 Field Mapping**: Sync titles, descriptions, statuses, priorities, assignees and labels; sync additional Jira fields (story points, fix versions, custom fields) with configurable [custom field mappings](#custom-field-mappings), including your own priority values
- **🔐 Secure**: Uses MCP (Model Context Protocol) for secure Jira access
- **📦 Standalone**: Zero modifications to Backlog.md core - fully independent plugin

## Architecture

### Design Principles

The plugin follows a **zero-coupling architecture** that ensures complete separation from Backlog.md core:

1. **Public APIs Only**: 
   - Uses Backlog CLI for all Backlog operations
   - Uses MCP Atlassian server for all Jira operations
   - No direct file manipulation or internal API calls

2. **External State Management**:
   - File-based storage in `.backlog-jira/` stores all plugin state
   - Jira link records in `.backlog-jira/links/<task-id>.json` (mirrored into task frontmatter as jira_key, jira_last_sync, etc.)
   - Snapshots stored as JSON files in `.backlog-jira/snapshots/`
   - Operations log in `.backlog-jira/ops-log.jsonl`
   - No modifications to Backlog.md data structures

3. **3-Way Merge**:
   - Stores base snapshots for both Backlog and Jira sides
   - Enables intelligent conflict detection by comparing current state to last known state
   - Supports multiple conflict resolution strategies

4. **Standalone CLI**:
   - Separate `backlog-jira` command namespace
   - Independent npm package installation
   - Can be installed, updated, or removed without affecting Backlog.md

### How It Works

```
┌──────────────┐         ┌─────────────────┐         ┌──────────┐
│  Backlog.md  │◄────────┤  backlog-jira   ├────────►│   Jira   │
│    Tasks     │  CLI    │     Plugin      │   MCP   │  Issues  │
└──────────────┘         └─────────────────┘         └──────────┘
                                 │
                                 ▼
                         ┌───────────────────┐
                         │ File-Based Store  │
                         │ - Frontmatter     │
                         │ - Snapshots       │
                         │ - Ops Log         │
                         └───────────────────┘
```

**Key Components**:

- **Integration Layer**: Wrappers for Backlog CLI and MCP Atlassian client
- **State Store**: File-based storage using task frontmatter, JSON snapshots, and JSONL operations log
- **Sync Engine**: Handles push, pull, and bidirectional sync with conflict resolution
- **Configuration System**: JSON-based configuration with project-specific overrides
- **Logger**: Pino-based logging with secret redaction and structured output

### Storage Architecture

The plugin uses file-based storage in `.backlog-jira/`:

- **Link Records**: Jira metadata (jira_key, jira_url, jira_last_sync, jira_sync_state) and mapped `frontmatter:<key>` values stored in `.backlog-jira/links/<task-id>.json` and mirrored into task frontmatter. Backlog.md 1.5x drops unknown frontmatter keys on `backlog task edit`; the plugin falls back to the link record and restores the keys after its own edits, so tasks stay linked
- **Snapshots**: Payload snapshots for 3-way merge stored in `.backlog-jira/snapshots/<task-id>-<side>.json`
- **Operations Log**: Audit log in `.backlog-jira/ops-log.jsonl` (JSONL format)

**Benefits:**
- ✅ Git-friendly (all metadata is version controlled)
- ✅ Human-readable (no binary database files)
- ✅ Single source of truth (metadata lives with the task)
- ✅ No external dependencies (no SQLite required)

## Features

### ✅ Core Capabilities (Phase 4 Complete)

- ✅ **Task-Issue Mapping**: Create and manage mappings between Backlog tasks and Jira issues
- ✅ **Push (Backlog → Jira)**: Push changes from Backlog to Jira
- ✅ **Pull (Jira → Backlog)**: Pull changes from Jira to Backlog
- ✅ **Bidirectional Sync**: Intelligent 3-way merge with conflict detection
- ✅ **Acceptance Criteria Sync**: Full support for AC with checked/unchecked state
- ✅ **Status Mapping**: Flexible status mapping with project overrides
- ✅ **Field-Level Conflicts**: Detect conflicts at field level (title, description, status, etc.)
- ✅ **Multiple Conflict Strategies**: prefer-backlog, prefer-jira, prompt, manual
- ✅ **Dry Run Mode**: Preview changes without applying them
- ✅ **Batch Operations**: Sync multiple tasks at once with `--all` flag

### ✅ Advanced Features (Phase 5 Complete)

- ✅ **Watch Mode**: Automatic polling-based sync with configurable intervals
- ✅ **Environment Validation**: Comprehensive `doctor` command checking all dependencies
- ✅ **Performance Optimization**: Parallel batch processing for large datasets (100 tasks < 30s)
- ✅ **Rate Limit Handling**: Exponential backoff and graceful error handling
- ✅ **Cross-Platform Support**: Works on Linux, macOS, and Windows via Bun runtime
- ✅ **Built-in MCP Server**: `backlog-jira mcp start` command with DNS configuration support

### 🚧 Future Enhancements

- [ ] **Web UI Integration**: Pull/Push buttons in browser interface
- [ ] **Webhooks**: Real-time sync triggered by Jira webhooks

## Prerequisites

Before installing the plugin, ensure you have:

1. **Backlog.md CLI** installed and configured
   - Install from: https://github.com/MrLesk/Backlog.md
   - Verify: `backlog --version`

2. **MCP Atlassian Server** available
   - Project: https://github.com/sooperset/mcp-atlassian
   - Runs via Docker by default (`ghcr.io/sooperset/mcp-atlassian:latest`), or install it locally
   - Configure with your Jira credentials (see Configuration section)

3. **Node.js 20+** (or Bun)
   - Node.js: https://nodejs.org/
   - Bun (also required for development): `curl -fsSL https://bun.sh/install | bash`

4. **Active Backlog.md Project**
   - Navigate to a directory with `backlog/` folder
   - Or initialize one: `backlog init`

## Installation

### From npm (Future)

```bash
npm install -g @benslavin/backlog-jira
```

This fork publishes under its own scope; the unscoped `backlog-jira` package on npm is the upstream 0.2.0 release. Either way the command is `backlog-jira`.

### From the Git Repository (Recommended)

Install the CLI globally straight from GitHub with your package manager of choice:

```bash
# npm
npm install -g git+https://github.com/benslavin/Backlog.md-jira-plugin.git

# pnpm
pnpm add -g git+https://github.com/benslavin/Backlog.md-jira-plugin.git

# bun
bun add -g git+https://github.com/benslavin/Backlog.md-jira-plugin.git
```

To pin a specific branch, tag, or commit, append `#<ref>` (e.g. `...Backlog.md-jira-plugin.git#v0.3.0`).

The prebuilt CLI (`dist/cli.js`) is committed to the repository, so installing runs no build scripts and works with pnpm's and bun's default script-blocking policies. It runs on Node.js 20+ (or Bun); Bun is only needed to develop the plugin.

To upgrade, re-run the same install command.

### From Source (Development)

```bash
# Clone the repository
git clone https://github.com/benslavin/Backlog.md-jira-plugin.git
cd Backlog.md-jira-plugin

# Install dependencies (Bun is required for building and testing)
bun install

# Build the CLI
bun run build

# Link globally (optional)
npm link

# Or run directly
./dist/cli.js --help
```

### Verify Installation

```bash
backlog-jira --version
backlog-jira doctor
```

## Configuration

### 1. Initialize Plugin

In your Backlog.md project directory:

```bash
backlog-jira init
```

This creates `.backlog-jira/` directory with:
- `config.json` - Configuration file (with default settings)
- `snapshots/` - Snapshot directory for 3-way merge
- `links/` - Jira link records per task (version controlled)
- `ops-log.jsonl` - Operations audit log
- `.gitignore` - Excludes everything except `links/` and `sprints.json`

`init` then offers to start the guided setup. If you decline, the default config stays in place and you can run `backlog-jira configure` whenever you are ready.

### Guided Setup (`backlog-jira configure`)

`backlog-jira configure` takes you from an empty Backlog.md project to a verified, ready-to-import configuration. Every step can be skipped, and each completed step is saved immediately. Esc goes back: inside a step it returns to the step's "Set up … now?" question without saving that step, and on that question it returns to the previous step (with `--step`, Esc leaves the step unchanged). Ctrl+C quits:

| Step | What it does |
|------|--------------|
| `credentials` | Checks that `JIRA_URL` and `JIRA_EMAIL` + `JIRA_API_TOKEN` (or `JIRA_PERSONAL_TOKEN`) are exported, and explains the export, `.env` and direnv options when they are not. You can enter them for the current session (optionally writing a git-ignored `.env`); tokens are never written to `config.json`. |
| `connection` | Starts the MCP Atlassian server and calls Jira, showing the underlying error (Docker, DNS, HTTP status, proxy) when it fails. |
| `project` | Picks the project and the issue type from lists fetched from Jira. |
| `status` | One checkbox list of the project's Jira statuses, labelled by where they were found (on Epic/Story issues, reachable by a transition, or used elsewhere on the site) and checked with Jira. Proposes the whole mapping to your Backlog statuses (from `backlog config`); accept it, or change only the statuses you pick (including leaving one explicitly unmapped). Unticked statuses are removed from the mapping. |
| `sprints` | Lists the project's boards, and for a board with sprints writes the sprint mapping (direction, `createSprints`, `archiveClosedSprints`, `pullScope`) and sets `mcp.envVars.TOOLSETS` so the `jira_agile` tools stay enabled. |
| `fields` | A menu that always shows the fields synced by default (summary, description, status, assignee, labels, priority), the configured mappings (including the sprint mapping) and the pending changes. **Add suggested fields** lists the fields used by the 50 most recently updated project issues, most used first, with a suggested target and type; noise fields (watchers, rank) and unsupported types are left out. **Search all Jira fields** marks fields that are synced by default or already mapped; picking a mapped field edits its mapping, and picking Priority edits how Jira priorities translate to Backlog priorities. Each field shows its target, type and direction on one line to accept or change one at a time; suggested targets always pass validation and the target question lists the targets already taken. **Edit** and **Remove** work on configured and pending mappings. Nothing is written until **Save**: Esc in a sub-menu returns to the menu, and leaving with pending changes (Esc or Ctrl+C) asks whether to save them. Mappings go through the same validation as `map-fields add`. |
| `conflict` | Chooses the conflict strategy. |
| `filter` | Sets the import JQL (default `project = KEY ORDER BY created DESC`) and shows how many issues match. `pull --import` pages through all matching issues (up to 1,000 per run). |

The wizard ends by running `backlog-jira doctor` and printing the next steps: preview the import with `backlog-jira pull --import --dry-run`, import with `backlog-jira pull --import`, and commit `.backlog-jira/`.

Revisit any single step later:

```bash
backlog-jira configure --step status
backlog-jira configure --step sprints
```

Re-running the wizard or a step only changes the settings that step manages; other settings (existing field mappings, `mcp` settings, keys it does not know) are kept.

For CI and scripts, `--non-interactive` writes the given values (and `jira.baseUrl` from `JIRA_URL`) without prompting:

```bash
backlog-jira configure --non-interactive --project-key PROJ --issue-type Task \
  --conflict-strategy prefer-jira --jql-filter "project = PROJ ORDER BY created DESC"
```

### 2. Configure MCP Atlassian Server

The plugin doesn't call Jira directly. Each command starts a local [mcp-atlassian](https://github.com/sooperset/mcp-atlassian) server (by default via Docker, using the `ghcr.io/sooperset/mcp-atlassian:latest` image) and passes it your Jira credentials from environment variables.

**Environment Variables** (exported in the shell that runs `backlog-jira`):

```bash
# Jira Cloud
export JIRA_URL=https://your-domain.atlassian.net
export JIRA_EMAIL=your-email@example.com        # JIRA_USERNAME also works
export JIRA_API_TOKEN=your-jira-api-token

# Jira Server/Data Center (instead of JIRA_EMAIL + JIRA_API_TOKEN)
# export JIRA_PERSONAL_TOKEN=your-personal-access-token
```

The plugin does not read `.env` files, and plain shell assignments without `export` are not passed on. To keep credentials in a git-ignored `.env` file, load it before running the plugin (`set -a; . ./.env; set +a`) or let [direnv](https://direnv.net) export it (`echo dotenv > .envrc && direnv allow`). `backlog-jira configure --step credentials` shows which variables are exported.

**MCP toolsets**: the plugin uses tools from the MCP Atlassian `jira_projects` and (for sprint sync) `jira_agile` toolsets. If you restrict `TOOLSETS` in `mcp.envVars`, include them, e.g. `"TOOLSETS": "default,jira_projects,jira_agile"` (the `sprints` step sets this for you).

**Running without Docker**: install `mcp-atlassian` yourself and point the plugin at it in `.backlog-jira/config.json`:

```json
{
  "mcp": {
    "useExternalServer": true,
    "serverCommand": "uvx",
    "serverArgs": ["mcp-atlassian"],
    "fallbackToDocker": true
  }
}
```

**Getting Jira API Token**:
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token and save it securely

### 3. Edit Configuration File (optional)

The guided setup writes these settings; you can also edit `.backlog-jira/config.json` directly:

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
      "In Progress": ["In Progress", "In Development"],
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

### Configuration Options

#### Jira Section

| Option | Description | Example |
|--------|-------------|---------|  
| `baseUrl` | Your Jira instance URL | `https://company.atlassian.net` |
| `projectKey` | Default Jira project key | `PROJ`, `DEV`, `SUPPORT` |
| `issueType` | Default issue type for new issues | `Task`, `Story`, `Bug` |
| `jqlFilter` | JQL of the issues `pull --import` imports (defaults to `project = <projectKey>`) | `project = PROJ AND labels = backend` |

#### Backlog Section

| Option | Description | Details |
|--------|-------------|---------|  
| `statusMapping` | Maps Backlog statuses to Jira; also used to decide whether a Jira status matches the Backlog status during change detection | See [Status Mapping Guide](docs/status-mapping.md) |
| `unmappedJiraStatuses` | Jira statuses deliberately left unmapped by `configure --step status` (kept as-is on pull) | `["Blocked"]` |
| `projectOverrides` | Project-specific status mappings | Override per Jira project |

#### Sync Section

| Option | Description | Values |
|--------|-------------|--------|
| `conflictStrategy` | Default conflict resolution | `prompt`, `prefer-backlog`, `prefer-jira`, `manual` |
| `enableAnnotations` | Add sync metadata to tasks | `true`, `false` |
| `watchInterval` | Watch mode check interval (seconds) | `60`, `300` |

#### Custom Field Mappings

Top-level `fieldMappings` maps extra Jira fields onto Backlog tasks. Each
mapping's `direction` decides where values flow: `pull` (default) writes Jira
values into Backlog, `push` sends Backlog values to Jira (on `push`, `sync` and
`create-issue`), and `both` syncs both ways with per-field conflict detection.

```json
{
  "fieldMappings": [
    { "backlog": "frontmatter:story_points", "jira": "customfield_10016", "type": "number",
      "direction": "both" },
    { "backlog": "milestone", "jira": "fixVersions", "type": "version" },
    { "backlog": "frontmatter:team", "jira": "customfield_10020", "type": "option",
      "direction": "push", "valueMap": { "Platform Team": "platform" } },
    { "backlog": "priority", "jira": "priority", "type": "option",
      "valueMap": { "P1": "high", "P2": "medium", "P3": "low" } }
  ]
}
```

The whole lifecycle for a mapping:

1. **Find the field**: `backlog-jira map-fields discover --search "story"` lists
   Jira field IDs with a suggested `type`.
2. **Add the mapping**: `backlog-jira map-fields add <target> <jira-field> --type <type>`
   (or edit `config.json`), choosing a `direction` and optional `valueMap`.
3. **Verify it**: `backlog-jira doctor` checks the field exists and, for `push`
   and `both` mappings, is editable for your project and issue type.
4. **Sync**: `pull` writes Jira values into Backlog, `push` and `create-issue`
   send Backlog values to Jira, and `sync` does both, reporting per-field
   conflicts for `both` mappings. Adding a mapping never causes a conflict.
5. **Inspect**: `backlog-jira view <task-id>` shows each mapped value from both
   sides.

| Property | Description |
|----------|-------------|
| `backlog` | `milestone`, `dependencies`, `references`, `priority`, `labels` (written with `backlog task edit`), or `frontmatter:<key>` (a plugin-owned key in the task file) |
| `jira` | Custom field ID (`customfield_10016`) or system field name (`fixVersions`, `components`, `duedate`) |
| `type` | `string`, `number`, `date`, `option`, `multi-option`, `user`, `version`, `array` |
| `direction` | Optional, default `pull`. `pull` mappings are never written to Jira; `push` mappings are never written to Backlog; `both` syncs both ways |
| `valueMap` | Optional. Translates Jira values to Backlog values, e.g. `{ "Highest": "high" }`, and back when pushing |

**Built-in priority mapping.** Priority is synced through a default mapping
between Backlog `priority` and Jira's system `priority` field. Its default
`valueMap` maps Highest/High/Critical/Blocker to `high`, Medium/Major to
`medium` and Low/Lowest/Minor/Trivial to `low`, and pushes `High`, `Medium` and
`Low`; unknown values fall back to medium. To use your own Jira priorities, add
a `{ "backlog": "priority", "jira": "priority", "type": "option", "valueMap": {...} }`
entry: its entries are merged over the defaults, and the first entry for each
Backlog priority is the value pushed to Jira. This mapping always syncs both
ways and its values must be `high`, `medium` or `low`. Configs without it need
no changes.


Invalid entries (unknown targets, unknown types, duplicate targets, or
`frontmatter:` keys that collide with Backlog core keys such as `status` or with
the plugin's `jira_*` keys) stop `pull`, `push` and `sync` with an error listing
every problem. Mapping `priority` to another Jira field (e.g. a custom
select) or `labels` to any field replaces the built-in Jira priority/labels,
which are then not synced. If Jira rejects a
mapped field on push (for example because it is not on the issue type's edit
screen), the rest of the push still goes through and the error names the
failing field; `backlog-jira doctor` checks each mapped field exists and is
editable. Manage mappings with
[`backlog-jira map-fields`](#backlog-jira-map-fields); see the
[Custom Field Mapping Guide](docs/custom-field-mapping.md) for details.

#### Sprint Sync

A `fieldMappings` entry of type `sprint` turns the Jira sprints of one board
into Backlog milestones:

```json
{ "backlog": "milestone", "jira": "sprint", "type": "sprint", "direction": "both",
  "boardId": 12, "createSprints": false, "archiveClosedSprints": true, "pullScope": "all" }
```

- **Pull** sets each task's milestone to its issue's open sprint (else the most
  recently completed one, else none). It creates missing milestones (due date
  from the sprint end date, description from the goal), follows renames, date
  and goal changes, and archives milestones of closed sprints. The full sprint
  history is stored in the task's link record.
- **Push** moves the issue into the milestone's sprint, or back to the backlog
  when the milestone is cleared. A milestone matching no future or active
  sprint is reported, or creates a sprint when `createSprints` is `true`.
  Closed sprints are never targeted and subtasks are skipped.
- **Sync** compares sprints by Jira sprint id: one-sided changes propagate,
  changes on both sides follow the conflict strategy, and sprint renames are
  not changes.
- `pullScope: "open"` limits `pull --import` to issues in open sprints.

The Sprint field is discovered automatically. `.backlog-jira/sprints.json`
links sprint ids to milestone ids so renames and duplicate names are safe.
Set it up with `backlog-jira map-fields boards` and
`backlog-jira map-fields add milestone sprint --type sprint --board <id>`,
then run `backlog-jira doctor`. Sprint sync needs Jira Software and the MCP
Atlassian `jira_agile` toolset. See the [Sprint Sync Guide](docs/sprint-sync.md)
for behaviour and limitations.

### 4. Verify Configuration

```bash
backlog-jira doctor
backlog-jira connect
```

The `doctor` command checks:
- ✅ Bun runtime version
- ✅ Backlog CLI availability
- ✅ Configuration file validity
- ✅ Database permissions
- ✅ Backlog.md project detection
- ✅ Git repository status

The `connect` command verifies:
- ✅ Backlog CLI connectivity
- ✅ MCP Atlassian server connectivity
- ✅ Jira API credentials

## Usage

### Quick Start

1. **Create a mapping** between Backlog task and Jira issue:
   ```bash
   backlog-jira map
   ```
   Follow the interactive prompts to map tasks to issues.

2. **Push changes** from Backlog to Jira:
   ```bash
   backlog-jira push task-123
   ```

3. **Pull changes** from Jira to Backlog:
   ```bash
   backlog-jira pull task-123
   ```

4. **Bidirectional sync** with conflict resolution:
   ```bash
   backlog-jira sync task-123
   ```

### Common Workflows

#### Workflow 1: Creating New Jira Issues from Backlog

**Option A: Using create-issue command (Recommended)**
```bash
# List unmapped Backlog tasks
backlog task list --plain

# Create Jira issue directly from Backlog task
backlog-jira create-issue task-123

# Or preview first with dry-run
backlog-jira create-issue task-123 --dry-run

# Create with custom issue type
backlog-jira create-issue task-123 --issue-type Bug
```

**Option B: Using map + push**
```bash
# Map a task to create a new Jira issue
backlog-jira map
# Select task → Choose "Create new Jira issue"

# Push the task to create the issue
backlog-jira push task-123
```

#### Workflow 2: Syncing Existing Tasks

```bash
# Map existing task to existing Jira issue
backlog-jira map
# Select task → Choose "Link to existing issue" → Enter issue key

# Sync bidirectionally
backlog-jira sync task-123
```

#### Workflow 3: Importing Existing Jira Project

```bash
# Configure JQL filter in .backlog-jira/config.json
# Or use command-line JQL:

# Preview what would be imported
backlog-jira pull --import --jql "project = MYPROJ" --dry-run

# Import all issues from project
backlog-jira pull --import --jql "project = MYPROJ"

# Import only open issues
backlog-jira pull --import --jql "project = MYPROJ AND status = 'Open'"

# Import issues from multiple projects
backlog-jira pull --import --jql "project IN (PROJ1, PROJ2) AND created >= -30d"
```

#### Workflow 4: Bulk Operations

```bash
# Sync all mapped tasks
backlog-jira sync --all

# Push all changes with dry-run first
backlog-jira push --all --dry-run
backlog-jira push --all

# Pull all updates from Jira
backlog-jira pull --all

# Import new issues and update existing ones
backlog-jira pull --import
```

#### Workflow 5: Handling Conflicts

```bash
# Sync with automatic conflict resolution
backlog-jira sync task-123 --strategy prefer-backlog

# Sync with interactive prompts
backlog-jira sync task-123 --strategy prompt

# Preview conflicts without resolving
backlog-jira sync task-123 --dry-run
```

## Commands

### `backlog-jira init`

Initialize plugin configuration and database, then offer the guided setup.

```bash
backlog-jira init
```

Creates:
- `.backlog-jira/config.json`
- `.backlog-jira/snapshots/`
- `.backlog-jira/links/` (created on first link)
- `.backlog-jira/ops-log.jsonl`
- `.backlog-jira/.gitignore`

### `backlog-jira configure`

Guided setup wizard; see [Guided Setup](#guided-setup-backlog-jira-configure).

```bash
backlog-jira configure                      # all steps
backlog-jira configure --step <step>        # credentials, connection, project, status, sprints, fields, conflict or filter
backlog-jira configure --non-interactive \
  [--project-key KEY] [--issue-type TYPE] [--conflict-strategy STRATEGY] \
  [--jql-filter JQL] [--enable-annotations]  # CI: no prompts
```

### `backlog-jira doctor`

Run health checks on your environment.

```bash
backlog-jira doctor
```

Checks:
- Runtime (Bun/Node.js)
- Backlog CLI installation
- Configuration validity
- Database connectivity
- Field mappings: each mapped Jira field exists, and `push`/`both` fields are editable for the configured project and issue type (the sprint mapping is checked separately)
- Sprint sync: the Sprint field exists and the board is reachable and has sprints; warns about linked tasks whose milestone matches no sprint (with `createSprints` off) and milestones the plugin could not update
- Project structure
- Git status

### `backlog-jira connect`

Verify connectivity to Backlog and Jira.

```bash
backlog-jira connect
```

Tests:
- Backlog CLI execution
- MCP Atlassian server connection
- Jira API authentication

Failures show the underlying error (missing credentials, Docker or server start failure, DNS, HTTP status).

### `backlog-jira map`

Create and manage task-to-issue mappings.

#### Interactive Mapping

```bash
# Interactive mapping (auto-discover or manual selection)
backlog-jira map interactive
backlog-jira map i  # Short alias

# Auto-map tasks by title similarity
backlog-jira map auto
backlog-jira map auto --dry-run        # Preview without creating mappings
backlog-jira map auto --min-score 0.8  # Set minimum similarity threshold
```

#### Direct Linking

When you know the exact Jira issue key, use `map link` for fast direct mapping:

```bash
# Link a task to a Jira issue by key
backlog-jira map link task-123 PROJ-456

# Overwrite existing mapping with --force
backlog-jira map link task-123 PROJ-789 --force
```

**When to use `map link`:**
- You already know the Jira issue key
- Faster than interactive selection
- Useful for scripting and automation
- Good for bulk mapping operations

**Example workflow:**
```bash
# Create a new task
backlog task create "Implement OAuth authentication"
# Output: Created task-125

# Link it to existing Jira issue
backlog-jira map link task-125 AUTH-42

# Start syncing
backlog-jira sync task-125
```

#### Mapping Management

```bash
# View current mappings
backlog-jira map --list

# Remove a mapping
backlog-jira map --remove task-123
```

### `backlog-jira map-fields`

Manage [custom field mappings](#custom-field-mappings).

```bash
# Find field IDs and suggested adapter types
backlog-jira map-fields discover --search "story points"
backlog-jira map-fields discover --custom-only

# Add mappings
backlog-jira map-fields add frontmatter:story_points customfield_10016 --type number
backlog-jira map-fields add milestone fixVersions --type version
backlog-jira map-fields add frontmatter:team customfield_10020 --type option --direction both
# Override the built-in priority valueMap (Jira system priority field)
backlog-jira map-fields add priority priority --type option \
  --value-map "P1=high" --value-map "P2=medium" --value-map "P3=low"
# Or take priority from a custom field instead
backlog-jira map-fields add priority customfield_10050 --type option --force \
  --value-map "Urgent=high" --value-map "Normal=medium"

# Sync Jira sprints of a board as milestones
backlog-jira map-fields boards --project PROJ
backlog-jira map-fields add milestone sprint --type sprint --board 12 --direction both

# Review and remove
backlog-jira map-fields list
backlog-jira map-fields remove milestone

# Apply to mapped tasks
backlog-jira pull --all
```

### `backlog-jira status`

View sync status and recent operations.

```bash
# Overall status
backlog-jira status

# Status for specific task
backlog-jira status task-123

# Show last N operations
backlog-jira status --history 20
```

### `backlog-jira create-issue <taskId>`

Create a new Jira issue from an unmapped Backlog task.

```bash
# Create issue for a task
backlog-jira create-issue task-123

# Preview what would be created
backlog-jira create-issue task-123 --dry-run

# Create with custom issue type
backlog-jira create-issue task-123 --issue-type Bug
backlog-jira create-issue task-123 --issue-type Story
backlog-jira create-issue task-123 --issue-type Epic
```

**What this command does:**
1. Validates that the task exists in Backlog
2. Validates that the task is not already mapped to a Jira issue
3. Reads all task metadata (title, description, status, assignee, labels, priority, AC)
4. Maps Backlog priority to Jira priority (high/medium/low → High/Medium/Low, or your [priority mapping](#custom-field-mappings))
5. Merges acceptance criteria into Jira description format
6. Creates the Jira issue via MCP `jira_create_issue` tool
7. Creates the mapping between task and Jira issue
8. Stores initial snapshots for 3-way merge conflict detection
9. Updates task frontmatter with Jira metadata (jiraKey, jiraUrl, jiraSyncState)

**Flags:**
- `--dry-run`: Preview the issue that would be created without actually creating it
- `--issue-type <type>`: Override the default issue type from config (e.g., Bug, Story, Epic)

**Success output:**
```
✅ Successfully created Jira issue TEST-123 for task task-324
```

**Error cases:**
- Task not found: `❌ Failed to create Jira issue: Task task-999 not found in Backlog`
- Already mapped: `❌ Failed to create Jira issue: Task task-123 is already mapped to Jira issue TEST-100`
- No project configured: `❌ Failed to create Jira issue: Jira project key not configured in .backlog-jira/config.json`

### `backlog-jira push [taskIds...]`

Push changes from Backlog to Jira.

```bash
# Push single task
backlog-jira push task-123

# Push multiple tasks
backlog-jira push task-123 task-124 task-125

# Push all mapped tasks
backlog-jira push --all

# Dry run (preview changes)
backlog-jira push task-123 --dry-run

# Force push (ignore conflicts)
backlog-jira push task-123 --force
```

**What gets pushed:**
- Title → Summary
- Description → Description
- Status → Status (with transitions)
- Assignee → Assignee
- Labels → Labels
- Acceptance Criteria → Embedded in description
- Mapped fields with direction `push` or `both` → their Jira fields

### `backlog-jira pull [taskIds...]`

Pull changes from Jira to Backlog.

```bash
# Pull single task
backlog-jira pull task-123

# Pull multiple tasks
backlog-jira pull task-123 task-124

# Pull all mapped tasks
backlog-jira pull --all

# Dry run (preview changes)
backlog-jira pull task-123 --dry-run

# Force pull (ignore conflicts)
backlog-jira pull task-123 --force
```

**What gets pulled:**
- Summary → Title
- Description → Description (AC extracted)
- Status → Status
- Assignee → Assignee
- Labels → Labels
- Acceptance Criteria → Parsed from description

#### Import Mode

Import unmapped Jira issues as new Backlog tasks:

```bash
# Import issues using JQL filter from config
backlog-jira pull --import

# Import with custom JQL filter
backlog-jira pull --import --jql "project = PROJ AND status = 'Open'"

# Preview import without creating tasks
backlog-jira pull --import --dry-run

# Import and force-update any conflicts
backlog-jira pull --import --force
```

**Import behavior:**
- Fetches Jira issues using JQL filter (from `--jql` flag, config.json, or JIRA_PROJECT env var)
- Creates new Backlog tasks for unmapped issues
- Automatically creates mappings
- Syncs all Jira fields (title, description, status, assignee, labels, priority)
- Extracts and converts Acceptance Criteria from Jira description
- Also pulls updates for already-mapped tasks found in the JQL results
- Without `--import` flag, only pulls already-mapped tasks (preserves existing behavior)

**JQL Configuration Priority:**
1. `--jql` command-line option (highest priority)
2. `jqlFilter` in `.backlog-jira/config.json`
3. Default: `project = JIRA_PROJECT ORDER BY created DESC`

### `backlog-jira sync [taskIds...]`

Bidirectional sync with conflict resolution.

```bash
# Sync single task
backlog-jira sync task-123

# Sync with strategy
backlog-jira sync task-123 --strategy prefer-backlog
backlog-jira sync task-123 --strategy prefer-jira
backlog-jira sync task-123 --strategy prompt
backlog-jira sync task-123 --strategy manual

# Sync all tasks
backlog-jira sync --all

# Dry run
backlog-jira sync task-123 --dry-run
```

**Conflict Strategies:**
- `prefer-backlog`: Use Backlog value when conflict detected
- `prefer-jira`: Use Jira value when conflict detected
- `prompt`: Ask user for each conflicting field (interactive). Fields changed
  on only one side are merged automatically, so each side keeps its own edits
  and every per-field choice is kept; when no field conflicts, the task is
  merged without prompting
- `manual`: Skip conflicts, log them for manual resolution

Mapped fields with direction `both` are compared per field; `pull` and `push`
mappings never conflict because their owning side always wins.

### `backlog-jira view`

View task/issue details and sync status.

```bash
# View task details (mapped fields show Backlog and Jira values)
backlog-jira view task-123 --plain

# The Jira key of the linked issue works too; the header shows TASK-123 ⇄ PROJ-456
backlog-jira view PROJ-456 --plain

# View with Jira issue details
backlog-jira view task-123 --with-jira

# View sync history
backlog-jira view task-123 --history
```

### `backlog-jira resolve <ids...>`

Pair Backlog task IDs with the Jira keys of their linked issues. Task IDs and Jira keys are
numbered independently, so text in tasks and Jira may mention either; the plugin never rewrites
it. Every command that takes a task (`view`, `push`, `pull`, `sync`, `map link`, `create-issue`)
also accepts the Jira key of its linked issue.

```bash
backlog-jira resolve TASK-12 PROJ-77 PROJ-99
# ✓ TASK-12 ⇄ PROJ-40
# ✓ TASK-31 ⇄ PROJ-77
# ○ PROJ-99 (Jira key, not linked to a Backlog task)

# Tab-separated rows for agents: input, task, jira, state
# (state is linked, unlinked-task, unlinked-jira or unknown)
backlog-jira resolve PROJ-77 --plain
```

Resolution uses the local link records only and makes no Jira calls.

### `backlog-jira watch` (Future)

Watch for changes and auto-sync.

```bash
# Start watch mode
backlog-jira watch

# Watch with specific interval
backlog-jira watch --interval 300

# Watch specific tasks
backlog-jira watch task-123 task-124
```

## Troubleshooting

### Common Issues

#### Issue: Strange characters in interactive prompts (âº, â, â¦)

**Problem:** The terminal is not configured for UTF-8 encoding, causing Unicode characters to display incorrectly.

**Solution:**

1. **Check your terminal encoding**:
   ```bash
   locale | grep UTF
   ```

2. **Set UTF-8 encoding** (add to `~/.bashrc` or `~/.zshrc`):
   ```bash
   export LANG=en_US.UTF-8
   export LC_ALL=en_US.UTF-8
   ```

3. **For Windows users**:
   - Use Windows Terminal or WSL2 with UTF-8 support
   - In CMD/PowerShell, run: `chcp 65001`
   - Or use Git Bash which supports UTF-8 by default

4. **Alternative - ASCII-only mode** (if UTF-8 is not available):
   ```bash
   # Set environment variable to disable Unicode characters
   export FORCE_ASCII=1
   backlog-jira configure
   ```

**Note:** The plugin uses Unicode characters (›, ✔, …) for better user experience in modern terminals. These require UTF-8 support.

#### Issue: "Backlog CLI not found"

**Solution:**
```bash
# Verify Backlog CLI is installed
which backlog
backlog --version

# If not found, install from:
# https://github.com/MrLesk/Backlog.md
```

#### Issue: "MCP Atlassian server connection failed"

**Solution:**
```bash
# Show the underlying error and which credentials are exported
backlog-jira configure --step credentials
backlog-jira configure --step connection

# Check MCP server is configured
echo $JIRA_URL
echo $JIRA_EMAIL

# Verify API token is set
echo $JIRA_API_TOKEN

# Test connection manually
backlog-jira connect
```

#### Issue: "No transition found for status"

**Problem:** Jira workflow doesn't allow the status transition.

**Solution:**
1. Check available transitions in Jira UI
2. Update status mapping in `.backlog-jira/config.json`
3. See [Status Mapping Guide](docs/status-mapping.md)

```bash
# Enable debug logging to see available transitions
LOG_LEVEL=debug backlog-jira push task-123
```

#### Issue: "Acceptance criteria not syncing"

**Solution:**
1. Verify AC format in Backlog: `- [ ] #1 Criterion text`
2. Check Jira description format: `Acceptance Criteria:` section
3. See [AC Sync Guide](docs/acceptance-criteria-sync.md)

```bash
# View task with AC
backlog task task-123 --plain

# Check sync logs
cat .backlog-jira/logs/sync.log | grep "AC"
```

#### Issue: "Conflicts during sync"

**Solution:**
1. Run with `--dry-run` to preview conflicts
2. Choose appropriate strategy:
   ```bash
   # Use Backlog as source of truth
   backlog-jira sync task-123 --strategy prefer-backlog
   
   # Use Jira as source of truth
   backlog-jira sync task-123 --strategy prefer-jira
   
   # Resolve interactively
   backlog-jira sync task-123 --strategy prompt
   ```

#### Issue: "Cannot write to .backlog-jira directory"

**Solution:**
```bash
# Fix directory permissions
chmod 755 .backlog-jira
chmod 755 .backlog-jira/snapshots

# Rebuild if corrupted
rm -rf .backlog-jira
backlog-jira init
```

### Debug Logging

Enable detailed logging for troubleshooting:

```bash
# Set log level
export LOG_LEVEL=debug

# Run command
backlog-jira sync task-123

# View logs
tail -f .backlog-jira/logs/backlog-jira.log
```

### Getting Help

1. **Check documentation**:
   - [Status Mapping Guide](docs/status-mapping.md)
   - [Acceptance Criteria Sync](docs/acceptance-criteria-sync.md)
   - [Custom Field Mapping](docs/custom-field-mapping.md)

2. **Run diagnostics**:
   ```bash
   backlog-jira doctor
   backlog-jira connect
   backlog-jira status
   ```

3. **Enable debug logging**:
   ```bash
   LOG_LEVEL=debug backlog-jira [command]
   ```

4. **Check operation logs**:
   ```bash
   backlog-jira status --history 50
   ```

## Development

### Setup Development Environment

```bash
# Clone repository
git clone https://github.com/benslavin/Backlog.md-jira-plugin.git
cd Backlog.md-jira-plugin

# Install dependencies
npm install

# Type check
npm run check:types

# Lint
npm run check

# Build
npm run build

# Run in development mode
bun run src/cli.ts --help
```

### Project Structure

```
backlog-jira/
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── commands/                 # Command implementations
│   │   ├── init.ts
│   │   ├── doctor.ts
│   │   ├── connect.ts
│   │   ├── map.ts
│   │   ├── resolve.ts
│   │   ├── status.ts
│   │   ├── push.ts
│   │   ├── pull.ts
│   │   ├── sync.ts
│   │   ├── view.ts
│   │   └── watch.ts
│   ├── integrations/             # Backlog & Jira integrations
│   │   ├── backlog.ts
│   │   └── jira.ts
│   ├── state/                    # State management
│   │   └── store.ts
│   ├── ui/                       # User interface components
│   │   ├── conflict-resolver.ts
│   │   └── display-adapter.ts
│   └── utils/                    # Utilities
│       ├── logger.ts
│       ├── status-mapping.ts
│       ├── sync-state.ts
│       ├── frontmatter.ts
│       └── normalizer.ts
├── docs/                         # Documentation
├── backlog/                      # Backlog.md tasks
├── .backlog-jira/               # Plugin state
│   ├── config.json
│   ├── snapshots/               # Snapshot JSON files
│   ├── links/                   # Jira link records per task
│   ├── ops-log.jsonl            # Operations audit log
│   └── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

### Testing

```bash
# Run all tests
bun test

# Run specific test
bun test src/commands/sync.test.ts

# Watch mode
bun test --watch
```

### Contributing

This plugin follows Backlog.md's plugin architecture. When contributing:

1. **Follow zero-coupling principle**: Only use public APIs
2. **No core modifications**: Plugin must work standalone
3. **External state**: Store all state in `.backlog-jira/`
4. **Test thoroughly**: Add tests for new features
5. **Document changes**: Update README and relevant docs
6. **Commit the build**: `dist/cli.js` is checked in so git installs need no build step. Run `bun run build` and commit `dist/` with any source change; `bun run check:dist` fails if the committed build is stale

**📚 For detailed development guidelines, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**  
Includes critical information about working with prompts, command structure, and common pitfalls.

## Benefits

### Why Use This Plugin?

✅ **Zero Coupling**: No modifications to Backlog.md core - can be installed/removed freely  
✅ **Bidirectional**: Changes flow both ways automatically  
✅ **Intelligent**: 3-way merge detects conflicts accurately  
✅ **Flexible**: Project-specific status mappings and custom configurations  
✅ **Secure**: Uses MCP protocol for safe Jira access  
✅ **Transparent**: Dry-run mode and detailed logging  
✅ **Standalone**: Independent lifecycle from Backlog.md updates  

### Use Cases

- **Development Teams**: Keep Backlog.md tasks synced with Jira for project management
- **Multi-Tool Workflows**: Use Backlog.md for planning, Jira for tracking
- **Remote Teams**: Ensure everyone has latest updates across both systems
- **Compliance**: Maintain audit trail with operations log
- **Custom Workflows**: Support complex Jira workflows with flexible mapping

## References

- **PR #394**: [Backlog.md Plugin System](https://github.com/MrLesk/Backlog.md/pull/394)
- **Backlog.md**: [Main Repository](https://github.com/MrLesk/Backlog.md)
- **MCP Atlassian**: [sooperset/mcp-atlassian](https://github.com/sooperset/mcp-atlassian)
- **Model Context Protocol**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Status Mapping Guide**: [docs/status-mapping.md](docs/status-mapping.md)
- **AC Sync Guide**: [docs/acceptance-criteria-sync.md](docs/acceptance-criteria-sync.md)
- **Custom Field Mapping Guide**: [docs/custom-field-mapping.md](docs/custom-field-mapping.md)

## License

MIT License (inherits from Backlog.md)

Copyright (c) 2025 Backlog.md Contributors

---

**Status: Phase 5 Complete ✓** - Full sync capabilities with watch mode, performance optimization, and environment validation

For questions or issues, please check the [Troubleshooting](#troubleshooting) section or open an issue on GitHub.
