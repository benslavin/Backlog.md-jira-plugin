---
id: TASK-357
title: 'Guided setup: init hands off to a step-by-step configure wizard'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 14:22'
updated_date: '2026-09-29 15:29'
labels:
  - setup
  - cli
  - docs
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Setting up the plugin for a new project is confusing: init only writes defaults, configure is undocumented, credentials must be exported (not just set or placed in .env), Jira statuses are not discoverable from the plugin, and sprint sync setup needs several separate commands plus a TOOLSETS setting. Connection failures are logged as `error: {}`, hiding the cause.

One guided path should take a user from an empty Backlog.md project to a verified, ready-to-import configuration, and let them revisit any single step later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After creating .backlog-jira/, init offers to run the configure wizard; declining leaves a valid default config and prints how to run it later
- [x] #2 configure walks through credentials, connection check, project and issue type, status mapping, sprints, field mappings, conflict strategy and import filter, and every step can be skipped
- [x] #3 Each step can be run on its own (e.g. backlog-jira configure --step sprints)
- [x] #4 The credentials step detects whether JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN (or JIRA_PERSONAL_TOKEN) are exported to the process, explains export, .env and direnv options when they are not, and never stores tokens in config.json
- [x] #5 The connection check shows the underlying error message when the MCP server or Jira call fails
- [x] #6 Project, issue type and board are chosen from lists fetched from Jira
- [x] #7 The status mapping step lists the project's Jira statuses (per issue type) next to the Backlog statuses from backlog config and writes statusMapping so every Jira status is covered or explicitly left unmapped
- [x] #8 The sprints step lists boards with sprint support, writes a valid sprint mapping with the chosen direction, createSprints, archiveClosedSprints and pullScope, and sets mcp.envVars.TOOLSETS so the jira_agile tools stay enabled
- [x] #9 The field mappings step shows discovered fields with suggested types and adds mappings through the same validation as map-fields
- [x] #10 Re-running configure or any step keeps config it does not manage (e.g. existing fieldMappings, mcp settings, unknown keys)
- [x] #11 The wizard ends by running doctor and printing next steps: import preview, the 50-issue import limit, and committing .backlog-jira/
- [x] #12 --non-interactive configure keeps working for CI
- [x] #13 Errors logged under an error key show their message instead of {} (connect, doctor and other commands)
- [x] #14 README no longer claims .env files are read and documents configure, init and the guided steps; doctor no longer reports 'No field mappings configured' when a sprint mapping exists
- [x] #15 The status step also offers Jira statuses no issue is in yet: transition names, Backlog statuses and current mappings are checked against Jira via JQL, shown with their source, and pre-filled for confirmation
- [x] #16 The status step picks the project's Jira statuses from one checkbox list labelled by source and issue type, proposes the whole mapping at once and only asks per status for the ones chosen to change; unticked statuses are dropped from the mapping
- [x] #17 The field mappings step ranks fields by how many sampled project issues use them, hides core-synced, unsupported and noise fields, and adds the ticked ones from one checkbox list with suggested target, type and direction (adjusting one by one and searching all fields stay available)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Logger: serialize `error` keys with pino's error serializer so logs show messages instead of {} (connect, doctor, all commands)
2. JiraClient: checkConnection() returning the underlying error, project status discovery per issue type (issue search + transitions), to_status support in transitions
3. Shared config-file helpers that read/modify/write config.json without dropping unmanaged keys
4. Pure setup helpers (credentials detection and help text, status mapping coverage, TOOLSETS merge, sprint mapping via addFieldMapping)
5. Rewrite configure as a step-based wizard (credentials, connection, project, status, sprints, fields, conflict, filter, finish) with --step and a real --non-interactive mode
6. init offers the wizard after creating .backlog-jira/
7. doctor: no "No field mappings configured" when a sprint mapping exists
8. README/AGENTS/docs updates, tests for helpers, steps, init and connect

