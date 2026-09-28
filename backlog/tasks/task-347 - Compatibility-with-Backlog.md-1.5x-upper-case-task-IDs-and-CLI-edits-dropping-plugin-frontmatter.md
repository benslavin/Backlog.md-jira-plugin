---
id: TASK-347
title: >-
  Compatibility with Backlog.md 1.5x: upper-case task IDs and CLI edits dropping
  plugin frontmatter
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 20:11'
updated_date: '2026-09-28 20:48'
labels:
  - jira
  - sync
  - compatibility
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while implementing TASK-344 against Backlog.md 1.53.0. Two regressions stop the plugin from working with current Backlog.md:

1. `backlog task <id> --plain` prints `Task TASK-1 - Title`, and `task list` prints upper-case IDs. BacklogClient.parseTaskDetail / parseTaskList and FrontmatterStore only match lower-case `task-N`, so getTask fails with "Failed to parse task ID".
2. `backlog task edit` rewrites the task file and drops frontmatter keys it does not know. That includes the plugin's jira_key, jira_url, jira_last_sync and jira_sync_state, and any frontmatter:<key> mapped fields, so any local edit unlinks the task from Jira.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Task IDs from Backlog.md CLI output are parsed regardless of case (TASK-1 and task-1)
- [x] #2 Jira link metadata survives a backlog task edit made by the user or by the plugin, or is stored somewhere Backlog.md does not rewrite
- [x] #3 Mapped frontmatter fields from field mappings survive backlog task edit or are restored without producing a spurious sync change
- [x] #4 Tests cover upper-case IDs and metadata persistence across CLI edits
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce against Backlog.md 1.53.0 (upper-case IDs, grouped list output, frontmatter keys dropped on edit)
2. Parse CLI IDs case-insensitively and normalize to lower-case task-N; support grouped list layout and "Created task TASK-N"
3. Store Jira link metadata and mapped frontmatter fields in .backlog-jira/links/<task-id>.json; read with fallback, mirror to frontmatter, restore after plugin edits
4. Keep links/ tracked by git via .backlog-jira/.gitignore
5. Unit tests + end-to-end test against the real CLI; docs
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Makes the plugin work with Backlog.md 1.5x (verified against 1.53.0).

- **Upper-case IDs**: BacklogClient parses `TASK-1`/`task-1` (any prefix, subtasks like `TASK-1.2`) in task detail, both list layouts (the 1.5x status-grouped layout with `[HIGH]` prefix and `(ac: x/y)` suffix, and the legacy one-line layout) and `Created task TASK-N` create output. IDs are normalized to lower case so they match file names, snapshots and stored mappings.
- **Link records**: Backlog.md 1.5x rebuilds frontmatter from a fixed key whitelist on every `backlog task edit`, so plugin keys cannot survive in the file alone. New `src/utils/task-links.ts` stores jira_key/jira_url/jira_last_sync/jira_sync_state and mapped `frontmatter:<key>` values in `.backlog-jira/links/<task-id>.json`. `updateJiraMetadata`/`updateFrontmatterFields` write both the record and the frontmatter; `getJiraMetadata`, `readTaskFrontmatter` and the FrontmatterStore scans fall back to the record for dropped keys (values present in the file win), so mapped-field hashes do not change after an edit. Existing frontmatter-only metadata migrates on the next plugin write.
- **Restore**: `BacklogClient.updateTask` re-applies missing plugin keys to the file after each `backlog task edit` (`restorePluginFrontmatter`).
- **Git**: generated `.backlog-jira/.gitignore` now re-includes `links/*.json`; existing ones get the rules appended on first link write.
- Docs: README, AGENTS.md storage section, custom-field-mapping.

Tests: `src/utils/task-links.test.ts` (fallback, restore, hand edits win, no spurious hash change, clear/unmap, migration, gitignore), new parser cases in `backlog.test.ts`, and `src/integrations/backlog-cli.test.ts` which runs create/get/list/edit against the installed `backlog` CLI (skipped when absent). 439 tests pass; biome and tsc clean.

Limitation: metadata dropped by a CLI edit before upgrading cannot be recovered; re-link with `backlog-jira map`.
<!-- SECTION:NOTES:END -->
