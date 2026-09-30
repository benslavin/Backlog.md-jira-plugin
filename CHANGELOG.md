# Changelog

This project is a fork of [eciuca/Backlog.md-jira-plugin](https://github.com/eciuca/Backlog.md-jira-plugin), published as `@benslavin/backlog-jira`. It follows [Semantic Versioning](https://semver.org/) on its own version line, starting at 0.3.0. Changes to the `.backlog-jira/` file formats (config, link records, `sprints.json`) count as breaking. The CLI command is `backlog-jira`.

## [Unreleased]

### Added

- Parent and epic links: task parents follow their issues' Jira parents and epics (Epic Link on Jira Server/Data Center) on pull, push and sync, compared by linked Jira key, with `parent` conflicts in the prompt. `pull --import` imports parents before children as Backlog subtasks, and issues whose Jira parent is linked to no task are reported and get their parent once it is linked. Hierarchies Jira cannot represent without changing issue types are reported and left pending. `view` shows a task's parent and subtasks, and `doctor` lists parent links that cannot be synced. See `docs/parent-sync.md`.
- `create-issue` creates a subtask under the issue linked to the task's parent, or a standard issue when that parent is an epic, after checking the parent in Jira. `--parent` takes a Jira key or a task ID.
- Config: `sync.parentLinks` (default `true`) and `jira.epicLinkField`. Link records gain an optional `parentProblem`.

### Changed

- Issues are fetched with their `parent` (and Epic Link field), and tasks with a parent now carry it in sync payloads. After upgrading, the first `sync` pushes existing Backlog parents to issues without a parent and pulls Jira parents to tasks without one. Set `"sync": { "parentLinks": false }` to keep the previous behaviour.

### Fixed

- Tasks without a description are read with an empty description instead of Backlog.md's "No description provided" placeholder. Issues imported with an empty description no longer look changed on every push, and the placeholder is no longer pushed to Jira. Issues that already received it are left as they are.
- Mappings of `timeoriginalestimate`, `timeestimate`, `timespent` and `comment` pull values. MCP Atlassian only returns these inside `timetracking` and `comments`, so they were silently empty. Estimates are pulled as Jira's duration strings (`"1d"`) and need `"type": "string"`. Validation now rejects other types and push directions for these fields.
- `configure` and `map-fields fields` no longer offer system fields MCP Atlassian does not return, and `doctor` reports pull mappings of them.

## [0.3.0] - 2026-09-29

First fork release. Forked from upstream `main` at `6c77390` (2025-10-28), which includes upstream work released after v0.2.0.

### Added

- Sprint sync: a `sprint` field mapping represents one board's Jira sprints as Backlog milestones. Pull creates, renames, updates and archives milestones; push moves issues between sprints or to the backlog, with opt-in sprint creation. Sync compares sprints by id, with per-field sprint conflicts. The registry is `.backlog-jira/sprints.json`, sprint history appears in `view`, per-sprint counts in `status`, and there are `doctor` checks. See `docs/sprint-sync.md`.
- Custom field mapping (`fieldMappings`, `map-fields`) with pull, push and bidirectional sync, per-field conflicts, and failure reporting.
- Configurable built-in priority mapping and config-driven status normalization.
- Guided setup: `init` hands off to a step-by-step `configure` wizard (`--step` to revisit one step). It lists Jira projects, statuses and boards, detects credentials without storing tokens, offers checkbox status selection with a proposed mapping, ranks field suggestions by project, and lets Esc step back.
- `resolve` command, plus every task-taking `backlog-jira` command accepts the linked Jira key; linked pairs print as `TASK ⇄ KEY`.
- Import pulls every issue matching the filter (paginated on Jira Cloud and Server), and the filter step shows the match count.
- Prebuilt Node-targeted `dist/` is committed so git installs work with npm, pnpm and bun.

### Changed

- Compatible with Backlog.md 1.5x: task IDs are case-insensitive, and link records in `.backlog-jira/links/` survive `backlog task edit`.
- Interactive conflict resolution merges built-in fields one by one, so one-sided changes propagate.
- Removed the unused SQLite `SyncStore` and the `better-sqlite3` dependency.
- Updated dependencies, including `@modelcontextprotocol/sdk`, to clear audit advisories.

### Fixed

- `doctor` validates `jira.projectKey` as written by `init`.
- Env vars are no longer set to the string `"undefined"`; lint, type check and tests pass.
- Log lines and MCP server output no longer cover wizard prompts.
- Docs use the correct Jira env vars (`JIRA_URL`, `JIRA_EMAIL`).

### Upstream changes after v0.2.0 included in this release

- File-based storage replacing SQLite, assignee mapping with auto-discovery, sync of implementation plan and notes, YAML-safe titles and frontmatter parsing, detection of proxy/HTML login pages and Jira API v2 deprecation errors, `--verbose`, and priority mapping fixes.

## [0.2.0] - 2025-10-15

Last upstream release, published to npm as `backlog-jira`. See the upstream repository for earlier history.

[0.3.0]: https://github.com/benslavin/Backlog.md-jira-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/eciuca/Backlog.md-jira-plugin/releases/tag/v0.2.0
