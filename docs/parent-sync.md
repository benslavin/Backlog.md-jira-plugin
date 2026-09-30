# Parent and Epic Links

## Overview

A Backlog task's parent (`parent_task_id`, which Backlog.md shows as subtasks in `backlog task view`, `backlog task list` and the board) is kept in step with its Jira issue's parent or epic.

- **Pull**: the task's parent becomes the task linked to the issue's Jira parent or epic. `pull --import` imports parents before their children and creates each child under its parent's task.
- **Push**: changing a task's parent sets, changes or clears the issue's parent (or Epic Link) in Jira. The plugin never changes an issue's type.
- **Sync**: parents are compared by linked Jira key. A change on one side propagates, and changes on both sides go through the configured conflict strategy (the field is `parent` in the prompt).
- **create-issue**: a task whose parent is linked becomes a subtask of the parent's issue, or a standard issue under it when the parent is an epic.

Parent links are on by default. Turn them off with:

```json
{ "sync": { "parentLinks": false } }
```

## How Parents Are Compared

Both sides are reduced to a Jira key:

| Side | Value |
|------|-------|
| Jira | The key of the issue's `parent`, else its Epic Link (Jira Server/Data Center) |
| Backlog | The Jira key linked to the task's parent task |

A parent task that is not linked to Jira is carried as `task:<id>`, so choosing it still counts as a Backlog change. Because only linked keys are compared, renaming or re-numbering tasks is not a change.

## Jira's Hierarchy

Jira allows three levels: **epic > standard issue > subtask**. Backlog.md allows any depth. The plugin maps a task's parent onto Jira as follows:

| Parent's issue | Task's issue | Result |
|----------------|--------------|--------|
| Epic | Standard issue | Linked to the epic (`parent` on Cloud, Epic Link on Server/Data Center) |
| Standard issue | Subtask | The subtask's parent is set |
| Epic | Subtask | Reported: the subtask would have to become a standard issue |
| Standard issue | Standard issue | Reported: the issue would have to become a subtask |
| Subtask | Any | Reported: Jira cannot nest issues under a subtask |
| Any | Epic | Reported: epics cannot have a parent |
| Not linked to Jira | Any | Reported: create the parent's issue first (`backlog-jira create-issue <parent-task>`) |

Clearing the parent of a standard issue removes its epic. Clearing the parent of a subtask is reported, since a Jira subtask always has a parent.

Reported parents are skipped, never half-applied. The push that found them fails for the parent only (everything else is pushed), the reason is stored with the task's Jira link, and the parent stays pending: the next push or sync retries it, so it goes through as soon as the hierarchy is fixed (for example after changing the issue's type in Jira or linking the parent task).

## Pull

- The task's `parent_task_id` follows the issue's parent or epic, and is cleared when Jira's parent is cleared.
- Backlog.md 1.53 only sets a parent at creation (`backlog task create -p`). For existing tasks the plugin rewrites the single `parent_task_id` line of the task file and leaves the rest of the file as it is. Backlog.md keeps the key on later `backlog task edit` calls.
- `pull --import` creates each task with `backlog task create -p`, parents first, so children become Backlog subtasks.
- An issue whose Jira parent or epic is not linked to any task is imported (or pulled) without that parent and reported:

  ```
  Warnings:
    TASK-7 ⇄ PROJ-40: imported without its parent: Jira parent PROJ-12 is not linked to a Backlog task; import it (backlog-jira pull --import) or link it (backlog-jira map link <task> PROJ-12), then pull again
  ```

  Once `PROJ-12` is linked, the next `pull` (or `sync`) sets the parent, even though nothing else changed.
- A Jira parent that is a subtask of the task in Backlog is reported instead of creating a cycle.

## Push

- A change of the task's parent sets, changes or clears the issue's parent. Epics are linked through the `parent` field on Jira Cloud and through the Epic Link field on Jira Server/Data Center.
- Parents Jira cannot represent are reported as described above. They appear in the push output like failed mapped fields:

  ```
  Failures:
    task-9: Mapped field could not be updated on PROJ-51:
    - parent: PROJ-51 is a standard issue; change its type to a subtask type in Jira before putting it under PROJ-40
  The parent stays pending and is retried by the next push (backlog-jira doctor lists parent links that cannot be synced).
  ```

