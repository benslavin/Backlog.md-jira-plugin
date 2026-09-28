---
id: TASK-343
title: 'Ship prebuilt Node-compatible dist for npm, pnpm and bun installs'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-28 18:26'
updated_date: '2026-09-28 18:31'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Git installs rely on the prepare script, which pnpm (and bun) block for git-hosted packages by default (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED). The built CLI also requires Bun at runtime. Ship a committed, Node-targeted dist/cli.js so the CLI installs from git with npm, pnpm or bun and runs on plain Node.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Installing from the git URL runs no build scripts (no prepare script)
- [x] #2 dist/cli.js is committed and runs under Node 20+ and Bun with correct UTF-8 output
- [x] #3 No Bun runtime APIs or Bun checks remain in the shipped CLI code (doctor included)
- [x] #4 A check:dist script fails when committed dist/ is stale relative to src/
- [x] #5 README install docs cover npm, pnpm and bun, with Bun only required for development
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Switch build to --target=node and cli.ts shebang to node (avoids @bun pragma UTF-8 issue)
2. Replace Bun.file and Bun runtime check in doctor.ts with Node equivalents
3. package.json: drop prepare, engines node>=20, add check:dist
4. Un-ignore dist/ and commit the build
5. Update README install docs
6. Verify: lint, types, tests, run dist under node and bun, pnpm pack/install from a local git clone
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Ship a committed, Node-targeted `dist/cli.js` so the CLI installs from git with npm, pnpm or bun (no build scripts to block) and runs on plain Node 20+ or Bun.

- Build now uses `--target=node`; `src/cli.ts` shebang is `#!/usr/bin/env node`. A `bun` shebang made `bun build` emit a `// @bun` pragma, which caused the old UTF-8 garbling when Bun ran a Node-targeted build.
- `doctor`: replaced `Bun.file` with `fs/promises.readFile`; the Bun version check is now a Node 20+ runtime check that names Bun when running under it; the install hint is package-manager neutral.
- `package.json`: removed `prepare`, `engines` is now `node >=20`, added `check:dist` (rebuild + `git diff --exit-code -- dist`).
- `dist/` is no longer gitignored.
- README: npm/pnpm/bun git-install instructions, Node 20+ prerequisite, Bun only for development, contributor note on committing `dist/`.

Testing:
- `bun run check`, `check:types`, `bun test` (284 pass).
- Build is reproducible and contains no absolute paths.
- Installed from a `git+file://` URL with npm, pnpm 12.6 and bun: no build scripts ran; `backlog-jira --version` and `doctor` print correctly under both Node 24 and Bun 1.4.
- `check:dist` passes on a fresh clone and fails after a source change.

Known limitation (not changed): doctor still checks for `node_modules` in the current directory, which does not make sense for a globally installed CLI.
<!-- SECTION:NOTES:END -->
