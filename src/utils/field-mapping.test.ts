import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	type FieldMapping,
	FieldMappingConfigError,
	buildMappedFieldUpdates,
	coerceForTarget,
	convertJiraValue,
	getIssueFieldsParam,
	getJiraFieldValue,
	getMappedJiraValue,
	loadFieldMappings,
	suggestTypeForSchema,
	validateFieldMappings,
} from "./field-mapping.ts";

function makeIssue(fields: Record<string, unknown>): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Issue",
		status: "To Do",
		issueType: "Task",
		created: "",
		updated: "",
		fields: { key: "PROJ-1", id: "10001", ...fields },
	};
}

function mapping(overrides: Partial<FieldMapping>): FieldMapping {
	return {
		backlog: "frontmatter:value",
		jira: "customfield_10001",
		type: "string",
		direction: "pull",
		...overrides,
	};
}

describe("validateFieldMappings", () => {
	it("returns no mappings and no errors when fieldMappings is absent", () => {
		expect(validateFieldMappings(undefined)).toEqual({
			mappings: [],
			errors: [],
		});
	});

	it("accepts valid entries and defaults direction to pull", () => {
		const { mappings, errors } = validateFieldMappings([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
			},
			{
				backlog: "milestone",
				jira: "fixVersions",
				type: "version",
				direction: "both",
			},
			{
				backlog: "priority",
				jira: "customfield_10020",
				type: "option",
				valueMap: { P1: "high" },
			},
		]);

		expect(errors).toEqual([]);
		expect(mappings).toEqual([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "pull",
			},
			{
				backlog: "milestone",
				jira: "fixVersions",
				type: "version",
				direction: "both",
			},
			{
				backlog: "priority",
				jira: "customfield_10020",
				type: "option",
				direction: "pull",
				valueMap: { P1: "high" },
			},
		]);
	});

	it("rejects a non-array value", () => {
		expect(validateFieldMappings({}).errors).toEqual([
			"fieldMappings must be an array",
		]);
	});

	it("reports missing and invalid properties with the entry index", () => {
		const { mappings, errors } = validateFieldMappings([
			"nope",
			{ jira: "customfield_1", type: "string" },
			{ backlog: "milestone", jira: "not a field!", type: "string" },
			{ backlog: "milestone", jira: "customfield_1", type: "boolean" },
			{
				backlog: "milestone",
				jira: "customfield_1",
				type: "string",
				direction: "sideways",
			},
			{
				backlog: "milestone",
				jira: "customfield_1",
				type: "string",
				valueMap: { a: 1 },
			},
		]);

		expect(mappings).toEqual([]);
		expect(errors).toEqual([
			"fieldMappings[0]: must be an object",
			'fieldMappings[1]: "backlog" is required',
			'fieldMappings[2]: "not a field!" is not a valid Jira field ID (use customfield_NNNNN or a system field name)',
			expect.stringContaining('fieldMappings[3]: "type" must be one of'),
			expect.stringContaining('fieldMappings[4]: "direction" must be one of'),
			'fieldMappings[5]: "valueMap" must be an object of string values',
		]);
	});

	it("rejects unknown native targets", () => {
		const { errors } = validateFieldMappings([
			{ backlog: "title", jira: "customfield_1", type: "string" },
		]);
		expect(errors[0]).toContain('unknown backlog target "title"');
	});

	it("rejects frontmatter keys that collide with Backlog core keys", () => {
		for (const key of ["status", "labels", "milestone", "created_date", "id"]) {
			const { errors } = validateFieldMappings([
				{
					backlog: `frontmatter:${key}`,
					jira: "customfield_1",
					type: "string",
				},
			]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("collides with the Backlog core field");
		}
	});

	it("rejects frontmatter keys that collide with plugin jira_* keys", () => {
		for (const key of ["jira_key", "jira_sync_state", "JIRA_custom"]) {
			const { errors } = validateFieldMappings([
				{
					backlog: `frontmatter:${key}`,
					jira: "customfield_1",
					type: "string",
				},
			]);
			expect(errors).toEqual([
				`fieldMappings[0]: "frontmatter:${key}" collides with plugin-owned jira_* metadata keys`,
			]);
		}
	});

	it("rejects malformed frontmatter keys", () => {
		const { errors } = validateFieldMappings([
			{ backlog: "frontmatter:", jira: "customfield_1", type: "string" },
			{ backlog: "frontmatter:a b", jira: "customfield_1", type: "string" },
		]);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("is not a valid frontmatter key");
	});

	it("rejects mapping the same backlog target twice", () => {
		const { mappings, errors } = validateFieldMappings([
			{ backlog: "milestone", jira: "customfield_1", type: "string" },
			{ backlog: "milestone", jira: "customfield_2", type: "string" },
		]);
		expect(mappings).toHaveLength(1);
		expect(errors).toEqual([
			'fieldMappings[1]: backlog target "milestone" is mapped more than once',
		]);
	});
});

