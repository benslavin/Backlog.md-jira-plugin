---
id: TASK-338
title: Remove unused SQLite store and better-sqlite3 dependency
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 17:16'
updated_date: '2026-09-28 17:27'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
All commands migrated to FrontmatterStore (task-329), but the legacy SQLite SyncStore, better-sqlite3 dependency and SQLite references remain. better-sqlite3 forces a native compile on every install (and a pnpm allowBuilds entry for git installs) despite never being used, since the CLI only runs under Bun.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 better-sqlite3 and @types/better-sqlite3 are removed from package.json and the build script no longer externalizes better-sqlite3
- [x] #2 No source file imports or loads bun:sqlite or better-sqlite3
- [x] #3 No remaining references to the SyncStore type; tsc reports no SyncStore errors
- [x] #4 Agent instructions and scripts/show-jira-metadata.sh no longer reference a SQLite database
- [x] #5 Test suite passes with no new failures
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Move shared interfaces into src/state/types.ts; reduce store.ts to re-exports
2. Replace stray SyncStore type refs with FrontmatterStore
3. Drop better-sqlite3 deps and build external
4. Update agent instructions text and rewrite show-jira-metadata.sh to read frontmatter/snapshots
5. Tidy SQLite mentions in tests
6. Record baseline test/tsc results, then re-run and compare
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Removed the legacy SQLite SyncStore and the better-sqlite3 dependency; all sync state already lived in FrontmatterStore since task-329.

- `src/state/types.ts`: new home for Mapping/Snapshot/SyncState/OpLog interfaces
- `src/state/store.ts`: now only re-exports types + FrontmatterStore (existing imports unchanged); SQLite loading removed, so no DB module is loaded at startup
- Replaced unimported `SyncStore` type refs in map/pull/push/sync with `FrontmatterStore` (tsc errors 58 -> 44)
- `create-issue.ts`: removed stale `dbPath` option, which was passed to FrontmatterStore as a config dir (tests created a `jira-sync.db/` directory); now uses the existing `configDir` option
- package.json: dropped better-sqlite3, @types/better-sqlite3 and `--external better-sqlite3`; bun.lock regenerated (removes better-sqlite3 and its 27 transitive deps) and package-lock.json updated (package-lock was also stale: dropped unused @inquirer/*, added prompts)
- Agent instructions: replaced SQLite "Database" section with file-based "Storage" section
- `scripts/show-jira-metadata.sh`: rewritten to read task frontmatter and snapshot JSON (run from project root)
- Tidied SQLite wording in tests

Testing: `bun run build` succeeds and the bundle contains no sqlite references; `bun test` 280 pass, 4 fail (pre-existing Jira env-var tests, same as HEAD). Verified with better-sqlite3 removed from node_modules. Script smoke-tested against a mock project.
<!-- SECTION:NOTES:END -->
