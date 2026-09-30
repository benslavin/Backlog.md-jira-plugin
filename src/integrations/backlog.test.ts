import { describe, expect, it, mock } from "bun:test";
import { BacklogClient } from "./backlog.ts";

describe("BacklogClient", () => {
	describe("parseTaskList", () => {
		it("should parse task list output correctly", async () => {
			const client = new BacklogClient();
			const mockOutput = `task-1 - First Task (To Do) [@alice] [frontend,bug] [high]
task-2 - Second Task (In Progress) [@bob]
task-3 - Third Task (Done)`;

			// Access private method through type assertion for testing
			const tasks = (
				client as unknown as { parseTaskList: (output: string) => unknown[] }
			).parseTaskList(mockOutput);

			expect(tasks).toHaveLength(3);
			expect(tasks[0]).toMatchObject({
				id: "task-1",
				title: "First Task",
				status: "To Do",
				assignee: "alice",
				labels: ["frontend", "bug"],
				priority: "high",
			});
		});

		it("should handle empty output", async () => {
			const client = new BacklogClient();
			const tasks = (
				client as unknown as { parseTaskList: (output: string) => unknown[] }
			).parseTaskList("");
			expect(tasks).toHaveLength(0);
		});
	});

	describe("parseTaskDetail", () => {
		it("should parse task detail output correctly", async () => {
			const client = new BacklogClient();
			const mockOutput = `Task task-42 - Test Task
==================================================

Status: ○ To Do
Assignee: @alice
Labels: backend, api
Priority: high
Created: 2025-01-01 10:00
Updated: 2025-01-02 15:30

Description:
--------------------------------------------------
This is a test task

Acceptance Criteria:
--------------------------------------------------
- [ ] #1 First criterion
- [x] #2 Second criterion
- [ ] #3 Third criterion

Implementation Plan:
--------------------------------------------------
1. Step one
2. Step two`;

			const task = (
				client as unknown as { parseTaskDetail: (output: string) => unknown }
			).parseTaskDetail(mockOutput);

			// The parser extracts all sections from the output
			expect(task).toMatchObject({
				id: "task-42",
				title: "Test Task",
				status: "To Do",
				assignee: "alice",
				labels: ["backend", "api"],
				priority: "high",
				description: "This is a test task",
				acceptanceCriteria: expect.any(Array),
				implementationPlan: expect.any(String),
			});
		});

		it("should parse acceptance criteria correctly", async () => {
			const client = new BacklogClient();
			const mockOutput = `Task task-1 - Test
==================================================

Status: ○ To Do

Acceptance Criteria:
--------------------------------------------------
- [ ] #1 First criterion
- [x] #2 Second criterion`;

			const task = (
				client as unknown as {
					parseTaskDetail: (output: string) => {
						acceptanceCriteria: unknown[];
					};
				}
			).parseTaskDetail(mockOutput);

			expect(task.acceptanceCriteria).toHaveLength(2);
			expect(task.acceptanceCriteria?.[0]).toMatchObject({
				index: 1,
				text: "First criterion",
				checked: false,
			});
			expect(task.acceptanceCriteria?.[1]).toMatchObject({
				index: 2,
				text: "Second criterion",
				checked: true,
			});
		});
	});

	describe("updateTask", () => {
		it("should build correct command arguments", async () => {
			const client = new BacklogClient();

			// Mock the execute method
			const executeMock = mock(() => Promise.resolve(""));
			(client as unknown as { execute: unknown }).execute = executeMock;

			await client.updateTask("task-1", {
				title: "New Title",
				status: "In Progress",
				assignee: "alice",
				checkAc: [1, 2],
				uncheckAc: [3],
			});

			expect(executeMock).toHaveBeenCalledWith([
				"task",
				"edit",
				"task-1",
				"-t",
				"New Title",
				"-s",
				"In Progress",
				"-a",
				"alice",
				"--check-ac",
				"1",
				"--check-ac",
				"2",
				"--uncheck-ac",
				"3",
			]);
		});
	});

	describe("listTasks", () => {
		it("should build correct command with filters", async () => {
			const client = new BacklogClient();

			const executeMock = mock(() => Promise.resolve(""));
			(client as unknown as { execute: unknown }).execute = executeMock;

			await client.listTasks({
				status: "To Do",
				assignee: "alice",
				labels: ["backend", "api"],
				priority: "high",
			});

			expect(executeMock).toHaveBeenCalledWith([
				"task",
				"list",
				"--plain",
				"-s",
				"To Do",
				"-a",
				"alice",
				"-l",
				"backend,api",
				"--priority",
				"high",
			]);
		});
	});

	describe("Backlog.md 1.5x output (upper-case IDs)", () => {
		type Parsers = {
			parseTaskList: (output: string) => unknown[];
			parseTaskDetail: (output: string) => { id: string; title: string };
			parseCreatedTaskId: (output: string) => string | null;
		};
		const parsers = () => new BacklogClient() as unknown as Parsers;

		it("parses the status-grouped task list", () => {
			const output = `To Do:
  TASK-1.1 - Sub

In Progress:
  TASK-1 - Hello (ac: 0/1)

Done:
  [HIGH] TASK-2 - Second one
`;
			expect(parsers().parseTaskList(output)).toEqual([
				{ id: "task-1.1", title: "Sub", status: "To Do", priority: undefined },
				{
					id: "task-1",
					title: "Hello",
					status: "In Progress",
					priority: undefined,
				},
				{ id: "task-2", title: "Second one", status: "Done", priority: "high" },
			]);
		});

		it("parses upper-case IDs in the legacy list layout", () => {
			const tasks = parsers().parseTaskList("TASK-7 - Seven (To Do)");
			expect(tasks).toEqual([
				expect.objectContaining({ id: "task-7", status: "To Do" }),
			]);
		});

		it("parses upper-case IDs in task detail", () => {
			const output = `File: /repo/backlog/tasks/task-1 - Hello.md

Task TASK-1 - Hello
==================================================

Status: ◒ In Progress
Priority: High
Ordinal: 1000
Created: 2026-09-28 20:42 (UTC)
`;
			const task = parsers().parseTaskDetail(output);
			expect(task).toMatchObject({
				id: "task-1",
				title: "Hello",
				status: "In Progress",
			});
		});

		it("reads a task without a description as having none", () => {
			const detail = (description: string) => `Task TASK-1 - Hello
==================================================

Status: ○ To Do

Description:
--------------------------------------------------
${description}

Acceptance Criteria:
--------------------------------------------------
No acceptance criteria defined
`;
			const p = parsers() as unknown as {
				parseTaskDetail: (output: string) => { description?: string };
			};
			expect(
				p.parseTaskDetail(detail("No description provided")).description,
			).toBeUndefined();
			expect(p.parseTaskDetail(detail("Real text")).description).toBe(
				"Real text",
			);
		});

		it("parses the created task ID from create output", () => {
			const p = parsers();
			expect(
				p.parseCreatedTaskId(
					"Created task TASK-12\nFile: /repo/backlog/tasks/task-12 - Hello.md\n",
				),
			).toBe("task-12");
			expect(p.parseCreatedTaskId("Created task-3")).toBe("task-3");
			expect(p.parseCreatedTaskId("TASK-4.1")).toBe("task-4.1");
			expect(p.parseCreatedTaskId("nothing here")).toBeNull();
		});
	});
});