Follow-up (AC #15): MCP Atlassian never returns transition targets, so collect transition names as candidates, check candidates (transition names, Backlog statuses, current mapping) with a status-in JQL query that drops names Jira rejects, show statuses by source and pre-fill the extra-statuses prompt
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Guided setup: `init` offers a step-by-step `configure` wizard that takes a new project to a verified, ready-to-import configuration.

- `configure` runs 8 skippable steps (credentials, connection, project, status, sprints, fields, conflict, filter). Each step is saved as it completes, Ctrl+C keeps completed steps, and `--step <name>` runs one step on its own. The wizard ends with doctor and next steps: import preview, the 50-issue import limit and committing .backlog-jira/
- Credentials: detects the exported JIRA_* variables, explains export/.env/direnv, can take credentials for the session and optionally write a git-ignored .env. Tokens never go into config.json
- Connection: `JiraClient.checkConnection()` returns the underlying error. MCP Atlassian answers field and project listings with [] when Jira is unreachable, so an empty field list now counts as a failure and a bounded `jira_search` surfaces the real cause. `connect` prints it too
- Project, issue type and boards come from Jira lists, with manual fallback. Status mapping lists Jira statuses per issue type (found from issues and their transitions, since MCP Atlassian has no workflow API) next to `backlog config get statuses`. Unmapped statuses are recorded in `backlog.unmappedJiraStatuses`
- Sprints step writes the sprint mapping through `addFieldMapping` and merges `mcp.envVars.TOOLSETS` (default,jira_projects,jira_agile). The fields step uses discovery, suggested types and the same validation as map-fields
- Steps only replace the keys they manage (new `utils/config-file.ts`); `--non-interactive` now writes flags and JIRA_URL for CI instead of exiting 1
- Logger serializes `error` keys with pino's error serializer, so logs no longer show `{}`
- doctor: `runDoctor()` does not exit, and it no longer reports "No field mappings configured" when a sprint mapping exists. `pull --import` falls back to `jira.projectKey` without a filter. Transitions read MCP `to_status`
- Docs: README (no .env claim, init/configure/guided steps, TOOLSETS), AUTHENTICATION (.env loading fixed), status-mapping, sprint-sync, AGENTS.md and the embedded agent instructions

Tests: setup helpers, config file, logger, wizard steps/wizard/non-interactive (configure.test.ts), init hand-off, checkConnection/to_status, doctor sprint message. 652 pass; biome and tsc clean. Checked by hand against the Docker MCP server with an unreachable Jira URL: the connection step shows the DNS error.

Follow-up fixes from a real run:
- init prints its summary with console.log and the wizard silences the logger (unless --verbose): the pino-pretty transport writes from a worker thread, so log lines appeared after, and over, the next prompt. doctor output is flushed before the next steps
- getAllProjects accepts the plain array MCP Atlassian returns (it read result.projects and failed with "Cannot read properties of undefined"). An empty project list now says so
- Silent-mode clients pipe the MCP server's stderr (FastMCP banner, TOOLSETS warning) instead of printing it, and add its tail to errors when the server fails to start
- Manual project keys need at least 2 characters, as the MCP server requires

Status discovery for statuses no issue is in yet (AC #15):
- MCP Atlassian never returns transition targets: the underlying library gives `to` as a string and MCP Atlassian only reads it as an object, so `to_status` is never set. A new project whose issues are all in To Do showed only "To Do"
- Transition names, Backlog statuses and the Jira statuses of the current mapping are now candidates. `checkStatusNames` runs `project = KEY AND status in (...)`, drops the names Jira rejects ("The value 'X' does not exist for the field 'status'") and retries. If the error text is not recognised it asks about each name, and it reports unchecked when Jira cannot be searched
- The status step shows statuses on issues by issue type, then the checked statuses no issue is in yet (noting that Jira checks names across the whole site), and pre-fills them in the "other statuses" prompt for editing
- Tests: discovery candidates, rejected-name parsing, retry, per-name fallback, unchecked and escaping; the wizard's status test uses a fake Jira that rejects unknown statuses. 662 pass

- Checked statuses are split by source: transition names of the project's issues are pre-filled as "Statuses <KEY> issues can move to". Checked Backlog statuses and mapping entries (e.g. init's default Open, Backlog, Closed, Resolved) are listed as "used elsewhere on this Jira site" and not pre-filled, because Jira checks names site-wide

Status and field steps reworked after a real run (AC #16, #17):
- Status: one checkbox list of the project's Jira statuses, each labelled by source and issue type ("on Epic, Story issues", "reachable from Story", "used elsewhere on this Jira site"). Confirmed ones are ticked; site-only names are ticked only when they come from a mapping the user configured, not init's defaults. An optional prompt adds unlisted statuses
- The whole mapping is proposed as a table with one "Use this mapping? Yes / Change some statuses" choice; per-status selects only for the statuses picked to change
- Unticked statuses, and mapped names Jira rejects as statuses, are dropped from the mapping (`buildStatusMappingConfig` `dropped` parameter), so init's Open, Backlog, Closed and Resolved no longer linger
- Fields: samples the 50 most recently updated project issues with `fields=*all` and lists fields with values, most used first, with usage ("2/2 issues"), suggested target and type (`suggestFieldMappings`). Hidden: fields the plugin already syncs, sprint/rank/epic/dev-panel fields, watchers and similar noise, unsupported types, fields already mapped. Unused fields are only offered when commonly useful (story points, due date, components, versions...). Commonly useful fields in use are pre-ticked; both story point field names map to frontmatter:story_points
- The ticked fields are shown as one plan with "Yes / Adjust target, type or direction / Cancel". "Search all fields…" keeps the old per-field flow
- Multiselect summary lines show short names (onRender hook) instead of full titles with labels
- Checked by rendering both steps in a pseudo-terminal with a fake Jira; 672 tests pass
<!-- SECTION:NOTES:END -->
