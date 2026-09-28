import { describe, expect, it, mock } from "bun:test";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	type FieldMapping,
	FieldValueError,
	buildMappedFieldUpdates,
	buildMappedJiraFields,
	convertBacklogValue,
	convertJiraValue,
} from "./field-mapping.ts";
import {
	MappedFieldPushError,
	createIssueWithMappedFields,
	formatMappedFieldFailures,
	payloadWithFailedFields,
	updateIssueWithMappedFields,
} from "./mapped-field-sync.ts";
import type { NormalizedPayload } from "./normalizer.ts";

function makeIssue(fields: Record<string, unknown> = {}): JiraIssue {
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
		direction: "both",
		...overrides,
	};
}

describe("convertBacklogValue (Backlog → Jira)", () => {
	it("converts scalar types", () => {
		expect(convertBacklogValue("hello", mapping({ type: "string" }))).toBe(
			"hello",
		);
		expect(convertBacklogValue(["a", "b"], mapping({ type: "string" }))).toBe(
			"a, b",
		);
		expect(convertBacklogValue("2.5", mapping({ type: "number" }))).toBe(2.5);
		expect(convertBacklogValue("2026-10-01", mapping({ type: "date" }))).toBe(
			"2026-10-01",
		);
		expect(convertBacklogValue("Red", mapping({ type: "option" }))).toEqual({
			value: "Red",
		});
	});

	it("converts list types", () => {
		expect(
			convertBacklogValue(["Red", "Blue"], mapping({ type: "multi-option" })),
		).toEqual([{ value: "Red" }, { value: "Blue" }]);
		expect(
			convertBacklogValue("Red, Blue", mapping({ type: "multi-option" })),
		).toEqual([{ value: "Red" }, { value: "Blue" }]);
		expect(
			convertBacklogValue(["API", "UI"], mapping({ type: "array" })),
		).toEqual(["API", "UI"]);
		expect(
			convertBacklogValue(
				["API"],
				mapping({ type: "array", jira: "components" }),
			),
		).toEqual([{ name: "API" }]);
	});

	it("sends versions as a list for list fields and a single object otherwise", () => {
		const fixVersions = mapping({ type: "version", jira: "fixVersions" });
		expect(convertBacklogValue("1.0, 1.1", fixVersions)).toEqual([
			{ name: "1.0" },
			{ name: "1.1" },
		]);
		expect(convertBacklogValue(null, fixVersions)).toEqual([]);
		expect(convertBacklogValue("2.0", mapping({ type: "version" }))).toEqual({
			name: "2.0",
		});
	});

	it("sends users as accountId when the value is an account ID", () => {
		expect(
			convertBacklogValue(
				"5b10a2844c20165700ede21f",
				mapping({ type: "user" }),
			),
		).toEqual({ accountId: "5b10a2844c20165700ede21f" });
		expect(convertBacklogValue("@alice", mapping({ type: "user" }))).toEqual({
			name: "alice",
		});
	});

	it("clears fields for empty values", () => {
		expect(convertBacklogValue(null, mapping({ type: "number" }))).toBeNull();
		expect(convertBacklogValue(null, mapping({ type: "option" }))).toBeNull();
		expect(
			convertBacklogValue(null, mapping({ type: "multi-option" })),
		).toEqual([]);
	});

	it("reverses valueMap so pulled values round-trip", () => {
		const priority = mapping({
			backlog: "priority",
			type: "option",
			valueMap: { P1: "high", P2: "medium" },
		});
		expect(convertBacklogValue("high", priority)).toEqual({ value: "P1" });
		expect(convertBacklogValue("MEDIUM", priority)).toEqual({ value: "P2" });
		expect(convertBacklogValue("low", priority)).toEqual({ value: "low" });

		// Round trip: Jira → Backlog → Jira
		const pulled = convertJiraValue({ value: "P1" }, priority);
		expect(convertBacklogValue(pulled, priority)).toEqual({ value: "P1" });
	});

	it("rejects values that cannot be represented", () => {
		expect(() =>
			convertBacklogValue("five", mapping({ type: "number" })),
		).toThrow(FieldValueError);
		expect(() =>
			convertBacklogValue("next week", mapping({ type: "date" })),
		).toThrow(FieldValueError);
	});
});