describe("loadFieldMappings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = uniqueTestDir("field-mapping-test");
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("returns [] when there is no config", () => {
		expect(loadFieldMappings(testDir)).toEqual([]);
	});

	it("loads valid mappings", () => {
		writeJson(`${testDir}/.backlog-jira/config.json`, {
			fieldMappings: [
				{ backlog: "frontmatter:team", jira: "customfield_1", type: "option" },
			],
		});
		expect(loadFieldMappings(testDir)).toHaveLength(1);
	});

	it("throws a clear error listing every invalid entry", () => {
		writeJson(`${testDir}/.backlog-jira/config.json`, {
			fieldMappings: [
				{ backlog: "frontmatter:jira_key", jira: "customfield_1", type: "x" },
			],
		});

		let error: unknown;
		try {
			loadFieldMappings(testDir);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(FieldMappingConfigError);
		const message = (error as Error).message;
		expect(message).toContain(
			"Invalid fieldMappings in .backlog-jira/config.json",
		);
		expect(message).toContain("jira_* metadata keys");
		expect(message).toContain('"type" must be one of');
	});
});

describe("getJiraFieldValue", () => {
	it("reads top-level, nested and snake_cased fields", () => {
		expect(
			getJiraFieldValue(makeIssue({ customfield_1: 5 }), "customfield_1"),
		).toBe(5);
		expect(
			getJiraFieldValue(
				makeIssue({ fields: { customfield_2: "x" } }),
				"customfield_2",
			),
		).toBe("x");
		expect(
			getJiraFieldValue(
				makeIssue({ fix_versions: [{ name: "1.0" }] }),
				"fixVersions",
			),
		).toEqual([{ name: "1.0" }]);
		expect(getJiraFieldValue(makeIssue({}), "customfield_3")).toBeUndefined();
	});
});

