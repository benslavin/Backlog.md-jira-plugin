---
id: TASK-344
title: 'Custom field mapping phase 1: pull-only mapping of Jira fields into Backlog'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 19:41'
updated_date: '2026-09-28 20:11'
labels:
  - jira
  - sync
  - field-mapping
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Users need Jira fields beyond title/description/status/priority/assignee/labels (e.g. story points, team, fix versions) available on their Backlog tasks. Today the synced field set is hard-coded in normalizer, pull, push and sync. This phase introduces user-defined field mappings in `.backlog-jira/config.json` and applies them in the pull direction only, so the adapters and sync-state changes can be proven without writing anything to Jira.

Mappings target either native CLI-editable Backlog fields (milestone, dependencies, references, priority, labels) written via `backlog task edit`, or plugin-owned `frontmatter:<key>` fields written via the existing frontmatter utilities. Jira targets are field IDs (customfield_NNNNN) or system field names.

Key risk: `computeHash` hashes a fixed payload shape; adding mapped fields must not change hashes for users without mappings, or every task will appear changed on both sides.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 config.json accepts a fieldMappings array (backlog target, jira field, type, direction, optional valueMap) and invalid entries are reported with a clear error
- [x] #2 Type adapters convert Jira values for string, number, date, option, multi-option, user (via assignee mapping), version and labels-like array fields
- [x] #3 backlog-jira pull writes mapped Jira values to native Backlog fields via the Backlog CLI and to frontmatter:<key> targets via frontmatter utilities
- [x] #4 frontmatter:<key> mappings that collide with Backlog core keys or plugin jira_* keys are rejected
- [x] #5 Mapped custom field IDs are requested when fetching issues so their values are present during pull
- [x] #6 Snapshot hashes for users with no fieldMappings are unchanged, and adding mappings does not produce spurious both-sides-changed conflicts
- [x] #7 backlog-jira map-fields supports list, add, remove and discover (lists the project's Jira fields with IDs and types)
- [x] #8 README describes custom field mapping accurately (pull-only) and no longer claims unsupported custom field sync
- [x] #9 Unit tests cover config validation, each type adapter, and pull application of mapped fields
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add src/utils/field-mapping.ts: config validation, type adapters, pull update builder
2. Extend normalizer with optional mappedFields (hash unchanged when absent); mapped priority/labels replace the core Jira source
3. Make classifySyncState aware of mapping-set changes so new mappings yield NeedsPull, not Conflict
4. Request mapped fields in JiraClient.getIssue; add field discovery (jira_search_fields)
5. Apply mappings in pull (update + import): native targets via Backlog CLI, frontmatter:<key> via frontmatter utils after the CLI edit
6. Fix frontmatter parser/serializer for block lists and quoting so writes do not corrupt Backlog.md files
7. Add map-fields list/add/remove/discover command
8. README + docs/custom-field-mapping.md
9. Tests for validation, adapters, hashing/classification, frontmatter, pull application, map-fields
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Adds pull-only custom field mapping: user-defined `fieldMappings` in `.backlog-jira/config.json` bring extra Jira fields onto Backlog tasks during `backlog-jira pull` (update and `--import`).

**What changed**
- `src/utils/field-mapping.ts` (new): config validation with per-entry errors (`FieldMappingConfigError`), reserved `frontmatter:` keys (Backlog core keys and `jira_*`), type adapters (string, number, date, option, multi-option, user via assignee mapping, version, array), `valueMap`, and `buildMappedFieldUpdates` to diff Jira values against the task.
- `normalizer.ts`: optional `mappedFields` on the payload. `computeHash` only includes it when non-empty, so hashes without mappings are byte-identical to before (covered by a test against the legacy algorithm). Mapped `priority`/`labels` replace the built-in Jira source for those core fields.
- `sync-state.ts`: `classifySyncState` accepts current payloads. When the mapped field set differs from the snapshot, it compares only shared fields and treats a mismatch on a newly mapped field as a Jira-side change. Adding a mapping gives NeedsPull, not Conflict, and removing one is not counted as a change. Call sites in pull/push/sync/status now pass payloads.
- `jira.ts`: `getIssue` requests default fields plus mapped field IDs when mappings exist (unchanged otherwise); new `searchFields` via `jira_search_fields`.
- `backlog.ts`: `updateTask` supports milestone, dependencies, references and clearing them and labels.
- `pull.ts`: native targets are merged into the CLI edit; `frontmatter:<key>` values are written after the CLI edit and diffed against the file as it is then. Import applies mappings too. Invalid config stops pull with a clear error.
- `frontmatter.ts`: parses block-sequence lists (the format Backlog.md 1.5x writes), serializes lists in block style, round-trips quotes/escapes, adds `updateFrontmatterFields`, and matches task files case-insensitively (TASK-1 vs task-1). Before this, `updateJiraMetadata` blanked `labels:`/`dependencies:` block lists.
- `map-fields` command: list, add (`--type`, `--direction`, repeatable `--value-map`, `--force`), remove, discover (`--search`, `--custom-only`, suggests `--type`).
- Docs: README (feature list, config reference, command) and `docs/custom-field-mapping.md`; AGENTS.md command list. `dist/` rebuilt.

**Tests**
- New: `field-mapping.test.ts`, `pull-field-mapping.test.ts`, `map-fields.test.ts`, plus frontmatter block-list/writer tests. `bun run check`, `check:types` and `bun test` (346 pass) are green.

**Known limitations / follow-ups**
- Per-field conflict detection, push and `view` for mapped fields are TASK-345.
- Found while testing against Backlog.md 1.53: `backlog task edit` drops unknown frontmatter keys (including `jira_key`), and `--plain` output uses upper-case IDs that the plugin's parsers do not match. See the follow-up task.

- Follow-up: TASK-347 (Backlog.md 1.5x compatibility).
<!-- SECTION:NOTES:END -->
