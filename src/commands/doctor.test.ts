import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { checkConfigFile, checkFieldMappings } from "./doctor.ts";
import { initCommand } from "./init.ts";

describe("doctor: configuration", () => {
	let testDir: string;
	let configPath: string;

	beforeEach(() => {
		testDir = uniqueTestDir("doctor-config-test");
		configPath = join(testDir, ".backlog-jira", "config.json");
	});

	afterEach(() => {
		mock.restore();
		cleanupDir(testDir);
	});

	async function initWithProjectKey(projectKey: string): Promise<void> {
		const prompts = await import("prompts");
		spyOn(prompts, "default").mockResolvedValue({ shouldSetup: false });
		await initCommand({ baseDir: testDir });
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		config.jira.projectKey = projectKey;
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	}

	it("passes for a config written by init once the project key is set", async () => {
		await initWithProjectKey("PROJ");
		await expect(checkConfigFile(testDir)).resolves.toBeUndefined();
	});

	it("reports the empty project key init leaves behind", async () => {
		await initWithProjectKey("");
		await expect(checkConfigFile(testDir)).rejects.toThrow(
			"Missing required config field: jira.projectKey",
		);
	});

	it("reports a missing project key", async () => {
		writeJson(configPath, { jira: { baseUrl: "https://x.atlassian.net" } });
		await expect(checkConfigFile(testDir)).rejects.toThrow(
			"Missing required config field: jira.projectKey",
		);
	});

	it("reports a whitespace-only project key", async () => {
		writeJson(configPath, { jira: { projectKey: "  " } });
		await expect(checkConfigFile(testDir)).rejects.toThrow("jira.projectKey");
	});

	it("does not require the legacy top-level keys", async () => {
		writeJson(configPath, { jira: { projectKey: "PROJ" } });
		await expect(checkConfigFile(testDir)).resolves.toBeUndefined();
	});

	it("reports a missing config file", async () => {
		await expect(checkConfigFile(testDir)).rejects.toThrow(
			"Config file not found",
		);
	});

	it("reports invalid JSON", async () => {
		writeJson(configPath, {});
		writeFileSync(configPath, "{ not json");
		await expect(checkConfigFile(testDir)).rejects.toThrow(
			"Config file contains invalid JSON",
		);
	});
});

describe("doctor: field mappings", () => {
	let testDir: string;

	function configure(fieldMappings: unknown[]): void {
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			jira: { projectKey: "PROJ", issueType: "Story" },
			fieldMappings,
		});
	}

	function fakeJira(screenFields: string[] = []) {
		return {
			searchFields: mock(async () => [
				{ id: "customfield_10016", name: "Story Points" },
				{ id: "customfield_10020", name: "Team" },
				{ id: "fixVersions", name: "Fix versions" },
			]),
			getProjectIssueTypes: mock(async () => [
				{ id: "10001", name: "Task" },
				{ id: "10002", name: "Story" },
			]),
			getCreateFieldIds: mock(async () => ["summary", ...screenFields]),
		};
	}

	beforeEach(() => {
		testDir = uniqueTestDir("doctor-test");
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("passes when there are no mappings", async () => {
		configure([]);
		const jira = fakeJira();
		expect(await checkFieldMappings(jira, testDir)).toEqual([]);
		expect(jira.searchFields).not.toHaveBeenCalled();
	});

	it("does not report 'No field mappings configured' when a sprint mapping exists", async () => {
		configure([
			{ backlog: "milestone", jira: "sprint", type: "sprint", boardId: 12 },
		]);
		const { logger } = await import("../utils/logger.ts");
		const info = spyOn(logger, "info");
		try {
			expect(await checkFieldMappings(fakeJira(), testDir)).toEqual([]);
			const lines = info.mock.calls.map((call) => String(call[0]));
			expect(lines).not.toContain("  ✓ No field mappings configured");
			expect(lines).toContain(
				"  ✓ No field mappings besides the sprint mapping",
			);
		} finally {
			info.mockRestore();
		}
	});

	it("verifies each mapped field against the configured project and issue type", async () => {
		configure([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "both",
			},
			{ backlog: "milestone", jira: "fixVersions", type: "version" },
		]);
		const jira = fakeJira(["customfield_10016"]);

		const results = await checkFieldMappings(jira, testDir);

		expect(results.every((r) => r.problems.length === 0)).toBe(true);
		expect(jira.getCreateFieldIds).toHaveBeenCalledWith("PROJ", "10002");
	});

	it("fails naming fields that are missing or not editable", async () => {
		configure([
			{
				backlog: "frontmatter:team",
				jira: "customfield_10020",
				type: "option",
				direction: "push",
			},
			{
				backlog: "frontmatter:gone",
				jira: "customfield_99999",
				type: "string",
			},
		]);

		await expect(checkFieldMappings(fakeJira(), testDir)).rejects.toThrow(
			"2 field mappings failed verification (customfield_10020, customfield_99999)",
		);
	});

	it("only checks existence for pull-only mappings", async () => {
		configure([
			{
				backlog: "frontmatter:team",
				jira: "customfield_10020",
				type: "option",
			},
		]);
		const jira = fakeJira();
		await checkFieldMappings(jira, testDir);
		expect(jira.getProjectIssueTypes).not.toHaveBeenCalled();
	});

	it("reports invalid mapping configuration", async () => {
		configure([{ backlog: "frontmatter:jira_key", jira: "x", type: "number" }]);
		await expect(checkFieldMappings(fakeJira(), testDir)).rejects.toThrow(
			"Invalid fieldMappings",
		);
	});
});
