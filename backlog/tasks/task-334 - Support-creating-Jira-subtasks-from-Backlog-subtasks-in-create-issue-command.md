---
id: task-334
title: Support creating Jira subtasks from Backlog subtasks in create-issue command
status: Done
assignee:
  - '@claude'
created_date: '2025-10-21 10:59'
updated_date: '2026-09-30 19:49'
labels:
  - enhancement
  - integration
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add support for creating Jira subtasks when the Backlog task has a parent task. The create-issue command should detect parent relationships and use the --parent flag when creating Jira issues, ensuring the parent-child hierarchy is preserved in Jira.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Add --parent <JIRA-KEY> flag to create-issue command
- [x] #2 Auto-detect when Backlog task has a parent and look up parent's Jira mapping
- [x] #3 Set issue type to 'Subtask' when --parent is provided or auto-detected
- [x] #4 Pass parent field in additional_fields to jira_create_issue MCP tool
- [x] #5 Update validation to ensure parent Jira issue exists before creating subtask
- [x] #6 Update CLI help documentation for --parent flag
- [x] #7 Add unit tests for subtask creation scenarios
- [x] #8 Handle case where parent task exists in Backlog but not yet mapped to Jira
- [x] #9 Update README with subtask creation examples
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a Jira hierarchy module: parse an issue's parent (parent field, or the Epic Link custom field on Server/DC), classify issues as epic/standard/subtask, detect Jira Cloud
2. JiraClient: always request parent (and the discovered Epic Link field), attach the parent to fetched issues
3. Plan issue creation for a task with a parent: resolve --parent (Jira key or task ID) or the task's own parent via its link; fetch the parent issue to validate it exists; epic parent -> standard issue under the epic, standard parent -> Subtask, subtask parent -> refuse
4. Unlinked Backlog parent -> clear error naming create-issue for the parent
5. create-issue --parent option, dry-run output, CLI help
6. Tests, README examples
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
`create-issue` creates subtasks and issues in epics from the task's parent, or from `--parent`.

- `--parent <id>` takes a Jira key, or a task ID whose linked issue is meant; that task also becomes the task's parent in Backlog. Without it, the issue linked to the task's own parent task is used.
- The parent is fetched from Jira before anything is created (`planIssueCreation` in src/utils/parent-sync.ts):
  - epic parent: a standard issue of `--issue-type`/`jira.issueType`
  - standard parent: a `Subtask`
  - subtask parent, a missing issue, or `--issue-type Epic`: refused
- The parent is sent in `additional_fields` as `parent: "KEY"`. On Jira Server/Data Center, epic parents go through the Epic Link field instead: `customfield_X: "KEY"`.
- A parent task not linked to Jira fails with a hint to run `create-issue` on the parent first, or to pass `--parent`.
- Dry run and success output show the issue type and the parent. The CLI help has examples, and the README has subtask examples and error cases.
- `push` of an unlinked task uses the same planning. When the parent cannot be used, the issue is created without it and the parent is reported as pending.

Tests: src/commands/create-issue.test.ts (8 new) and src/utils/parent-sync.test.ts (planIssueCreation). src/commands/parent-links.test.ts exercises create-issue end to end with the real Backlog CLI.
<!-- SECTION:NOTES:END -->
