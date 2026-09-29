---
id: TASK-355
title: Bidirectional sprint sync with per-field conflict handling
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 02:58'
labels:
  - sync
  - conflict
  - sprints
dependencies:
  - TASK-354
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
sync and watch must treat the sprint like other mapped fields: one-sided changes propagate and changes on both sides go through the configured conflict strategy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Snapshots record the displayed sprint by Jira sprint id
- [x] #2 A sprint change on only one side propagates during sync
- [x] #3 A sprint change on both sides is resolved per field by the configured conflict strategy, including prompt mode
- [x] #4 Renaming a sprint in Jira is not treated as a Backlog-side change
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Carry the displayed sprint in sync payloads as mappedFields.milestone: Jira = displayed sprint id, Backlog = sprint id registered for the milestone (milestone:<id> when unregistered, "" when unset); persist the discovered Sprint field id in sprints.json so normalization stays synchronous
2. Give the milestone key the sprint mapping direction in sync-state classification
3. JiraClient always requests the persisted Sprint field
4. sync: shared pull/push sprint contexts, sprint conflict detection, per-field sprint merge in applyFieldResolutions, forced pull/push for prefer-* strategies
5. Registry saves merge concurrent writes
6. Tests for payload values, classification, conflict detection and resolution
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
`backlog-jira sync` (and `watch`) now handle the sprint like any other mapped field.

**Payload and snapshots** (`src/utils/sprint-payload.ts`, `normalizer.ts`)
- With a sprint mapping, both payloads carry `mappedFields.milestone` = Jira sprint id. The Jira side uses the issue's displayed sprint (open, else latest completed). The Backlog side uses the sprint registered for the task's milestone, `milestone:<id>` for a milestone with no sprint yet, and "" when unset. Snapshots therefore record the displayed sprint by id
- Ids survive renames, so a Jira sprint rename (and the milestone rename pull makes) is no change on either side
- Without a sprint mapping, payloads and hashes are unchanged
- Adding a sprint mapping to in-sync tasks is handled by the existing mapping-set-change logic
- The discovered Sprint field id is stored in `sprints.json` (`sprintFieldId`) so normalization needs no Jira call; contexts reuse it instead of rediscovering. `JiraClient.getIssue` always requests it when sprint sync is configured

**Classification and resolution**
- `classifySyncState` gives the `milestone` key the sprint mapping's direction, so one-sided changes become NeedsPush/NeedsPull, one-way mappings restore from their owner, and changes on both sides are a Conflict
- Conflicts: `detectSprintConflict` adds a "sprint" field to the prompt with milestone/sprint names (no manual entry). `applyFieldResolutions` merges the sprint per field: a chosen side, else the side that changed. It then pulls Jira's sprint into the milestone or pushes the milestone as the issue's sprint, and sprint push failures are reported like mapped field failures
- prefer-jira/prefer-backlog use pull/push with force, which now bypasses the `both`-direction local-change guards added in TASK-353/354

**Concurrency**
- `sync` builds one pull and one push sprint context sharing a registry and milestone adapter, and passes them to its per-task pull/push calls (new internal `sprintContext` option), so parallel tasks don't create duplicate milestones or sprints
- `SprintRegistry.save()` now merges changes another instance wrote since load, re-applying only its own touched entries
- Sync prints sprint warnings

Tests: `src/utils/sprint-sync.test.ts` (classification, merge planning, payload values incl. rename, conflict text, `applyFieldResolutions` end to end with the installed Backlog CLI and a fake Jira) and a concurrent-save test in `sprint-registry.test.ts`. bun check, check:types and full suite (573) pass; dist rebuilt.
<!-- SECTION:NOTES:END -->
