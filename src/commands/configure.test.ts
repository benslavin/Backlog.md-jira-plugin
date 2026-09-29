import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptObject } from "prompts";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import type { RawConfig } from "../utils/config-file.ts";
import { CONFIGURE_STEPS, type WizardJira, runConfigure } from "./configure.ts";

const JIRA_ENV = [
	"JIRA_URL",
	"JIRA_EMAIL",
	"JIRA_USERNAME",
	"JIRA_API_TOKEN",
	"JIRA_PERSONAL_TOKEN",
];

type Answer = unknown | ((question: PromptObject) => unknown);

let testDir: string;
let output: string[];
let savedEnv: Record<string, string | undefined>;

function configPath(): string {
	return join(testDir, ".backlog-jira", "config.json");
}

function readConfig(): RawConfig {
	return JSON.parse(readFileSync(configPath(), "utf-8"));
}

function setEnv(values: Record<string, string>): void {
	for (const name of JIRA_ENV) delete process.env[name];
	Object.assign(process.env, values);
}

const CLOUD_ENV = {
	JIRA_URL: "https://acme.atlassian.net/",
	JIRA_EMAIL: "dev@acme.test",
	JIRA_API_TOKEN: "super-secret-token",
};

/**
 * Answer prompts by question name; unanswered questions cancel (Ctrl+C)
 */
async function answer(answers: Record<string, Answer | Answer[]>) {
	const prompts = await import("prompts");
	const asked: PromptObject[] = [];
	const queues = new Map(
		Object.entries(answers).map(([name, value]) => [
			name,
			Array.isArray(value) ? [...value] : [value],
		]),
	);
	spyOn(prompts, "default").mockImplementation((async (
		question: PromptObject,
	) => {
		asked.push(question);
		const name = String(question.name);
		const queue = queues.get(name);
		if (!queue || queue.length === 0) return {};
		const next = queue.length > 1 ? queue.shift() : queue[0];
		return {
			[name]: typeof next === "function" ? next(question) : next,
		};
	}) as never);
	return asked;
}

function fakeJira(overrides: Partial<Record<keyof WizardJira, unknown>> = {}) {
	const jira = {
		checkConnection: mock(async () => ({ ok: true })),
		getAllProjects: mock(async () => [
			{ key: "WEB", name: "Website", id: "1" },
			{ key: "API", name: "Backend", id: "2" },
		]),
		getProjectIssueTypes: mock(async () => [
			{ id: "1", name: "Task" },
			{ id: "2", name: "Story" },
		]),
		searchIssues: mock(async (jql: string) => ({
			issues: jql.includes('"Task"')
				? [
						{ key: "API-1", status: "Open" },
						{ key: "API-2", status: "In Review" },
					]
				: [],
			total: 120,
			startAt: 0,
			maxResults: 1,
		})),
		getTransitions: mock(async () => [
			{ id: "1", name: "Close", to: { id: "", name: "Closed" } },
		]),
		listBoards: mock(async () => [
			{ id: "7", name: "API kanban", type: "kanban", supportsSprints: false },
			{ id: "12", name: "API scrum", type: "scrum", supportsSprints: true },
		]),
		searchFields: mock(async () => [
			{
				id: "customfield_10016",
				name: "Story Points",
				custom: true,
				schema: { type: "number" },
			},
			{
				id: "customfield_10020",
				name: "Sprint",
				custom: true,
				schema: {
					type: "array",
					custom: "com.pyxis.greenhopper.jira:gh-sprint",
				},
			},
		]),
		close: mock(async () => {}),
		...overrides,
	};
	return jira;
}

function run(
	options: Parameters<typeof runConfigure>[0] = {},
	jira = fakeJira(),
) {
	return runConfigure({
		cwd: testDir,
		createJira: () => jira as unknown as WizardJira,
		backlogStatuses: () => ["To Do", "In Progress", "Done"],
		doctor: async () => ({ ok: true }),
		...options,
	});
}

