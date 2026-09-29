---
id: TASK-356
title: 'Doctor, view, status, map-fields and docs for sprint sync'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 03:03'
labels:
  - doctor
  - docs
  - sprints
dependencies:
  - TASK-355
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Users need to set up sprint sync, see sprint state and learn why a sprint change did not reach Jira.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 doctor errors when the Sprint field cannot be discovered, the board is unreachable or the board has no sprints (kanban)
- [x] #2 doctor warns about linked tasks whose milestone matches no sprint while createSprints is false
- [x] #3 doctor notes when createSprints is true that pushes may create Jira sprints
- [x] #4 doctor warns about sprint milestones the adapter refused to update
- [x] #5 view shows a task's sprint history and status shows task counts per sprint
- [x] #6 map-fields offers Sprint as a mapping choice and writes a valid sprint mapping
- [x] #7 AGENTS.md and README document sprint configuration, behaviour and limitations
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. doctor: checkSprintSync (errors for Sprint field, board reachability and kanban boards; warnings for unmatched milestones with createSprints off, refusals, stale field id; note for createSprints) and warning counts from checks
2. view: sprint history from the link record; status: tasks per sprint (text) and sprintId (json)
3. map-fields: --type sprint with --board/--create-sprints/--no-archive-closed-sprints/--pull-scope, list shows the sprint mapping, discover points the gh-sprint field at it, new boards subcommand (JiraClient.listBoards)
4. Docs: docs/sprint-sync.md, README, AGENTS.md, custom-field-mapping.md link
5. Tests
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Tooling and docs for sprint sync.

**doctor** (`checkSprintSync` in `src/commands/doctor.ts`, a critical check)
- Errors: the Sprint field cannot be discovered; the board is missing, not accessible or unreachable (including a missing `jira_agile` toolset); or it is a kanban board without sprints
- Warnings: linked tasks whose milestone stands for no registered sprint and matches no open board sprint by name while `createSprints` is off (listed per task); milestones in `.backlog-jira/milestone-refusals.json`; a recorded Sprint field id that differs from Jira's
- Note: `createSprints` on means pushes may create sprints
- Checks can now return warning counts, which are included in doctor's summary

**view / status**
- `view <task-id>` prints the sprint history from the link record, marking the sprint shown as the milestone (`src/utils/sprint-report.ts`)
- `status` prints "Tasks per sprint" (name, id, state; "(no sprint)" last); `--json` adds `sprintId` per task

**map-fields**
- `add milestone sprint --type sprint --board <id>` with `--direction`, `--create-sprints`, `--no-archive-closed-sprints`, `--pull-scope`; options left at defaults are not written and the entry is validated
- `list` shows the sprint mapping and its options
- `discover` suggests the sprint command for the gh-sprint field
- New `boards [--project KEY]` lists boards and whether they have sprints (`JiraClient.listBoards`)

**Docs**
- New `docs/sprint-sync.md` (configuration, mapping and registry, pull, push, sync/conflicts, doctor/view/status, limitations)
- README: Sprint Sync section, doctor checks, map-fields examples
- AGENTS.md: Sprint Sync section with agent guidance and storage entries for `sprints.json` and `milestone-refusals.json`
- `docs/custom-field-mapping.md`: link to the guide

Tests: `src/commands/doctor-sprint.test.ts`, `src/utils/sprint-report.test.ts`, sprint cases in `map-fields.test.ts`, `listBoards` in `jira-sprints.test.ts`. bun check, check:types and full suite (589) pass; dist rebuilt; the built CLI's `map-fields add/list` was smoke-tested in a scratch project.
<!-- SECTION:NOTES:END -->
