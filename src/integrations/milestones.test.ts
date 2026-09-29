import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import { SprintRegistry } from "../state/sprint-registry.ts";
import {
	type BacklogCliRunner,
	MilestoneAdapter,
	parseMilestoneFile,
	readMilestoneRefusals,
	rewriteMilestoneFile,
} from "./milestones.ts";

const GENERATED = `---
id: m-3
title: "Sprint 12"
due_date: "2026-10-10"
---

## Description

Ship sprint sync
second line
`;

const MILESTONE_HELP = `Commands:
  list [options]                list milestones with completion status
  add [options] <name>          add a milestone file
  rename [options] <from> <to>  rename a milestone file
  archive <name>                archive a milestone by id or title
`;
const RENAME_HELP = `Options:
  --no-update-tasks  do not update local tasks that reference the milestone
  --due-date <date>  set due date (YYYY-MM-DD)
  --clear-due-date   clear milestone due date
`;

describe("parseMilestoneFile", () => {
	it("reads id, title, due date and description", () => {
		expect(parseMilestoneFile(GENERATED, "/x.md", false)).toEqual({
			id: "m-3",
			title: "Sprint 12",
			dueDate: "2026-10-10",
			description: "Ship sprint sync\nsecond line",
			archived: false,
			filePath: "/x.md",
		});
	});

	it("unescapes quoted titles", () => {
		const milestone = parseMilestoneFile(
			'---\nid: m-1\ntitle: "Q \\"x\\": y #1"\n---\n',
			"/x.md",
			true,
		);
		expect(milestone?.title).toBe('Q "x": y #1');
		expect(milestone?.archived).toBe(true);
	});

	it("ignores files without id or title", () => {
		expect(parseMilestoneFile("# no frontmatter\n", "/x.md", false)).toBeNull();
	});
});

describe("rewriteMilestoneFile", () => {
	it("changes only the due_date line and Description text", () => {
		const result = rewriteMilestoneFile(GENERATED, "m-3", {
			dueDate: "2026-10-24",
			description: "New goal",
		});
		expect(result).toEqual({
			content: `---
id: m-3
title: "Sprint 12"
due_date: "2026-10-24"
---

## Description

New goal
`,
		});
	});

	it("adds and removes the due date", () => {
		const withoutDue = GENERATED.replace('due_date: "2026-10-10"\n', "");
		const added = rewriteMilestoneFile(withoutDue, "m-3", {
			dueDate: "2026-11-01",
		});
		expect(added).toEqual({ content: GENERATED.replace("10-10", "11-01") });
		expect(rewriteMilestoneFile(GENERATED, "m-3", { dueDate: null })).toEqual({
			content: withoutDue,
		});
	});

	it("keeps everything outside the Description section byte-identical", () => {
		const content = `---
id: m-3
title: "Sprint 12"
custom_key: keep me
---

Intro text   with   spacing

## Description

Old goal

## Notes

- untouched
`;
		const result = rewriteMilestoneFile(content, "m-3", {
			description: "New goal",
		});
		expect(result).toEqual({
			content: content.replace("Old goal", "New goal"),
		});
		const cleared = rewriteMilestoneFile(content, "m-3", {
			description: null,
		});
		expect(cleared).toEqual({
			content: content.replace("\n\nOld goal\n", "\n"),
		});
	});

	it("refuses files that do not match the expected format", () => {
		const cases: Array<[string, string]> = [
			[GENERATED.replace(/\n/g, "\r\n"), "CRLF"],
			["## Description\n\nx\n", "frontmatter"],
			[GENERATED.replace("id: m-3", "id: m-4"), "does not match m-3"],
			[
				GENERATED.replace("title:", "labels:\n  - a\ntitle:"),
				"unexpected frontmatter line",
			],
			[
				GENERATED.replace("due_date", 'due_date: "2026-01-01"\ndue_date'),
				'repeated "due_date"',
			],
			[GENERATED.replace("## Description", "## About"), 'no "## Description"'],
			[
				`${GENERATED}\n## Description\n\nagain\n`,
				'more than one "## Description"',
			],
		];
		for (const [content, error] of cases) {
			const result = rewriteMilestoneFile(content, "m-3", {
				description: "x",
			});
			expect("error" in result && result.error).toContain(error);
		}
	});
});

