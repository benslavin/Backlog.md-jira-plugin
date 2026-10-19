---
id: TASK-366
title: Treat tasks whose Backlog and Jira content already match as in sync
status: Done
assignee:
  - '@claude'
created_date: '2026-10-19 16:53'
updated_date: '2026-10-19 17:01'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
sync, pull and push compare each side only with its own last snapshot, so a change to how payloads are computed (a parser fix, a normalizer change, a new mapped field) makes every affected task look changed and pushes or pulls identical content, creating Jira updates and watcher notifications. Compare the two current payloads directly first: when they match, the task is in sync and only its snapshots are refreshed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A task whose current Backlog and Jira payloads are equal but whose snapshots are stale is classified InSync; sync makes no Jira update and leaves the task file untouched
- [x] #2 That task's backlog and jira snapshots are rewritten to the current payloads, so the next run sees it as plainly in sync
- [x] #3 The sync, pull and push summaries count rebaselined tasks separately from tasks already in sync; --dry-run reports them and writes no snapshots
- [x] #4 The same change on both sides (e.g. the same status in Jira and in the file) is InSync with refreshed snapshots, not a Conflict
- [x] #5 Descriptions differing only in whitespace (trailing spaces, CRLF vs LF, extra blank lines) compare equal; content differences, including Markdown/Jira conversion differences, do not
- [x] #6 Classification is unchanged when the payloads differ (NeedsPush, NeedsPull, Conflict, mapping-direction rules); pull --force and push --force always write
- [x] #7 Tests cover stale snapshots with equal payloads, the same change on both sides, whitespace-only description differences and a real one-sided change
- [x] #8 CHANGELOG entry under 0.3.5 says a future parser or normalizer change no longer causes a one-time burst of pushes for tasks whose content already matches
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. normalizer: whitespace-normalized description compare, Jira-form Backlog description (description + AC + plan + notes, as push sends it) and a cross-side payload compare (assignee through the assignee mapping, as pull reads it)
2. classifySyncState: when snapshot classification is not InSync but the current payloads match, return InSync with rebaseline: true
3. sync/pull/push: rebaseline snapshots (each side with its own hash), no Jira call, no task file write; report a separate "rebaselined" count; dry run saves nothing
4. Unit tests (sync-state, normalizer) and an end-to-end test against the Backlog CLI with an in-memory Jira
5. CHANGELOG 0.3.5, docs
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
sync, pull and push now treat a task whose current Backlog and Jira content already match as InSync, refreshing stale snapshots without writing to Jira or the task file.

- classifySyncState wraps the snapshot classification: when it is not InSync or Unknown and compareSides finds no differing field, it returns InSync with rebaseline: true. Classification is otherwise unchanged.
- compareSides (normalizer.ts) compares every field comparePayloads covers, including mappedFields (sprint) and parent. Descriptions are compared with whitespace normalized, the Backlog side as push writes it to Jira (backlogDescriptionForJira: description + AC + plan + notes), since the Jira description carries those sections and would otherwise never match. A Jira assignee matches the Backlog assignee it maps to (mapJiraUserToBacklog), as pull reads it.
- recordMatchingSnapshots stores each side with its own hash, so the next run is plainly in sync.
- SyncResult, PullResult and PushResult gain rebaselined; the CLI prints a Rebaselined count. --dry-run reports without saving. --force paths are unchanged. push still pushes a rebaselined task whose sprint registry has a pending milestone move.
- buildJiraUpdates uses backlogDescriptionForJira, so the comparison and the push share one definition.
- Found along the way: with no field mappings, 0.3.4 pushed an imported task with acceptance criteria straight back on the next sync, because recordSyncedSnapshots stores both sides under the source hash. That now rebaselines once with no writes; the snapshot hashing itself is unchanged.

Tests: sync-state.test.ts (stale snapshots, same change on both sides, whitespace, Markdown differences, one-sided changes, parent/sprint), normalizer.test.ts, and content-match.test.ts end to end against the Backlog CLI with an in-memory Jira (sync, pull, push, dry run, push --force).

CHANGELOG entry is under [Unreleased], following the repo convention that the release commit stamps it 0.3.5. README, AGENTS.md and agent-instructions.ts updated; dist rebuilt.
<!-- SECTION:NOTES:END -->
