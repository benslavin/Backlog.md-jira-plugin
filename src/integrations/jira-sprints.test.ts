import { describe, expect, it, mock } from "bun:test";
import {
	type JiraSprint,
	SPRINT_FIELD_SCHEMA,
	findSprintFieldId,
	parseBoard,
	parseSprint,
	parseSprintFieldValue,
} from "./jira-sprints.ts";
import { JiraClient, type JiraIssue } from "./jira.ts";

type ToolCall = [string, Record<string, unknown>];

function mockTools(
	client: JiraClient,
	handler: (tool: string, input: Record<string, unknown>) => unknown,
) {
	const callMcpTool = mock((tool: string, input: Record<string, unknown>) =>
		Promise.resolve(handler(tool, input)),
	);
	(client as unknown as { callMcpTool: unknown }).callMcpTool = callMcpTool;
	return callMcpTool;
}

function issueWith(fields: Record<string, unknown>): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Issue",
		status: "To Do",
		issueType: "Task",
		created: "",
		updated: "",
		fields,
	};
}

describe("parseSprint", () => {
	it("parses Agile API sprint objects", () => {
		expect(
			parseSprint({
				id: 37,
				self: "https://example.atlassian.net/rest/agile/1.0/sprint/37",
				state: "closed",
				name: "Sprint 1",
				startDate: "2026-09-01T09:00:00.000Z",
				endDate: "2026-09-14T17:00:00.000Z",
				completeDate: "2026-09-15T10:00:00.000Z",
				originBoardId: 5,
				goal: "Ship sync",
			}),
		).toEqual({
			id: "37",
			name: "Sprint 1",
			state: "closed",
			startDate: "2026-09-01T09:00:00.000Z",
			endDate: "2026-09-14T17:00:00.000Z",
			completeDate: "2026-09-15T10:00:00.000Z",
			goal: "Ship sync",
			boardId: "5",
		});
	});

	it("parses MCP simplified sprints with snake_case dates", () => {
		expect(
			parseSprint({
				id: "38",
				name: "Sprint 2",
				state: "active",
				start_date: "2026-09-15T09:00:00.000Z",
				end_date: "2026-09-28T17:00:00.000Z",
			}),
		).toEqual({
			id: "38",
			name: "Sprint 2",
			state: "active",
			startDate: "2026-09-15T09:00:00.000Z",
			endDate: "2026-09-28T17:00:00.000Z",
		});
	});

	it("parses legacy Jira Server sprint strings, including commas in names", () => {
		expect(
			parseSprint(
				"com.atlassian.greenhopper.service.sprint.Sprint@1f2e3d[id=12,rapidViewId=3,state=CLOSED,name=Sprint 4, hardening,goal=,startDate=2026-08-01T09:00:00.000Z,endDate=2026-08-14T17:00:00.000Z,completeDate=<null>,sequence=12]",
			),
		).toEqual({
			id: "12",
			name: "Sprint 4, hardening",
			state: "closed",
			startDate: "2026-08-01T09:00:00.000Z",
			endDate: "2026-08-14T17:00:00.000Z",
			boardId: "3",
		});
	});

	it("rejects values that are not sprints", () => {
		expect(parseSprint(null)).toBeNull();
		expect(parseSprint("Sprint 1")).toBeNull();
		expect(parseSprint({ id: "1", name: "No state" })).toBeNull();
		expect(parseSprint({ id: "-1", name: "Unknown", state: "future" })).toBe(
			null,
		);
		expect(parseSprint({ id: "1", name: "Bad", state: "archived" })).toBeNull();
	});
});

describe("parseSprintFieldValue", () => {
	it("parses raw arrays and MCP value wrappers", () => {
		const sprints = [
			{ id: 1, name: "Sprint 1", state: "closed", boardId: 5 },
			{ id: 2, name: "Sprint 2", state: "active", boardId: 5 },
		];
		const expected: JiraSprint[] = [
			{ id: "1", name: "Sprint 1", state: "closed", boardId: "5" },
			{ id: "2", name: "Sprint 2", state: "active", boardId: "5" },
		];
		expect(parseSprintFieldValue(sprints)).toEqual(expected);
		expect(parseSprintFieldValue({ value: sprints, name: "Sprint" })).toEqual(
			expected,
		);
	});

	it("parses a single sprint and drops unparseable entries", () => {
		expect(
			parseSprintFieldValue({ id: 3, name: "Sprint 3", state: "future" }),
		).toEqual([{ id: "3", name: "Sprint 3", state: "future" }]);
		expect(
			parseSprintFieldValue([
				"garbage",
				{ id: 3, name: "Sprint 3", state: "FUTURE" },
			]),
		).toEqual([{ id: "3", name: "Sprint 3", state: "future" }]);
	});

	it("returns an empty list for missing or empty values", () => {
		expect(parseSprintFieldValue(undefined)).toEqual([]);
		expect(parseSprintFieldValue(null)).toEqual([]);
		expect(parseSprintFieldValue([])).toEqual([]);
		expect(parseSprintFieldValue({ value: null, name: "Sprint" })).toEqual([]);
	});
});

