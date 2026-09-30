---
id: TASK-362
title: >-
  Backlog client reads the 'No description provided' placeholder as a task
  description
status: To Do
assignee: []
created_date: '2026-09-30 19:41'
labels:
  - bug
  - backlog-cli
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
BacklogClient.parseTaskDetail assigns Backlog.md's placeholder line 'No description provided' (printed by backlog task <id> --plain for tasks without a description) to task.description. A task imported from a Jira issue with an empty description therefore differs from its issue on every classification: push and sync treat it as changed in Backlog and push the placeholder text to Jira as the description. Found while testing TASK-361 end to end.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A task without a description is read with an empty description
- [ ] #2 Importing a Jira issue with an empty description leaves the task in sync (no push on the next push or sync)
- [ ] #3 A test covers the placeholder
<!-- AC:END -->
