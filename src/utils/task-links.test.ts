import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import type { BacklogTask } from "../integrations/backlog.ts";
import { FrontmatterStore } from "../state/frontmatter-store.ts";
import { type FieldMapping, readTaskFrontmatter } from "./field-mapping.ts";
import {
	getJiraMetadata,
	parseFrontmatter,
	restorePluginFrontmatter,
	updateFrontmatterFields,
	updateJiraMetadata,
} from "./frontmatter.ts";
import { computeHash, normalizeBacklogTask } from "./normalizer.ts";
import {
	CONFIG_DIR_GITIGNORE,
	getLinksDir,
	normalizeTaskId,
	readTaskLink,
	taskIdFromFilePath,
} from "./task-links.ts";

// Frontmatter as Backlog.md 1.5x writes it after `backlog task edit`:
// only the keys it knows, everything else dropped.
const BACKLOG_FRONTMATTER = `---
id: TASK-1
title: Hello
status: In Progress
assignee: []
created_date: '2026-09-28 20:42'
updated_date: '2026-09-28 20:43'
labels: []
dependencies: []
ordinal: 1000
---

## Description

desc
`;

const storyPoints: FieldMapping = {
	backlog: "frontmatter:story_points",
	jira: "customfield_10016",
	type: "number",
	direction: "pull",
};

describe("task ID helpers", () => {
	it("normalizes upper-case IDs", () => {
		expect(normalizeTaskId("TASK-1")).toBe("task-1");
		expect(normalizeTaskId("task-1.2")).toBe("task-1.2");
	});

	it("extracts task IDs from file names regardless of case", () => {
		expect(taskIdFromFilePath("/x/backlog/tasks/task-12 - Title.md")).toBe(
			"task-12",
		);
		expect(taskIdFromFilePath("TASK-3.1 - Sub.md")).toBe("task-3.1");
		expect(taskIdFromFilePath("task.md")).toBeNull();
	});
});

