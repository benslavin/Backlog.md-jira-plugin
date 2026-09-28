import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir } from "../../test/helpers/fs.ts";
import {
	getTaskFilePath,
	parseFrontmatter,
	updateFrontmatterFields,
	updateJiraMetadata,
} from "./frontmatter.ts";

describe("parseFrontmatter", () => {
	describe("basic parsing", () => {
		it("should parse simple key-value pairs", () => {
			const content = `---
id: task-1
title: Simple title
status: To Do
---

Task body content`;

			const { frontmatter, body } = parseFrontmatter(content);
			expect(frontmatter.id).toBe("task-1");
			expect(frontmatter.title).toBe("Simple title");
			expect(frontmatter.status).toBe("To Do");
			expect(body).toBe("\nTask body content");
		});

		it("should handle empty frontmatter", () => {
			const content = "Task without frontmatter";
			const { frontmatter, body } = parseFrontmatter(content);
			expect(frontmatter).toEqual({});
			expect(body).toBe(content);
		});

		it("should handle arrays", () => {
			const content = `---
labels: [bug, frontend, critical]
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.labels).toEqual(["bug", "frontend", "critical"]);
		});
	});

	describe("multi-line values with folded scalar (>-)", () => {
		it("should parse folded scalar multi-line title", () => {
			const content = `---
id: task-1
title: >-
  This is a very long title
  that spans multiple lines
  but should be folded into one
status: To Do
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe(
				"This is a very long title that spans multiple lines but should be folded into one",
			);
		});

		it("should parse folded scalar with > indicator", () => {
			const content = `---
description: >
  First line
  Second line
  Third line
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.description).toBe("First line Second line Third line");
		});
	});

	describe("multi-line values with literal scalar (|-)", () => {
		it("should parse literal scalar preserving newlines", () => {
			const content = `---
description: |-
  Line one
  Line two
  Line three
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.description).toBe("Line one\nLine two\nLine three");
		});

		it("should parse literal scalar with | indicator", () => {
			const content = `---
notes: |
  First note
  Second note
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.notes).toBe("First note\nSecond note");
		});
	});

	describe("special characters and quoting", () => {
		it("should parse title with square brackets (unquoted)", () => {
			const content = `---
id: task-1
title: "[JIRA-123] Fix bug in authentication"
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("[JIRA-123] Fix bug in authentication");
		});

		it("should parse title with colons (quoted)", () => {
			const content = `---
title: "Feature: Implement login system"
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("Feature: Implement login system");
		});

		it("should parse title with mixed special characters", () => {
			const content = `---
title: '[PROJ-456]: "Critical" bug & issue'
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe('[PROJ-456]: "Critical" bug & issue');
		});

		it("should parse title with hash symbol", () => {
			const content = `---
title: "Task #123: Implementation"
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("Task #123: Implementation");
		});

		it("should parse title with pipe symbol", () => {
			const content = `---
title: "Feature A | Feature B"
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("Feature A | Feature B");
		});

		it("should parse title with curly braces", () => {
			const content = `---
title: "Config {value} update"
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("Config {value} update");
		});
	});

	describe("complex real-world scenarios", () => {
		it("should parse task file with all features", () => {
			const content = `---
id: task-333
title: "[JIRA-789] Fix: User's @mention | notification system"
status: In Progress
priority: High
assignee: "@john-doe"
labels: [bug, backend, critical]
description: >-
  This task involves fixing the notification
  system for user mentions in comments
jira_key: JIRA-789
jira_url: "https://jira.example.com/browse/JIRA-789"
---

## Task Body

Implementation details here.`;

			const { frontmatter, body } = parseFrontmatter(content);
			expect(frontmatter.id).toBe("task-333");
			expect(frontmatter.title).toBe(
				"[JIRA-789] Fix: User's @mention | notification system",
			);
			expect(frontmatter.status).toBe("In Progress");
			expect(frontmatter.priority).toBe("High");
			expect(frontmatter.assignee).toBe("@john-doe");
			expect(frontmatter.labels).toEqual(["bug", "backend", "critical"]);
			expect(frontmatter.description).toBe(
				"This task involves fixing the notification system for user mentions in comments",
			);
			expect(frontmatter.jira_key).toBe("JIRA-789");
			expect(frontmatter.jira_url).toBe(
				"https://jira.example.com/browse/JIRA-789",
			);
			expect(body).toContain("## Task Body");
		});

		it("should handle task with escaped quotes in title", () => {
			const content = `---
title: 'Task with "quoted" text inside'
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe('Task with "quoted" text inside');
		});

		it("should handle mixed indentation in multi-line values", () => {
			const content = `---
plan: |-
  Step 1: Research
  Step 2: Implement
  Step 3: Test
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.plan).toBe(
				"Step 1: Research\nStep 2: Implement\nStep 3: Test",
			);
		});
	});

	describe("edge cases", () => {
		it("should handle empty values", () => {
			const content = `---
title: ""
description:
status: To Do
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("");
			expect(frontmatter.description).toBe("");
			expect(frontmatter.status).toBe("To Do");
		});

		it("should handle values with leading/trailing whitespace", () => {
			const content = `---
title: "  Padded title  "
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.title).toBe("  Padded title  ");
		});

		it("should handle multiple consecutive multi-line blocks", () => {
			const content = `---
description: >-
  First block
  continues here
notes: >-
  Second block
  also continues
---

Body`;

			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter.description).toBe("First block continues here");
			expect(frontmatter.notes).toBe("Second block also continues");
		});
	});
});

describe("block sequences and quoting (Backlog.md 1.5x format)", () => {
	it("parses block sequence lists", () => {
		const content = `---
id: TASK-345
title: 'Phase 2: push'
assignee: []
labels:
  - jira
  - sync
dependencies:
  - TASK-344
priority: medium
---
body`;

		const { frontmatter } = parseFrontmatter(content);
		expect(frontmatter.title).toBe("Phase 2: push");
		expect(frontmatter.assignee).toEqual([]);
		expect(frontmatter.labels).toEqual(["jira", "sync"]);
		expect(frontmatter.dependencies).toEqual(["TASK-344"]);
		expect(frontmatter.priority).toBe("medium");
	});

	it("unescapes quotes in single- and double-quoted values", () => {
		const content = `---
a: 'it''s'
b: "say \\"hi\\""
c: ["x, y", 'z']
---
`;
		const { frontmatter } = parseFrontmatter(content);
		expect(frontmatter.a).toBe("it's");
		expect(frontmatter.b).toBe('say "hi"');
		expect(frontmatter.c).toEqual(["x, y", "z"]);
	});
});

describe("frontmatter writers", () => {
	let testDir: string;
	let filePath: string;

	beforeEach(() => {
		testDir = uniqueTestDir("frontmatter-test");
		filePath = join(testDir, "task.md");
		writeFileSync(
			filePath,
			`---
id: TASK-1
title: One
labels:
  - a
  - b
dependencies:
  - TASK-2
---

## Description
`,
		);
	});

	afterEach(() => {
		cleanupDir(testDir);
	});

	it("preserves block lists when updating Jira metadata", () => {
		updateJiraMetadata(filePath, { jiraKey: "PROJ-1" });
		const { frontmatter, body } = parseFrontmatter(
			readFileSync(filePath, "utf-8"),
		);
		expect(frontmatter.labels).toEqual(["a", "b"]);
		expect(frontmatter.dependencies).toEqual(["TASK-2"]);
		expect(frontmatter.jira_key).toBe("PROJ-1");
		expect(body).toBe("\n## Description\n");
	});

	it("sets, round-trips and removes plugin frontmatter fields", () => {
		updateFrontmatterFields(filePath, {
			story_points: "5",
			team: "Core: Platform",
			components: ["API", "UI, Web"],
			quote: 'a "b" \\ c',
		});

		let { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
		expect(frontmatter.story_points).toBe("5");
		expect(frontmatter.team).toBe("Core: Platform");
		expect(frontmatter.components).toEqual(["API", "UI, Web"]);
		expect(frontmatter.quote).toBe('a "b" \\ c');
		expect(frontmatter.labels).toEqual(["a", "b"]);

		updateFrontmatterFields(filePath, { story_points: null });
		({ frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8")));
		expect("story_points" in frontmatter).toBe(false);
		expect(frontmatter.team).toBe("Core: Platform");
	});
});

describe("getTaskFilePath", () => {
	let testDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = uniqueTestDir("task-path-test");
		mkdirSync(join(testDir, "backlog", "tasks"), { recursive: true });
		writeFileSync(join(testDir, "backlog", "tasks", "task-7 - Seven.md"), "");
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("matches task IDs case-insensitively", () => {
		expect(getTaskFilePath("task-7")).toEndWith("task-7 - Seven.md");
		expect(getTaskFilePath("TASK-7")).toEndWith("task-7 - Seven.md");
	});
});
