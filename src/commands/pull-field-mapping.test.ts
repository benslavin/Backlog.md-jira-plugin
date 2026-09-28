import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { BacklogClient, type BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import type { Snapshot } from "../state/types.ts";
import {
	type FieldMapping,
	buildMappedFieldUpdates,
	readTaskFrontmatter,
} from "../utils/field-mapping.ts";
import {
	getTaskFilePath,
	parseFrontmatter,
	updateFrontmatterFields,
} from "../utils/frontmatter.ts";
import {
	type NormalizedPayload,
	comparePayloads,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "../utils/normalizer.ts";
import { classifySyncState } from "../utils/sync-state.ts";
import { buildBacklogUpdates } from "./pull.ts";

const task: BacklogTask = {
	id: "task-1",
	title: "Test Task",
	description: "Description",
	status: "To Do",
	priority: "medium",
	labels: ["backend"],
	acceptanceCriteria: [],
};

function makeIssue(fields: Record<string, unknown> = {}): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Test Task",
		description: "Description",
		status: "To Do",
		issueType: "Task",
		priority: "Medium",
		labels: ["backend"],
		created: "",
		updated: "",
		fields: { key: "PROJ-1", id: "10001", ...fields },
	};
}

const storyPoints: FieldMapping = {
	backlog: "frontmatter:story_points",
	jira: "customfield_10016",
	type: "number",
	direction: "pull",
};

const milestone: FieldMapping = {
	backlog: "milestone",
	jira: "fixVersions",
	type: "version",
	direction: "pull",
};

function snapshot(
	side: "backlog" | "jira",
	payload: NormalizedPayload,
	hash = computeHash(payload),
): Snapshot {
	return {
		backlogId: "task-1",
		side,
		hash,
		payload: JSON.stringify(payload),
		updatedAt: new Date().toISOString(),
	};
}

describe("hash stability", () => {
	it("hashes payloads without mapped fields exactly as before fieldMappings existed", () => {
		const payload = normalizeBacklogTask(task, { fieldMappings: [] });
		expect(payload.mappedFields).toBeUndefined();

		// The pre-fieldMappings hash algorithm
		const legacy = crypto
			.createHash("sha256")
			.update(
				JSON.stringify({
					acceptanceCriteria: payload.acceptanceCriteria,
					assignee: payload.assignee || "",
					description: payload.description,
					labels: payload.labels,
					priority: payload.priority || "",
					status: payload.status,
					title: payload.title,
				}),
			)
			.digest("hex");

		expect(computeHash(payload)).toBe(legacy);
		expect(computeHash({ ...payload, mappedFields: {} })).toBe(legacy);
	});

	it("includes mapped fields in the hash when mappings apply", () => {
		const withMapping = normalizeBacklogTask(task, {
			fieldMappings: [storyPoints],
			frontmatter: { story_points: "5" },
		});
		expect(withMapping.mappedFields).toEqual({
			"frontmatter:story_points": "5",
		});
		expect(computeHash(withMapping)).not.toBe(
			computeHash(normalizeBacklogTask(task, { fieldMappings: [] })),
		);
	});

	it("includes push-only mappings so both sides hash alike when in sync", () => {
		const payload = normalizeJiraIssue(makeIssue({ customfield_10016: 3 }), {
			fieldMappings: [{ ...storyPoints, direction: "push" }],
		});
		expect(payload.mappedFields).toEqual({ "frontmatter:story_points": "3" });
	});

	it("normalizes both sides to the same mapped representation", () => {
		const issue = makeIssue({
			customfield_10016: 5,
			fixVersions: [{ name: "1.0" }],
		});
		const fieldMappings = [storyPoints, milestone];
		const jira = normalizeJiraIssue(issue, { fieldMappings });
		const backlog = normalizeBacklogTask(task, {
			fieldMappings,
			frontmatter: { story_points: "5", milestone: "1.0" },
		});

		expect(jira.mappedFields).toEqual(backlog.mappedFields);
		expect(computeHash(jira)).toBe(computeHash(backlog));
		expect(comparePayloads(jira, backlog)).toEqual([]);
		expect(
			comparePayloads(jira, {
				...backlog,
				mappedFields: { ...backlog.mappedFields, milestone: "" },
			}),
		).toEqual(["milestone"]);
	});

	it("uses mapped priority/labels as the Jira source of the core fields", () => {
		const payload = normalizeJiraIssue(
			makeIssue({
				customfield_1: { value: "P1" },
				components: [{ name: "API" }],
			}),
			{
				fieldMappings: [
					{
						backlog: "priority",
						jira: "customfield_1",
						type: "option",
						direction: "pull",
						valueMap: { P1: "High" },
					},
					{
						backlog: "labels",
						jira: "components",
						type: "array",
						direction: "pull",
					},
				],
			},
		);
		expect(payload.priority).toBe("high");
		expect(payload.labels).toEqual(["api"]);
		expect(payload.mappedFields).toBeUndefined();
	});
});