function printed(): string {
	return output.join("\n");
}

beforeEach(() => {
	testDir = uniqueTestDir("configure-test");
	output = [];
	savedEnv = Object.fromEntries(JIRA_ENV.map((n) => [n, process.env[n]]));
	setEnv(CLOUD_ENV);
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	mock.restore();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	cleanupDir(testDir);
});

/** A config with settings the wizard does not manage */
function writeExistingConfig(extra: RawConfig = {}): void {
	writeJson(configPath(), {
		jira: {
			baseUrl: "https://acme.atlassian.net",
			projectKey: "API",
			issueType: "Task",
			jqlFilter: "",
			customJiraKey: "keep",
		},
		backlog: {
			statusMapping: { "To Do": ["Open"], Done: ["Done"] },
			assigneeMapping: { "@dev": "dev@acme.test" },
		},
		sync: { conflictStrategy: "prompt", watchInterval: 30 },
		mcp: { serverArgs: ["--dns 8.8.8.8"], envVars: { HTTPS_PROXY: "p" } },
		fieldMappings: [
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "pull",
			},
		],
		unknownTopLevel: { nested: [1, 2] },
		...extra,
	});
}

function expectUnmanagedKept(config: RawConfig): void {
	expect(config.unknownTopLevel).toEqual({ nested: [1, 2] });
	expect((config.jira as RawConfig).customJiraKey).toBe("keep");
	expect((config.backlog as RawConfig).assigneeMapping).toEqual({
		"@dev": "dev@acme.test",
	});
	expect((config.sync as RawConfig).watchInterval).toBe(30);
	expect((config.mcp as RawConfig).serverArgs).toEqual(["--dns 8.8.8.8"]);
	expect(
		((config.mcp as RawConfig).envVars as Record<string, string>).HTTPS_PROXY,
	).toBe("p");
	expect(config.fieldMappings).toContainEqual({
		backlog: "frontmatter:story_points",
		jira: "customfield_10016",
		type: "number",
		direction: "pull",
	});
}

