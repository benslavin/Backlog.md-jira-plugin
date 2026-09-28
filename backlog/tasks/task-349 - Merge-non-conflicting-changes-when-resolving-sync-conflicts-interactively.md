---
id: TASK-349
title: Merge non-conflicting changes when resolving sync conflicts interactively
status: To Do
assignee: []
created_date: '2026-09-28 20:34'
labels:
  - sync
  - conflict
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When sync classifies a task as Conflict, the prompt strategy only acts on fields detected as conflicting, and applies built-in field choices by pulling or pushing the whole task. Changes made on only one side (e.g. title edited in Backlog, status in Jira) are not propagated when no built-in field conflicts, and choosing Jira for one built-in field and Backlog for another loses one of the choices. Mapped fields already merge per field since TASK-345; built-in fields should do the same.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Interactive resolution propagates built-in fields changed on only one side
- [ ] #2 Choosing different sources for different built-in fields keeps every choice
- [ ] #3 Snapshots after resolution leave the task InSync
- [ ] #4 Tests cover one-sided changes and mixed choices
<!-- AC:END -->
