/**
 * Tasks whose Backlog and Jira content already match, end to end: sync, pull
 * and push against the installed Backlog.md CLI and an in-memory Jira
 * (JiraClient methods are replaced on its prototype). Stale snapshots are
 * refreshed without writing to Jira or to the task file. Skipped when
 * `backlog` is not on the PATH.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { JiraClient, type JiraIssue } from "../integrations/jira.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import { getTaskFilePath } from "../utils/frontmatter.ts";
import { type NormalizedPayload, computeHash } from "../utils/normalizer.ts";
import { pull } from "./pull.ts";
import { push } from "./push.ts";
import { sync } from "./sync.ts";

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

function backlogCli(...args: string[]): string {
	const result = spawnSync("backlog", args, { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

interface FakeIssue {
	summary: string;
	description: string;
	status: string;
}

/** In-memory Jira: issues by key */
const jiraIssues = new Map<string, FakeIssue>();
/** Jira writes: one entry per update or transition */
const jiraWrites: string[] = [];

function toJiraIssue(key: string): JiraIssue {
	const found = jiraIssues.get(key);
	if (!found) throw new Error(`Issue does not exist: ${key}`);
	return {
		key,
		id: key,
		summary: found.summary,
		description: found.description,
		status: found.status,
		issueType: "Task",
		labels: [],
		created: "",
		updated: "",
		fields: { summary: found.summary, description: found.description },
	};
}

const fakeMethods: Partial<Record<keyof JiraClient, unknown>> = {
	getIssue: async (key: string) => toJiraIssue(key),
	searchAllIssues: async () => ({
		issues: [...jiraIssues.keys()].map(toJiraIssue),
		truncated: false,
	}),
	updateIssue: async (
		key: string,
		updates: { summary?: string; description?: string },
	) => {
		const found = jiraIssues.get(key);
		if (!found) throw new Error(`Issue does not exist: ${key}`);
		jiraWrites.push(`update ${key}`);
		if (updates.summary) found.summary = updates.summary;
		if (updates.description) found.description = updates.description;
	},
	getTransitions: async () => [],
	transitionIssue: async (key: string) => {
		jiraWrites.push(`transition ${key}`);
	},
	setIssueParent: async (key: string) => {
		jiraWrites.push(`parent ${key}`);
	},
	getEpicLinkFieldId: async () => null,
	includeIssueFields: () => {},
	close: async () => {},
};

const DESCRIPTION =
	"Steps:\n\n1. Open the login page\n2. Sign in\n\nAcceptance Criteria:\n- [ ] Users can log in";

describe.skipIf(!hasBacklogCli)("tasks whose content already matches", () => {
	let testDir: string;
	let originalCwd: string;
	let taskId: string;
	const originals = new Map<string, unknown>();
	const store = () => new FrontmatterStore();
	const taskFile = () => readFileSync(getTaskFilePath(taskId), "utf-8");
	const snapshotFile = (side: "backlog" | "jira") =>
		readFileSync(
			join(testDir, ".backlog-jira", "snapshots", `${taskId}-${side}.json`),
			"utf-8",
		);

	/** Make the Backlog snapshot stale, as a parser change would */
	const staleBacklogSnapshot = () => {
		const s = store();
		const stored = JSON.parse(
			s.getSnapshots(taskId).backlog?.payload ?? "{}",
		) as NormalizedPayload;
		const truncated = { ...stored, description: "Steps:" };
		s.setSnapshot(taskId, "backlog", computeHash(truncated), truncated);
		s.close();
	};

	beforeAll(async () => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("content-match-test");
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlogCli("init", "content-match", "--defaults");
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			jira: { projectKey: "PROJ", issueType: "Task" },
			backlog: {
				statusMapping: { "To Do": ["To Do"], Done: ["Done"] },
			},
			sync: { conflictStrategy: "prefer-backlog" },
		});
		for (const [name, fn] of Object.entries(fakeMethods)) {
			const proto = JiraClient.prototype as unknown as Record<string, unknown>;
			originals.set(name, proto[name]);
			proto[name] = fn;
		}

		jiraIssues.set("PROJ-1", {
			summary: "Fix login",
			description: DESCRIPTION,
			status: "To Do",
		});
		const imported = await pull({ import: true });
		expect(imported.failed).toEqual([]);
		taskId = imported.importedLinks[0].taskId;
	});

	afterAll(() => {
		const proto = JiraClient.prototype as unknown as Record<string, unknown>;
		for (const [name, fn] of originals) proto[name] = fn;
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	beforeEach(() => {
		jiraWrites.length = 0;
	});

	it("rebaselines after the import instead of pushing identical content", async () => {
		// The import stores both snapshots with the Jira hash, and the Jira
		// description carries the acceptance criteria, so the Backlog side
		// looked changed and 0.3.4 pushed it back unchanged
		const result = await sync();

		expect(result.synced).toEqual([]);
		expect(result.rebaselined).toEqual([taskId]);
		expect(jiraWrites).toEqual([]);
		expect((await sync()).skipped).toEqual([taskId]);
	});

	it("rebaselines stale snapshots without writing to Jira or the task file", async () => {
		staleBacklogSnapshot();
		const before = taskFile();

		const result = await sync();

		expect(result.failed).toEqual([]);
		expect(result.synced).toEqual([]);
		expect(result.rebaselined).toEqual([taskId]);
		expect(jiraWrites).toEqual([]);
		expect(taskFile()).toBe(before);
		expect(jiraIssues.get("PROJ-1")?.description).toBe(DESCRIPTION);

		// The snapshots now hold the current payloads
		const second = await sync();
		expect(second.skipped).toEqual([taskId]);
		expect(second.rebaselined).toEqual([]);
	});

	it("reports a rebaseline under --dry-run without saving snapshots", async () => {
		staleBacklogSnapshot();
		const stale = snapshotFile("backlog");

		const result = await sync({ dryRun: true });

		expect(result.rebaselined).toEqual([taskId]);
		expect(snapshotFile("backlog")).toBe(stale);
		expect((await sync()).rebaselined).toEqual([taskId]);
	});

	it("rebaselines in pull and push too", async () => {
		staleBacklogSnapshot();
		const pulled = await pull();
		expect(pulled.pulled).toEqual([]);
		expect(pulled.rebaselined).toEqual([taskId]);

		staleBacklogSnapshot();
		const before = taskFile();
		const pushed = await push();
		expect(pushed.pushed).toEqual([]);
		expect(pushed.rebaselined).toEqual([taskId]);
		expect(jiraWrites).toEqual([]);
		expect(taskFile()).toBe(before);
	});

	it("treats the same change on both sides as in sync, not a conflict", async () => {
		backlogCli("task", "edit", taskId, "-s", "Done");
		const found = jiraIssues.get("PROJ-1");
		if (found) found.status = "Done";

		const result = await sync();

		expect(result.conflicts).toEqual([]);
		expect(result.rebaselined).toEqual([taskId]);
		expect(jiraWrites).toEqual([]);
		expect((await sync()).skipped).toEqual([taskId]);
	});

	it("still pushes a real one-sided change", async () => {
		backlogCli("task", "edit", taskId, "-t", "Fix logins");

		const result = await sync();

		expect(result.synced).toEqual([taskId]);
		expect(result.rebaselined).toEqual([]);
		expect(jiraIssues.get("PROJ-1")?.summary).toBe("Fix logins");
	});

	it("still writes with push --force", async () => {
		staleBacklogSnapshot();

		const result = await push({ taskIds: [taskId], force: true });

		expect(result.pushed).toEqual([taskId]);
		expect(result.rebaselined).toEqual([]);
	});
});
