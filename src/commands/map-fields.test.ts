import { describe, expect, it } from "bun:test";
import { FieldMappingConfigError } from "../utils/field-mapping.ts";
import {
	addFieldMapping,
	parseValueMapEntries,
	removeFieldMapping,
} from "./map-fields.ts";

describe("map-fields", () => {
	describe("addFieldMapping", () => {
		it("adds a mapping and keeps the rest of the config", () => {
			const config = addFieldMapping(
				{ jira: { projectKey: "PROJ" } },
				{
					backlog: "frontmatter:story_points",
					jira: "customfield_10016",
					type: "number",
				},
			);

			expect(config.jira).toEqual({ projectKey: "PROJ" });
			expect(config.fieldMappings).toEqual([
				{
					backlog: "frontmatter:story_points",
					jira: "customfield_10016",
					type: "number",
					direction: "pull",
				},
			]);
		});

		it("stores a valueMap when given", () => {
			const config = addFieldMapping(
				{},
				{
					backlog: "priority",
					jira: "customfield_1",
					type: "option",
					valueMap: { P1: "high" },
				},
			);
			expect(config.fieldMappings).toEqual([
				{
					backlog: "priority",
					jira: "customfield_1",
					type: "option",
					direction: "pull",
					valueMap: { P1: "high" },
				},
			]);
		});

		it("refuses to overwrite an existing target without force", () => {
			const config = addFieldMapping(
				{},
				{ backlog: "milestone", jira: "fixVersions", type: "version" },
			);
			expect(() =>
				addFieldMapping(config, {
					backlog: "milestone",
					jira: "customfield_2",
					type: "string",
				}),
			).toThrow(/already exists/);

			const replaced = addFieldMapping(
				config,
				{ backlog: "milestone", jira: "customfield_2", type: "string" },
				{ force: true },
			);
			expect(replaced.fieldMappings).toEqual([
				{
					backlog: "milestone",
					jira: "customfield_2",
					type: "string",
					direction: "pull",
				},
			]);
		});

		it("rejects invalid mappings with a clear error", () => {
			expect(() =>
				addFieldMapping(
					{},
					{
						backlog: "frontmatter:jira_key",
						jira: "customfield_1",
						type: "string",
					},
				),
			).toThrow(FieldMappingConfigError);
			expect(() =>
				addFieldMapping(
					{},
					{ backlog: "milestone", jira: "customfield_1", type: "bogus" },
				),
			).toThrow(/"type" must be one of/);
		});
	});

	describe("removeFieldMapping", () => {
		it("removes the mapping for a target", () => {
			const config = addFieldMapping(
				{},
				{ backlog: "milestone", jira: "fixVersions", type: "version" },
			);
			expect(removeFieldMapping(config, "milestone").fieldMappings).toEqual([]);
		});

		it("errors when the target is not mapped", () => {
			expect(() => removeFieldMapping({}, "milestone")).toThrow(
				'No field mapping found for "milestone"',
			);
		});
	});

	describe("parseValueMapEntries", () => {
		it("parses Jira=Backlog pairs", () => {
			expect(parseValueMapEntries(["Highest=high", "Low = low"])).toEqual({
				Highest: "high",
				Low: "low",
			});
			expect(parseValueMapEntries([])).toBeUndefined();
		});

		it("rejects entries without a separator", () => {
			expect(() => parseValueMapEntries(["nope"])).toThrow(
				/Invalid --value-map entry/,
			);
		});
	});
});
