---
id: TASK-350
title: Jira Agile API client for sprints and Sprint field discovery
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 01:35'
labels:
  - jira
  - sprints
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sprint sync needs Jira Software (Agile) operations the REST v3 client does not cover. Sprint membership is set through the Agile API, sprint names are only unique per board, and the Sprint custom field id differs between sites.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Client lists sprints of a configured board, including future, active and closed sprints with id, name, state, start/end/complete dates and goal
- [x] #2 Client moves an issue into a given sprint and moves an issue back to the backlog
- [x] #3 Client creates a future sprint on a board with name, optional end date and goal
- [x] #4 Sprint field id is discovered from Jira field metadata (gh-sprint schema) without user configuration
- [x] #5 Client reports whether a board supports sprints (scrum) or not (kanban)
- [x] #6 Issue sprint field values are parsed into typed sprint objects
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect the mcp-atlassian image for jira_agile tools (boards, sprints, create sprint, add to sprint, move to backlog) and field metadata shape
2. Add typed sprint/board parsers in src/integrations/jira-sprints.ts (Agile API, MCP simplified dicts, MCP value wrappers, legacy Server strings)
3. Add JiraClient methods: getSprintFieldId, getBoard, getBoardSprints, createSprint, moveIssueToSprint, moveIssueToBacklog, getIssueSprints
4. Unit tests with mocked MCP calls; bun check, types, tests, rebuild dist
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Sprint operations for the JiraClient, going through the MCP Atlassian jira_agile tools (which call /rest/agile/1.0), plus typed parsers for sprints and boards.

- New `src/integrations/jira-sprints.ts`: `JiraSprint`/`JiraBoard` types, `parseSprint`, `parseSprintFieldValue` (raw arrays, MCP `{ value }` wrappers, single objects, legacy `...Sprint@x[id=..,state=CLOSED,..]` strings with commas in names), `findSprintFieldId` (gh-sprint schema), `parseBoard` (kanban => no sprints)
- `JiraClient`: `getBoardSprints(boardId, { state })` pages through `jira_get_sprints_from_board` (all states by default); `moveIssueToSprint` / `moveIssueToBacklog` use `jira_add_issues_to_sprint` / `jira_move_issues_to_backlog`; `createSprint(boardId, { name, endDate?, goal? })`; `getSprintFieldId()` discovers and caches the field via `jira_search_fields`; `getBoard(boardId)` reports type and `supportsSprints`; `getIssueSprints(issue)` parses an issue's Sprint field
- Missing agile tools (e.g. TOOLSETS without jira_agile) raise an error explaining how to enable the toolset

Limitations of the current mcp-atlassian server:
- `jira_create_sprint` requires a start date that is not in the past, so `createSprint` defaults it to one minute from now (the sprint stays future) and rejects end dates before that
- `jira_get_sprints_from_board` omits completeDate, so board-listed closed sprints only carry it if the server returns it; issue Sprint field values do include it
- Board and sprint listing errors are swallowed by the server and come back as empty lists, and there is no board-by-id tool, so `getBoard` pages through `jira_get_agile_boards` and returns null when not found

Tests: `src/integrations/jira-sprints.test.ts` (20 tests). bun check, check:types and full test suite pass; dist rebuilt.
<!-- SECTION:NOTES:END -->
