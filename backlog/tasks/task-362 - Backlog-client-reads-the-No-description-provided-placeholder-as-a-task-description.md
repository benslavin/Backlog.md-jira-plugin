---
id: TASK-362
title: >-
  Backlog client reads the 'No description provided' placeholder as a task
  description
status: Done
assignee:
  - '@claude'
created_date: '2026-09-30 19:41'
updated_date: '2026-09-30 20:02'
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
- [x] #1 A task without a description is read with an empty description
- [x] #2 Importing a Jira issue with an empty description leaves the task in sync (no push on the next push or sync)
- [x] #3 A test covers the placeholder
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Check which placeholders backlog task <id> --plain prints for empty sections
2. Ignore them in BacklogClient.parseTaskDetail
3. Parser unit test; e2e case importing an issue with an empty description
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Tasks without a description are read with an empty description.

- `BacklogClient.parseTaskDetail` ignores Backlog.md's "No description provided" placeholder in the Description section. It is the only placeholder read into a field: empty plan and notes sections are not printed, and the acceptance criteria and Definition of Done placeholders are never assigned.
- Tests:
  - parser unit test (backlog.test.ts)
  - real-CLI check (backlog-cli.test.ts)
  - end-to-end import of an issue with an empty description, which stays in sync on push and sync (parent-links.test.ts)
- The fake Jira in parent-links.test.ts now gives issues created without a description an empty one; the placeholder had hidden that.
- Out of scope as agreed: issues that already received the placeholder text are not cleaned up.

bun test (809), tsc, biome and a dist rebuild are clean.
<!-- SECTION:NOTES:END -->
