import { describe, expect, it, mock } from "bun:test";
import type { JiraIssue } from "../integrations/jira.ts";
import { FieldMappingConfigError } from "./field-mapping.ts";
import {
	applyRequiredToolsets,
	applySprintSettings,
	buildStatusMappingConfig,
	buildStatusOptions,
	checkStatusNames,
	credentialHelpLines,
	describeStatusOption,
	detectCredentials,
	discoverProjectStatuses,
	isDefaultStatusMapping,
	mergeEnvFile,
	mergeToolsets,
	rejectedStatusNames,
	suggestBacklogStatus,
	suggestFieldMappings,
	uncoveredJiraStatuses,
} from "./setup.ts";

describe("detectCredentials", () => {
	it("accepts Jira Cloud credentials", () => {
		const status = detectCredentials({
			JIRA_URL: "https://x.atlassian.net",
			JIRA_EMAIL: "me@example.com",
			JIRA_API_TOKEN: "secret",
		});
		expect(status.auth).toBe("cloud");
		expect(status.missing).toEqual([]);
	});

	it("accepts a personal access token", () => {
		const status = detectCredentials({
			JIRA_URL: "https://jira.example.com",
			JIRA_PERSONAL_TOKEN: "pat",
		});
		expect(status.auth).toBe("server");
		expect(status.missing).toEqual([]);
	});

	it("accepts JIRA_USERNAME in place of JIRA_EMAIL", () => {
		const status = detectCredentials({
			JIRA_URL: "https://x.atlassian.net",
			JIRA_USERNAME: "me@example.com",
			JIRA_API_TOKEN: "secret",
		});
		expect(status.auth).toBe("cloud");
	});

	it("lists what is missing and treats blank values as unset", () => {
		const status = detectCredentials({ JIRA_URL: " ", JIRA_EMAIL: "a@b.c" });
		expect(status.auth).toBeNull();
		expect(status.missing).toEqual(["JIRA_URL", "JIRA_API_TOKEN"]);
	});

	it("needs a URL even with a token", () => {
		expect(detectCredentials({ JIRA_PERSONAL_TOKEN: "pat" }).auth).toBeNull();
	});
});

describe("credentialHelpLines", () => {
	it("explains export, .env and direnv", () => {
		const text = credentialHelpLines().join("\n");
		expect(text).toContain("export JIRA_URL=");
		expect(text).toContain("set -a; . ./.env; set +a");
		expect(text).toContain("direnv allow");
		expect(text).toContain("JIRA_PERSONAL_TOKEN");
		expect(text).toContain("never stored in .backlog-jira/config.json");
	});
});

describe("mergeEnvFile", () => {
	it("replaces Jira variables and keeps other lines", () => {
		const merged = mergeEnvFile(
			"# app\nPORT=3000\nJIRA_URL=old\nexport JIRA_API_TOKEN=old\n",
			{ JIRA_URL: "https://x.atlassian.net", JIRA_API_TOKEN: "it's" },
		);
		expect(merged).toBe(
			"# app\nPORT=3000\n\nJIRA_URL='https://x.atlassian.net'\nJIRA_API_TOKEN='it'\\''s'\n",
		);
	});

	it("writes a new file", () => {
		expect(mergeEnvFile("", { JIRA_URL: "u" })).toBe("JIRA_URL='u'\n");
	});
});

describe("suggestBacklogStatus", () => {
	const statuses = ["To Do", "In Progress", "Done"];

	it("keeps the current mapping", () => {
		expect(
			suggestBacklogStatus("QA", statuses, { Done: ["qa"], "To Do": [] }),
		).toBe("Done");
	});

	it("matches a status of the same name", () => {
		expect(suggestBacklogStatus("in progress", statuses)).toBe("In Progress");
	});

	it("guesses from common workflow names", () => {
		expect(suggestBacklogStatus("Resolved", statuses)).toBe("Done");
		expect(suggestBacklogStatus("Won't Do", statuses)).toBe("Done");
		expect(suggestBacklogStatus("Selected for Development", statuses)).toBe(
			"To Do",
		);
		expect(suggestBacklogStatus("Code Review", statuses)).toBe("In Progress");
	});

	it("works with custom Backlog statuses", () => {
		const custom = ["Backlog", "Doing", "Review", "Shipped"];
		expect(suggestBacklogStatus("Closed", custom)).toBe("Shipped");
		expect(suggestBacklogStatus("Open", custom)).toBe("Backlog");
		expect(suggestBacklogStatus("Testing", custom)).toBe("Doing");
	});
});

