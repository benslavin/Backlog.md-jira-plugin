# Custom Field Mapping

## Overview

Custom field mappings bring Jira fields beyond the built-in set (title, description, status, priority, assignee, labels, acceptance criteria) onto Backlog tasks: story points, team, fix versions, due dates, components and so on.

**Mappings are pull-only.** `backlog-jira pull` (including `pull --import`) writes mapped Jira values into Backlog. Mapped values are never sent to Jira, and Backlog-side edits to a mapped field are overwritten by the next pull.

## Configuration Location

Mappings live in `.backlog-jira/config.json` under the top-level `fieldMappings` array. Edit the file directly or use `backlog-jira map-fields`.

```json
{
  "fieldMappings": [
    { "backlog": "frontmatter:story_points", "jira": "customfield_10016", "type": "number" },
    { "backlog": "frontmatter:team", "jira": "customfield_10020", "type": "option" },
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
| `direction` | no | `pull` (default), `push` or `both`. Only the pull side is applied today; `push` mappings are ignored. |
| `valueMap` | no | Object translating Jira values to Backlog values. Exact matches win, then case-insensitive matches; unmapped values pass through. |

### Backlog Targets

| Target | Written with | Notes |
|--------|--------------|-------|
| `milestone` | `backlog task edit --milestone` / `--clear-milestone` | List values are joined with `, `. |
| `dependencies` | `backlog task edit --dep` / `--clear-deps` | Values should be Backlog task IDs. |
| `references` | `backlog task edit --ref` / `--clear-refs` | |
| `priority` | `backlog task edit --priority` | Replaces the built-in Jira priority as the source. Values must be valid Backlog priorities; use `valueMap`. An empty Jira value leaves the Backlog priority unchanged. |
| `labels` | `backlog task edit --label` / `--clear-labels` | Replaces the built-in Jira labels as the source. |
| `frontmatter:<key>` | Plugin frontmatter utilities | Stored as `<key>` in the task file's frontmatter. |

`frontmatter:<key>` targets are rejected when `<key>` is a Backlog core key (`id`, `title`, `status`, `assignee`, `labels`, `milestone`, `dependencies`, `priority`, `created_date`, ...) or starts with `jira_` (reserved for the plugin's sync metadata).

### Type Adapters

| Type | Jira value | Backlog value |
|------|------------|---------------|
| `string` | Text (or any object with a display value) | Trimmed text |
| `number` | Number field | Canonical number, e.g. `5`, `2.5` |
| `date` | Date or date-time | `YYYY-MM-DD` |
| `option` | Single select `{ "value": "Red" }` | `Red` |
| `multi-option` | Multi select / checkboxes | List of option values |
| `user` | User picker | Backlog assignee via the assignee mapping (`backlog-jira map-assignees`), otherwise the Jira display name |
| `version` | Version or version list (`fixVersions`) | Version name or list of names |
| `array` | Labels-like list (`components`, text lists) | List of names; comma-separated text is split |

Empty Jira values clear the Backlog target (except `priority`).

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

`discover` lists the fields visible to your Jira account through MCP Atlassian's `jira_search_fields` tool. Not every field is on every project's screens.

## How Sync State Handles Mappings

- Mapped fields are requested explicitly when issues are fetched, so their values are available during pull.
- Mapped values are part of the change-detection hash only when mappings exist. Without `fieldMappings`, hashes are identical to earlier versions.
- Adding a mapping does not produce a both-sides-changed conflict: fields that were not in the last snapshot are compared directly, and a mismatch is treated as a Jira-side change (`NeedsPull`). Removing a mapping is not treated as a change.
- `frontmatter:<key>` values are written after any `backlog task edit` in the same pull, and are rewritten on pull if they are missing from the task file.
