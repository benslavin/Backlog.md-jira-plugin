import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import {
	FieldMappingConfigError,
	loadFieldMappings,
	loadSprintMapping,
	validateFieldMappings,
} from "./field-mapping.ts";

const sprint = (overrides: Record<string, unknown> = {}) => ({
	backlog: "milestone",
	jira: "sprint",
	type: "sprint",
	boardId: 12,
	...overrides,
});

describe("sprint field mappings", () => {
	it("accepts a sprint mapping and applies defaults", () => {
		const { mappings, errors, sprintMapping } = validateFieldMappings([
			sprint(),
		]);
		expect(errors).toEqual([]);
		expect(mappings).toEqual([]);
		expect(sprintMapping).toEqual({
			backlog: "milestone",
			jira: "sprint",
			type: "sprint",
			direction: "pull",
			boardId: "12",
			createSprints: false,
			archiveClosedSprints: true,
			pullScope: "all",
		});
	});

	it("accepts every sprint option", () => {
		const { errors, sprintMapping } = validateFieldMappings([
			sprint({
				boardId: "7",
				direction: "both",
				createSprints: true,
				archiveClosedSprints: false,
				pullScope: "open",
			}),
		]);
		expect(errors).toEqual([]);
		expect(sprintMapping).toMatchObject({
			boardId: "7",
			direction: "both",
			createSprints: true,
			archiveClosedSprints: false,
			pullScope: "open",
		});
	});

	it("keeps sprint mappings apart from generic mappings", () => {
		const { mappings, sprintMapping } = validateFieldMappings([
			{ backlog: "frontmatter:team", jira: "customfield_1", type: "option" },
			sprint(),
		]);
		expect(mappings.map((m) => m.backlog)).toEqual(["frontmatter:team"]);
		expect(sprintMapping?.boardId).toBe("12");
	});

	it("rejects a sprint mapping targeting anything other than milestone", () => {
		const { errors, sprintMapping } = validateFieldMappings([
			sprint({ backlog: "frontmatter:sprint" }),
		]);
		expect(sprintMapping).toBeNull();
		expect(errors).toEqual([
			'fieldMappings[0]: a sprint mapping must target the Backlog "milestone" (got "frontmatter:sprint")',
		]);
	});

	it("rejects a sprint mapping whose jira target is not sprint", () => {
		const { errors } = validateFieldMappings([
			sprint({ jira: "customfield_10020" }),
		]);
		expect(errors[0]).toContain('must use "jira": "sprint"');
	});

	it("names the collision when milestone is mapped elsewhere first", () => {
		const { errors, sprintMapping } = validateFieldMappings([
			{ backlog: "milestone", jira: "fixVersions", type: "version" },
			sprint(),
		]);
		expect(sprintMapping).toBeNull();
		expect(errors).toEqual([
			'fieldMappings[1]: sprint mapping targets "milestone", which fieldMappings[0] already maps to fixVersions; remove that mapping to sync sprints',
		]);
	});

	it("names the collision when milestone is mapped elsewhere afterwards", () => {
		const { errors } = validateFieldMappings([
			sprint(),
			{ backlog: "milestone", jira: "fixVersions", type: "version" },
		]);
		expect(errors).toEqual([
			'fieldMappings[1]: backlog target "milestone" is already mapped to Jira sprints by fieldMappings[0]; a sprint mapping needs the milestone to itself',
		]);
	});

	it("rejects a sprint mapping without boardId", () => {
		for (const boardId of [undefined, null, ""]) {
			const { errors, sprintMapping } = validateFieldMappings([
				sprint({ boardId }),
			]);
			expect(sprintMapping).toBeNull();
			expect(errors).toEqual([
				'fieldMappings[0]: a sprint mapping requires "boardId", the Jira board whose sprints become milestones',
			]);
		}
	});

	it("rejects boardIds that are not positive integers", () => {
		for (const boardId of [0, -3, 1.5, "abc", true]) {
			const { errors } = validateFieldMappings([sprint({ boardId })]);
			expect(errors[0]).toContain('"boardId" must be a positive integer');
		}
	});

	it("rejects invalid sprint options", () => {
		const { errors } = validateFieldMappings([
			sprint({
				direction: "sideways",
				createSprints: "yes",
				archiveClosedSprints: 1,
				pullScope: "closed",
				valueMap: { a: "b" },
			}),
		]);
		expect(errors).toEqual([
			'fieldMappings[0]: "direction" must be one of pull, push, both',
			'fieldMappings[0]: "createSprints" must be true or false',
			'fieldMappings[0]: "archiveClosedSprints" must be true or false',
			'fieldMappings[0]: "pullScope" must be one of all, open',
			'fieldMappings[0]: "valueMap" is not supported for sprint mappings; sprints map to milestones by id and name',
		]);
	});

	it("allows only one sprint mapping", () => {
		const { errors } = validateFieldMappings([
			sprint(),
			sprint({ boardId: 3 }),
		]);
		expect(errors).toContain(
			"fieldMappings[1]: only one sprint mapping is allowed (already configured by fieldMappings[0])",
		);
	});

	it("rejects sprint options on other mapping types", () => {
		const { errors } = validateFieldMappings([
			{
				backlog: "milestone",
				jira: "fixVersions",
				type: "version",
				boardId: 12,
			},
		]);
		expect(errors).toEqual([
			'fieldMappings[0]: "boardId" is only valid for "type": "sprint"',
		]);
	});

	it("lists sprint among the valid types", () => {
		const { errors } = validateFieldMappings([
			{ backlog: "milestone", jira: "fixVersions", type: "sprintz" },
		]);
		expect(errors[0]).toContain("array, sprint");
	});
});

describe("loadSprintMapping", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = uniqueTestDir("sprint-mapping-test");
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("returns null when there is no config or no sprint mapping", () => {
		expect(loadSprintMapping(testDir)).toBeNull();
		writeJson(`${testDir}/.backlog-jira/config.json`, { fieldMappings: [] });
		expect(loadSprintMapping(testDir)).toBeNull();
	});

	it("loads the sprint mapping without adding it to the generic mappings", () => {
		writeJson(`${testDir}/.backlog-jira/config.json`, {
			fieldMappings: [sprint({ pullScope: "open" })],
		});
		expect(loadSprintMapping(testDir)).toMatchObject({
			boardId: "12",
			pullScope: "open",
		});
		expect(loadFieldMappings(testDir)).toEqual([]);
	});

	it("throws on an invalid sprint mapping", () => {
		writeJson(`${testDir}/.backlog-jira/config.json`, {
			fieldMappings: [sprint({ boardId: undefined })],
		});
		expect(() => loadSprintMapping(testDir)).toThrow(FieldMappingConfigError);
		expect(() => loadFieldMappings(testDir)).toThrow('requires "boardId"');
	});
});
