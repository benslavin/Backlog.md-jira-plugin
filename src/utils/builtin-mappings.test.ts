import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { addFieldMapping } from "../commands/map-fields.ts";
import { buildBacklogUpdates } from "../commands/pull.ts";
import type { BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	DEFAULT_PRIORITY_MAPPING,
	type FieldMapping,
	FieldMappingConfigError,
	loadFieldMappings,
	loadPriorityMapping,
	resolvePriorityMapping,
	validateFieldMappings,
} from "./field-mapping.ts";
import { getOverriddenCoreFields } from "./mapped-field-sync.ts";
import {
	comparePayloads,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "./normalizer.ts";
import {
	type BacklogPriority,
	mapBacklogPriorityToJira,
	mapJiraPriorityToBacklog,
} from "./priority-mapping.ts";
import { buildStatusMapping } from "./status-mapping.ts";

const priorityOverride = {
	backlog: "priority",
	jira: "priority",
	type: "option",
	valueMap: { P1: "high", P2: "medium", P3: "low", Major: "high" },
};

const task: BacklogTask = {
	id: "task-1",
	title: "Test Task",
	description: "Description",
	status: "To Do",
	priority: "medium",
	labels: [],
	acceptanceCriteria: [],
};

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Test Task",
		description: "Description",
		status: "To Do",
		issueType: "Task",
		priority: "Medium",
		labels: [],
		created: "",
		updated: "",
		...overrides,
	};
}

describe("default priority mapping", () => {
	const defaults = resolvePriorityMapping([]);

	it("maps every legacy Jira priority as before", () => {
		const expected: Record<string, BacklogPriority> = {
			Highest: "high",
			High: "high",
			Medium: "medium",
			Low: "low",
			Lowest: "low",
			Critical: "high",
			Blocker: "high",
			Major: "medium",
			Minor: "low",
			Trivial: "low",
		};
		for (const [jira, backlog] of Object.entries(expected)) {
			expect(mapJiraPriorityToBacklog(jira, defaults)).toBe(backlog);
			expect(mapJiraPriorityToBacklog(jira.toUpperCase(), defaults)).toBe(
				backlog,
			);
		}
		expect(mapJiraPriorityToBacklog("P1", defaults)).toBe("medium");
		expect(mapJiraPriorityToBacklog(undefined, defaults)).toBeUndefined();
	});

	it("pushes High, Medium and Low, defaulting to Medium", () => {
		expect(mapBacklogPriorityToJira("high", defaults)).toBe("High");
		expect(mapBacklogPriorityToJira(" MEDIUM ", defaults)).toBe("Medium");
		expect(mapBacklogPriorityToJira("low", defaults)).toBe("Low");
		expect(mapBacklogPriorityToJira("critical", defaults)).toBe("Medium");
		expect(mapBacklogPriorityToJira(undefined, defaults)).toBeUndefined();
	});

	it("is a both-way option mapping on the Jira system priority field", () => {
		expect(defaults).toMatchObject({
			backlog: "priority",
			jira: "priority",
			type: "option",
			direction: "both",
		});
		expect(defaults.valueMap).toEqual(
			DEFAULT_PRIORITY_MAPPING.valueMap as Record<string, string>,
		);
	});
});

describe("overridden priority valueMap", () => {
	const { mappings, errors } = validateFieldMappings([priorityOverride]);
	const mapping = resolvePriorityMapping(mappings);

	it("accepts the override and defaults its direction to both", () => {
		expect(errors).toEqual([]);
		expect(mappings[0].direction).toBe("both");
	});

	it("uses configured values first and keeps the defaults for the rest", () => {
		expect(mapJiraPriorityToBacklog("P1", mapping)).toBe("high");
		expect(mapJiraPriorityToBacklog("p3", mapping)).toBe("low");
		// Configured entry replaces the default Major → medium
		expect(mapJiraPriorityToBacklog("Major", mapping)).toBe("high");
		expect(mapJiraPriorityToBacklog("Highest", mapping)).toBe("high");
		expect(mapJiraPriorityToBacklog("Unknown", mapping)).toBe("medium");
	});

	it("pushes the first configured Jira value for each Backlog priority", () => {
		expect(mapBacklogPriorityToJira("high", mapping)).toBe("P1");
		expect(mapBacklogPriorityToJira("medium", mapping)).toBe("P2");
		expect(mapBacklogPriorityToJira("low", mapping)).toBe("P3");
		expect(mapBacklogPriorityToJira("urgent", mapping)).toBe("P2");
	});

	it("is kept out of the generic mapping engine", () => {
		expect(getOverriddenCoreFields(mappings).has("priority")).toBe(false);
	});

	it("rejects invalid overrides", () => {
		const invalid = validateFieldMappings([
			{ ...priorityOverride, type: "string", direction: "pull" },
		]);
		expect(invalid.mappings).toEqual([]);
		expect(invalid.errors.join("\n")).toContain('"type": "option"');
		expect(invalid.errors.join("\n")).toContain("both ways");

		const badValue = validateFieldMappings([
			{ ...priorityOverride, valueMap: { P0: "urgent" } },
		]);
		expect(badValue.errors[0]).toContain("not a Backlog priority");
	});

	it("still treats priority mapped to another Jira field as a replacement", () => {
		const custom: FieldMapping = {
			backlog: "priority",
			jira: "customfield_10050",
			type: "option",
			direction: "pull",
		};
		expect(getOverriddenCoreFields([custom]).has("priority")).toBe(true);
		expect(resolvePriorityMapping([custom]).valueMap).toEqual(
			DEFAULT_PRIORITY_MAPPING.valueMap as Record<string, string>,
		);
	});

	it("is added by map-fields with direction both", () => {
		const config = addFieldMapping(
			{},
			{ backlog: "priority", jira: "priority", type: "option" },
		);
		expect(config.fieldMappings).toEqual([
			{
				backlog: "priority",
				jira: "priority",
				type: "option",
				direction: "both",
			},
		]);
	});
});

