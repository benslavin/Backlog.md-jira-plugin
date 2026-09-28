---
id: TASK-348
title: Fix doctor configuration check requiring keys init never writes
status: To Do
assignee: []
created_date: '2026-09-28 20:34'
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
- [ ] #1 doctor's Configuration check passes for a config written by backlog-jira init
- [ ] #2 The check reports a missing or empty jira.projectKey
- [ ] #3 Tests cover a valid config and a config missing the project key
<!-- AC:END -->