describe("classifySyncState across mapping changes", () => {
	const issue = makeIssue({ customfield_10016: 5 });

	// Snapshots written before any fieldMappings existed
	const oldBacklog = normalizeBacklogTask(task, { fieldMappings: [] });
	const oldJira = normalizeJiraIssue(issue, { fieldMappings: [] });
	const oldSnapshots = {
		backlog: snapshot("backlog", oldBacklog),
		jira: snapshot("jira", oldJira, computeHash(oldBacklog)),
	};

	function classify(
		backlog: NormalizedPayload,
		jira: NormalizedPayload,
		snapshots = oldSnapshots,
	) {
		return classifySyncState(
			computeHash(backlog),
			computeHash(jira),
			snapshots.backlog,
			snapshots.jira,
			{ backlog, jira },
		).state;
	}

	it("is InSync when nothing changed and no mappings exist", () => {
		expect(classify(oldBacklog, oldJira)).toBe("InSync");
	});

	it("adding a mapping yields NeedsPull, not a both-sides Conflict", () => {
		const backlog = normalizeBacklogTask(task, {
			fieldMappings: [storyPoints],
			frontmatter: {},
		});
		const jira = normalizeJiraIssue(issue, { fieldMappings: [storyPoints] });

		// Without mapping-change awareness both hashes differ from the snapshots
		expect(
			classifySyncState(
				computeHash(backlog),
				computeHash(jira),
				oldSnapshots.backlog,
				oldSnapshots.jira,
			).state,
		).toBe("Conflict");

		expect(classify(backlog, jira)).toBe("NeedsPull");
	});

	it("adding a mapping whose values already match stays InSync", () => {
		const backlog = normalizeBacklogTask(task, {
			fieldMappings: [storyPoints],
			frontmatter: { story_points: "5" },
		});
		const jira = normalizeJiraIssue(issue, { fieldMappings: [storyPoints] });
		expect(classify(backlog, jira)).toBe("InSync");
	});

	it("still reports real Backlog changes alongside a new mapping", () => {
		const backlog = normalizeBacklogTask(
			{ ...task, title: "Renamed locally" },
			{ fieldMappings: [storyPoints], frontmatter: { story_points: "5" } },
		);
		const jira = normalizeJiraIssue(issue, { fieldMappings: [storyPoints] });
		expect(classify(backlog, jira)).toBe("NeedsPush");
	});

	it("removing a mapping does not register as a change", () => {
		const mappedBacklog = normalizeBacklogTask(task, {
			fieldMappings: [storyPoints],
			frontmatter: { story_points: "5" },
		});
		const mappedJira = normalizeJiraIssue(issue, {
			fieldMappings: [storyPoints],
		});
		const snapshots = {
			backlog: snapshot("backlog", mappedBacklog),
			jira: snapshot("jira", mappedJira),
		};
		expect(classify(oldBacklog, oldJira, snapshots)).toBe("InSync");
	});

	it("detects Jira changes to mapped fields once mappings are in the snapshot", () => {
		const backlog = normalizeBacklogTask(task, {
			fieldMappings: [storyPoints],
			frontmatter: { story_points: "5" },
		});
		const jira = normalizeJiraIssue(issue, { fieldMappings: [storyPoints] });
		const snapshots = {
			backlog: snapshot("backlog", backlog),
			jira: snapshot("jira", jira),
		};
		const changedJira = normalizeJiraIssue(
			makeIssue({ customfield_10016: 8 }),
			{ fieldMappings: [storyPoints] },
		);
		expect(classify(backlog, changedJira, snapshots)).toBe("NeedsPull");
	});
});

describe("buildBacklogUpdates with field mappings", () => {
	it("leaves core labels/priority to mappings that target them", () => {
		const issue = makeIssue({ customfield_1: { value: "P1" } });
		issue.priority = "Highest";
		issue.labels = ["jira-label"];

		const fieldMappings: FieldMapping[] = [
			{
				backlog: "priority",
				jira: "customfield_1",
				type: "option",
				direction: "pull",
				valueMap: { P1: "low" },
			},
			{
				backlog: "labels",
				jira: "components",
				type: "array",
				direction: "pull",
			},
		];

		const without = buildBacklogUpdates(issue, task, "PROJ");
		expect(without.priority).toBe("high");
		expect(without.labels).toEqual(["jira-label"]);

		const withMappings = buildBacklogUpdates(
			issue,
			task,
			"PROJ",
			fieldMappings,
		);
		expect(withMappings.priority).toBeUndefined();
		expect(withMappings.labels).toBeUndefined();
	});
});

