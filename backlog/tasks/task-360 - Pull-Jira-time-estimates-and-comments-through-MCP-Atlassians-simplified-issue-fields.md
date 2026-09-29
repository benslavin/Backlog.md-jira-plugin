---
id: TASK-360
title: >-
  Pull Jira time estimates and comments through MCP Atlassian's simplified issue
  fields
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-29 18:03'
updated_date: '2026-09-29 18:08'
labels:
  - jira
  - field-mapping
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
MCP Atlassian rebuilds issues from a fixed schema: it passes customfield_* values through but drops unmodelled system fields. Mapping timeoriginalestimate or timeestimate therefore writes nothing, because MCP Atlassian only returns them inside timetracking as display strings ("1d"). Mapping comment writes nothing either, because MCP Atlassian returns comments under the key comments. The wizard offers these fields anyway, so the mappings fail without any warning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A pull mapping of timeoriginalestimate writes Jira's original estimate display string (e.g. "1d") to the Backlog target
- [x] #2 A pull mapping of timeestimate writes Jira's remaining estimate display string to the Backlog target
- [x] #3 A pull mapping of comment writes the issue's comments to the Backlog target
- [x] #4 Config validation and doctor flag estimate mappings whose type is not string, and push/both directions for these read-only fields, with a message saying how to fix them
- [x] #5 The configure wizard and map-fields no longer offer system fields that MCP Atlassian cannot return
- [x] #6 Tests cover the aliases, the validation messages and the field picker
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add an alias table in field-mapping.ts: timeoriginalestimate/timeestimate/timespent read from MCP's timetracking, comment read from comments
2. Request the aliased field when fetching issues
3. Validate aliased mappings: type must fit, direction must be pull
4. Flag pulled system fields MCP Atlassian drops in doctor; filter them from the wizard, suggestions and map-fields fields
5. Tests, docs, changelog, dist
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
MCP Atlassian rebuilds issues from a fixed model. It passes customfield_* values through but drops system fields it does not model, so mappings of `timeoriginalestimate` and `comment` pulled nothing.

- `MCP_FIELD_ALIASES` (src/utils/field-mapping.ts) reads `timeoriginalestimate`, `timeestimate` and `timespent` from `timetracking` as Jira's duration strings ("1d"). It reads `comment` from `comments` as one "Author (YYYY-MM-DD): text" line per comment; `string` mappings join the lines with " | ". A raw value is still used if a server returns one.
- `getMappedJiraFieldIds` requests the field each alias lives in.
- `validateFieldMappings` rejects aliased mappings whose type does not fit or whose direction is not pull, and says which type to use.
- `isMcpReturnedField` filters system fields MCP Atlassian drops from the configure field list, the field suggestions and `map-fields fields`. `verifyFieldMappings` (doctor) reports pull/both mappings of those fields.
- `suggestTypeForSchema` suggests `string` for estimates and `array` for comments.
- Docs: docs/custom-field-mapping.md section "System Fields Returned by MCP Atlassian"; CHANGELOG Unreleased entry.

Testing: bun test (730 pass), tsc, biome and the dist rebuild are all clean. Not yet checked against a live Jira site.

Migration: an existing `timeoriginalestimate` mapping with `"type": "number"` now fails validation with a message to use `"type": "string"`.
<!-- SECTION:NOTES:END -->