describe("configure --step", () => {
	it("rejects an unknown step", async () => {
		await answer({});
		await expect(run({ step: "nope" })).rejects.toThrow('Unknown step "nope"');
	});

	it("creates .backlog-jira/ when it is missing", async () => {
		await answer({ conflictStrategy: "prefer-jira" });
		await run({ step: "conflict" });
		expect(readConfig().sync).toMatchObject({
			conflictStrategy: "prefer-jira",
		});
		expect(existsSync(join(testDir, ".backlog-jira", ".gitignore"))).toBe(true);
	});

	it("conflict: keeps config it does not manage", async () => {
		writeExistingConfig();
		await answer({ conflictStrategy: "prefer-backlog" });

		const result = await run({ step: "conflict" });

		expect(result.completed).toEqual(["conflict"]);
		const config = readConfig();
		expect((config.sync as RawConfig).conflictStrategy).toBe("prefer-backlog");
		expectUnmanagedKept(config);
	});

	describe("credentials", () => {
		it("reports exported credentials and stores only the URL", async () => {
			writeExistingConfig();
			await answer({});

			const result = await run({ step: "credentials" });

			expect(result.completed).toEqual(["credentials"]);
			expect(printed()).toContain("JIRA_URL");
			expect(printed()).toContain("(set, hidden)");
			expect(printed()).not.toContain("super-secret-token");
			const config = readConfig();
			expect((config.jira as RawConfig).baseUrl).toBe(
				"https://acme.atlassian.net",
			);
			expect(JSON.stringify(config)).not.toContain("super-secret-token");
			expectUnmanagedKept(config);
		});

		it("explains export, .env and direnv when credentials are missing", async () => {
			setEnv({});
			await answer({ enterCredentials: false });

			const result = await run({ step: "credentials" });

			expect(result.skipped).toEqual(["credentials"]);
			expect(printed()).toContain(
				"Not exported to this process: JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN",
			);
			expect(printed()).toContain("export JIRA_API_TOKEN=");
			expect(printed()).toContain("set -a; . ./.env; set +a");
			expect(printed()).toContain("direnv allow");
		});

		it("uses entered credentials for the session and never writes tokens to config.json", async () => {
			setEnv({});
			await answer({
				enterCredentials: true,
				instanceType: "server",
				jiraUrl: "https://jira.acme.test/",
				jiraPersonalToken: "pat-secret",
				saveEnvFile: true,
			});

			const result = await run({ step: "credentials" });

			expect(result.completed).toEqual(["credentials"]);
			expect(process.env.JIRA_PERSONAL_TOKEN).toBe("pat-secret");
			const raw = readFileSync(configPath(), "utf-8");
			expect(raw).not.toContain("pat-secret");
			expect(JSON.parse(raw).jira.baseUrl).toBe("https://jira.acme.test");
			expect(readFileSync(join(testDir, ".env"), "utf-8")).toContain(
				"JIRA_PERSONAL_TOKEN='pat-secret'",
			);
			expect(readFileSync(join(testDir, ".gitignore"), "utf-8")).toContain(
				".env",
			);
		});
	});

	describe("connection", () => {
		it("shows the underlying error when the check fails", async () => {
			await answer({});
			const jira = fakeJira({
				checkConnection: mock(async () => ({
					ok: false,
					error: "spawn docker ENOENT",
				})),
			});

			const result = await run({ step: "connection" }, jira);

			expect(result.failed).toBe(true);
			expect(printed()).toContain("spawn docker ENOENT");
		});

		it("fails without calling Jira when credentials are missing", async () => {
			setEnv({});
			await answer({});
			const jira = fakeJira();

			const result = await run({ step: "connection" }, jira);

			expect(result.failed).toBe(true);
			expect(jira.checkConnection).not.toHaveBeenCalled();
			expect(printed()).toContain("--step credentials");
		});
	});

	it("project: chooses project and issue type from Jira lists", async () => {
		writeExistingConfig();
		const asked = await answer({ project: "WEB", issueType: "Story" });
		const jira = fakeJira();

		await run({ step: "project" }, jira);

		const config = readConfig();
		expect(config.jira).toMatchObject({
			projectKey: "WEB",
			issueType: "Story",
		});
		expect(jira.getProjectIssueTypes).toHaveBeenCalledWith("WEB");
		const projectQuestion = asked.find((q) => q.name === "project");
		expect(
			(projectQuestion?.choices as Array<{ value: string }>).map(
				(c) => c.value,
			),
		).toEqual(["API", "WEB", "__manual__"]);
		// Current project preselected
		expect(projectQuestion?.initial).toBe(0);
		expectUnmanagedKept(config);
	});

	it("project: falls back to manual entry when projects cannot be listed", async () => {
		await answer({ projectKey: "ops", issueType: "Task" });
		const jira = fakeJira({
			getAllProjects: mock(async () => {
				throw new Error("MCP tool jira_get_all_projects failed: 401");
			}),
		});

		await run({ step: "project" }, jira);

		expect(printed()).toContain("jira_get_all_projects failed: 401");
		expect(readConfig().jira).toMatchObject({ projectKey: "OPS" });
	});

	it("status: lists Jira statuses per issue type and covers each one", async () => {
		writeExistingConfig();
		await answer({
			extraStatuses: "Blocked",
			// Leave Blocked unmapped, accept the suggestion for the others
			backlogStatus: (q: PromptObject) =>
				String(q.message).includes("Blocked")
					? "__unmapped__"
					: (q.choices as Array<{ value: string }>)[q.initial as number].value,
		});

		const result = await run({ step: "status" });

		expect(result.completed).toEqual(["status"]);
		expect(printed()).toContain("Backlog statuses: To Do, In Progress, Done");
		expect(printed()).toMatch(/Task\s+Open, In Review, Closed/);
		const backlog = readConfig().backlog as RawConfig;
		expect(backlog.statusMapping).toEqual({
			"To Do": ["Open"],
			Done: ["Done", "Closed"],
			"In Progress": ["In Review"],
		});
		expect(backlog.unmappedJiraStatuses).toEqual(["Blocked"]);
		expect(backlog.assigneeMapping).toEqual({ "@dev": "dev@acme.test" });
	});

	it("status: needs a project", async () => {
		await answer({});
		const result = await run({ step: "status" });
		expect(result.skipped).toEqual(["status"]);
		expect(printed()).toContain("--step project");
	});

	it("sprints: writes a sprint mapping for a board with sprints and enables jira_agile", async () => {
		writeExistingConfig();
		const asked = await answer({
			board: "12",
			sprintDirection: "both",
			createSprints: true,
			archiveClosedSprints: false,
			pullScope: "open",
		});
		const jira = fakeJira();

		const result = await run({ step: "sprints" }, jira);

		expect(result.completed).toEqual(["sprints"]);
		expect(jira.listBoards).toHaveBeenCalledWith({ projectKey: "API" });
		const boardQuestion = asked.find((q) => q.name === "board");
		expect(
			(boardQuestion?.choices as Array<{ value: string }>).map((c) => c.value),
		).toEqual(["12", "__manual__", "__skip__"]);
		const config = readConfig();
		expect(config.fieldMappings).toContainEqual({
			backlog: "milestone",
			jira: "sprint",
			type: "sprint",
			direction: "both",
			boardId: 12,
			createSprints: true,
			archiveClosedSprints: false,
			pullScope: "open",
		});
		expect(
			((config.mcp as RawConfig).envVars as Record<string, string>).TOOLSETS,
		).toBe("default,jira_projects,jira_agile");
		expectUnmanagedKept(config);
	});

	it("sprints: can turn sprint sync off", async () => {
		writeExistingConfig({
			fieldMappings: [
				{ backlog: "milestone", jira: "sprint", type: "sprint", boardId: 12 },
			],
		});
		await answer({ board: "__off__" });

		await run({ step: "sprints" });

		expect(readConfig().fieldMappings).toEqual([]);
	});

	it("fields: adds a mapping with a suggested type and validates like map-fields", async () => {
		writeExistingConfig({ fieldMappings: [] });
		const asked = await answer({
			addField: [true, true, false],
			jiraField: "customfield_10016",
			backlogTarget: ["frontmatter:story_points", "frontmatter:jira_key"],
			fieldType: (q: PromptObject) =>
				(q.choices as Array<{ value: string }>)[q.initial as number].value,
			fieldDirection: "both",
		});

		const result = await run({ step: "fields" });

		expect(result.completed).toEqual(["fields"]);
		const fieldQuestion = asked.find((q) => q.name === "jiraField");
		const titles = (fieldQuestion?.choices as Array<{ title: string }>).map(
			(c) => c.title,
		);
		expect(titles).toEqual([
			"Story Points (customfield_10016) [number] → number",
		]);
		// The reserved key is rejected by the same validation as map-fields
		expect(printed()).toMatch(/✗[^\n]*\n.*"frontmatter:jira_key" collides/);
		const targetQuestion = asked.find((q) => q.name === "backlogTarget");
		expect(targetQuestion?.initial).toBe("frontmatter:story_points");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "both",
			},
		]);
	});

	it("filter: suggests the project JQL and reports the 50-issue import limit", async () => {
		writeExistingConfig();
		const asked = await answer({
			jqlFilter: (q: PromptObject) => q.initial,
		});

		await run({ step: "filter" });

		expect(asked.find((q) => q.name === "jqlFilter")?.initial).toBe(
			"project = API ORDER BY created DESC",
		);
		expect(printed()).toContain("120 issues match");
		expect(printed()).toContain("first 50");
		expect((readConfig().jira as RawConfig).jqlFilter).toBe(
			"project = API ORDER BY created DESC",
		);
	});
});

