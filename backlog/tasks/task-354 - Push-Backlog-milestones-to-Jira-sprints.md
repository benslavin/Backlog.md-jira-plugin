---
id: TASK-354
title: Push Backlog milestones to Jira sprints
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 02:49'
labels:
  - push
  - sprints
dependencies:
  - TASK-353
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A milestone change on a linked task moves the Jira issue between sprints. Creating sprints in Jira is opt-in; by default only existing future or active sprints on the configured board can be targeted.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Changing a task milestone to a milestone matching a future or active sprint (by registry, then by name on the board) moves the issue into that sprint
- [x] #2 Clearing a task milestone moves an issue in an open sprint back to the backlog
- [x] #3 Targeting a closed sprint is skipped with a reported field failure unless it is already the issue's value
- [x] #4 With createSprints true, an unmatched milestone creates a future sprint (name, end date from due date, goal from description), registers it and assigns the issue
- [x] #5 With createSprints false, an unmatched milestone is reported as a field failure and the rest of the task still pushes
- [x] #6 Subtask issues are skipped because they follow their parent's sprint
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/utils/sprint-push.ts: context (Sprint field discovery, board sprints fetched once), milestone → sprint resolution (registry, then open board sprint by name, then opt-in creation), per-task move into sprint / back to backlog, closed-sprint and subtask handling
2. Serialize resolution per milestone so parallel pushes create one sprint
3. Wire into push after the core update and for newly created issues; report sprint problems as mapped field failures of the sprint mapping
4. Include InSync tasks whose milestone changed since the last sprint sync in default push
5. Tests with a fake Jira against the installed Backlog CLI
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
`backlog-jira push` now moves Jira issues between sprints from their task's milestone when a sprint mapping with direction push or both is configured.

**Behaviour** (`src/utils/sprint-push.ts`, wired into `src/commands/push.ts`)
- A milestone resolves to a sprint via `.backlog-jira/sprints.json`, else an open (active before future) sprint on the board with the same name ignoring case, which is then registered. The board is fetched once per push
- The issue is moved with the Agile API only when it is not already in that sprint
- Clearing the milestone moves an issue that is in an open sprint to the backlog; issues only in closed sprints are left alone
- A closed target sprint is a failure unless it is already the issue's displayed sprint
- `createSprints: true`: an unmatched milestone creates one future sprint (name = title, end date = due date at 23:59:59Z, goal = description, ignoring Backlog's default `Milestone: <title>`), registers it and assigns the issue. Resolution is shared per milestone, so parallel pushes create one sprint
- `createSprints: false`: an unmatched milestone fails with a message naming the board
- Subtasks are skipped (Sub-task/Subtask name, or `subtask`/`hierarchyLevel: -1` issue type flags when present)
- With direction `both`, only a milestone changed since the last sprint sync is pushed; with `push`, the milestone is enforced
- After a push, the link record's `sprintSync` records the sprint the issue now shows, so the next pull does not see the push as a Jira-side change. Failed pushes leave it untouched so they retry
- Default push also picks up in-sync tasks whose milestone changed since the last sprint sync

**Failure reporting**
- Sprint problems come back as failures of the sprint mapping (`sprint (mapped to milestone): ...`) in the existing `MappedFieldPushError`, after the rest of the task has been pushed and its snapshots recorded; the hint points at the board instead of edit screens
- Snapshots are unaffected because milestones are not in the synced payload

**Known limit:** clearing a milestone moves the issue to the backlog, but when the issue has closed sprints the next pull sets the milestone to the most recently completed one, as TASK-353 specifies.

Tests: `src/utils/sprint-push.test.ts` (fake Jira, installed Backlog CLI). bun check, check:types and full suite (556) pass; dist rebuilt.
<!-- SECTION:NOTES:END -->
