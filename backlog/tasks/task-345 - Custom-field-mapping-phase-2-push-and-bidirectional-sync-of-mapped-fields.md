---
id: TASK-345
title: 'Custom field mapping phase 2: push and bidirectional sync of mapped fields'
status: To Do
assignee: []
created_date: '2026-09-28 19:41'
labels:
  - jira
  - sync
  - field-mapping
dependencies:
  - TASK-344
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Building on the pull-only field mappings from TASK-344, allow mapped fields to flow from Backlog to Jira and participate in bidirectional sync with field-level conflict detection. Mappings honour their direction (pull, push, both).

Jira rejects the entire update with a 400 when a field is not on the issue type's edit screen, so misconfiguration must be caught early and reported per field rather than failing the whole push.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 backlog-jira push sends changed mapped values for push/both mappings using the type adapters' Backlog-to-Jira conversion
- [ ] #2 create-issue includes mapped field values when creating a Jira issue from a Backlog task
- [ ] #3 backlog-jira sync detects conflicts per mapped field and resolves them with the configured conflict strategy (prompt, prefer-backlog, prefer-jira)
- [ ] #4 Mappings with direction pull are never written to Jira and mappings with direction push are never written to Backlog
- [ ] #5 backlog-jira doctor verifies each mapped Jira field exists and is editable for the configured project and issue type
- [ ] #6 A push that fails because of a single non-editable mapped field reports which field failed
- [ ] #7 backlog-jira view <task-id> shows mapped field values from both Backlog and Jira
- [ ] #8 Tests cover push conversion, direction enforcement, and conflict detection for mapped fields
<!-- AC:END -->