describe("configure wizard", () => {
	it("walks every step in order, allows skipping and ends with doctor and next steps", async () => {
		writeExistingConfig();
		const asked = await answer({
			run_credentials: true,
			run_connection: true,
			run_project: false,
			run_status: false,
			run_sprints: false,
			run_fields: false,
			run_conflict: true,
			conflictStrategy: "prefer-jira",
			run_filter: false,
		});
		const doctor = mock(async () => ({ ok: true }));
		const jira = fakeJira();
		const createJira = mock(() => jira as unknown as WizardJira);

		const result = await run({ doctor, createJira });

		expect(
			asked.filter((q) => String(q.name).startsWith("run_")).map((q) => q.name),
		).toEqual(CONFIGURE_STEPS.map((s) => `run_${s}`));
		expect(result.completed).toEqual(["credentials", "connection", "conflict"]);
		expect(result.skipped).toEqual([
			"project",
			"status",
			"sprints",
			"fields",
			"filter",
		]);
		expect(doctor).toHaveBeenCalledTimes(1);
		// One client for all steps, closed before doctor runs
		expect(createJira).toHaveBeenCalledTimes(1);
		expect(jira.close).toHaveBeenCalled();
		expect(printed()).toContain("backlog-jira configure --step sprints");
		expect(printed()).toContain("pull --import --dry-run");
		expect(printed()).toContain("at most 50 issues per run");
		expect(printed()).toContain("git add .backlog-jira");
		expectUnmanagedKept(readConfig());
	});

	it("saves completed steps when cancelled", async () => {
		writeExistingConfig();
		await answer({
			run_credentials: false,
			run_connection: false,
			run_project: true,
			project: "WEB",
			issueType: "Task",
			// Ctrl+C at the status step
		});

		const result = await run();

		expect(result.cancelledAt).toBe("status");
		expect(readConfig().jira).toMatchObject({ projectKey: "WEB" });
		expect(printed()).toContain("configure --step status");
	});

	it("asks whether to continue when the connection fails", async () => {
		await answer({
			run_credentials: false,
			run_connection: true,
			continueOffline: false,
		});
		const jira = fakeJira({
			checkConnection: mock(async () => ({
				ok: false,
				error: "401 Unauthorized",
			})),
		});
		const doctor = mock(async () => ({ ok: true }));

		const result = await run({ doctor }, jira);

		expect(result.failed).toBe(true);
		expect(printed()).toContain("401 Unauthorized");
		expect(doctor).not.toHaveBeenCalled();
	});
});

