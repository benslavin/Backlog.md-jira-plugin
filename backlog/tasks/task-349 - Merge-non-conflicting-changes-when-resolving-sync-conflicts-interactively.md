---
id: TASK-349
title: Merge non-conflicting changes when resolving sync conflicts interactively
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 20:34'
updated_date: '2026-09-29 01:13'
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
- [x] #1 Interactive resolution propagates built-in fields changed on only one side
- [x] #2 Choosing different sources for different built-in fields keeps every choice
- [x] #3 Snapshots after resolution leave the task InSync
- [x] #4 Tests cover one-sided changes and mixed choices
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add src/commands/sync-merge.ts: detect built-in field conflicts from normalized current/base payloads (fixes raw-vs-normalized comparisons), plan a per-field merge (one-sided changes take the changed side, conflicts take the chosen side or manual value), and apply it with targeted writes: Jira-won fields to Backlog via buildBacklogUpdates, then Backlog-won fields to Jira via buildJiraUpdates on the merged task
2. Replace whole-task pull/push in applyFieldResolutions with the built-in merge; mapped-field merge still runs last
3. Prompt strategy with no conflicting fields merges without prompting
4. Snapshots recorded from the merged state with the sync field mappings
5. Tests: one-sided changes, mixed choices, manual values, description+AC interplay, InSync after resolution
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Interactive (prompt) conflict resolution now merges built-in fields per field instead of pulling or pushing the whole task.

- New `src/commands/sync-merge.ts`: detects built-in conflicts from normalized current/base payloads (the old check compared raw task values with normalized snapshots and read a non-existent `summary` key), plans a per-field merge (one-sided changes take the changed side, conflicts take the chosen or manual value) and applies it with targeted writes: Jira-won and manual values to Backlog via `buildBacklogUpdates`, then Backlog-won and manual values to Jira from the merged task via `buildJiraUpdates`
- Acceptance criteria are merged as their own field; Jira description + Backlog AC (which share Jira's description) are combined
- `applyFieldResolutions` uses the built-in merge; the mapped-field merge still runs last. Snapshots are normalized with the sync field mappings so the task classifies InSync
- Prompt strategy with no conflicting fields merges without prompting (resolution `merged`); manual entry is not offered for acceptance criteria
- `buildJiraUpdates` exported; it and `findTransitionForStatus` accept a client with just `getTransitions`
- README/AGENTS.md describe the per-field prompt behaviour

Tests: `src/commands/sync-merge.test.ts` covers conflict detection, merge planning, one-sided changes, mixed choices, manual values, description/AC interplay and InSync after resolution. bun test (458 pass), biome check and tsc pass.
<!-- SECTION:NOTES:END -->