describe("buildMappedJiraFields", () => {
	const points = mapping({
		backlog: "frontmatter:story_points",
		jira: "customfield_10016",
		type: "number",
	});

	it("sends only changed values", () => {
		const issue = makeIssue({ customfield_10016: 3 });
		expect(
			buildMappedJiraFields({ story_points: "3" }, issue, [points]).fields,
		).toEqual({});

		const result = buildMappedJiraFields({ story_points: "5" }, issue, [
			points,
		]);
		expect(result.fields).toEqual({ customfield_10016: 5 });
		expect(result.changes).toEqual([
			{ mapping: points, backlogValue: "5", jiraValue: "3" },
		]);
	});

	it("clears the Jira field when the Backlog value is removed", () => {
		const issue = makeIssue({ customfield_10016: 3 });
		expect(buildMappedJiraFields({}, issue, [points]).fields).toEqual({
			customfield_10016: null,
		});
	});

	it("includes every non-empty value when creating an issue", () => {
		const team = mapping({
			backlog: "frontmatter:team",
			jira: "customfield_10020",
			type: "option",
			direction: "push",
		});
		expect(
			buildMappedJiraFields({ story_points: "8" }, null, [points, team]).fields,
		).toEqual({ customfield_10016: 8 });
	});

	it("never writes pull-only mappings to Jira", () => {
		const pullOnly = { ...points, direction: "pull" as const };
		const issue = makeIssue({ customfield_10016: 3 });
		expect(
			buildMappedJiraFields({ story_points: "5" }, issue, [pullOnly]).fields,
		).toEqual({});
		expect(
			buildMappedJiraFields({ story_points: "5" }, null, [pullOnly]).fields,
		).toEqual({});
	});

	it("reports values that cannot be converted per field", () => {
		const result = buildMappedJiraFields(
			{ story_points: "lots" },
			makeIssue({ customfield_10016: 3 }),
			[points],
		);
		expect(result.fields).toEqual({});
		expect(result.errors).toEqual([
			{ mapping: points, error: '"lots" is not a number' },
		]);
	});
});

describe("buildMappedFieldUpdates direction", () => {
	it("never writes push-only mappings to Backlog", () => {
		const pushOnly = mapping({
			backlog: "frontmatter:story_points",
			jira: "customfield_10016",
			type: "number",
			direction: "push",
		});
		const updates = buildMappedFieldUpdates(
			makeIssue({ customfield_10016: 3 }),
			{ story_points: "5" },
			[pushOnly],
		);
		expect(updates).toEqual({ cli: {}, frontmatter: {} });
	});
});

describe("updateIssueWithMappedFields", () => {
	const points = mapping({
		backlog: "frontmatter:story_points",
		jira: "customfield_10016",
		type: "number",
	});
	const team = mapping({
		backlog: "frontmatter:team",
		jira: "customfield_10020",
		type: "option",
	});
	const mapped = {
		fields: { customfield_10016: 5, customfield_10020: { value: "Core" } },
		changes: [
			{ mapping: points, backlogValue: "5", jiraValue: "3" },
			{ mapping: team, backlogValue: "Core", jiraValue: null },
		],
		errors: [],
	};

	it("sends core and mapped fields in one update", async () => {
		const updateIssue = mock(async () => {});
		const failures = await updateIssueWithMappedFields(
			{ updateIssue },
			"PROJ-1",
			{ summary: "New" },
			mapped,
		);
		expect(failures).toEqual([]);
		expect(updateIssue).toHaveBeenCalledTimes(1);
		expect(updateIssue).toHaveBeenCalledWith("PROJ-1", {
			summary: "New",
			fields: mapped.fields,
		});
	});

	it("isolates and reports the single non-editable field", async () => {
		const rejected =
			"Field 'customfield_10020' cannot be set. It is not on the appropriate screen, or unknown.";
		const updateIssue = mock(
			async (_key: string, updates: { fields?: Record<string, unknown> }) => {
				if (updates.fields && "customfield_10020" in updates.fields) {
					throw new Error(rejected);
				}
			},
		);

		const failures = await updateIssueWithMappedFields(
			{ updateIssue },
			"PROJ-1",
			{ summary: "New" },
			mapped,
		);

		expect(failures).toEqual([{ mapping: team, error: rejected }]);
		// combined, core alone, then each mapped field
		expect(updateIssue).toHaveBeenCalledTimes(4);
		expect(updateIssue).toHaveBeenCalledWith("PROJ-1", { summary: "New" });
		expect(updateIssue).toHaveBeenCalledWith("PROJ-1", {
			fields: { customfield_10016: 5 },
		});

		const message = new MappedFieldPushError("PROJ-1", failures).message;
		expect(message).toContain("customfield_10020");
		expect(message).toContain("frontmatter:team");
		expect(message).not.toContain("customfield_10016");
	});

	it("rethrows when the core fields themselves fail", async () => {
		const updateIssue = mock(async () => {
			throw new Error("summary is required");
		});
		await expect(
			updateIssueWithMappedFields(
				{ updateIssue },
				"PROJ-1",
				{ summary: "" },
				mapped,
			),
		).rejects.toThrow("summary is required");
	});

	it("reports conversion errors without calling Jira for them", async () => {
		const updateIssue = mock(async () => {});
		const failures = await updateIssueWithMappedFields(
			{ updateIssue },
			"PROJ-1",
			{},
			{
				fields: {},
				changes: [],
				errors: [{ mapping: points, error: '"lots" is not a number' }],
			},
		);
		expect(updateIssue).not.toHaveBeenCalled();
		expect(failures).toEqual([
			{ mapping: points, error: '"lots" is not a number' },
		]);
	});
});

