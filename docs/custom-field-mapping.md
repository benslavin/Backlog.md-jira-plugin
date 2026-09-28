# Custom Field Mapping

## Overview

Custom field mappings bring Jira fields beyond the built-in set (title, description, status, priority, assignee, labels, acceptance criteria) onto Backlog tasks: story points, team, fix versions, due dates, components and so on.

Each mapping has a direction:

- `pull` (default): `backlog-jira pull` (including `pull --import`) writes the Jira value into Backlog. The value is never sent to Jira; Backlog-side edits are restored from Jira by the next pull or sync.
- `push`: `backlog-jira push` and `backlog-jira create-issue` send the Backlog value to Jira. The value is never written to Backlog; Jira-side edits are overwritten by the next push or sync.
- `both`: values flow both ways, and `backlog-jira sync` detects conflicts per field.

## Configuration Location

Mappings live in `.backlog-jira/config.json` under the top-level `fieldMappings` array. Edit the file directly or use `backlog-jira map-fields`.

```json
{
  "fieldMappings": [
    { "backlog": "frontmatter:story_points", "jira": "customfield_10016", "type": "number", "direction": "both" },
    { "backlog": "frontmatter:team", "jira": "customfield_10020", "type": "option", "direction": "push" },
    { "backlog": "frontmatter:due", "jira": "duedate", "type": "date" },
    { "backlog": "milestone", "jira": "fixVersions", "type": "version" },
    { "backlog": "labels", "jira": "components", "type": "array" },
    {
      "backlog": "priority",
      "jira": "customfield_10050",
      "type": "option",
      "valueMap": { "P1": "high", "P2": "medium", "P3": "low" }
    }
  ]
}
```

## Mapping Properties

