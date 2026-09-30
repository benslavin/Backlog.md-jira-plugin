/**
 * End-to-end checks against the installed Backlog.md CLI.
 * Skipped when `backlog` is not on the PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import { readTaskFrontmatter } from "../utils/field-mapping.ts";
import {
	getTaskFilePath,
	parseFrontmatter,
	updateFrontmatterFields,
	updateJiraMetadata,
} from "../utils/frontmatter.ts";
import { BacklogClient } from "./backlog.ts";

const hasBacklogCli =
	spawnSync("backlog", ["--version"], { encoding: "utf-8" }).status === 0;

function backlog(...args: string[]): string {
	const result = spawnSync("backlog", args, { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function fileFrontmatter(taskId: string): Record<string, unknown> {
	return parseFrontmatter(readFileSync(getTaskFilePath(taskId), "utf-8"))
		.frontmatter;
}

describe.skipIf(!hasBacklogCli)("Backlog.md CLI compatibility", () => {
	let testDir: string;
	let originalCwd: string;
	let store: FrontmatterStore;
	const client = new BacklogClient();

	beforeAll(() => {
		testDir = uniqueTestDir("backlog-cli-test");
		originalCwd = process.cwd();
		process.chdir(testDir);
		spawnSync("git", ["init", "-q"]);
		backlog("init", "cli-test", "--defaults");
		mkdirSync(join(testDir, ".backlog-jira"), { recursive: true });
		store = new FrontmatterStore(join(testDir, ".backlog-jira"));
	});

	afterAll(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("creates, reads and lists tasks whatever the ID case", async () => {
		const taskId = await client.createTask({ title: "Hello", ac: ["one"] });
		expect(taskId).toBe("task-1");

		const task = await client.getTask("TASK-1");
		expect(task).toMatchObject({ id: "task-1", title: "Hello" });

		const tasks = await client.listTasks();
		expect(tasks).toContainEqual(
			expect.objectContaining({
				id: "task-1",
				title: "Hello",
				status: "To Do",
			}),
		);
	});

	it("reads a task created without a description as having none", async () => {
		const taskId = await client.createTask({ title: "No description" });
		expect(backlog("task", taskId, "--plain")).toContain(
			"No description provided",
		);
		expect((await client.getTask(taskId)).description).toBeUndefined();
	});

	it("keeps Jira metadata and mapped fields across a user's backlog task edit", () => {
		const filePath = getTaskFilePath("task-1");
		updateJiraMetadata(filePath, {
			jiraKey: "PROJ-1",
			jiraLastSync: "2026-09-28T00:00:00Z",
			jiraSyncState: "InSync",
		});
		updateFrontmatterFields(filePath, { story_points: "5" });

		backlog("task", "edit", "1", "-s", "In Progress");

		// Backlog.md drops the plugin's keys from the file...
		expect(fileFrontmatter("task-1").jira_key).toBeUndefined();
		// ...but the plugin still sees the link and mapped values
		expect(store.getMapping("task-1")?.jiraKey).toBe("PROJ-1");
		expect(store.getAllMappings().get("task-1")).toBe("PROJ-1");
		expect(store.getMappingByJiraKey("PROJ-1")?.backlogId).toBe("task-1");
		expect(store.getSyncState("task-1")?.conflictState).toBe("InSync");
		expect(readTaskFrontmatter("task-1").story_points).toBe("5");
	});

	it("restores plugin frontmatter after its own edits", async () => {
		await client.updateTask("TASK-1", { title: "Hello again" });

		const frontmatter = fileFrontmatter("task-1");
		expect(frontmatter.title).toBe("Hello again");
		expect(frontmatter.jira_key).toBe("PROJ-1");
		expect(frontmatter.jira_sync_state).toBe("InSync");
		expect(frontmatter.story_points).toBe("5");
	});
});
