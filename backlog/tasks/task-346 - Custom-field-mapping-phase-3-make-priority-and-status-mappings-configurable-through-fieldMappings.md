---
id: TASK-346
title: >-
  Custom field mapping phase 3: make priority and status mappings configurable
  through fieldMappings
status: To Do
assignee: []
created_date: '2026-09-28 19:41'
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
- [ ] #1 Priority is synced through a default field mapping whose valueMap users can override in config.json
- [ ] #2 With no priority override configured, priority sync behaves exactly as before
- [ ] #3 Normalizer status comparison uses the configured status mapping instead of its own hard-coded table
- [ ] #4 Existing configs without fieldMappings keep working with no manual migration
- [ ] #5 README documents fieldMappings end-to-end and the Custom Field Mapping item is removed from Future Enhancements
- [ ] #6 Tests cover default priority behaviour, overridden priority valueMap, and configured status normalization
<!-- AC:END -->
