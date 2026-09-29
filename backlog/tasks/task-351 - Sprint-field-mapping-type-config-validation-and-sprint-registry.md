---
id: TASK-351
title: 'Sprint field mapping type, config validation and sprint registry'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 01:48'
labels:
  - config
  - sprints
dependencies:
  - TASK-350
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sprints are represented as Backlog.md milestones (one per board, one board per config). They are configured as a fieldMappings entry of type "sprint" so they reuse direction handling and per-field conflicts. A registry keyed by Jira sprint id keeps sprint to milestone links stable across renames and duplicate names.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 fieldMappings accepts type "sprint" with backlog target milestone, jira target sprint, direction, boardId, createSprints (default false), archiveClosedSprints (default true) and pullScope ("all" | "open", default "all")
- [x] #2 Config validation rejects a sprint mapping targeting anything other than milestone and names the collision when milestone is also mapped elsewhere (e.g. fixVersions)
- [x] #3 Config validation rejects a sprint mapping without boardId
- [x] #4 Registry in .backlog-jira/sprints.json stores Jira sprint id, milestone id and last known sprint data (name, state, dates, goal)
- [x] #5 Registry is human-readable JSON and survives reads and writes without reordering unrelated entries
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend validateFieldMappings with a "type": "sprint" branch returning a separate SprintMapping (boardId, createSprints, archiveClosedSprints, pullScope defaults) so the generic pull/push/create engines keep ignoring it until the sprint engine lands
2. Name milestone collisions in either order, require boardId, allow one sprint mapping, reject sprint-only keys on other types
3. Add loadSprintMapping
4. Add SprintRegistry in src/state/sprint-registry.ts backed by .backlog-jira/sprints.json (ordered array, unknown keys preserved, no-op saves skipped) and re-include it in .backlog-jira/.gitignore
5. Tests for validation, loading and registry round-trips
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Sprint mapping config and the sprint registry that later sprint sync tasks build on.

**Config (`src/utils/field-mapping.ts`)**
- `fieldMappings` accepts one `{ "backlog": "milestone", "jira": "sprint", "type": "sprint", "boardId": 12 }` entry with optional `direction` (default pull), `createSprints` (default false), `archiveClosedSprints` (default true) and `pullScope` ("all" | "open", default "all"); `boardId` accepts a positive integer or numeric string and is stored as a string
- `validateFieldMappings` returns it as `sprintMapping`, separate from the generic `mappings`, so pull/push/create-issue/view keep ignoring it until the sprint engine (TASK-353+) handles it; `loadSprintMapping(cwd)` loads it
- Errors: targets other than milestone, a jira target other than "sprint", missing/invalid `boardId`, invalid options, `valueMap`, a second sprint mapping, and sprint-only keys on other types. A milestone collision names the other entry and its Jira field in either order (e.g. `fieldMappings[1]: sprint mapping targets "milestone", which fieldMappings[0] already maps to fixVersions`)

**Registry (`src/state/sprint-registry.ts`)**
- `.backlog-jira/sprints.json`: `{ "version": 1, "sprints": [ { sprintId, milestoneId, boardId, name, state, startDate, endDate, completeDate, goal } ] }`
- Entries are an ordered array because JavaScript reorders numeric object keys; updates happen in place and keep position, key order and unknown keys; new sprints are appended; saves are skipped when nothing changed, so hand formatting survives
- `upsert` follows Jira for name/state/dates/goal but keeps a learned board id and a closed sprint's complete date when the source omits it (the MCP board listing drops completeDate)
- Damaged files throw `SprintRegistryError` and are never overwritten
- The registry is shared project metadata, so `!sprints.json` is added to the generated `.backlog-jira/.gitignore` and appended to existing ones on save

Tests: `src/utils/sprint-mapping.test.ts`, `src/state/sprint-registry.test.ts`. bun check, check:types and the full suite (502) pass; dist rebuilt. map-fields support and docs are left to TASK-356.
<!-- SECTION:NOTES:END -->
