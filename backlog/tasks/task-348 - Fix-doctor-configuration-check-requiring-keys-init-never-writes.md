---
id: TASK-348
title: Fix doctor configuration check requiring keys init never writes
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 20:34'
updated_date: '2026-09-28 21:31'
labels:
  - doctor
  - bug
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
backlog-jira doctor's Configuration check requires top-level jiraProjectKey and mcpServerName keys in .backlog-jira/config.json, but init writes jira.projectKey and no mcpServerName. The critical check therefore always fails and doctor exits 1 on a correctly initialised project. Found while adding the field mapping check in TASK-345.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 doctor's Configuration check passes for a config written by backlog-jira init
- [x] #2 The check reports a missing or empty jira.projectKey
- [x] #3 Tests cover a valid config and a config missing the project key
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace the legacy top-level jiraProjectKey/mcpServerName check with a check for jira.projectKey, the shape init writes
2. Export checkConfigFile with a cwd parameter so it can be tested
3. Add doctor tests using a real init-written config plus missing/empty key cases
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
doctor's Configuration check now validates the config shape `backlog-jira init` writes instead of the legacy top-level `jiraProjectKey`/`mcpServerName` keys, so it passes on a correctly configured project.

- `checkConfigFile(cwd)` is exported and requires a non-empty `jira.projectKey`; missing, empty or whitespace-only values fail with "Missing required config field: jira.projectKey (set it in .backlog-jira/config.json)"
- A fresh init (which leaves `projectKey` empty for the user to fill) fails with that message, matching init's "edit config.json" next step
- The `JIRA_PROJECT` env fallback used elsewhere is not accepted here; the check reports what the config file must contain
- Tests in `src/commands/doctor.test.ts` cover an init-written config with the key set, the empty key init leaves, a missing key, whitespace, absent config and invalid JSON
- Rebuilt `dist/cli.js`; `bun run check`, `tsc` and the full test suite (446 tests) pass
<!-- SECTION:NOTES:END -->