describe("priority mapping from config.json", () => {
	let testDir: string;
	let originalCwd: string;

	beforeEach(() => {
		testDir = uniqueTestDir("builtin-mappings-test");
		originalCwd = process.cwd();
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	const configPath = () => join(testDir, ".backlog-jira", "config.json");

	it("uses the defaults for configs without fieldMappings", () => {
		writeJson(configPath(), { jira: { projectKey: "PROJ" } });
		expect(loadPriorityMapping().valueMap).toEqual(
			DEFAULT_PRIORITY_MAPPING.valueMap as Record<string, string>,
		);
		expect(loadFieldMappings()).toEqual([]);
		expect(mapJiraPriorityToBacklog("Blocker")).toBe("high");
		expect(mapBacklogPriorityToJira("low")).toBe("Low");
	});

	it("applies an overridden valueMap on pull and push", () => {
		writeJson(configPath(), { fieldMappings: [priorityOverride] });
		expect(loadFieldMappings()).toEqual([]);
		expect(mapBacklogPriorityToJira("high")).toBe("P1");

		const updates = buildBacklogUpdates(
			makeIssue({ priority: "P1" }),
			task,
			"PROJ",
			loadFieldMappings(),
		);
		expect(updates.priority).toBe("high");
	});

	it("reports an invalid override as a config error", () => {
		writeJson(configPath(), {
			fieldMappings: [{ ...priorityOverride, direction: "push" }],
		});
		expect(() => loadPriorityMapping()).toThrow(FieldMappingConfigError);
		expect(() => loadFieldMappings()).toThrow(FieldMappingConfigError);
	});
});

describe("configured status normalization", () => {
	const statusMapping = buildStatusMapping(
		{
			"To Do": ["Open", "Triage"],
			"In Progress": ["Doing", "Code Review"],
			Done: ["Shipped"],
		},
		{
			OPS: {
				backlogToJira: { Done: ["Deployed"] },
				jiraToBacklog: { Deployed: "Done" },
			},
		},
	);
	const normalizeJira = (status: string, key = "PROJ-1") =>
		normalizeJiraIssue(makeIssue({ status, key }), {
			fieldMappings: [],
			statusMapping,
		}).status;
	const normalizeBacklog = (status: string) =>
		normalizeBacklogTask({ ...task, status }, { fieldMappings: [] }).status;

	it("resolves Jira statuses through the configured mapping", () => {
		expect(normalizeJira("Triage")).toBe(normalizeBacklog("To Do"));
		expect(normalizeJira("code review")).toBe(normalizeBacklog("In Progress"));
		expect(normalizeJira("Shipped")).toBe(normalizeBacklog("Done"));
		expect(normalizeJira("Deployed", "OPS-7")).toBe(normalizeBacklog("Done"));
	});

	it("no longer applies the old hard-coded equivalences", () => {
		// "Closed" is not in this config, so it does not equal Done
		expect(normalizeJira("Closed")).not.toBe(normalizeBacklog("Done"));
		expect(
			comparePayloads(
				normalizeBacklogTask(
					{ ...task, status: "Done" },
					{ fieldMappings: [] },
				),
				normalizeJiraIssue(makeIssue({ status: "Closed" }), {
					fieldMappings: [],
					statusMapping,
				}),
			),
		).toContain("status");
	});

	it("keeps the canonical tokens used by earlier hashes", () => {
		const defaults = buildStatusMapping({
			"To Do": ["To Do", "Open", "Backlog"],
			"In Progress": ["In Progress"],
			Done: ["Done", "Closed", "Resolved"],
		});
		const jira = (status: string) =>
			normalizeJiraIssue(makeIssue({ status }), {
				fieldMappings: [],
				statusMapping: defaults,
			}).status;
		expect(jira("Open")).toBe("todo");
		expect(jira("In Progress")).toBe("in_progress");
		expect(jira("Resolved")).toBe("done");
		expect(normalizeBacklog("To Do")).toBe("todo");
		expect(normalizeBacklog("In Progress")).toBe("in_progress");
		expect(normalizeBacklog("Blocked")).toBe("blocked");

		const backlogPayload = normalizeBacklogTask(task, { fieldMappings: [] });
		const jiraPayload = normalizeJiraIssue(makeIssue({ status: "Backlog" }), {
			fieldMappings: [],
			statusMapping: defaults,
		});
		expect(backlogPayload.status).toBe(jiraPayload.status);
	});
});