| Property | Required | Description |
|----------|----------|-------------|
| `backlog` | yes | Backlog target (see below). Each target may be mapped once. |
| `jira` | yes | Jira custom field ID (`customfield_NNNNN`) or system field name (`fixVersions`, `components`, `duedate`, ...). |
| `type` | yes | Type adapter used to convert the Jira value (see below). |
| `direction` | no | `pull` (default), `push` or `both`. See [Overview](#overview). |
| `valueMap` | no | Object translating Jira values to Backlog values. Exact matches win, then case-insensitive matches; unmapped values pass through. Pushed values are translated back (Backlog value → Jira key). |

### Backlog Targets

| Target | Written with | Notes |
|--------|--------------|-------|
| `milestone` | `backlog task edit --milestone` / `--clear-milestone` | List values are joined with `, `. |
| `dependencies` | `backlog task edit --dep` / `--clear-deps` | Values should be Backlog task IDs. |
| `references` | `backlog task edit --ref` / `--clear-refs` | |
| `priority` | `backlog task edit --priority` | Replaces the built-in Jira priority, which is then not synced in either direction. Values must be valid Backlog priorities; use `valueMap`. An empty Jira value leaves the Backlog priority unchanged. |
| `labels` | `backlog task edit --label` / `--clear-labels` | Replaces the built-in Jira labels, which are then not synced in either direction. |
| `frontmatter:<key>` | Plugin frontmatter utilities | Stored as `<key>` in the task file's frontmatter. |

`frontmatter:<key>` targets are rejected when `<key>` is a Backlog core key (`id`, `title`, `status`, `assignee`, `labels`, `milestone`, `dependencies`, `priority`, `created_date`, ...) or starts with `jira_` (reserved for the plugin's sync metadata).

### Type Adapters

| Type | Jira value | Backlog value | Sent to Jira as |
|------|------------|---------------|-----------------|
| `string` | Text (or any object with a display value) | Trimmed text | Text (lists joined with `, `) |
| `number` | Number field | Canonical number, e.g. `5`, `2.5` | Number; non-numeric values are reported as a failed field |
| `date` | Date or date-time | `YYYY-MM-DD` | `YYYY-MM-DD`; other values are reported as a failed field |
| `option` | Single select `{ "value": "Red" }` | `Red` | `{ "value": "Red" }` |
| `multi-option` | Multi select / checkboxes | List of option values | `[{ "value": ... }]` |
| `user` | User picker | Backlog assignee via the assignee mapping (`backlog-jira map-assignees`), otherwise the Jira display name | `{ "accountId": ... }` when the (mapped) value is an account ID, otherwise `{ "name": ... }` (Server/DC). On Jira Cloud, map assignees to account IDs. |
| `version` | Version or version list (`fixVersions`) | Version name or list of names | `[{ "name": ... }]` for list fields (`fixVersions`, `versions`, or list values), otherwise `{ "name": ... }` |
| `array` | Labels-like list (`components`, text lists) | List of names; comma-separated text is split | `components`: `[{ "name": ... }]`; other fields: list of strings |

Empty Jira values clear the Backlog target (except `priority`). Empty Backlog values clear the Jira field (`null`, or `[]` for list fields); on `create-issue` empty values are simply omitted.

## Commands

```bash
# List Jira fields with IDs, schema types and a suggested --type
backlog-jira map-fields discover
backlog-jira map-fields discover --search "story" --custom-only

# Add, replace, list and remove mappings
backlog-jira map-fields add frontmatter:story_points customfield_10016 --type number
backlog-jira map-fields add frontmatter:team customfield_10020 --type option --value-map "Platform Team=platform"
backlog-jira map-fields add milestone fixVersions --type version --force
backlog-jira map-fields list
backlog-jira map-fields remove milestone
```

`discover` lists the fields visible to your Jira account through MCP Atlassian's `jira_search_fields` tool. Not every field is on every project's screens: run `backlog-jira doctor` to check.

```bash
# Push and sync respect each mapping's direction
backlog-jira push task-12
backlog-jira sync task-12 --strategy prompt

# Show mapped values from Backlog and Jira side by side
backlog-jira view task-12 --plain
```

## Verifying Mappings

`backlog-jira doctor` checks every mapping:

- the Jira field exists (via `jira_search_fields`);
- for `push` and `both` mappings, the field is on the screen of the configured `jira.projectKey` and `jira.issueType` (via `jira_get_project_issue_types` and `jira_get_create_fields`). MCP Atlassian exposes create-screen metadata, which is used as the check for editability.

If MCP Atlassian cannot provide screen metadata (older versions), the editability check is skipped with a warning.

## Push Failures

Jira rejects a whole update with a 400 when any field in it cannot be set. When an update that includes mapped fields fails, the plugin retries the built-in fields on their own and then each mapped field separately, so everything else is still pushed and the error names the fields at fault:

```
task-12: Mapped field could not be updated on PROJ-12:
  - customfield_10020 (mapped to frontmatter:team): Field 'customfield_10020' cannot be set. It is not on the appropriate screen, or unknown.
```

Failed fields stay pending (the task keeps `NeedsPush`), so the next push or sync retries them once the screen or the mapping is fixed. `create-issue` works the same way: if Jira rejects a mapped field, the issue is created without it and the failing field is reported as a warning.

## Conflicts

`backlog-jira sync` compares each mapped field against the last synced snapshot:

- `both` mappings changed on both sides to different values are reported as conflicts per field and resolved with the configured strategy. `prefer-backlog` and `prefer-jira` push or pull the whole task; `prompt` asks per field (including a manual value; comma-separated for list targets) and writes the chosen value to both sides.
- `pull` mappings never conflict: Jira wins. A Backlog-only edit to a pull field is restored from Jira.
- `push` mappings never conflict: Backlog wins. A Jira-only edit to a push field is overwritten from Backlog.

## How Sync State Handles Mappings

- Mapped fields (in every direction) are requested explicitly when issues are fetched, so their values are available during pull, push and `view`.
- Mapped values are part of the change-detection hash only when mappings exist. Without `fieldMappings`, hashes are identical to earlier versions.
- Adding a mapping does not produce a both-sides-changed conflict: fields that were not in the last snapshot are compared directly, and a mismatch is treated as a change on the mapping's source side (`NeedsPush` for `push` mappings, `NeedsPull` otherwise). Removing a mapping is not treated as a change.
- Direction is applied when classifying changes: a side whose only edits are to fields it does not own is not counted as changed, and the owner's value is restored instead.
- `frontmatter:<key>` values are written after any `backlog task edit` in the same pull, and are rewritten on pull if they are missing from the task file.