describe("buildStatusMappingConfig", () => {
	it("maps chosen statuses and records unmapped ones", () => {
		const result = buildStatusMappingConfig({
			Open: "To Do",
			"In Review": "In Progress",
			Done: "Done",
			Blocked: null,
		});
		expect(result.statusMapping).toEqual({
			"To Do": ["Open"],
			"In Progress": ["In Review"],
			Done: ["Done"],
		});
		expect(result.unmappedJiraStatuses).toEqual(["Blocked"]);
	});

	it("keeps previous entries for statuses not chosen and moves re-chosen ones", () => {
		const result = buildStatusMappingConfig(
			{ Resolved: "Done", Blocked: "In Progress" },
			{ "To Do": ["Open", "Backlog"], Done: ["Done", "resolved"] },
			["Blocked", "Parked"],
		);
		expect(result.statusMapping).toEqual({
			"To Do": ["Open", "Backlog"],
			Done: ["Done", "Resolved"],
			"In Progress": ["Blocked"],
		});
		expect(result.unmappedJiraStatuses).toEqual(["Parked"]);
	});
});

describe("uncoveredJiraStatuses", () => {
	it("lists statuses neither mapped nor left unmapped", () => {
		expect(
			uncoveredJiraStatuses(
				["Open", "Blocked", "QA", "done"],
				{ "To Do": ["Open"], Done: ["Done"] },
				["blocked"],
			),
		).toEqual(["QA"]);
	});
});

describe("mergeToolsets", () => {
	it("enables the default, project and agile toolsets when unset", () => {
		expect(mergeToolsets()).toBe("default,jira_projects,jira_agile");
		expect(mergeToolsets("")).toBe("default,jira_projects,jira_agile");
	});

	it("adds missing toolsets to a restricted list", () => {
		expect(mergeToolsets("default")).toBe("default,jira_projects,jira_agile");
		expect(mergeToolsets("jira_issues, jira_agile")).toBe(
			"jira_issues,jira_agile,jira_projects",
		);
	});

	it("keeps all", () => {
		expect(mergeToolsets("all")).toBe("all");
	});
});

describe("applyRequiredToolsets", () => {
	it("keeps other mcp settings and env vars", () => {
		const config = applyRequiredToolsets({
			mcp: {
				serverArgs: ["--dns 8.8.8.8"],
				envVars: { HTTPS_PROXY: "http://proxy", TOOLSETS: "default" },
			},
		});
		expect(config.mcp).toEqual({
			serverArgs: ["--dns 8.8.8.8"],
			envVars: {
				HTTPS_PROXY: "http://proxy",
				TOOLSETS: "default,jira_projects,jira_agile",
			},
		});
	});
});

