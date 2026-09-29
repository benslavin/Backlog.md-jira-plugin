import { describe, expect, it, mock } from "bun:test";
import type { JiraIssue } from "../integrations/jira.ts";
import { FieldMappingConfigError } from "./field-mapping.ts";
import {
	applyRequiredToolsets,
	applySprintSettings,
	buildStatusMappingConfig,
	credentialHelpLines,
	detectCredentials,
	discoverProjectStatuses,
	mergeEnvFile,
	mergeToolsets,
	suggestBacklogStatus,
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

	it("collects statuses per issue type from issues and transitions", async () => {
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
							{ id: "1", name: "Start", to: { id: "", name: "In Progress" } },
							{ id: "2", name: "Finish", to: { id: "", name: "Done" } },
						]
					: [],
			),
		};

		const result = await discoverProjectStatuses(jira, "PROJ", ["Task", "Bug"]);

		expect(result).toEqual([
			{ issueType: "Task", statuses: ["To Do", "In Progress", "Done"] },
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
			{ issueType: "Task", statuses: ["Open"] },
		]);
	});
});
