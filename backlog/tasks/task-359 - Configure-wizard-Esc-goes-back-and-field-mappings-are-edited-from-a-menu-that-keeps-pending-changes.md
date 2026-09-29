---
id: TASK-359
title: >-
  Configure wizard: Esc goes back, and field mappings are edited from a menu
  that keeps pending changes
status: Done
assignee:
  - '@claude'
created_date: '2026-09-29 17:23'
updated_date: '2026-09-29 17:34'
labels:
  - setup
  - cli
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
In the configure wizard, Esc cancels the whole setup, the same as Ctrl+C, so there is no way to back out of a single question. In the field mappings step, fields picked so far are only saved at the final confirmation, so cancelling partway (e.g. after a target is rejected) loses every pending mapping.

The step also makes it hard to know what is already mapped. "Current mappings" prints once and scrolls away and leaves out fields synced by default. The field search lists fields the plugin already syncs (Priority, Status, Summary), and for Priority it pre-fills the reserved target frontmatter:priority, which is only rejected after the field is picked.

Field mapping setup should work from a menu that always shows default-synced, configured and pending mappings, where any action can be backed out of without losing work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Throughout configure, Esc returns to the previous question or menu, and only Ctrl+C cancels the wizard
- [x] #2 The field mappings step is a menu that shows fields synced by default, configured mappings and pending (unsaved) mappings, with actions to add suggested fields, search all fields, edit a pending mapping, remove a mapping, save, or discard
- [x] #3 Pressing Esc while adding or editing a field drops only that field and returns to the menu, keeping other pending mappings
- [x] #4 Esc at the menu, or cancelling the wizard with pending mappings, offers to save them before leaving
- [x] #5 Field search marks fields synced by default and fields already configured or pending (with their target), and does not offer an unmappable default target for them
- [x] #6 Picking Jira's system Priority field leads to the built-in priority mapping's value map instead of a frontmatter target
- [x] #7 The suggested Backlog target for any field is one that validation accepts, and the target prompt lists the targets that are already taken
- [x] #8 Each field shows its suggested target, type and direction on one line and can be accepted in one keypress or edited one attribute at a time
- [x] #9 Existing mappings (including a sprint mapping) can be removed from the menu
- [x] #10 configure --step fields and the full wizard behave the same, and configure tests cover Esc-back, save-on-cancel and conflicting targets
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. ask(): patch each prompt's exit handler (via onRender) so Esc throws WizardBack while Ctrl+C keeps throwing WizardCancelled
2. Wizard loop: snapshot config per step; Esc inside a step returns to its "Set up now?" question (restoring the snapshot), Esc there goes to the previous step; with --step, Esc leaves the step unchanged
3. setup.ts: suggestBacklogTarget() that always yields a valid, untaken frontmatter target (reserved and jira_ keys get another name); use it for suggestions and search
4. Rewrite fieldsStep as a menu over a draft (configured, removals, pending): add suggested, search all, edit, remove, save, discard; Esc in sub-flows returns to the menu; Esc at the menu asks save/discard/keep editing; Ctrl+C with changes offers to save
5. Field editor: one summary line with Accept / change target / type / direction / back; target prompt lists taken targets and rejects them
6. Search labels default-synced, configured and pending fields; Priority opens the built-in priority value map
7. Tests in configure.test.ts and setup.test.ts; update docs (AGENTS.md/README/docs) where the wizard is described
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Esc now steps back through the configure wizard, and the field mappings step is a menu over a draft that is only written on Save.

- `ask()` replaces each prompt's exit handler (Esc) when it renders, so Esc throws `WizardBack` while Ctrl+C still throws `WizardCancelled`. `prompts` treats both keys as abort, and Esc in an autocomplete used to submit the highlighted choice.
- Wizard loop: config is snapshotted per step. Esc inside a step restores the snapshot and re-asks "Set up … now?". Esc on that question goes to the previous step (the first step stays put). With `--step`, Esc leaves the step unchanged.
- Field mappings menu: shows fields synced by default, configured mappings (sprint included, marked removing or changing) and pending changes. Actions: add suggested, search all, edit, remove, save, discard.
- Esc in a sub-menu returns to the menu. Esc at the menu with changes asks save, discard or keep editing. Ctrl+C with changes asks whether to save before quitting.
- Each field is one line (target, type, direction) with Accept or change one attribute. The target prompt lists taken targets and rejects them.
- Search marks default-synced, configured and pending fields. Picking a mapped field edits it; picking Priority edits the built-in priority value map.
- `suggestBacklogTarget()` in setup.ts always returns a valid, untaken frontmatter target (reserved keys get `_jira`, `jira_` prefixes are dropped, keys starting with a digit get `field_`). It also fixes suggestions such as Due date, which previously suggested the reserved `frontmatter:due_date`.

Testing:
- configure.test.ts: prompt mock gained `ESC` and `CANCEL` answers; `ESC` goes through the real exit-patching path. 14 new or rewritten tests cover the menu, Esc and Ctrl+C handling, taken and reserved targets, priority, editing, removal and wizard back navigation.
- setup.test.ts: suggestBacklogTarget tests.
- Checked Esc and Ctrl+C by hand in a pseudo-terminal against the real `prompts` library.
- bun check, check:types and the full test suite (720) pass; README guided-setup section updated; dist rebuilt.
<!-- SECTION:NOTES:END -->