describe("createIssueWithMappedFields", () => {
	const points = mapping({
		backlog: "frontmatter:story_points",
		jira: "customfield_10016",
		type: "number",
	});
	const mapped = {
		fields: { customfield_10016: 5 },
		changes: [{ mapping: points, backlogValue: "5", jiraValue: null }],
		errors: [],
	};

	it("includes mapped fields in the create request", async () => {
		const createIssue = mock(async () => makeIssue());
		const updateIssue = mock(async () => {});
		const { failures } = await createIssueWithMappedFields(
			{ createIssue, updateIssue },
			"PROJ",
			"Task",
			"Title",
			{ description: "Desc" },
			mapped,
		);
		expect(failures).toEqual([]);
		expect(createIssue).toHaveBeenCalledWith("PROJ", "Task", "Title", {
			description: "Desc",
			fields: { customfield_10016: 5 },
		});
		expect(updateIssue).not.toHaveBeenCalled();
	});

	it("creates without the rejected field and reports it", async () => {
		const createIssue = mock(
			async (
				_p: string,
				_t: string,
				_s: string,
				options?: { fields?: Record<string, unknown> },
			) => {
				if (options?.fields) {
					throw new Error(
						"customfield_10016: Field 'customfield_10016' cannot be set.",
					);
				}
				return makeIssue();
			},
		);
		const updateIssue = mock(async () => {
			throw new Error("Field 'customfield_10016' cannot be set.");
		});

		const { issue, failures } = await createIssueWithMappedFields(
			{ createIssue, updateIssue },
			"PROJ",
			"Task",
			"Title",
			{},
			mapped,
		);
		expect(issue.key).toBe("PROJ-1");
		expect(createIssue).toHaveBeenCalledTimes(2);
		expect(failures.map((f) => f.mapping.jira)).toEqual(["customfield_10016"]);
	});

	it("rethrows create errors unrelated to mapped fields", async () => {
		const createIssue = mock(async () => {
			throw new Error("project does not exist");
		});
		await expect(
			createIssueWithMappedFields(
				{ createIssue, updateIssue: mock(async () => {}) },
				"NOPE",
				"Task",
				"Title",
				{},
				mapped,
			),
		).rejects.toThrow("project does not exist");
		expect(createIssue).toHaveBeenCalledTimes(1);
	});
});

describe("partial push bookkeeping", () => {
	it("keeps failed fields pending in the Backlog snapshot", () => {
		const points = mapping({ backlog: "frontmatter:story_points" });
		const backlog: NormalizedPayload = {
			title: "T",
			description: "",
			status: "todo",
			labels: [],
			acceptanceCriteria: [],
			mappedFields: {
				"frontmatter:story_points": "5",
				"frontmatter:team": "A",
			},
		};
		const jira: NormalizedPayload = {
			...backlog,
			mappedFields: {
				"frontmatter:story_points": "3",
				"frontmatter:team": "A",
			},
		};
		const snapshot = payloadWithFailedFields(backlog, jira, [
			{ mapping: points, error: "x" },
		]);
		expect(snapshot.mappedFields).toEqual({
			"frontmatter:story_points": "3",
			"frontmatter:team": "A",
		});
		// the live payload is not modified
		expect(backlog.mappedFields?.["frontmatter:story_points"]).toBe("5");
	});

	it("names each failed field in the error message", () => {
		const message = formatMappedFieldFailures("PROJ-1", [
			{
				mapping: mapping({ jira: "customfield_1", backlog: "milestone" }),
				error: "not on screen\nstack",
			},
		]);
		expect(message).toContain(
			"customfield_1 (mapped to milestone): not on screen",
		);
		expect(message).not.toContain("stack");
	});
});
