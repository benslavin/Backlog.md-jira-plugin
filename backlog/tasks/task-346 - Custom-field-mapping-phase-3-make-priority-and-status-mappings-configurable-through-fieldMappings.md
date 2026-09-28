---
id: TASK-346
title: >-
  Custom field mapping phase 3: make priority and status mappings configurable
  through fieldMappings
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 19:41'
updated_date: '2026-09-28 20:41'
labels:
  - jira
  - sync
  - field-mapping
dependencies:
  - TASK-345
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Priority mapping is a hard-coded table (src/utils/priority-mapping.ts) and the normalizer carries its own fixed status table, so teams with non-standard Jira priorities or workflows cannot adjust them. With the generic field mapping engine from TASK-344 and TASK-345 in place, express these built-in mappings as default fieldMappings that users can override, and retire the Future Enhancements entry in the README.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Priority is synced through a default field mapping whose valueMap users can override in config.json
- [x] #2 With no priority override configured, priority sync behaves exactly as before
- [x] #3 Normalizer status comparison uses the configured status mapping instead of its own hard-coded table
- [x] #4 Existing configs without fieldMappings keep working with no manual migration
- [x] #5 README documents fieldMappings end-to-end and the Custom Field Mapping item is removed from Future Enhancements
- [x] #6 Tests cover default priority behaviour, overridden priority valueMap, and configured status normalization
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. field-mapping.ts: add DEFAULT_PRIORITY_MAPPING (backlog "priority" <-> Jira system field "priority", option, both) with the legacy table as valueMap; treat a fieldMappings entry {backlog:"priority", jira:"priority"} as an override whose valueMap is merged over the defaults; validate it (type option, direction both, values high/medium/low); keep it out of the generic mapping engine (loadFieldMappings, getOverriddenCoreFields)
2. priority-mapping.ts: drive both directions from the effective priority mapping (loadPriorityMapping) with unchanged fallbacks (unknown -> medium/Medium)
3. pull import: map Jira priority through the mapping instead of passing it raw
4. map-fields add: default direction both for the built-in priority entry
5. normalizer: resolve Jira status through configured backlog.statusMapping (incl. projectOverrides) and canonicalise to the legacy tokens so default hashes are stable
6. Tests: default priority, overridden valueMap, config loading, configured status normalization
7. README + docs/custom-field-mapping.md; drop Future Enhancements entry; rebuild dist
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Priority and status are now driven by configuration instead of hard-coded tables.

- Priority syncs through `DEFAULT_PRIORITY_MAPPING` (Backlog `priority` <-> Jira system `priority`, `option`, `both`), whose valueMap is the old table, ordered so pushes still send High/Medium/Low. A `fieldMappings` entry `{ "backlog": "priority", "jira": "priority", "type": "option", "valueMap": {...} }` is merged over the defaults (configured entries win and are pushed first). It is validated (type option, direction both, values high/medium/low) and kept out of the generic engine (`loadFieldMappings`, `getOverriddenCoreFields`, create-issue). Priority mapped to any other Jira field still replaces the built-in priority as before.
- `mapJiraPriorityToBacklog` / `mapBacklogPriorityToJira` take the mapping (loaded from config.json by default) and keep the unknown -> medium/Medium fallbacks. Pull import now maps Jira priority instead of passing it raw to `backlog task create`.
- `map-fields add priority priority` defaults direction to `both`.
- Normalizer resolves Jira statuses via `backlog.statusMapping` + `projectOverrides` (same as pull) and keeps the legacy `todo`/`in_progress` tokens, so default-config hashes are unchanged. Jira statuses only matched by the old hard-coded table (e.g. In Review, Doing, On Hold) hash differently now, which shows up once as a Jira-side change and is resolved by the next pull/sync; no manual migration.
- `loadStatusMapping` no longer warns when config.json is missing; new `buildStatusMapping` helper.
- README documents fieldMappings end-to-end plus the built-in priority mapping; Custom Field Mapping entries removed from Future Enhancements; docs/custom-field-mapping.md and docs/status-mapping.md updated; dist rebuilt.
- Tests: src/utils/builtin-mappings.test.ts (default priority, overridden valueMap, config loading/validation, map-fields default, configured status normalization, legacy status tokens). bun run check, check:types and bun test (421) pass.
<!-- SECTION:NOTES:END -->