describe("BacklogClient.updateTask for native mapped fields", () => {
	function captureArgs(updates: Parameters<BacklogClient["updateTask"]>[1]) {
		const client = new BacklogClient();
		const execute = mock((_args: string[]) => Promise.resolve(""));
		(client as unknown as { execute: typeof execute }).execute = execute;
		return client.updateTask("task-1", updates).then(() => {
			return execute.mock.calls[0][0];
		});
	}

	it("passes milestone, dependencies and references to the Backlog CLI", async () => {
		const args = await captureArgs({
			milestone: "1.0",
			dependencies: ["TASK-2", "TASK-3"],
			references: ["https://a", "https://b"],
		});
		expect(args).toEqual([
			"task",
			"edit",
			"task-1",
			"--milestone",
			"1.0",
			"--dep",
			"TASK-2,TASK-3",
			"--ref",
			"https://a",
			"--ref",
			"https://b",
		]);
	});

	it("clears native fields that are empty in Jira", async () => {
		const args = await captureArgs({
			clearMilestone: true,
			clearDependencies: true,
			clearReferences: true,
			clearLabels: true,
		});
		expect(args).toEqual([
			"task",
			"edit",
			"task-1",
			"--clear-labels",
			"--clear-milestone",
			"--clear-deps",
			"--clear-refs",
		]);
	});
});

describe("pull application of mapped fields", () => {
	let testDir: string;
	let originalCwd: string;

	const fieldMappings: FieldMapping[] = [
		storyPoints,
		{
			backlog: "frontmatter:components",
			jira: "components",
			type: "array",
			direction: "pull",
		},
		milestone,
	];

	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("pull-field-mapping-test");
		mkdirSync(join(testDir, "backlog", "tasks"), { recursive: true });
		writeFileSync(
			join(testDir, "backlog", "tasks", "task-1 - Test-Task.md"),
			`---
id: TASK-1
title: Test Task
status: To Do
labels:
  - backend
milestone: '1.0'
jira_key: PROJ-1
---

## Description
`,
		);
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			fieldMappings,
		});
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("writes frontmatter targets, leaves core and jira_* keys intact, and converges hashes", () => {
		const issue = makeIssue({
			customfield_10016: 3,
			components: [{ name: "API" }, { name: "UI" }],
			fixVersions: [{ name: "1.0" }],
		});

		const updates = buildMappedFieldUpdates(
			issue,
			readTaskFrontmatter("TASK-1"),
			fieldMappings,
		);
		// milestone already matches, so only frontmatter targets change
		expect(updates.cli).toEqual({});
		expect(updates.frontmatter).toEqual({
			story_points: "3",
			components: ["API", "UI"],
		});

		updateFrontmatterFields(getTaskFilePath("TASK-1"), updates.frontmatter);

		const { frontmatter } = parseFrontmatter(
			readFileSync(getTaskFilePath("TASK-1"), "utf-8"),
		);
		expect(frontmatter.story_points).toBe("3");
		expect(frontmatter.components).toEqual(["API", "UI"]);
		expect(frontmatter.labels).toEqual(["backend"]);
		expect(frontmatter.jira_key).toBe("PROJ-1");

		// Mappings are loaded from config.json when not passed explicitly
		const backlogPayload = normalizeBacklogTask({ ...task, id: "TASK-1" });
		const jiraPayload = normalizeJiraIssue(issue);
		expect(backlogPayload.mappedFields).toEqual(jiraPayload.mappedFields);
		expect(computeHash(backlogPayload)).toBe(computeHash(jiraPayload));

		// A second pull has nothing to do
		expect(
			buildMappedFieldUpdates(
				issue,
				readTaskFrontmatter("TASK-1"),
				fieldMappings,
			),
		).toEqual({ cli: {}, frontmatter: {} });
	});

	it("reports invalid config when normalizing", () => {
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			fieldMappings: [
				{
					backlog: "frontmatter:status",
					jira: "customfield_1",
					type: "string",
				},
			],
		});
		expect(() => normalizeJiraIssue(makeIssue())).toThrow(
			/collides with the Backlog core field "status"/,
		);
	});
});