describe("type adapters (convertJiraValue)", () => {
	it("string: trims text and unwraps MCP value wrappers", () => {
		expect(convertJiraValue("  Core  ", { type: "string" })).toBe("Core");
		expect(convertJiraValue({ value: "Core" }, { type: "string" })).toBe(
			"Core",
		);
		expect(convertJiraValue("", { type: "string" })).toBeNull();
		expect(convertJiraValue(null, { type: "string" })).toBeNull();
	});

	it("number: canonicalizes numeric values", () => {
		expect(convertJiraValue(5, { type: "number" })).toBe("5");
		expect(convertJiraValue(2.5, { type: "number" })).toBe("2.5");
		expect(convertJiraValue("8.0", { type: "number" })).toBe("8");
		expect(convertJiraValue({ value: 3 }, { type: "number" })).toBe("3");
		expect(convertJiraValue("abc", { type: "number" })).toBeNull();
		expect(convertJiraValue(null, { type: "number" })).toBeNull();
	});

	it("date: keeps the calendar date", () => {
		expect(convertJiraValue("2026-09-28", { type: "date" })).toBe("2026-09-28");
		expect(
			convertJiraValue("2026-09-28T10:15:00.000+0000", { type: "date" }),
		).toBe("2026-09-28");
		expect(convertJiraValue("next week", { type: "date" })).toBeNull();
	});

	it("option: extracts the option value", () => {
		expect(
			convertJiraValue({ value: "Red", id: "10100" }, { type: "option" }),
		).toBe("Red");
		expect(convertJiraValue("Red", { type: "option" })).toBe("Red");
	});

	it("multi-option: extracts all option values", () => {
		expect(
			convertJiraValue([{ value: "iOS" }, { value: "Android" }], {
				type: "multi-option",
			}),
		).toEqual(["iOS", "Android"]);
		expect(convertJiraValue([], { type: "multi-option" })).toBeNull();
		expect(
			convertJiraValue({ value: [{ value: "Web" }] }, { type: "multi-option" }),
		).toEqual(["Web"]);
	});

	it("user: uses the display name and falls back to the Jira identifier", () => {
		expect(
			convertJiraValue(
				{ displayName: "Jane Doe", accountId: "abc" },
				{ type: "user" },
			),
		).toBe("Jane Doe");
		expect(
			convertJiraValue({ display_name: "Jane Doe" }, { type: "user" }),
		).toBe("Jane Doe");
		expect(convertJiraValue(null, { type: "user" })).toBeNull();
	});

	it("version: extracts version names (single or list)", () => {
		expect(
			convertJiraValue({ name: "1.2.0", id: "1" }, { type: "version" }),
		).toBe("1.2.0");
		expect(
			convertJiraValue([{ name: "1.2.0" }, { name: "1.3.0" }], {
				type: "version",
			}),
		).toEqual(["1.2.0", "1.3.0"]);
	});

	it("array: accepts string lists, object lists and comma-separated text", () => {
		expect(convertJiraValue(["a", "b"], { type: "array" })).toEqual(["a", "b"]);
		expect(
			convertJiraValue([{ name: "API" }, { name: "UI" }], { type: "array" }),
		).toEqual(["API", "UI"]);
		expect(convertJiraValue("a, b", { type: "array" })).toEqual(["a", "b"]);
		expect(convertJiraValue(null, { type: "array" })).toBeNull();
	});

	it("applies valueMap to scalars and lists (case-insensitive fallback)", () => {
		const valueMap = { Highest: "high", Low: "low" };
		expect(
			convertJiraValue({ value: "Highest" }, { type: "option", valueMap }),
		).toBe("high");
		expect(convertJiraValue("highest", { type: "string", valueMap })).toBe(
			"high",
		);
		expect(
			convertJiraValue(["Low", "Other"], { type: "array", valueMap }),
		).toEqual(["low", "Other"]);
	});
});

describe("user adapter with assignee mapping", () => {
	let testDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("field-mapping-user-test");
		writeJson(`${testDir}/.backlog-jira/config.json`, {
			backlog: { assigneeMapping: { jane: "Jane Doe" } },
		});
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("maps Jira users to Backlog assignees via the assignee mapping", () => {
		expect(
			convertJiraValue({ displayName: "Jane Doe" }, { type: "user" }),
		).toBe("@jane");
		expect(convertJiraValue({ displayName: "Unknown" }, { type: "user" })).toBe(
			"Unknown",
		);
	});
});

describe("coerceForTarget", () => {
	it("wraps scalars for list targets and joins lists for scalar targets", () => {
		expect(coerceForTarget("TASK-1", "dependencies")).toEqual(["TASK-1"]);
		expect(coerceForTarget(["1.0", "1.1"], "milestone")).toBe("1.0, 1.1");
		expect(coerceForTarget(["a"], "frontmatter:tags")).toEqual(["a"]);
		expect(coerceForTarget(null, "labels")).toBeNull();
	});

	it("is applied when reading mapped Jira values", () => {
		const issue = makeIssue({ fixVersions: [{ name: "2.0" }] });
		expect(
			getMappedJiraValue(
				issue,
				mapping({ backlog: "milestone", jira: "fixVersions", type: "version" }),
			),
		).toBe("2.0");
	});
});

