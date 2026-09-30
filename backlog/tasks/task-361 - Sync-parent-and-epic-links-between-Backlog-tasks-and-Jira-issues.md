---
id: TASK-361
title: Sync parent and epic links between Backlog tasks and Jira issues
status: Done
assignee:
  - '@claude'
created_date: '2026-09-30 19:17'
updated_date: '2026-09-30 19:49'
labels:
  - enhancement
  - integration
dependencies:
  - TASK-334
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Builds on task-334 (subtasks from create-issue) to keep task hierarchy in step with Jira after creation. Today pull imports every issue as a top-level task, push never changes a Jira parent, and epics are not handled anywhere, so teams that organise work under epics lose that structure on one side or the other.

Parent links should follow the same model as other synced fields: compared by linked Jira key, one-sided changes propagate, and changes on both sides follow the conflict strategy.

Constraints to design around:
- Jira only allows epic > standard issue > subtask, while Backlog allows any depth. Some Backlog hierarchies cannot be represented in Jira.
- Changing a Jira parent can mean converting between subtask and standard issue types.
- Jira Server/Data Center (and older company-managed projects) link epics through the Epic Link custom field rather than `parent`.
- Backlog.md 1.53 only sets a parent at creation (`backlog task create -p`); `backlog task edit` cannot change it. For existing tasks the plugin writes `parent_task_id` in the task frontmatter directly. This is the one Backlog-owned key the plugin writes, so keep it to that key, use `backlog task create -p` whenever a task is created, and switch to the CLI if Backlog adds a way to edit parents.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pull --import creates a task under the task linked to the issue's Jira parent or epic, importing parents before their children when both match the filter
- [x] #2 Pull reports issues whose Jira parent or epic is not linked to any task, and a later pull sets the task's parent once the Jira parent is linked
- [x] #3 When a linked issue's Jira parent changes or is cleared, pull sets or clears the task's parent_task_id, leaving the rest of the task file unchanged
- [x] #4 Tasks whose parent the plugin set are shown as subtasks by Backlog (task view, task list, board) and survive later backlog task edit calls
- [x] #5 Push sets, changes or clears the Jira parent of a linked issue when the task's parent changes, without silently changing its issue type
- [x] #6 create-issue on a task whose parent is linked to a Jira epic creates a standard issue under the epic rather than a subtask, and --parent also accepts a task ID
- [x] #7 Hierarchies Jira cannot represent (e.g. a subtask of a subtask) are reported and skipped, never pushed partially
- [x] #8 sync compares parents by linked Jira key: one-sided changes propagate, and changes on both sides follow the conflict strategy (parent in the prompt)
- [x] #9 Epic links work on Jira Cloud (parent field) and Jira Server/Data Center (Epic Link field)
- [x] #10 view shows a task's parent and children as TASK ⇄ KEY pairs, and doctor reports parent links that cannot be synced
- [x] #11 README, AGENTS.md and docs/ describe parent and epic sync, its limits and how to fix unlinked parents
- [x] #12 Unit tests cover pull, push, sync, epic parents in create-issue and unrepresentable hierarchies
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Payload: add parent (linked Jira key, task:<id> for an unlinked parent task) to normalized payloads; hash it only when set; treat snapshots without it as legacy
2. Backlog side: parse Parent from the CLI, write parent_task_id with a single-line frontmatter edit, create imported tasks with -p
3. Pull: set/clear parent from the Jira parent or epic; unlinked Jira parents are reported, recorded on the link record and picked up by a later pull once linked; import orders parents before children
4. Push: set/change/clear the Jira parent via parent or Epic Link; refuse type changes and unrepresentable hierarchies as pending failures
5. Sync: per-field parent conflict (prompt field parent), one-sided propagation, prefer-* strategies via push/pull
6. view parent/children pairs, doctor parent link checks
7. Docs (docs/parent-sync.md, README, AGENTS.md + agent instructions template), CHANGELOG, dist
8. Tests
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task parents are synced with Jira parents and epics on pull, push and sync, compared by linked Jira key.

**Payload and state**
- Normalized payloads carry `parent`: the parent's linked Jira key, `task:<id>` for a parent task not linked to Jira, or "" for none (src/utils/parent-payload.ts). It is hashed only when set, so hashes of tasks without a parent are unchanged.
- Snapshots from before this change have no `parent`. `classifyWithoutParent` (sync-state.ts) compares everything else as usual and counts a parent that differs as a change on the side that has one.
- `sync.parentLinks: false` turns it off.

**Jira side** (src/integrations/jira-hierarchy.ts, jira.ts)
- Issues are fetched with `parent`, plus the Epic Link field on Server/Data Center, which is discovered by its gh-epic-link schema or set with `jira.epicLinkField`.
- The parent is attached as `JiraIssue.parent`, with its kind (epic/standard/subtask).
- `setIssueParent` writes `parent`, or the Epic Link field.

**Backlog side** (src/utils/task-parents.ts)
- `BacklogClient` parses the parent ID from `Parent:`.
- Imports use `backlog task create -p`.
- Existing tasks get their parent through a rewrite of the single `parent_task_id` line. Backlog.md 1.53 keeps it through `backlog task edit` (checked with the real CLI).

**Pull**
- A task's parent is set or cleared from the issue's Jira parent or epic.
- `pull --import` imports parents before their children, grouped by depth (`orderByParent`).
- A Jira parent not linked to any task is reported and recorded in the link record (`parentProblem`). The backlog snapshot keeps the task's own state. `parentNeedsPull` makes pull and sync set the parent once the Jira parent is linked.

**Push**
- `planParentChange` sets, changes or clears the issue's parent without changing its type.
- These are reported as parent failures (like mapped field failures) and stay pending, so they are retried: a subtask of a subtask, a standard issue under a standard issue, a subtask under an epic, a subtask losing its parent, an epic with a parent, or an unlinked parent task.

**Sync**
- `detectParentConflict` / `planParentMerge` / `applyParentMerge` add a `parent` field to conflicts; the prompt offers only Backlog or Jira for it.
- One-sided changes merge. `prefer-*` goes through push/pull.
- Push and pull share sync's parent context, so their warnings reach the sync output.

**view and doctor**
- `view` shows the task's parent and subtasks as TASK ⇄ KEY pairs, and the recorded problem.
- `doctor` lists linked tasks with unlinked parents, chains deeper than three levels and recorded problems. On Server/Data Center it also shows the Epic Link field.

**Docs**: docs/parent-sync.md; README config options and section; AGENTS.md and the agent instructions template; CHANGELOG.

**Testing**
- bun test passes (806), with tsc, biome and a dist rebuild clean.
- New tests: jira-hierarchy, parent-sync, parent-payload (hashes and legacy classification) and doctor-parents.
- An end-to-end suite (src/commands/parent-links.test.ts) runs pull/push/sync/create-issue against the real Backlog CLI with an in-memory Jira.
- Not yet checked against a live Jira site. Shapes and write paths follow MCP Atlassian's source: `parent` objects, `{value}`-wrapped Epic Link, string `parent` on create, and `null` to clear on Cloud.

**Follow-up**: TASK-362 (the "No description provided" placeholder is read as a description, found by the e2e test).
<!-- SECTION:NOTES:END -->
