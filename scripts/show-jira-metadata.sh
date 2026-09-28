#!/bin/bash
# Show Jira metadata for a Backlog task
# Run from the project root (the directory containing backlog/ and .backlog-jira/)

set -euo pipefail

TASKS_DIR="backlog/tasks"
SNAPSHOTS_DIR=".backlog-jira/snapshots"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <task-id>"
    echo "Example: $0 289"
    echo "         $0 task-289"
    exit 1
fi

TASK_ID="$1"
# Normalize task ID (add 'task-' prefix if not present)
if [[ ! "$TASK_ID" =~ ^task- ]]; then
    TASK_ID="task-$TASK_ID"
fi

TASK_FILE=$(find "$TASKS_DIR" -maxdepth 1 -name "$TASK_ID - *.md" 2>/dev/null | head -n 1)

if [ -z "$TASK_FILE" ]; then
    echo "Error: Task file not found for $TASK_ID in $TASKS_DIR"
    echo "Run this script from the project root."
    exit 1
fi

# Read a scalar field from the task's YAML frontmatter
frontmatter_field() {
    awk -v key="$1" '
        NR == 1 && $0 == "---" { in_fm = 1; next }
        in_fm && $0 == "---" { exit }
        in_fm && index($0, key ":") == 1 {
            value = substr($0, length(key) + 2)
            sub(/^[ \t]+/, "", value)
            gsub(/^["'\'']|["'\'']$/, "", value)
            print value
            exit
        }
    ' "$TASK_FILE"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Jira Metadata for $TASK_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

JIRA_KEY=$(frontmatter_field jira_key)

if [ -z "$JIRA_KEY" ]; then
    echo "❌ No Jira mapping found for $TASK_ID"
    echo ""
    echo "To create a mapping, run:"
    echo "  backlog-jira map interactive"
    exit 1
fi

echo ""
echo "🔗 Mapping Information"
echo "────────────────────────────────────────────────────────"
echo "  Backlog ID:    $TASK_ID"
echo "  Jira Key:      $JIRA_KEY"
JIRA_URL=$(frontmatter_field jira_url)
if [ -n "$JIRA_URL" ]; then
    echo "  Jira URL:      $JIRA_URL"
fi

echo ""
echo "📊 Sync State"
echo "────────────────────────────────────────────────────────"
LAST_SYNC=$(frontmatter_field jira_last_sync)
SYNC_STATE=$(frontmatter_field jira_sync_state)
echo "  Last Sync:     ${LAST_SYNC:-Never}"
echo "  Sync State:    ${SYNC_STATE:-None}"

show_snapshot() {
    local snapshot_file="$SNAPSHOTS_DIR/$TASK_ID-$1.json"
    if [ -f "$snapshot_file" ]; then
        echo "  Updated At:    $(jq -r '.updatedAt' "$snapshot_file")"
        echo "  Hash:          $(jq -r '.hash' "$snapshot_file")"
        jq '.payload | fromjson' "$snapshot_file"
    else
        echo "  No snapshot available"
    fi
}

echo ""
echo "🔍 Jira Snapshot (Last Synced State)"
echo "────────────────────────────────────────────────────────"
show_snapshot jira

echo ""
echo "📝 Backlog Snapshot (Last Synced State)"
echo "────────────────────────────────────────────────────────"
show_snapshot backlog

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
