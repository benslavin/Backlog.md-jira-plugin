---
id: TASK-358
title: Resolve Backlog task IDs and Jira keys interchangeably
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 16:36'
updated_date: '2026-09-29 16:55'
labels:
  - enhancement
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Backlog tasks and Jira issues have unrelated IDs (TASK-001 <> CR2-77), and task text refers to either one. Matching the IDs is not feasible: the Backlog.md CLI cannot set task IDs, both systems allocate numbers independently, and subtask numbering differs. Instead, keep one owner per ID and make the plugin, and the agents using it, resolve either ID wherever one is expected.

Text in descriptions and comments is not rewritten; only tools resolve IDs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every plugin command that takes a task ID (view, push, pull, map, and others) also accepts the Jira key of a linked issue and acts on the linked task
- [x] #2 status, view, the import summary and conflict prompts show linked tasks as the pair of IDs (e.g. TASK-001 ⇄ CR2-77)
- [x] #3 A resolve command takes any mix of task IDs and Jira keys and prints each with its counterpart, with --plain output for agents; unlinked or unknown IDs are reported as such
- [x] #4 The generated agent instructions explain that <PROJECT>-<n> in task text is a Jira key, how to resolve it, and not to use Jira keys where a task ID is expected
- [x] #5 Descriptions and comments are never rewritten to translate IDs during pull or push
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add an ID resolver (task files + link records, task prefix, project key)
2. Resolve task arguments in push, pull, sync, view, map link and create-issue
3. Show TASK ⇄ KEY pairs in status, view, import summary and conflict prompts
4. Add a resolve command with --plain rows
5. Explain Jira keys in generated agent instructions, AGENTS.md and README
6. Tests for resolution, command wiring, summaries and verbatim text
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Plugin commands now accept a linked issue's Jira key wherever they expect a task ID, and a new `resolve` command pairs IDs for people and agents.

- `src/utils/id-resolver.ts`: resolves an ID from the task files and link records. An existing task wins over a Jira key spelled the same. A task ID with the Backlog prefix (`task_prefix`) but no file is unknown, and any other `<KEY>-<n>` counts as an unlinked Jira key. Only the file listing is read when every argument is a task ID, so sync's per-task push/pull calls don't scan every link.
- push, pull and sync resolve `taskIds`. An ID that names no task is reported as a failure with a hint (link or import) and never falls back to processing every mapped task. view, `map link` and create-issue accept a linked Jira key too.
- The pair `TASK-1 ⇄ CR2-77` appears in the status table (its `--grep` also matches Jira keys), the view header, the conflict prompt, sync failure lines and the pull import summary (new `PullResult.importedLinks`).
- `backlog-jira resolve <ids...> [--plain]`: works offline. `--plain` prints tab-separated `input, task, jira, state` rows (linked, unlinked-task, unlinked-jira or unknown).
- Generated CLI and MCP agent instructions, AGENTS.md and README explain that `<PROJECT>-<n>` in task text is a Jira key, how to resolve it, and not to pass it to `backlog` commands.
- Descriptions and titles are not rewritten. New tests check that push and pull pass them through as written.
- Also fixed: view shows the stored issue URL (or one built from JIRA_URL) instead of a placeholder; the status tip no longer points at a nonexistent `resolve` conflict command; the configure filter test no longer fails when the temp path contains "50".

Tests: `id-resolver.test.ts`, `task-id-args.test.ts` and additions to the create-issue and agent-instructions tests. `bun run check`, `check:types` and `bun test` (703 pass) are green.
<!-- SECTION:NOTES:END -->
