---
id: TASK-365
title: Read multi-section task descriptions whole
status: Done
assignee:
  - '@claude'
created_date: '2026-10-19 15:08'
updated_date: '2026-10-19 15:18'
labels:
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
BacklogClient.parseTaskDetail treated any line of `backlog task --plain` output ending in a colon as a new section, so a description line such as `Steps:` ended the description and the rest was lost. create-issue and push then sent the truncated description to Jira, and a pull could write it back over the full task file. The parser also dropped blank lines, read `- [ ]` lines in any section as acceptance criteria, and let `Status:` and `Task …` lines in a description overwrite the task's status and title.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A description with lines ending in a colon, Markdown headings and blank lines is read exactly as Backlog.md stores it
- [x] #2 Only lines in the Acceptance Criteria section are read as acceptance criteria
- [x] #3 Status, title and other header fields are read only from the task header
- [x] #4 Other sections (plan, notes) are read whole the same way
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce with Backlog.md 1.53.0 --plain output
2. Start sections only at a `Name:` line followed by the dashed divider; read header fields before the first section and AC only in its section; keep blank lines
3. Add parser and CLI regression tests
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- `parseTaskDetail` starts a section only at a `Name:` line followed by Backlog.md's dashed divider, so description lines ending in a colon (`Steps:`, `## Root cause:`) no longer end the description and cut it short in Jira.
- Header fields (`Task`, `Status:`, `Assignee:`, …) are read only before the first section, and acceptance criteria only inside the Acceptance Criteria section.
- Section text keeps its blank lines, so descriptions match what Jira stores.
- Upgrade effect: tasks whose descriptions have blank lines read as changed once. Under prefer-backlog this pushes them once, restoring truncated Jira descriptions; under prompt the description is offered as a conflict.
- Tests: parser test with header-like and AC-like description lines, and an end-to-end check against the Backlog.md CLI.
<!-- SECTION:NOTES:END -->