describe("MilestoneAdapter.update without the Backlog CLI", () => {
	let testDir: string;
	let filePath: string;
	let calls: string[][];

	function runner(
		milestoneHelp = MILESTONE_HELP,
		editHelp = "",
	): BacklogCliRunner {
		return async (args) => {
			calls.push(args);
			const key = args.join(" ");
			if (key === "milestone --help") return milestoneHelp;
			if (key === "milestone rename --help") return RENAME_HELP;
			if (key === "milestone edit --help") return editHelp;
			return "";
		};
	}

	function registryWith(milestoneId: string | null): SprintRegistry {
		const registry = SprintRegistry.load(testDir);
		if (milestoneId) {
			registry.upsert(
				{ id: "37", name: "Sprint 12", state: "active" },
				milestoneId,
			);
		}
		return registry;
	}

	beforeEach(() => {
		testDir = uniqueTestDir("milestones-test");
		const dir = join(testDir, "backlog", "milestones");
		mkdirSync(dir, { recursive: true });
		filePath = join(dir, "m-3 - sprint-12.md");
		writeFileSync(filePath, GENERATED);
		calls = [];
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("uses backlog milestone edit when the installed CLI has it", async () => {
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(
				`${MILESTONE_HELP}  edit [options] <name>  edit a milestone\n`,
				"  --due-date <date>\n  --clear-due-date\n  -d, --description <text>\n",
			),
			registry: registryWith(null),
		});

		const result = await adapter.update("m-3", {
			dueDate: "2026-10-24",
			description: "New goal",
		});

		expect(result).toEqual({
			status: "updated",
			methods: { dueDate: "edit", description: "edit" },
		});
		expect(calls.at(-1)).toEqual([
			"milestone",
			"edit",
			"--due-date=2026-10-24",
			"--description=New goal",
			"--",
			"m-3",
		]);
		// The CLI did the write; the file is left to it
		expect(readFileSync(filePath, "utf-8")).toBe(GENERATED);
	});

	it("updates the due date through a same-title rename and the description through the guarded fallback", async () => {
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(),
			registry: registryWith("m-3"),
		});

		const result = await adapter.update("m-3", {
			dueDate: null,
			description: "New goal",
		});

		expect(result).toEqual({
			status: "updated",
			methods: { dueDate: "rename", description: "file" },
		});
		expect(calls).toContainEqual([
			"milestone",
			"rename",
			"--clear-due-date",
			"--no-update-tasks",
			"--",
			"m-3",
			"Sprint 12",
		]);
		// The fake CLI did not clear the due date; only the description changed
		expect(readFileSync(filePath, "utf-8")).toBe(
			GENERATED.replace("Ship sprint sync\nsecond line", "New goal"),
		);
	});

	it("does nothing when values already match", async () => {
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(),
			registry: registryWith("m-3"),
		});
		expect(
			await adapter.update("m-3", {
				dueDate: "2026-10-10",
				description: " Ship sprint sync\nsecond line ",
			}),
		).toEqual({ status: "unchanged", methods: {} });
		expect(calls).toEqual([]);
	});

	it("refuses fallback writes to milestones outside the sprint registry and records it", async () => {
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(),
			registry: registryWith(null),
		});

		const result = await adapter.update("m-3", { description: "New goal" });

		expect(result.status).toBe("refused");
		expect(result.reason).toContain("not a sprint milestone");
		expect(readFileSync(filePath, "utf-8")).toBe(GENERATED);
		expect(readMilestoneRefusals(testDir)).toMatchObject([
			{ milestoneId: "m-3", title: "Sprint 12", fields: ["description"] },
		]);
	});

	it("refuses to write a file in an unexpected format, then clears the refusal once an update succeeds", async () => {
		const odd = GENERATED.replace("## Description", "## About");
		writeFileSync(filePath, odd);
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(),
			registry: registryWith("m-3"),
		});

		const refused = await adapter.update("m-3", { description: "New goal" });
		expect(refused.status).toBe("refused");
		expect(refused.reason).toContain(
			"does not match the expected milestone format",
		);
		expect(readFileSync(filePath, "utf-8")).toBe(odd);
		expect(readMilestoneRefusals(testDir)).toHaveLength(1);

		writeFileSync(filePath, GENERATED);
		expect(
			(await adapter.update("m-3", { description: "New goal" })).status,
		).toBe("updated");
		expect(readMilestoneRefusals(testDir)).toEqual([]);
	});

	it("rejects malformed due dates", async () => {
		const adapter = new MilestoneAdapter({
			cwd: testDir,
			runner: runner(),
			registry: registryWith("m-3"),
		});
		await expect(
			adapter.update("m-3", { dueDate: "10/24/2026" }),
		).rejects.toThrow("YYYY-MM-DD");
	});

	it("never offers a way to remove milestones", () => {
		const adapter = new MilestoneAdapter({ cwd: testDir, runner: runner() });
		expect("remove" in adapter).toBe(false);
		expect("delete" in adapter).toBe(false);
	});
});

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasBacklogCli)("MilestoneAdapter with the Backlog CLI", () => {
	let testDir: string;

	function backlog(...args: string[]): string {
		const result = spawnSync("backlog", args, {
			cwd: testDir,
			encoding: "utf-8",
		});
		if (result.status !== 0) {
			throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	function milestoneFiles(): string[] {
		const dirs = [
			join(testDir, "backlog", "milestones"),
			join(testDir, "backlog", "archive", "milestones"),
		];
		return dirs.flatMap((dir) =>
			existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [],
		);
	}

	beforeEach(() => {
		testDir = uniqueTestDir("milestones-cli-test");
		spawnSync("git", ["init", "-q"], { cwd: testDir });
		backlog(
			"init",
			"milestones-test",
			"--defaults",
			"--integration-mode",
			"none",
		);
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("creates, adopts, renames and archives milestones through the CLI", async () => {
		const adapter = new MilestoneAdapter({ cwd: testDir });

		const first = await adapter.ensure({
			title: "-Sprint 1",
			dueDate: "2026-10-10",
			description: "-First goal",
		});
		expect(first.created).toBe(true);
		expect(first.milestone).toMatchObject({
			title: "-Sprint 1",
			dueDate: "2026-10-10",
			description: "-First goal",
			archived: false,
		});

		const adopted = await adapter.ensure({ title: "-SPRINT 1 " });
		expect(adopted).toEqual({ milestone: first.milestone, created: false });
		expect(milestoneFiles()).toHaveLength(1);

		const id = first.milestone.id;
		backlog("task", "create", "Linked", "--milestone", id);

		expect(await adapter.rename(id, "Sprint 1 (renamed)")).toBe(true);
		expect(adapter.get(id)?.title).toBe("Sprint 1 (renamed)");

		expect(await adapter.archive(id)).toBe(true);
		expect(await adapter.archive(id)).toBe(false);
		expect(adapter.get(id)?.archived).toBe(true);
		// Milestones are never removed and tasks keep pointing at them
		expect(milestoneFiles()).toHaveLength(1);
		expect(backlog("task", "1", "--plain")).toContain(id);
	});

	it("does not adopt milestones the caller rules out", async () => {
		const adapter = new MilestoneAdapter({ cwd: testDir });
		const first = await adapter.ensure({ title: "Sprint 1" });
		await adapter.archive(first.milestone.id);

		const second = await adapter.ensure(
			{ title: "Sprint 1" },
			{ isAdoptable: (m) => m.id !== first.milestone.id },
		);
		expect(second.created).toBe(true);
		expect(second.milestone.id).not.toBe(first.milestone.id);
	});

	it("updates due date via the CLI and description via the guarded fallback", async () => {
		const adapter = new MilestoneAdapter({ cwd: testDir });
		const { milestone } = await adapter.ensure({
			title: "Sprint 2",
			description: "Old goal",
		});
		const registry = SprintRegistry.load(testDir);
		registry.upsert(
			{ id: "40", name: "Sprint 2", state: "future" },
			milestone.id,
		);
		registry.save();

		const result = await adapter.update(milestone.id, {
			dueDate: "2026-11-20",
			description: "New goal",
		});

		expect(result.status).toBe("updated");
		expect(result.methods.dueDate).not.toBe("file");
		expect(adapter.get(milestone.id)).toMatchObject({
			dueDate: "2026-11-20",
			description: "New goal",
		});
		expect(backlog("milestone", "list", "--plain")).toContain("Sprint 2");

		const cleared = await adapter.update(milestone.id, { dueDate: null });
		expect(cleared.status).toBe("updated");
		expect(adapter.get(milestone.id)?.dueDate).toBeUndefined();
	});
});
