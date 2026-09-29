---
id: TASK-353
title: Pull Jira sprints into Backlog milestones
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 02:11'
labels:
  - pull
  - sprints
dependencies:
  - TASK-352
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pull sets each task milestone from its Jira issue sprint and keeps sprint milestones in step with Jira. The task shows the open sprint, or the most recently closed sprint when none is open; the full sprint history lives in the link record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Task milestone is the issue's open (active or future) sprint, else the most recently completed sprint, else cleared
- [x] #2 Missing sprint milestones are created with due date from the sprint end date and description from the sprint goal
- [x] #3 Sprint renames in Jira rename the matching milestone
- [x] #4 Sprint date and goal changes in Jira update the matching milestone
- [x] #5 Closed sprints archive their milestone when archiveClosedSprints is true, and tasks keep pointing at it
- [x] #6 Full sprint history (id, name, state, dates) is stored in the task link record
- [x] #7 pullScope "open" restricts pulled issues to sprint in openSprints(), combined with jqlFilter
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Link record: add sprint history and last synced displayed sprint/milestone (sprintSync)
2. JiraClient.includeIssueFields so fetched issues carry the discovered Sprint field
3. src/utils/sprint-pull.ts: context, displayed-sprint selection, milestone resolution (registry → adopt → create, unique title on name clash), rename/update/archive reconciliation, board refresh of registered sprints, per-task milestone update, openSprints() JQL scope; milestone CLI calls serialized because pull runs tasks in parallel
4. Wire into pull (mapped, InSync sprint-only changes, import, dry run) and print warnings in the CLI
5. Unit tests plus end-to-end tests against the installed Backlog CLI
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
`backlog-jira pull` now sets each task's milestone from its Jira issue's sprint when a sprint mapping with direction pull or both is configured.

**Behaviour** (`src/utils/sprint-pull.ts`, wired into `src/commands/pull.ts`)
- Displayed sprint: the active sprint, else the earliest future sprint, else the most recently completed sprint (by complete date, then end date); no sprint clears the milestone
- A sprint's milestone is found via `.backlog-jira/sprints.json`. Otherwise a same-title milestone that is not linked to another sprint is adopted, or a new one is created with due date = date part of the sprint end date and description = sprint goal. If an active milestone of another sprint already has the title, the new one is titled `<name> (sprint <id>)`
- Every resolved sprint is reconciled once per run: rename to the sprint name, due date/goal update through the milestone adapter, and archive when closed and `archiveClosedSprints` is true. Tasks keep pointing at archived milestones
- Bulk pulls also refresh milestones of registered sprints from the board, so renames, date/goal changes and closures arrive even when none of their issues are pulled. Pulls of given task ids (as `sync` does) skip this and reconcile only their own sprints
- The link record stores the issue's sprint history (id, name, state, start/end/complete dates) and `sprintSync` (displayed sprint id and milestone)
- Default pull also picks up tasks whose core payload is in sync but whose sprints changed; InSync tasks still get their sprint applied
- `pullScope: "open"` wraps the import JQL (config `jqlFilter` or `--jql`) as `(<filter>) AND sprint in openSprints()`, keeping ORDER BY last
- With direction `both`, a milestone changed in Backlog while the Jira sprint did not change is left alone (for push, TASK-354/355); with direction `pull`, Jira wins
- Milestone CLI calls and milestone edits are serialized, since pull processes tasks 10 at a time
- Sprint problems (refused milestone updates, rename conflicts, reopened sprints with archived milestones, board refresh failures) become warnings in `PullResult.warnings`, printed by the CLI, and do not fail the task

**Supporting changes**
- `JiraClient.includeIssueFields` so `getIssue` requests the discovered Sprint field
- `TaskLink` gains `sprints` and `sprintSync`

Tests: `src/utils/sprint-pull.test.ts` (unit tests plus end-to-end tests against the installed Backlog CLI with a fake Jira). `pull()` itself has no end-to-end test because it constructs real clients, like the existing pull tests. bun check, check:types and full suite (538) pass; dist rebuilt.
<!-- SECTION:NOTES:END -->
