# Sprint Sync

## Overview

Sprint sync represents the Jira sprints of one board as Backlog.md milestones. Each linked task's milestone shows its issue's sprint, and changing the milestone in Backlog moves the issue between sprints in Jira.

- **Pull**: the task milestone becomes the issue's open (active or future) sprint, else its most recently completed sprint, else it is cleared. Missing milestones are created, and renames, date changes, goal changes and closures in Jira are applied to them.
- **Push**: a task's milestone moves the issue into the matching sprint of the board, or back to the backlog when the milestone is cleared. Creating sprints in Jira is opt-in.
- **Sync**: the sprint is compared like any other mapped field. A change on one side propagates, and changes on both sides go through the configured conflict strategy.

Sprint sync needs Jira Software (the Sprint field and the Agile API) and the MCP Atlassian `jira_agile` toolset, which is enabled unless `TOOLSETS` restricts it.

## Configuration

Sprint sync is a `fieldMappings` entry of type `sprint` in `.backlog-jira/config.json`:

```json
{
  "fieldMappings": [
    {
      "backlog": "milestone",
      "jira": "sprint",
      "type": "sprint",
      "direction": "both",
      "boardId": 12,
      "createSprints": false,
      "archiveClosedSprints": true,
      "pullScope": "all"
    }
  ]
}
```

| Property | Required | Description |
|----------|----------|-------------|
| `backlog` | yes | Always `milestone`. No other mapping may target `milestone` (e.g. `fixVersions`). |
| `jira` | yes | Always `sprint`. The Sprint custom field is discovered from Jira field metadata (the `gh-sprint` schema), so the site-specific `customfield_NNNNN` id is not needed. |
| `type` | yes | `sprint` |
| `boardId` | yes | The Jira board whose sprints become milestones (one board per config). Sprint names are only unique per board. |
| `direction` | no | `pull` (default), `push` or `both`, as for other mappings. |
| `createSprints` | no | Default `false`. When `true`, pushing a milestone that matches no sprint creates a future sprint on the board. |
| `archiveClosedSprints` | no | Default `true`. Closed sprints archive their milestone; tasks keep pointing at it. |
| `pullScope` | no | `all` (default) or `open`. With `open`, `pull --import` only imports issues in open sprints: the JQL becomes `(<jqlFilter>) AND sprint in openSprints()`. |

Set it up with the CLI:

```bash
# Find the board id (scrum boards have sprints)
backlog-jira map-fields boards --project PROJ

# Add the mapping
backlog-jira map-fields add milestone sprint --type sprint --board 12 --direction both
# Options: --create-sprints, --no-archive-closed-sprints, --pull-scope open

# Check the board and Sprint field, then create sprint milestones
backlog-jira doctor
backlog-jira pull --all
```

## How Sprints Map to Milestones

`.backlog-jira/sprints.json` is the sprint registry. It links each Jira sprint id to its milestone id and keeps the sprint's last known name, state, dates and goal, plus the discovered Sprint field id. Because the link is by id, renaming a sprint in Jira renames the milestone instead of creating a new one. Sprints with the same name also stay apart. The registry is shared project metadata and is re-included in `.backlog-jira/.gitignore`.

- **Pull**: a sprint without a registry entry adopts an active milestone with the same title (unless that milestone already stands for another sprint), or creates one. The due date is the sprint end date (as Jira wrote it) and the description is the sprint goal. If another sprint's milestone already has the title, the new milestone is named `<sprint name> (sprint <id>)`.
- **Push**: a milestone resolves to a sprint through the registry, else to a future or active sprint on the board with the same name (ignoring case, active first). Name matches are registered.

Milestones are created, renamed and archived only through the `backlog milestone` CLI and are never removed. Backlog.md has no milestone edit command yet. Due dates are therefore updated through `backlog milestone edit` when the installed CLI has it, else through a same-title `backlog milestone rename --due-date`. Descriptions (sprint goals) fall back to a guarded direct write. That write only touches milestones in the registry, and only their `due_date` line and `## Description` section. It refuses files that do not look like Backlog.md milestone files. Refusals are recorded in `.backlog-jira/milestone-refusals.json` and reported by `doctor`.

## Pull

- Sets each task's milestone from its issue's displayed sprint (open, else most recently completed, else none).
- Reconciles the milestone of every sprint it touches: title, due date, description, and archiving when closed (with `archiveClosedSprints`).
- On bulk pulls, also reconciles every registered sprint of the board, so changes arrive even when none of its issues are pulled.
- Stores the issue's full sprint history (id, name, state, start, end and complete dates) in `.backlog-jira/links/<task-id>.json`. `backlog-jira view <task-id>` shows it.
- Picks up tasks whose only change is their sprint.

Problems that do not stop the task are reported under "Warnings", for example a refused milestone update or a sprint reopened after its milestone was archived.

## Push

- Moves the issue into the milestone's sprint if it is not already there.
- A cleared milestone moves an issue in an open sprint to the backlog. Issues only in closed sprints are left alone.
- A closed sprint cannot be targeted, unless it is already the issue's displayed sprint.
- An unmatched milestone:
  - with `createSprints` on, creates one future sprint. Its name is the milestone title, its end date the due date (end of day, UTC) and its goal the description. It is then registered and the issue assigned.
  - with `createSprints` off, is reported as a failure.
- Subtasks are skipped because they follow their parent's sprint.
- With direction `both`, only a milestone changed in Backlog since the last sprint sync is pushed.

Sprint problems are reported like mapped field failures (`sprint (mapped to milestone): ...`) after the rest of the task has been pushed.

## Sync and Conflicts

Sync payloads and snapshots carry the displayed sprint as its Jira sprint id under `mappedFields.milestone`:

- The Jira side uses the id of the issue's displayed sprint.
- The Backlog side uses the id of the sprint registered for the task's milestone, `milestone:<id>` for a milestone with no sprint yet, or empty when unset.

Renaming a sprint in Jira therefore changes neither side.

- **One side changed**: the change propagates. One-way mappings restore the owner's sprint.
- **Both sides changed to different sprints**: this is a conflict, resolved per field by the conflict strategy:
  - `prefer-backlog` pushes the milestone.
  - `prefer-jira` pulls the sprint.
  - `prompt` asks for the `sprint` field, with only the Backlog or Jira choice.
  - `manual` marks the task for manual resolution.

## Doctor, View and Status

- `backlog-jira doctor`:
  - **Errors** when the Sprint field cannot be discovered, when the board is missing or unreachable, or when it is a kanban board without sprints.
  - **Warns** about linked tasks whose milestone matches no sprint while `createSprints` is off, and about milestones the fallback writer refused to update.
  - **Notes** when `createSprints` is on.
- `backlog-jira view <task-id>` shows the task's sprint history and marks the sprint shown as its milestone.
- `backlog-jira status` lists task counts per sprint. With `--json`, each task includes its `sprintId`.

## Limitations

- One board per config. Issues in sprints of other boards show those sprints, which are created as milestones on pull but are not matched by name on push.
- The task shows a single sprint. Clearing a milestone moves the issue to the backlog, but when the issue has completed sprints the next pull sets the milestone to the most recently completed one.
- MCP Atlassian's sprint listing omits complete dates. They come from issue Sprint field values and are kept in the registry.
- MCP Atlassian requires a start date when creating a sprint. Created sprints get a start date one minute in the future and stay in the future state. End dates must be later than that.
- Archived milestones cannot be renamed or unarchived through the Backlog CLI. A reopened sprint whose milestone is archived produces a warning.
- Subtask detection uses the issue type name (`Sub-task`, `Subtask`) or the `subtask` flag when Jira returns it.
