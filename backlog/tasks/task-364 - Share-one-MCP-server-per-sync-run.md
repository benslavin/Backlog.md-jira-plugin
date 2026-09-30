---
id: TASK-364
title: Share one MCP server per sync run
status: Done
assignee:
  - '@claude'
created_date: '2026-09-30 21:18'
updated_date: '2026-09-30 21:19'
labels:
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
sync pulls and pushes each task through pull() and push(), which each started their own MCP Atlassian server (a docker container per task, 10 at a time). On CI runners the container starts timed out (MCP error -32001), and their startup banners flooded the output. sync's own client was also never closed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 sync reuses its Jira client for the per-task pulls and pushes, starting one MCP server per run
- [x] #2 Concurrent calls on a client that is still connecting share that one connection
- [x] #3 sync closes its Jira client when it finishes
- [x] #4 pull and push run the MCP server silently unless --verbose
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- `pull` and `push` take an optional `jira` client, used and left open instead of creating and closing their own. `sync` passes its client to every per-task pull and push, so a run starts one MCP server instead of one per task.
- `JiraClient.ensureConnected` shares the connection in progress with concurrent callers (it used to hand them the client before it had connected), and `close` waits for it. A failed start is retried on the next call.
- `sync` closes its client when it finishes.
- Standalone `pull` and `push` start the MCP server in silent mode unless `--verbose`, as `sync` already did, so its startup banner no longer prints.
- Tests: one connection for concurrent calls, retry after a failed start.
<!-- SECTION:NOTES:END -->