describe("applySprintSettings", () => {
	const settings = {
		boardId: "12",
		direction: "both" as const,
		createSprints: false,
		archiveClosedSprints: true,
		pullScope: "open" as const,
	};

	it("writes a valid sprint mapping, keeps other mappings and sets TOOLSETS", () => {
		const config = applySprintSettings(
			{
				custom: { keep: true },
				fieldMappings: [
					{
						backlog: "frontmatter:story_points",
						jira: "customfield_10016",
						type: "number",
					},
				],
			},
			settings,
		);
		expect(config.custom).toEqual({ keep: true });
		expect(config.fieldMappings).toEqual([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
			},
			{
				backlog: "milestone",
				jira: "sprint",
				type: "sprint",
				direction: "both",
				boardId: 12,
				createSprints: false,
				archiveClosedSprints: true,
				pullScope: "open",
			},
		]);
		expect(
			(config.mcp as { envVars: Record<string, string> }).envVars.TOOLSETS,
		).toBe("default,jira_projects,jira_agile");
	});

	it("replaces an existing milestone mapping", () => {
		const config = applySprintSettings(
			{
				fieldMappings: [
					{ backlog: "milestone", jira: "fixVersions", type: "version" },
				],
			},
			{ ...settings, direction: "pull" },
		);
		expect(config.fieldMappings).toHaveLength(1);
		expect((config.fieldMappings as Array<{ type: string }>)[0].type).toBe(
			"sprint",
		);
	});

	it("rejects an invalid board id like map-fields", () => {
		expect(() => applySprintSettings({}, { ...settings, boardId: "" })).toThrow(
			FieldMappingConfigError,
		);
	});
});

describe("discoverProjectStatuses", () => {
	const issue = (key: string, status: string) =>
		({ key, status }) as unknown as JiraIssue;

	it("collects statuses per issue type from issues, with transition names and targets as candidates", async () => {
		const jira = {
			searchIssues: mock(async (jql: string) => ({
				issues: jql.includes('"Bug"')
					? []
					: [
							issue("P-1", "To Do"),
							issue("P-2", "In Progress"),
							issue("P-3", "To Do"),
						],
			})),
			getTransitions: mock(async (key: string) =>
				key === "P-1"
					? [
							// MCP Atlassian leaves the target empty
							{ id: "1", name: "In Progress", to: { id: "", name: "" } },
							{ id: "2", name: "Start Review", to: { id: "", name: "" } },
							{ id: "3", name: "Finish", to: { id: "", name: "Done" } },
						]
					: [],
			),
		};

		const result = await discoverProjectStatuses(jira, "PROJ", ["Task", "Bug"]);

		expect(result).toEqual([
			{
				issueType: "Task",
				statuses: ["To Do", "In Progress"],
				candidates: ["Start Review", "Done", "Finish"],
			},
		]);
		expect(jira.searchIssues.mock.calls[0][0]).toBe(
			'project = "PROJ" AND issuetype = "Task" ORDER BY updated DESC',
		);
		// One sample issue per status
		expect(jira.getTransitions).toHaveBeenCalledTimes(2);
	});

	it("ignores transition failures", async () => {
		const jira = {
			searchIssues: async () => ({ issues: [issue("P-1", "Open")] }),
			getTransitions: async () => {
				throw new Error("forbidden");
			},
		};
		expect(await discoverProjectStatuses(jira, "PROJ", ["Task"])).toEqual([
			{ issueType: "Task", statuses: ["Open"], candidates: [] },
		]);
	});
});

describe("rejectedStatusNames", () => {
	it("reads the names Jira rejects from its error text", () => {
		expect(
			rejectedStatusNames(
				"MCP tool jira_search failed: Error searching issues: 400 The value 'Start Review' does not exist for the field 'status'.; The value 'Finish' does not exist for the field 'status'.",
			),
		).toEqual(["Start Review", "Finish"]);
		expect(rejectedStatusNames("401 Unauthorized")).toEqual([]);
	});
});

