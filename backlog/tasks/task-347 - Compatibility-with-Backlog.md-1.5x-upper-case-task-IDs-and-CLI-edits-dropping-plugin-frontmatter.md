---
id: TASK-347
title: >-
  Compatibility with Backlog.md 1.5x: upper-case task IDs and CLI edits dropping
  plugin frontmatter
status: To Do
assignee: []
created_date: '2026-09-28 20:11'
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
- [ ] #1 Task IDs from Backlog.md CLI output are parsed regardless of case (TASK-1 and task-1)
- [ ] #2 Jira link metadata survives a backlog task edit made by the user or by the plugin, or is stored somewhere Backlog.md does not rewrite
- [ ] #3 Mapped frontmatter fields from field mappings survive backlog task edit or are restored without producing a spurious sync change
- [ ] #4 Tests cover upper-case IDs and metadata persistence across CLI edits
<!-- AC:END -->
