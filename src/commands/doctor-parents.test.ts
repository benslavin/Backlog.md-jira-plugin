import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import { logger } from "../utils/logger.ts";
import { writeTaskLink } from "../utils/task-links.ts";
import { checkParentLinks } from "./doctor.ts";

describe("doctor: parent links", () => {
	let testDir: string;
	let originalCwd: string;
	let originalUrl: string | undefined;
	let lines: { info: string[]; warn: string[] };

	function writeTask(id: string, jiraKey?: string, parent?: string): void {
		const tasksDir = join(testDir, "backlog", "tasks");
		mkdirSync(tasksDir, { recursive: true });
		writeFileSync(
			join(tasksDir, `${id} - Task.md`),
			`---\nid: ${id.toUpperCase()}\ntitle: Task\n${parent ? `parent_task_id: ${parent.toUpperCase()}\n` : ""}${jiraKey ? `jira_key: ${jiraKey}\n` : ""}---\n`,
			"utf-8",
		);
	}

	function configure(config: Record<string, unknown> = {}): void {
		writeJson(join(testDir, ".backlog-jira", "config.json"), {
			jira: { projectKey: "PROJ" },
			...config,
		});
	}

	const jira = (fields: Array<{ id: string; name: string }> | Error) => ({
		searchFields: mock(async () => {
			if (fields instanceof Error) throw fields;
			return fields;
		}),
	});

	beforeEach(() => {
		originalCwd = process.cwd();
		originalUrl = process.env.JIRA_URL;
		testDir = uniqueTestDir("doctor-parents-test");
		process.chdir(testDir);
		lines = { info: [], warn: [] };
		for (const level of ["info", "warn"] as const) {
			spyOn(logger, level).mockImplementation(((message: unknown) => {
				lines[level].push(String(message));
			}) as never);
		}
	});

	afterEach(() => {
		mock.restore();
		if (originalUrl === undefined) delete process.env.JIRA_URL;
		else process.env.JIRA_URL = originalUrl;
		process.chdir(originalCwd);
		cleanupDir(testDir);
	});

	it("lists linked tasks whose parent cannot be synced", async () => {
		configure();
		process.env.JIRA_URL = "https://acme.atlassian.net";
		writeTask("task-1");
		writeTask("task-2", "PROJ-2", "task-1");
		writeTask("task-3", "PROJ-3");
		writeTaskLink("task-3", {
			jiraKey: "PROJ-3",
			parentProblem: "PROJ-3 is a standard issue",
		});

		const warnings = await checkParentLinks(jira([]));

		expect(warnings).toBe(2);
		expect(lines.warn.join("\n")).toContain(
			"TASK-2 ⇄ PROJ-2: parent TASK-1 is not linked to Jira",
		);
		expect(lines.warn.join("\n")).toContain(
			"TASK-3 ⇄ PROJ-3: PROJ-3 is a standard issue",
		);
	});

	it("passes when every parent link can be synced", async () => {
		configure();
		process.env.JIRA_URL = "https://acme.atlassian.net";
		writeTask("task-1", "PROJ-1");
		writeTask("task-2", "PROJ-2", "task-1");

		expect(await checkParentLinks(jira([]))).toBe(0);
		expect(lines.info).toContain(
			"  ✓ Parent links of linked tasks can be synced",
		);
	});

	it("reports the Epic Link field on Jira Server/Data Center", async () => {
		configure();
		process.env.JIRA_URL = "https://jira.acme.com";
		const found = jira([{ id: "customfield_10100", name: "Epic Link" }]);

		expect(await checkParentLinks(found)).toBe(0);
		expect(lines.info).toContain(
			"  ✓ Epics are linked through the Epic Link field customfield_10100",
		);

		expect(await checkParentLinks(jira([]))).toBe(1);
		expect(lines.warn[0]).toContain("No Epic Link field found");

		expect(await checkParentLinks(jira(new Error("401 Unauthorized")))).toBe(1);
		expect(lines.warn[1]).toContain(
			"Could not look up the Epic Link field: 401 Unauthorized",
		);
	});

	it("uses a configured epic link without asking Jira", async () => {
		configure({ jira: { projectKey: "PROJ", epicLinkField: "customfield_7" } });
		process.env.JIRA_URL = "https://jira.acme.com";
		const client = jira([]);

		expect(await checkParentLinks(client)).toBe(0);
		expect(client.searchFields).not.toHaveBeenCalled();
		expect(lines.info[0]).toContain("customfield_7");
	});

	it("says when parent links are off", async () => {
		configure({ sync: { parentLinks: false } });
		writeTask("task-2", "PROJ-2", "task-1");

		expect(await checkParentLinks(jira([]))).toBe(0);
		expect(lines.info).toEqual([
			"  ✓ Parent links are not synced (sync.parentLinks: false)",
		]);
	});
});