describe("buildMappedFieldUpdates", () => {
	const issue = makeIssue({
		customfield_10016: 5,
		customfield_10020: { value: "Platform" },
		fixVersions: [{ name: "1.0" }],
		customfield_10030: ["TASK-2", "TASK-3"],
		customfield_10040: "https://example.com/spec",
		customfield_10050: { value: "Highest" },
		components: [{ name: "API" }],
	});

	const mappings: FieldMapping[] = [
		mapping({
			backlog: "frontmatter:story_points",
			jira: "customfield_10016",
			type: "number",
		}),
		mapping({
			backlog: "frontmatter:team",
			jira: "customfield_10020",
			type: "option",
		}),
		mapping({ backlog: "milestone", jira: "fixVersions", type: "version" }),
		mapping({
			backlog: "dependencies",
			jira: "customfield_10030",
			type: "array",
		}),
		mapping({
			backlog: "references",
			jira: "customfield_10040",
			type: "string",
		}),
		mapping({
			backlog: "priority",
			jira: "customfield_10050",
			type: "option",
			valueMap: { Highest: "High" },
		}),
		mapping({ backlog: "labels", jira: "components", type: "array" }),
	];

	it("writes native targets via CLI updates and frontmatter targets separately", () => {
		const updates = buildMappedFieldUpdates(issue, {}, mappings);

		expect(updates.cli).toEqual({
			milestone: "1.0",
			dependencies: ["TASK-2", "TASK-3"],
			references: ["https://example.com/spec"],
			priority: "high",
			labels: ["API"],
		});
		expect(updates.frontmatter).toEqual({
			story_points: "5",
			team: "Platform",
		});
	});

	it("produces no updates when Backlog already matches Jira", () => {
		const updates = buildMappedFieldUpdates(
			issue,
			{
				story_points: "5",
				team: "Platform",
				milestone: "1.0",
				dependencies: ["TASK-3", "TASK-2"],
				references: ["https://example.com/spec"],
				priority: "high",
				labels: ["API"],
			},
			mappings,
		);
		expect(updates).toEqual({ cli: {}, frontmatter: {} });
	});

	it("clears Backlog values that are empty in Jira", () => {
		const updates = buildMappedFieldUpdates(
			makeIssue({}),
			{
				story_points: "5",
				milestone: "1.0",
				dependencies: ["TASK-2"],
				references: ["x"],
				labels: ["a"],
				priority: "high",
			},
			mappings,
		);
		expect(updates.cli).toEqual({
			clearMilestone: true,
			clearDependencies: true,
			clearReferences: true,
			clearLabels: true,
		});
		expect(updates.frontmatter).toEqual({ story_points: null });
	});

	it("ignores push-only mappings", () => {
		const updates = buildMappedFieldUpdates(issue, {}, [
			mapping({
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "push",
			}),
		]);
		expect(updates).toEqual({ cli: {}, frontmatter: {} });
	});
});

describe("getIssueFieldsParam", () => {
	it("is undefined without mappings so server defaults apply", () => {
		expect(getIssueFieldsParam([])).toBeUndefined();
	});

	it("requests mapped fields in addition to the default fields", () => {
		const param = getIssueFieldsParam([
			mapping({ jira: "customfield_10016" }),
			mapping({ backlog: "milestone", jira: "fixVersions" }),
			mapping({ backlog: "frontmatter:x", jira: "customfield_10016" }),
			mapping({ backlog: "labels", jira: "labels", type: "array" }),
		]);
		const fields = param?.split(",") ?? [];
		expect(fields).toContain("summary");
		expect(fields).toContain("status");
		expect(fields).toContain("customfield_10016");
		expect(fields).toContain("fixVersions");
		expect(fields.filter((f) => f === "customfield_10016")).toHaveLength(1);
		expect(fields.filter((f) => f === "labels")).toHaveLength(1);
	});

	it("requests fields for push-only mappings so they can be compared", () => {
		expect(
			getIssueFieldsParam([
				mapping({ jira: "customfield_10016", direction: "push" }),
			]),
		).toContain("customfield_10016");
	});
});

describe("suggestTypeForSchema", () => {
	it("maps Jira schema types to adapter types", () => {
		expect(suggestTypeForSchema({ type: "number" })).toBe("number");
		expect(suggestTypeForSchema({ type: "datetime" })).toBe("date");
		expect(suggestTypeForSchema({ type: "option" })).toBe("option");
		expect(suggestTypeForSchema({ type: "array", items: "option" })).toBe(
			"multi-option",
		);
		expect(suggestTypeForSchema({ type: "array", items: "version" })).toBe(
			"version",
		);
		expect(suggestTypeForSchema({ type: "array", items: "string" })).toBe(
			"array",
		);
		expect(suggestTypeForSchema({ type: "user" })).toBe("user");
		expect(suggestTypeForSchema({ type: "any" })).toBeUndefined();
		expect(suggestTypeForSchema(undefined)).toBeUndefined();
	});
});