describe("checkStatusNames", () => {
	const REAL = ["to do", "in progress", "blocked", "done"];
	/** Jira rejecting status names it does not know, like the real API */
	function jiraWithStatuses(
		errorText = (name: string) =>
			`The value '${name}' does not exist for the field 'status'.`,
	) {
		return {
			searchIssues: mock(async (jql: string) => {
				const names = [...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(1);
				const unknown = names.filter((n) => !REAL.includes(n.toLowerCase()));
				if (unknown.length > 0)
					throw new Error(unknown.map(errorText).join(" "));
				return { issues: [] };
			}),
		};
	}

	it("keeps the names Jira accepts in one retry", async () => {
		const jira = jiraWithStatuses();
		const result = await checkStatusNames(jira, "CR2", [
			"In Progress",
			"Start Review",
			"Blocked",
			"Client Review",
			"Done",
		]);
		expect(result).toEqual({
			statuses: ["In Progress", "Blocked", "Done"],
			checked: true,
		});
		expect(jira.searchIssues).toHaveBeenCalledTimes(2);
		expect(jira.searchIssues.mock.calls[0][0]).toBe(
			'project = "CR2" AND status in ("In Progress", "Start Review", "Blocked", "Client Review", "Done")',
		);
	});

	it("asks name by name when the error text is not recognised", async () => {
		const jira = jiraWithStatuses(() => "400 Bad Request");
		const result = await checkStatusNames(jira, "CR2", ["Done", "Finish"]);
		expect(result).toEqual({ statuses: ["Done"], checked: true });
	});

	it("reports unchecked when Jira cannot be searched", async () => {
		const jira = {
			searchIssues: async () => {
				throw new Error("Connection closed");
			},
		};
		expect(await checkStatusNames(jira, "CR2", ["Done"])).toEqual({
			statuses: [],
			checked: false,
		});
	});

	it("escapes quotes in names", async () => {
		const jira = {
			searchIssues: mock(async (_jql: string) => ({ issues: [] })),
		};
		await checkStatusNames(jira, "CR2", ['Won"t do']);
		expect(jira.searchIssues.mock.calls[0][0]).toBe(
			'project = "CR2" AND status in ("Won\\"t do")',
		);
	});
});

describe("buildStatusMappingConfig dropped statuses", () => {
	it("removes dropped statuses from the previous mapping and unmapped list", () => {
		const result = buildStatusMappingConfig(
			{ "To Do": "To Do" },
			{ "To Do": ["To Do", "Open", "Backlog"], Done: ["Done", "Resolved"] },
			["Parked"],
			["open", "Resolved", "Parked"],
		);
		expect(result).toEqual({
			statusMapping: { "To Do": ["Backlog", "To Do"], Done: ["Done"] },
			unmappedJiraStatuses: [],
		});
	});
});

describe("isDefaultStatusMapping", () => {
	it("recognises the mapping init writes", () => {
		expect(
			isDefaultStatusMapping({
				"To Do": ["To Do", "Open", "Backlog"],
				"In Progress": ["In Progress"],
				Done: ["Done", "Closed", "Resolved"],
			}),
		).toBe(true);
		expect(isDefaultStatusMapping({ "To Do": ["Open"] })).toBe(false);
	});
});

describe("buildStatusOptions", () => {
	const perType = [
		{
			issueType: "Epic",
			statuses: ["To Do"],
			candidates: ["In Progress", "Done"],
		},
		{
			issueType: "Story",
			statuses: ["To Do"],
			candidates: ["In Progress", "Client Review", "Start Work"],
		},
	];

	it("orders by certainty, names issue types and ticks confirmed statuses", () => {
		const options = buildStatusOptions(
			perType,
			{
				statuses: ["In Progress", "Done", "Client Review", "Open"],
				checked: true,
			},
			{ "To Do": ["Open"] },
		);
		expect(options).toEqual([
			{
				name: "To Do",
				source: "issues",
				issueTypes: ["Epic", "Story"],
				selected: true,
			},
			{
				name: "In Progress",
				source: "transitions",
				issueTypes: ["Epic", "Story"],
				selected: true,
			},
			{
				name: "Done",
				source: "transitions",
				issueTypes: ["Epic"],
				selected: true,
			},
			{
				name: "Client Review",
				source: "transitions",
				issueTypes: ["Story"],
				selected: true,
			},
			// In the user's own mapping, so ticked
			{ name: "Open", source: "site", issueTypes: [], selected: true },
		]);
		expect(describeStatusOption(options[0])).toBe("on Epic, Story issues");
		expect(describeStatusOption(options[3])).toBe("reachable from Story");
		expect(describeStatusOption(options[4])).toBe(
			"used elsewhere on this Jira site",
		);
	});

	it("does not tick site statuses that only come from init's default mapping", () => {
		const options = buildStatusOptions(
			perType,
			{ statuses: ["Open", "Closed"], checked: true },
			{
				"To Do": ["To Do", "Open", "Backlog"],
				"In Progress": ["In Progress"],
				Done: ["Done", "Closed", "Resolved"],
			},
		);
		expect(options.filter((o) => o.source === "site")).toEqual([
			{ name: "Open", source: "site", issueTypes: [], selected: false },
			{ name: "Closed", source: "site", issueTypes: [], selected: false },
		]);
	});

	it("offers unticked transition names when Jira could not check them", () => {
		const options = buildStatusOptions(perType, {
			statuses: [],
			checked: false,
		});
		expect(
			options.filter((o) => o.source === "unverified").map((o) => o.name),
		).toEqual(["In Progress", "Done", "Client Review", "Start Work"]);
		expect(options.every((o) => o.source === "issues" || !o.selected)).toBe(
			true,
		);
	});
});

describe("suggestFieldMappings", () => {
	const fields = [
		{ id: "customfield_1", name: "Story Points", schema: { type: "number" } },
		{ id: "customfield_2", name: "Client", schema: { type: "string" } },
		{ id: "customfield_3", name: "Empty Notes", schema: { type: "string" } },
		{
			id: "customfield_4",
			name: "Rank",
			schema: {
				type: "any",
				custom: "com.pyxis.greenhopper.jira:gh-lexo-rank",
			},
		},
		{ id: "customfield_5", name: "Checklist Blob", schema: { type: "any" } },
		{ id: "duedate", name: "Due date", schema: { type: "date" } },
		{
			id: "components",
			name: "Components",
			schema: { type: "array", items: "component" },
		},
		{ id: "watches", name: "Watchers", schema: { type: "watches" } },
		{
			id: "labels",
			name: "Labels",
			schema: { type: "array", items: "string" },
		},
		{ id: "customfield_6", name: "Client", schema: { type: "string" } },
	];
	const issue = (fieldValues: Record<string, unknown>) =>
		({ key: "P-1", fields: fieldValues }) as unknown as JiraIssue;
	const sample = [
		issue({
			customfield_1: { value: 3, name: "Story Points" },
			customfield_2: { value: "Acme" },
			customfield_3: { value: "  " },
			customfield_5: { value: { x: 1 } },
			customfield_6: { value: "B" },
			components: [{ name: "API" }],
			labels: ["a"],
		}),
		issue({
			customfield_1: { value: 5 },
			customfield_3: { value: null },
			components: [],
		}),
	];

	it("ranks used fields, keeps useful unused ones and hides the rest", () => {
		const suggestions = suggestFieldMappings(fields, sample);
		expect(
			suggestions.map((s) => [
				s.field.id,
				s.used,
				s.backlog,
				s.type,
				s.selected,
			]),
		).toEqual([
			["customfield_1", 2, "frontmatter:story_points", "number", true],
			["components", 1, "frontmatter:components", "array", true],
			["customfield_2", 1, "frontmatter:client", "string", false],
			["customfield_6", 1, "frontmatter:client_2", "string", false],
			["duedate", 0, "frontmatter:due_date", "date", false],
		]);
		expect(suggestions.every((s) => s.direction === "pull")).toBe(true);
	});

	it("uses one target for both story point field names", () => {
		const [suggestion] = suggestFieldMappings(
			[
				{
					id: "customfield_9",
					name: "Story point estimate",
					schema: { type: "number" },
				},
			],
			[],
		);
		expect(suggestion.backlog).toBe("frontmatter:story_points");
	});

	it("skips mapped fields and avoids mapped targets", () => {
		const suggestions = suggestFieldMappings(fields, sample, {
			mappedFields: ["customfield_1"],
			mappedTargets: ["frontmatter:client"],
			limit: 2,
		});
		expect(suggestions.map((s) => [s.field.id, s.backlog])).toEqual([
			["components", "frontmatter:components"],
			["customfield_2", "frontmatter:client_2"],
		]);
	});
});
