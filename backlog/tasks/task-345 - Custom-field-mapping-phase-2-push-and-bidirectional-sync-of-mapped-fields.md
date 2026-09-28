---
id: TASK-345
title: 'Custom field mapping phase 2: push and bidirectional sync of mapped fields'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 19:41'
updated_date: '2026-09-28 20:34'
labels:
  - jira
  - sync
  - field-mapping
dependencies:
  - TASK-344
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Building on the pull-only field mappings from TASK-344, allow mapped fields to flow from Backlog to Jira and participate in bidirectional sync with field-level conflict detection. Mappings honour their direction (pull, push, both).

Jira rejects the entire update with a 400 when a field is not on the issue type's edit screen, so misconfiguration must be caught early and reported per field rather than failing the whole push.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 backlog-jira push sends changed mapped values for push/both mappings using the type adapters' Backlog-to-Jira conversion
- [x] #2 create-issue includes mapped field values when creating a Jira issue from a Backlog task
- [x] #3 backlog-jira sync detects conflicts per mapped field and resolves them with the configured conflict strategy (prompt, prefer-backlog, prefer-jira)
- [x] #4 Mappings with direction pull are never written to Jira and mappings with direction push are never written to Backlog
- [x] #5 backlog-jira doctor verifies each mapped Jira field exists and is editable for the configured project and issue type
- [x] #6 A push that fails because of a single non-editable mapped field reports which field failed
- [x] #7 backlog-jira view <task-id> shows mapped field values from both Backlog and Jira
- [x] #8 Tests cover push conversion, direction enforcement, and conflict detection for mapped fields
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. field-mapping.ts: Backlog→Jira type adapters (reverse valueMap), push mapping helpers, request all mapped fields on fetch, shared Backlog-write builder
2. New utils/mapped-field-sync.ts: build Jira field updates, apply them with per-field failure isolation, create-with-fallback, 3-way mapped-field merge/conflict detection, view formatting, doctor verification
3. normalizer/sync-state: include all mappings in payloads; direction-aware classification (owner side wins for pull-only/push-only fields)
4. push + create-issue: send mapped fields, report failing field, keep NeedsPush on partial failure
5. pull: never write push-only; built-in priority/labels not synced when mapped
6. sync: per-field mapped conflicts, prompt resolution applies chosen values to both sides
7. jira.ts: getProjectIssueTypes/getCreateFields, JSON result error detection + operations_failed
8. doctor + view commands
9. Tests, docs, README, dist rebuild
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Mapped fields now flow in the direction each mapping declares: `push`/`both` values are sent to Jira by push, sync and create-issue, `both` fields get per-field conflict detection in sync, and doctor/view understand mappings.

**What changed**
- `field-mapping.ts`: Backlog → Jira type adapters (`convertBacklogValue`, reverse `valueMap`, `FieldValueError` for unrepresentable numbers/dates), `getPushMappings`, `buildMappedJiraFields` / `buildJiraValueUpdates`, and a shared `buildBacklogValueUpdates`. Issues are fetched with mapped fields of every direction.
- New `mapped-field-sync.ts`: update/create with per-field failure isolation (Jira rejects a whole update with one bad field, so on failure the core fields are retried alone and each mapped field separately), `MappedFieldPushError` naming the failing Jira field and its Backlog target, snapshot helpers, per-field conflict detection and merge, `view` formatting and doctor verification.
- Direction enforcement: pull never writes push mappings, push never writes pull mappings. `sync-state.ts` classifies direction-aware: a side whose only edits are to fields it does not own is not counted as changed and the owner restores them (Backlog edit to a pull field → NeedsPull; Jira edit to a push field → NeedsPush). A side identical to its own snapshot payload is unchanged even if its hash differs (values that round-trip in another form, e.g. users). Snapshots after push/pull mark one-way fields the other side owns so they converge.
- Mapped `priority`/`labels` replace the built-in Jira field in both directions (previously pull only).
- push: partial failures keep the failed fields pending (NeedsPush) and report them; create path includes mapped fields. create-issue includes mapped fields and reports rejected ones as warnings.
- sync: mapped `both` fields are reported as field conflicts; prefer-* strategies rely on push/pull honouring direction; the prompt strategy merges mapped fields per field and writes chosen values to both sides after the built-in pull/push. sync now fails a task when its inner push/pull fails instead of reporting it synced.
- doctor: new Field mappings check (field exists via `jira_search_fields`; push/both fields on the issue type screen via `jira_get_project_issue_types` + `jira_get_create_fields`). view: Mapped Fields section with Backlog and Jira values and a `[differs]` flag.
- jira.ts: JSON tool results are judged by error keys (`error`, `errorMessages`, `errors`) rather than words like "failed" in values; `updateIssue` throws on `operations_failed` (newer MCP Atlassian reports field errors there instead of failing the call).
- pull.ts: removed `process.exit(0)` from `pull()`: it aborted sync mid-resolution and hid the CLI result summary (the CLI already exits after printing).
- Docs: custom-field-mapping guide (directions, adapters table, doctor, push failures, conflicts), README, AGENTS.md; `map-fields` shows direction arrows. `dist/` rebuilt.

**Tests**
- New `field-mapping-push.test.ts` (conversion, direction, failure isolation, create fallback), `mapped-field-conflicts.test.ts` (direction-aware classification, conflicts, merge, snapshots, view, verification), `doctor.test.ts`; create-issue and jira tests extended. `bun run check`, `check:types` and `bun test` (405 pass) are green.

**Limitations / follow-ups**
- Editability is checked against the create screen (the metadata MCP Atlassian exposes), not the edit screen.
- `view` could not be smoke-tested end-to-end against Backlog.md 1.53 because of the upper-case task ID parsing issue (TASK-347).
- TASK-348: doctor Configuration check requires keys init never writes.
- TASK-349: interactive conflict resolution does not merge one-sided built-in field changes.
<!-- SECTION:NOTES:END -->