- `push <task>` of a task that is not linked yet creates its issue as `create-issue` would. If the parent cannot be used, the issue is created without it and the parent is reported and left pending.

## Sync and Conflicts

`sync` compares the parent like any other field:

- Changed in Backlog only: pushed. Changed in Jira only: pulled.
- Changed on both sides to different parents: a conflict. `prompt` asks which parent to keep (Backlog or Jira), and `prefer-backlog` / `prefer-jira` pick a side. Other fields changed on only one side are merged as usual.

Snapshots stored before parent links existed carry no parent. For those tasks, a parent that differs between the sides counts as a change on the side that has one, so the first sync after upgrading pushes Backlog parents to issues without one and pulls Jira parents to tasks without one.

## create-issue

```bash
backlog-jira create-issue TASK-12                  # under the issue linked to TASK-12's parent, if any
backlog-jira create-issue TASK-12 --parent PROJ-40 # subtask of PROJ-40, or a standard issue if PROJ-40 is an epic
backlog-jira create-issue TASK-12 --parent TASK-3  # under the issue linked to TASK-3
backlog-jira create-issue TASK-12 --parent PROJ-40 --dry-run
```

- The parent is looked up in Jira before anything is created, so a parent that does not exist, a subtask parent, or an `--issue-type Epic` with a parent fails without creating an issue.
- Under a standard issue the issue type is `Subtask` (MCP Atlassian resolves it to the project's subtask type) unless `--issue-type` names another subtask type. Under an epic it is `--issue-type` or `jira.issueType`.
- A task whose parent task is not linked to Jira fails with a hint to create the parent's issue first, or to pass `--parent`.
- When `--parent` names a task (or a Jira key linked to one), that task also becomes the task's parent in Backlog.

## Epic Links on Jira Server/Data Center

Jira Cloud links epics through the `parent` field. Jira Server/Data Center (and older company-managed setups) use the Epic Link custom field, which the plugin discovers by its `gh-epic-link` schema. Set it explicitly when discovery fails or picks the wrong field:

```json
{ "jira": { "epicLinkField": "customfield_10100" } }
```

Use `"epicLinkField": "parent"` to link epics through the `parent` field. Jira Cloud is recognised from `JIRA_URL` (`*.atlassian.net`), as MCP Atlassian does.

## View and Doctor

`backlog-jira view <task-id>` lists the task's parent and subtasks as `TASK ⇄ KEY` pairs, and the reason when its parent could not be synced:

```
Parent Links:
--------------------------------------------------
Parent: TASK-3 ⇄ PROJ-40
Subtasks (2):
  - TASK-3.1 ⇄ PROJ-51
  - TASK-3.2
```

`backlog-jira doctor` reports parent links of linked tasks that cannot be synced: parents not linked to Jira, hierarchies deeper than Jira's three levels, and problems recorded by the last pull or push. On Jira Server/Data Center it also shows the Epic Link field in use.

## Fixing Unlinked Parents

| Situation | Fix |
|-----------|-----|
| A task's parent task has no Jira issue | `backlog-jira create-issue <parent-task>`, then `backlog-jira push <task>` |
| An issue's Jira parent has no task | `backlog-jira pull --import` with a filter that includes the parent, or `backlog-jira map link <task> <PARENT-KEY>`; the next pull sets the parent |
| A task needs to become a subtask of a standard issue | Change the issue's type to a subtask type in Jira, then push |
| A task sits more than three levels deep | Flatten the hierarchy in Backlog, or leave the extra level out of Jira (the parent stays reported) |

## Limitations

- Backlog.md cannot change an existing task's parent from the CLI, so the plugin edits `parent_task_id` in the task file. It is the only Backlog-owned key the plugin writes.
- Issue types are never changed: moving between standard issue and subtask is done in Jira.
- Clearing a `parent` through MCP Atlassian works on Jira Cloud only; on Server/Data Center only Epic Links can be cleared.
- Hierarchy levels above epics (Jira Cloud Premium) are not synced.
- Issue kinds are told from issue type names (`Epic`, `Sub-task`/`Subtask`) and Jira's subtask flag where MCP Atlassian returns it; a custom subtask type is recognised when its issue has a non-epic parent.
