import { describe, expect, it } from "bun:test";
import {
	findEpicLinkFieldId,
	isJiraCloudUrl,
	kindOfIssue,
	kindOfIssueType,
	parseIssueParent,
} from "./jira-hierarchy.ts";

describe("kindOfIssueType", () => {
	it("tells epics, standard issues and subtasks apart by name", () => {
		expect(kindOfIssueType({ name: "Epic" })).toBe("epic");
		expect(kindOfIssueType({ name: "Story" })).toBe("standard");
		expect(kindOfIssueType({ name: "Sub-task" })).toBe("subtask");
		expect(kindOfIssueType({ name: "Subtask" })).toBe("subtask");
		expect(kindOfIssueType({})).toBeUndefined();
	});

	it("prefers Jira's subtask flag and hierarchy level over the name", () => {
		expect(kindOfIssueType({ name: "Bit", subtask: true })).toBe("subtask");
		expect(kindOfIssueType({ name: "Bit", hierarchyLevel: -1 })).toBe(
			"subtask",
		);
		expect(kindOfIssueType({ name: "Initiative", hierarchyLevel: 1 })).toBe(
			"epic",
		);
		expect(kindOfIssueType({ subtask: false })).toBe("standard");
	});
});

describe("parseIssueParent", () => {
	it("reads Jira's parent object as MCP Atlassian returns it", () => {
		expect(
			parseIssueParent({
				parent: {
					id: "1",
					key: "PROJ-5",
					fields: {
						summary: "Parent",
						issuetype: { name: "Story", subtask: false, hierarchyLevel: 0 },
					},
				},
			}),
		).toEqual({
			key: "PROJ-5",
			issueType: "Story",
			kind: "standard",
			via: "parent",
		});
	});

	it("recognises an epic parent (Jira Cloud)", () => {
		expect(
			parseIssueParent({
				parent: { key: "PROJ-1", fields: { issuetype: { name: "Epic" } } },
			}),
		).toMatchObject({ key: "PROJ-1", kind: "epic", via: "parent" });
	});

	it("reads the Epic Link field (Jira Server/Data Center) when no parent is set", () => {
		expect(
			parseIssueParent(
				{ customfield_10100: { value: "PROJ-9" } },
				"customfield_10100",
			),
		).toEqual({ key: "PROJ-9", kind: "epic", via: "epicLink" });
		expect(
			parseIssueParent({ customfield_10100: "PROJ-9" }, "customfield_10100"),
		).toMatchObject({ key: "PROJ-9", via: "epicLink" });
	});

	it("returns null when the issue has neither", () => {
		expect(parseIssueParent({ summary: "x" }, "customfield_10100")).toBeNull();
		expect(
			parseIssueParent(
				{ customfield_10100: { value: null } },
				"customfield_10100",
			),
		).toBeNull();
		expect(parseIssueParent(undefined)).toBeNull();
	});

	it("reads fields nested under fields", () => {
		expect(
			parseIssueParent({ fields: { parent: { key: "PROJ-2" } } }),
		).toMatchObject({ key: "PROJ-2", via: "parent" });
	});
});

describe("kindOfIssue", () => {
	it("uses the issue type name", () => {
		expect(kindOfIssue({ issueType: "Epic" })).toBe("epic");
		expect(kindOfIssue({ issueType: "Sub-task" })).toBe("subtask");
		expect(kindOfIssue({ issueType: "Task" })).toBe("standard");
	});

	it("treats a custom-named type under a standard parent as a subtask", () => {
		expect(
			kindOfIssue({
				issueType: "Technical step",
				parent: { key: "PROJ-1", kind: "standard", via: "parent" },
			}),
		).toBe("subtask");
		expect(
			kindOfIssue({
				issueType: "Story",
				parent: { key: "PROJ-1", kind: "epic", via: "parent" },
			}),
		).toBe("standard");
	});
});

describe("isJiraCloudUrl", () => {
	it("matches Atlassian Cloud hosts only", () => {
		expect(isJiraCloudUrl("https://acme.atlassian.net")).toBe(true);
		expect(isJiraCloudUrl("https://jira.acme.com")).toBe(false);
		expect(isJiraCloudUrl("not a url")).toBe(false);
		expect(isJiraCloudUrl(undefined)).toBe(false);
	});
});

describe("findEpicLinkFieldId", () => {
	it("finds the Epic Link field by schema, else by name", () => {
		expect(
			findEpicLinkFieldId([
				{ id: "customfield_1", name: "Epic Name" },
				{
					id: "customfield_2",
					name: "Link to epic",
					schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
				},
			]),
		).toBe("customfield_2");
		expect(
			findEpicLinkFieldId([{ id: "customfield_3", name: "Epic Link" }]),
		).toBe("customfield_3");
		expect(
			findEpicLinkFieldId([{ id: "summary", name: "Summary" }]),
		).toBeNull();
	});
});
