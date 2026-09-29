---
id: TASK-352
title: Milestone adapter for sprint milestones with CLI-first updates
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 01:30'
updated_date: '2026-09-29 02:06'
labels:
  - backlog
  - sprints
dependencies:
  - TASK-351
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sprint milestones must be created, renamed, archived and updated as Jira sprints change. Future sprints usually get dates only when started, so due date and goal must be updatable after creation. Backlog.md has no milestone edit command yet, so updates go through one narrow adapter that prefers the CLI and falls back to a guarded direct write until an upstream command exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Milestones are created, renamed and archived only through the backlog milestone CLI
- [x] #2 An existing milestone with the same title is adopted instead of creating a duplicate
- [x] #3 Updating due date and description uses backlog milestone edit when the installed CLI supports it
- [x] #4 Fallback update touches only milestones present in the sprint registry and only their due_date and Description section, leaving all other content byte-identical
- [x] #5 Fallback update refuses to write when the milestone file does not match the expected format and records the refusal for doctor
- [x] #6 Milestones are never removed, so tasks keep their milestone reference
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Probe Backlog.md 1.53 milestone CLI (add/rename/archive, no edit; rename supports --due-date/--clear-due-date; tasks store milestone ids; alias conflicts are case-insensitive)
2. MilestoneAdapter in src/integrations/milestones.ts: list/get/findByTitle from files, ensure (adopt or add), rename, archive via CLI
3. update(): milestone edit when available, else same-title rename for due date, else guarded fallback write limited to registry milestones, due_date line and Description section
4. Record refusals in .backlog-jira/milestone-refusals.json for doctor
5. Unit tests with a fake CLI runner plus end-to-end tests against the installed CLI
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added `MilestoneAdapter` (`src/integrations/milestones.ts`), the one place the plugin changes Backlog.md milestones.

- Listing reads active (`backlog/milestones`) and archived (`backlog/archive/milestones`) files; `findByTitle` matches like Backlog.md alias checks (trimmed, case-insensitive), active first
- `ensure` adopts a same-title milestone (optional `isAdoptable` filter so callers can skip milestones linked to another sprint) or runs `backlog milestone add`; `rename` and `archive` use the CLI. CLI calls put options as `--opt=value` and positionals after `--`, so titles and descriptions starting with "-" work
- `update({ dueDate, description })` detects capabilities from `--help`: `backlog milestone edit` when present, else a same-title `backlog milestone rename --due-date/--clear-due-date --no-update-tasks` for the due date (Backlog.md 1.53 has no edit command), else the fallback
- Fallback write: only milestones in `.backlog-jira/sprints.json`, only the `due_date` line and Description section text; everything else is byte-identical. It refuses CRLF files, missing/odd frontmatter lines, id mismatch, repeated keys, and missing or repeated Description sections
- Refusals are recorded in `.backlog-jira/milestone-refusals.json` (`readMilestoneRefusals` for doctor in TASK-356) and cleared by the next successful update
- No remove operation exists; archived milestones cannot be renamed through the CLI and are left unchanged

Tests: `src/integrations/milestones.test.ts` (unit tests with a fake CLI runner plus end-to-end tests against the installed Backlog.md CLI, skipped when it is missing). bun check, check:types and full suite (519) pass.
<!-- SECTION:NOTES:END -->
