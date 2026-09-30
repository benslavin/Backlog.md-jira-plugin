---
id: TASK-363
title: Send JSON-typed MCP Atlassian arguments as JSON strings
status: Done
assignee:
  - '@claude'
created_date: '2026-09-30 21:18'
updated_date: '2026-09-30 21:19'
labels:
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
MCP Atlassian's jira_create_issue (additional_fields), jira_update_issue (fields) and jira_transition_issue (fields) take JSON strings. The plugin sent objects, so every create-issue with a priority, labels, parent or mapped field, and every push that changed a field, failed with a pydantic 'Input should be a valid string' error.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 create-issue sends priority, labels, parent and mapped fields to jira_create_issue as one JSON string
- [x] #2 Pushes send jira_update_issue fields as a JSON string
- [x] #3 Transitions send jira_transition_issue fields as a JSON string
- [x] #4 The current mcp-atlassian image accepts the arguments (no validation error)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- `createIssue` merges priority, labels and extra fields (parent, mapped fields) into one object and sends it as a JSON string in `additional_fields`, omitted when empty.
- `updateIssue` and `transitionIssue` send `fields` as JSON strings.
- Checked against `ghcr.io/sooperset/mcp-atlassian:latest`: both tools declare these parameters as `str`. The old object form fails validation there; the new form passes it.
- Tests: JSON string payloads for create (with parent), update and transition, and no `additional_fields` when there are none.
<!-- SECTION:NOTES:END -->
