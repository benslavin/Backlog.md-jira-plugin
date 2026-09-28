import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { checkFieldMappings } from "./doctor.ts";

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