describe("findSprintFieldId", () => {
	it("finds the field by gh-sprint schema, not by name", () => {
		expect(
			findSprintFieldId([
				{ id: "customfield_10001", schema: { custom: "other:sprint-ish" } },
				{ id: "customfield_10104", schema: { custom: SPRINT_FIELD_SCHEMA } },
			]),
		).toBe("customfield_10104");
		expect(findSprintFieldId([{ id: "summary" }])).toBeNull();
	});
});

describe("parseBoard", () => {
	it("reports whether a board supports sprints", () => {
		expect(parseBoard({ id: 5, name: "Team board", type: "scrum" })).toEqual({
			id: "5",
			name: "Team board",
			type: "scrum",
			supportsSprints: true,
		});
		expect(parseBoard({ id: "6", name: "Flow", type: "kanban" })).toEqual({
			id: "6",
			name: "Flow",
			type: "kanban",
			supportsSprints: false,
		});
		expect(parseBoard({ name: "No id" })).toBeNull();
	});
});

describe("JiraClient sprint operations", () => {
	it("lists all sprints of a board across pages", async () => {
		const client = new JiraClient();
		const page1 = Array.from({ length: 50 }, (_, i) => ({
			id: String(i + 1),
			name: `Sprint ${i + 1}`,
			state: "closed",
			start_date: "2026-01-01T00:00:00.000Z",
			end_date: "2026-01-14T00:00:00.000Z",
		}));
		const page2 = [
			{ id: "51", name: "Sprint 51", state: "active", goal: "Finish" },
			{ id: "52", name: "Sprint 52", state: "future" },
		];
		const calls = mockTools(client, (_tool, input) =>
			input.start_at === 0 ? page1 : page2,
		);

		const sprints = await client.getBoardSprints(5);

		expect(calls.mock.calls as unknown as ToolCall[]).toEqual([
			[
				"jira_get_sprints_from_board",
				{ board_id: "5", start_at: 0, limit: 50 },
			],
			[
				"jira_get_sprints_from_board",
				{ board_id: "5", start_at: 50, limit: 50 },
			],
		]);
		expect(sprints).toHaveLength(52);
		expect(sprints[0]).toEqual({
			id: "1",
			name: "Sprint 1",
			state: "closed",
			startDate: "2026-01-01T00:00:00.000Z",
			endDate: "2026-01-14T00:00:00.000Z",
			boardId: "5",
		});
		expect(sprints.slice(50).map((s) => [s.state, s.goal])).toEqual([
			["active", "Finish"],
			["future", undefined],
		]);
	});

	it("filters sprints by state", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => []);
		await client.getBoardSprints("5", { state: ["active", "future"] });
		expect(calls).toHaveBeenCalledWith("jira_get_sprints_from_board", {
			board_id: "5",
			start_at: 0,
			limit: 50,
			state: "active,future",
		});
	});

	it("moves an issue into a sprint and back to the backlog", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => ({ message: "ok" }));

		await client.moveIssueToSprint("PROJ-1", 42);
		await client.moveIssueToBacklog("PROJ-1");

		expect(calls.mock.calls as unknown as ToolCall[]).toEqual([
			["jira_add_issues_to_sprint", { sprint_id: "42", issue_keys: "PROJ-1" }],
			["jira_move_issues_to_backlog", { issue_keys: "PROJ-1" }],
		]);
	});

	it("creates a future sprint with name, end date and goal", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, (_tool, input) => ({
			id: "77",
			name: input.name,
			state: "future",
			start_date: input.start_date,
			end_date: input.end_date,
			goal: input.goal,
		}));
		const endDate = new Date(Date.now() + 14 * 86_400_000).toISOString();

		const sprint = await client.createSprint(5, {
			name: "Sprint 9",
			endDate,
			goal: "Ship sprints",
		});

		const [tool, input] = (calls.mock.calls as unknown as ToolCall[])[0];
		expect(tool).toBe("jira_create_sprint");
		expect(input).toMatchObject({
			board_id: "5",
			name: "Sprint 9",
			end_date: endDate,
			goal: "Ship sprints",
		});
		// MCP Atlassian rejects start dates in the past
		expect(Date.parse(input.start_date as string)).toBeGreaterThan(Date.now());
		expect(sprint).toMatchObject({
			id: "77",
			name: "Sprint 9",
			state: "future",
			endDate,
			goal: "Ship sprints",
			boardId: "5",
		});
	});

	it("creates a sprint without end date or goal", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => ({
			id: "78",
			name: "Sprint 10",
			state: "future",
		}));

		await client.createSprint("5", { name: "Sprint 10" });

		const input = (calls.mock.calls as unknown as ToolCall[])[0][1];
		expect(input.end_date).toBe("");
		expect("goal" in input).toBe(false);
	});

	it("refuses to create a sprint ending before it starts", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => ({}));
		await expect(
			client.createSprint(5, {
				name: "Late",
				endDate: "2020-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("must be after its start date");
		expect(calls).not.toHaveBeenCalled();
	});

	it("discovers the Sprint field id once from field metadata", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => [
			{
				id: "customfield_10020",
				name: "Sprint",
				schema: { custom: SPRINT_FIELD_SCHEMA },
			},
			{ id: "customfield_10021", name: "Sprint Points" },
		]);

		expect(await client.getSprintFieldId()).toBe("customfield_10020");
		expect(await client.getSprintFieldId()).toBe("customfield_10020");
		expect(calls).toHaveBeenCalledTimes(1);
		expect(calls).toHaveBeenCalledWith("jira_search_fields", {
			keyword: "sprint",
			limit: 50,
		});
	});

	it("returns null when the site has no Sprint field", async () => {
		const client = new JiraClient();
		mockTools(client, () => [{ id: "customfield_1", name: "Other" }]);
		expect(await client.getSprintFieldId()).toBeNull();
	});

	it("reports board type and sprint support", async () => {
		const client = new JiraClient();
		const calls = mockTools(client, () => [
			{ id: "4", name: "Flow", type: "kanban" },
			{ id: "5", name: "Team", type: "scrum" },
		]);

		expect(await client.getBoard(5, { projectKey: "PROJ" })).toEqual({
			id: "5",
			name: "Team",
			type: "scrum",
			supportsSprints: true,
		});
		expect((await client.getBoard("4"))?.supportsSprints).toBe(false);
		expect(await client.getBoard("99")).toBeNull();
		expect(calls).toHaveBeenCalledWith("jira_get_agile_boards", {
			start_at: 0,
			limit: 50,
			project_key: "PROJ",
		});
	});

	it("lists boards across pages", async () => {
		const client = new JiraClient();
		const page = Array.from({ length: 50 }, (_, i) => ({
			id: i + 1,
			name: `Board ${i + 1}`,
			type: "scrum",
		}));
		const calls = mockTools(client, (_tool, input) =>
			input.start_at === 0 ? page : [{ id: 51, name: "Flow", type: "kanban" }],
		);
		const boards = await client.listBoards({ projectKey: "PROJ" });
		expect(boards).toHaveLength(51);
		expect(boards[50]).toEqual({
			id: "51",
			name: "Flow",
			type: "kanban",
			supportsSprints: false,
		});
		expect(calls).toHaveBeenCalledWith("jira_get_agile_boards", {
			start_at: 50,
			limit: 50,
			project_key: "PROJ",
		});
	});

	it("parses the sprints of an issue", async () => {
		const client = new JiraClient();
		mockTools(client, () => [
			{ id: "customfield_10020", schema: { custom: SPRINT_FIELD_SCHEMA } },
		]);
		const issue = issueWith({
			customfield_10020: {
				value: [{ id: 2, name: "Sprint 2", state: "active", boardId: 5 }],
				name: "Sprint",
			},
		});

		expect(await client.getIssueSprints(issue)).toEqual([
			{ id: "2", name: "Sprint 2", state: "active", boardId: "5" },
		]);
		expect(
			await client.getIssueSprints(issueWith({}), "customfield_1"),
		).toEqual([]);
	});

	it("explains how to enable the agile toolset when tools are missing", async () => {
		const client = new JiraClient();
		(client as unknown as { callMcpTool: unknown }).callMcpTool = mock(() =>
			Promise.reject(new Error("Unknown tool: jira_get_sprints_from_board")),
		);
		await expect(client.getBoardSprints(5)).rejects.toThrow("jira_agile");
	});
});