describe("Jira link metadata across Backlog.md rewrites", () => {
	let testDir: string;
	let originalCwd: string;
	let taskPath: string;

	/** Simulate `backlog task edit`, which drops unknown frontmatter keys */
	function simulateBacklogEdit(): void {
		writeFileSync(taskPath, BACKLOG_FRONTMATTER, "utf-8");
	}

	beforeEach(() => {
		testDir = uniqueTestDir("task-links-test");
		originalCwd = process.cwd();
		mkdirSync(join(testDir, "backlog", "tasks"), { recursive: true });
		mkdirSync(join(testDir, ".backlog-jira"), { recursive: true });
		taskPath = join(testDir, "backlog", "tasks", "task-1 - Hello.md");
		writeFileSync(taskPath, BACKLOG_FRONTMATTER, "utf-8");
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("records Jira metadata outside the task file", () => {
		updateJiraMetadata(taskPath, {
			jiraKey: "PROJ-1",
			jiraUrl: "https://example.atlassian.net/browse/PROJ-1",
			jiraLastSync: "2026-09-28T00:00:00Z",
			jiraSyncState: "InSync",
		});

		expect(readTaskLink("TASK-1")).toEqual({
			jiraKey: "PROJ-1",
			jiraUrl: "https://example.atlassian.net/browse/PROJ-1",
			jiraLastSync: "2026-09-28T00:00:00Z",
			jiraSyncState: "InSync",
		});
		const { frontmatter } = parseFrontmatter(readFileSync(taskPath, "utf-8"));
		expect(frontmatter.jira_key).toBe("PROJ-1");
	});

	it("keeps the task linked after Backlog.md drops the jira_* keys", () => {
		updateJiraMetadata(taskPath, {
			jiraKey: "PROJ-1",
			jiraLastSync: "2026-09-28T00:00:00Z",
			jiraSyncState: "InSync",
		});
		simulateBacklogEdit();

		expect(getJiraMetadata(taskPath)).toMatchObject({
			jiraKey: "PROJ-1",
			jiraLastSync: "2026-09-28T00:00:00Z",
			jiraSyncState: "InSync",
		});

		const store = new FrontmatterStore(join(testDir, ".backlog-jira"));
		expect(store.getMapping("TASK-1")?.jiraKey).toBe("PROJ-1");
		expect(store.getMappingByJiraKey("PROJ-1")?.backlogId).toBe("task-1");
		expect(store.getAllMappings().get("task-1")).toBe("PROJ-1");
		expect(store.getSyncState("task-1")?.conflictState).toBe("InSync");
	});

	it("restores dropped plugin keys into the task file", () => {
		updateJiraMetadata(taskPath, { jiraKey: "PROJ-1" });
		updateFrontmatterFields(taskPath, { story_points: "5" });
		simulateBacklogEdit();

		expect(restorePluginFrontmatter("TASK-1")).toBe(true);
		const content = readFileSync(taskPath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter.jira_key).toBe("PROJ-1");
		expect(frontmatter.story_points).toBe("5");
		expect(frontmatter.updated_date).toBe("2026-09-28 20:43");
		expect(body).toContain("desc");

		// Nothing left to restore
		expect(restorePluginFrontmatter("task-1")).toBe(false);
	});

	it("does not overwrite values edited by hand in the file", () => {
		updateFrontmatterFields(taskPath, { story_points: "5" });
		const edited = readFileSync(taskPath, "utf-8").replace(
			"story_points: 5",
			"story_points: 8",
		);
		writeFileSync(taskPath, edited, "utf-8");

		expect(readTaskFrontmatter("task-1").story_points).toBe("8");
		updateJiraMetadata(taskPath, { jiraKey: "PROJ-1" });
		const { frontmatter } = parseFrontmatter(readFileSync(taskPath, "utf-8"));
		expect(frontmatter.story_points).toBe("8");
	});

	it("serves mapped fields from the link record without a spurious change", () => {
		updateJiraMetadata(taskPath, { jiraKey: "PROJ-1" });
		updateFrontmatterFields(taskPath, {
			story_points: "5",
			components: ["api", "web"],
		});
		const task: BacklogTask = {
			id: "task-1",
			title: "Hello",
			status: "In Progress",
		};
		const before = computeHash(
			normalizeBacklogTask(task, { fieldMappings: [storyPoints] }),
		);

		simulateBacklogEdit();

		expect(readTaskFrontmatter("TASK-1")).toMatchObject({
			story_points: "5",
			components: ["api", "web"],
		});
		const after = computeHash(
			normalizeBacklogTask(task, { fieldMappings: [storyPoints] }),
		);
		expect(after).toBe(before);
	});

	it("removes fields from the link record when cleared", () => {
		updateJiraMetadata(taskPath, { jiraKey: "PROJ-1" });
		updateFrontmatterFields(taskPath, { story_points: "5" });
		updateFrontmatterFields(taskPath, { story_points: null });
		simulateBacklogEdit();

		expect(readTaskFrontmatter("task-1").story_points).toBeUndefined();
		expect(readTaskLink("task-1")?.frontmatter).toBeUndefined();
	});

	it("deletes the link record when the mapping is removed", () => {
		const store = new FrontmatterStore(join(testDir, ".backlog-jira"));
		store.addMapping("task-1", "PROJ-1");
		store.deleteMapping("task-1");
		simulateBacklogEdit();

		expect(store.getMapping("task-1")).toBeNull();
		expect(existsSync(join(getLinksDir(), "task-1.json"))).toBe(false);
	});

	it("migrates metadata that only exists in frontmatter", () => {
		writeFileSync(
			taskPath,
			BACKLOG_FRONTMATTER.replace(
				"ordinal: 1000\n",
				"ordinal: 1000\njira_key: PROJ-9\njira_url: https://x/browse/PROJ-9\n",
			),
			"utf-8",
		);

		updateJiraMetadata(taskPath, { jiraSyncState: "InSync" });

		expect(readTaskLink("task-1")).toEqual({
			jiraKey: "PROJ-9",
			jiraUrl: "https://x/browse/PROJ-9",
			jiraSyncState: "InSync",
		});
	});

	it("re-includes link records in an existing .backlog-jira/.gitignore", () => {
		const gitignorePath = join(testDir, ".backlog-jira", ".gitignore");
		writeFileSync(gitignorePath, "# Ignore all files\n*\n!.gitignore\n");

		updateJiraMetadata(taskPath, { jiraKey: "PROJ-1" });
		updateJiraMetadata(taskPath, { jiraSyncState: "InSync" });

		const content = readFileSync(gitignorePath, "utf-8");
		expect(content).toBe(
			"# Ignore all files\n*\n!.gitignore\n!links/\n!links/*.json\n",
		);
		expect(CONFIG_DIR_GITIGNORE).toContain("!links/*.json");
	});
});
