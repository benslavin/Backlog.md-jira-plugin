---
id: TASK-339
title: 'Make check, check:types and test pass on a clean checkout'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-28 17:38'
updated_date: '2026-09-28 17:42'
labels:
  - tooling
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
bun run check, bun run check:types and bun test all fail on main. The failures hide a real bug: process.env.X = undefined stores the string "undefined" rather than unsetting the variable, which breaks env-validation tests and leaks a bogus JIRA_PERSONAL_TOKEN from the configure connection test.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bun run check exits 0
- [x] #2 bun run check:types exits 0 without requiring bunx on PATH
- [x] #3 bun test passes with no failures
- [x] #4 configure connection test no longer leaves env vars set to the string "undefined"
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Point check:types at tsc directly instead of bunx
2. Fix env-unset bug (delete instead of = undefined) in configure.ts and tests; add helper for restore
3. Disable biome noDelete (its quick-fix introduced the bug); apply biome safe fixes; fix remaining any/non-null by hand
4. Fix stale test types and vitest imports; fix 3 source type errors
5. Run all three checks
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
All three checks now pass: `bun run check`, `bun run check:types` (tsc, 0 errors), `bun test` (284 pass, 0 fail).

**Bug fix**
- `process.env.X = undefined` stores the string "undefined". `configure.ts` did this during the connection test and in `Object.assign(process.env, originalEnv)` restores, so unset vars (e.g. JIRA_PERSONAL_TOKEN) could come back as "undefined". Added `setEnv`/`restoreEnv` helpers that delete unset vars.
- Same pattern in `mcp.test.ts` and `jira.test.ts` caused the 4 failing tests; switched to `delete`.

**Tooling**
- `check:types` runs `tsc` directly instead of `bunx`.
- Disabled Biome `performance/noDelete`: its quick-fix introduced the env bug, and the frontmatter `delete`s are intentional.
- Removed unused `rootDir` from tsconfig (noEmit; it rejected `test/helpers` imports).

**Cleanup**
- Biome formatting, import ordering and template-literal fixes (behavior-preserving).
- Removed `any` from `jira-config.ts` and the `sync.ts` stdout/stderr filter; replaced non-null assertions on `result.hints`.
- Source type errors: `view.ts` uses the shared `TaskWithJira`, `jira.ts` casts `result.content` once, `create-issue.ts` drops an extra arg to `mapBacklogPriorityToJira`.
- Test types: mocks typed with `Mapping`, `BacklogTask`, `JiraIssue`, `PushOptions`/`PullOptions`; `vitest` imports switched to `bun:test`.
<!-- SECTION:NOTES:END -->