describe("configure --non-interactive", () => {
	it("writes the given settings and keeps everything else", async () => {
		writeExistingConfig();
		const prompts = await import("prompts");
		const promptSpy = spyOn(prompts, "default");

		const result = await run({
			nonInteractive: true,
			projectKey: "web",
			issueType: "Bug",
			conflictStrategy: "prefer-backlog",
			jqlFilter: "project = WEB",
		});

		expect(result.failed).toBe(false);
		expect(promptSpy).not.toHaveBeenCalled();
		const config = readConfig();
		expect(config.jira).toMatchObject({
			baseUrl: "https://acme.atlassian.net",
			projectKey: "WEB",
			issueType: "Bug",
			jqlFilter: "project = WEB",
		});
		expect((config.sync as RawConfig).conflictStrategy).toBe("prefer-backlog");
		expect(JSON.stringify(config)).not.toContain("super-secret-token");
		expectUnmanagedKept(config);
	});

	it("creates a default config and warns about missing credentials", async () => {
		setEnv({});
		await run({ nonInteractive: true });
		expect(readConfig().jira).toMatchObject({ issueType: "Task" });
		expect(printed()).toContain("not exported to this process: JIRA_URL");
		expect(printed()).toContain("--project-key");
	});

	it("rejects an invalid conflict strategy", async () => {
		await expect(
			run({ nonInteractive: true, conflictStrategy: "newest" }),
		).rejects.toThrow('Invalid conflict strategy "newest"');
	});
});
