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

/** Answer that presses Esc */
const ESC = Symbol("Esc");
/** Answer that presses Ctrl+C */
const CANCEL = Symbol("Ctrl+C");

/**
 * Answer prompts by question name; unanswered questions cancel (Ctrl+C).
 * A list answers one question at a time and repeats its last answer.
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
		if (next === CANCEL) return {};
		if (next === ESC) {
			// What prompts does on Esc: render, then exit(), which aborts
			const prompt = { exit() {}, abort() {} };
			(question.onRender as ((this: unknown) => void) | undefined)?.call(
				prompt,
			);
			prompt.exit();
			return {};
		}
		return {
			[name]: typeof next === "function" ? next(question) : next,
		};
	}) as never);
	return asked;
}

/** Recently updated project issues with all fields, as MCP Atlassian returns them */
const SAMPLE_ISSUES = [
	{
		key: "API-1",
		status: "Open",
		fields: {
			summary: "One",
			customfield_10016: { value: 3, name: "Story Points" },
			customfield_10030: { value: "Acme", name: "Client" },
			customfield_10040: { value: null, name: "Unused Text" },
			watches: { watch_count: 1 },
		},
	},
	{
		key: "API-2",
		status: "In Review",
		fields: {
			summary: "Two",
			customfield_10016: { value: 5, name: "Story Points" },
			customfield_10040: { value: "", name: "Unused Text" },
		},
	},
];

/** Statuses the fake Jira site knows (lower-cased) */
const JIRA_STATUSES = [
	"open",
	"in review",
	"closed",
	"done",
	"to do",
	"blocked",
];

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
		searchIssues: mock(async (jql: string, options?: { fields?: string }) => {
			if (options?.fields === "*all") {
				return {
					issues: SAMPLE_ISSUES,
					total: SAMPLE_ISSUES.length,
					startAt: 0,
					maxResults: 50,
				};
			}
			// Jira rejects status names that are not statuses
			const inClause = jql.match(/status in \((.*)\)/);
			if (inClause) {
				const rejected = [...inClause[1].matchAll(/"([^"]+)"/g)]
					.map((m) => m[1])
					.filter((name) => !JIRA_STATUSES.includes(name.toLowerCase()));
				if (rejected.length > 0) {
					throw new Error(
						rejected
							.map(
								(name) =>
									`The value '${name}' does not exist for the field 'status'.`,
							)
							.join(" "),
					);
				}
			}
			return {
				issues: jql.includes('"Task"')
					? [
							{ key: "API-1", status: "Open" },
							{ key: "API-2", status: "In Review" },
						]
					: [],
				total: 120,
				startAt: 0,
				maxResults: 1,
			};
		}),
		// MCP Atlassian returns transitions without their target status
		getTransitions: mock(async () => [
			{ id: "1", name: "Closed", to: { id: "", name: "" } },
			{ id: "2", name: "Start Progress", to: { id: "", name: "" } },
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
				id: "customfield_10030",
				name: "Client",
				custom: true,
				schema: { type: "string" },
			},
			{
				id: "customfield_10040",
				name: "Unused Text",
				custom: true,
				schema: { type: "string" },
			},
			{
				id: "fixVersions",
				name: "Fix versions",
				schema: { type: "array", items: "version" },
			},
			{ id: "watches", name: "Watchers", schema: { type: "watches" } },
			{ id: "summary", name: "Summary", schema: { type: "string" } },
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

	it("Esc in a single step leaves it unchanged", async () => {
		writeExistingConfig({ sync: { conflictStrategy: "prompt" } });
		await answer({ conflictStrategy: ESC });

		const result = await run({ step: "conflict" });

		expect(result.cancelledAt).toBeUndefined();
		expect(result.skipped).toEqual(["conflict"]);
		expect(printed()).toContain("Left unchanged.");
		expect(readConfig().sync).toMatchObject({ conflictStrategy: "prompt" });
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
		const asked = await answer({ projectKey: "ops", issueType: "Task" });
		const jira = fakeJira({
			getAllProjects: mock(async () => {
				throw new Error("MCP tool jira_get_all_projects failed: 401");
			}),
		});

		await run({ step: "project" }, jira);

		expect(printed()).toContain("jira_get_all_projects failed: 401");
		const keyQuestion = asked.find((q) => q.name === "projectKey");
		const validate = keyQuestion?.validate as (value: string) => unknown;
		expect(validate("X")).not.toBe(true);
		expect(validate("ops")).toBe(true);
		expect(readConfig().jira).toMatchObject({ projectKey: "OPS" });
	});

	it("status: picks statuses from one checkbox list and proposes the whole mapping", async () => {
		writeExistingConfig();
		const asked = await answer({
			// Keep the ticked statuses
			jiraStatuses: (q: PromptObject) =>
				(q.choices as Array<{ value: string; selected?: boolean }>)
					.filter((c) => c.selected)
					.map((c) => c.value),
			extraStatuses: "Blocked",
			statusDecision: "change",
			// Arrays queue answers, so a multiselect answer is wrapped
			statusesToChange: [["Blocked"]],
			backlogStatus: "__unmapped__",
		});

		const result = await run({ step: "status" });

		expect(result.completed).toEqual(["status"]);
		expect(printed()).toContain("Backlog statuses: To Do, In Progress, Done");
		const list = asked.find((q) => q.name === "jiraStatuses");
		const choices = (
			list?.choices as Array<{
				title: string;
				value: string;
				selected: boolean;
			}>
		).map((c) => ({ value: c.value, selected: c.selected, title: c.title }));
		// Issues, then checked transition names, then other statuses on the
		// site; "Start Progress" and "In Progress" are not statuses there
		expect(choices.map((c) => [c.value, c.selected])).toEqual([
			["Open", true],
			["In Review", true],
			["Closed", true],
			["To Do", false],
			["Done", true],
		]);
		expect(choices[0].title).toContain("on Task issues");
		expect(choices[2].title).toContain("reachable from Task");
		expect(choices[3].title).toContain("used elsewhere on this Jira site");
		// The whole proposal is shown; only the changed status is asked about
		expect(printed()).toMatch(/In Review\s+→\s+In Progress/);
		expect(asked.filter((q) => q.name === "backlogStatus")).toHaveLength(1);

		const backlog = readConfig().backlog as RawConfig;
		expect(backlog.statusMapping).toEqual({
			"To Do": ["Open"],
			"In Progress": ["In Review"],
			Done: ["Closed", "Done"],
		});
		expect(backlog.unmappedJiraStatuses).toEqual(["Blocked"]);
		expect(backlog.assigneeMapping).toEqual({ "@dev": "dev@acme.test" });
	});

	it("status: accepting the proposal asks nothing per status and drops init's unused defaults", async () => {
		await answer({ run_status: true });
		// Default config from init with a project
		await run({ nonInteractive: true, projectKey: "API" });
		const asked = await answer({
			jiraStatuses: (q: PromptObject) =>
				(q.choices as Array<{ value: string; selected?: boolean }>)
					.filter((c) => c.selected)
					.map((c) => c.value),
			extraStatuses: "",
			statusDecision: "accept",
		});

		await run({ step: "status" });

		// init's defaults are not ticked just because they are mapped
		const list = asked.find((q) => q.name === "jiraStatuses");
		expect(
			(list?.choices as Array<{ value: string; selected: boolean }>)
				.filter((c) => !c.selected)
				.map((c) => c.value),
		).toEqual(["To Do", "Done"]);
		expect(asked.some((q) => q.name === "backlogStatus")).toBe(false);
		// Unticked statuses and mapped names that are not statuses on the site
		// (Backlog, In Progress, Resolved) are removed
		expect((readConfig().backlog as RawConfig).statusMapping).toEqual({
			"To Do": ["Open"],
			"In Progress": ["In Review"],
			Done: ["Closed"],
		});
		expect(printed()).toContain(
			"Removed: To Do, Done, Backlog, In Progress, Resolved",
		);
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

	it("fields: offers fields the project uses, ranked, and adds the ticked ones", async () => {
		writeExistingConfig({ fieldMappings: [] });
		const asked = await answer({
			fieldsMenu: ["suggested", "save"],
			fieldsToSync: (q: PromptObject) =>
				(q.choices as Array<{ value: string; selected?: boolean }>)
					.filter((c) => c.selected)
					.map((c) => c.value),
		});
		const jira = fakeJira();

		const result = await run({ step: "fields" }, jira);

		expect(result.completed).toEqual(["fields"]);
		expect(jira.searchIssues).toHaveBeenCalledWith(
			'project = "API" ORDER BY updated DESC',
			{ maxResults: 50, fields: "*all" },
		);
		const list = asked.find((q) => q.name === "fieldsToSync");
		const choices = list?.choices as Array<{
			title: string;
			value: string;
			selected?: boolean;
		}>;
		// Most used first; unused only when commonly useful; no core-synced,
		// sprint or watcher fields
		expect(choices.map((c) => c.value)).toEqual([
			"customfield_10016",
			"customfield_10030",
			"fixVersions",
		]);
		expect(choices[0].title).toContain("2/2 issues");
		expect(choices[0].title).toContain("frontmatter:story_points");
		expect(choices[2].title).toContain("not used yet");
		expect(choices.map((c) => Boolean(c.selected))).toEqual([
			true,
			false,
			false,
		]);
		expect(asked.some((q) => q.name === "backlogTarget")).toBe(false);
		// The menu lists the pending mapping before it is saved
		expect(printed()).toContain("Pending, not saved yet:");
		const menus = asked.filter((q) => q.name === "fieldsMenu");
		const saveTitle = (menus[1].choices as Array<{ title: string }>).find((c) =>
			c.title.startsWith("Save"),
		)?.title;
		expect(saveTitle).toBe("Save 1 change and continue");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:story_points",
				jira: "customfield_10016",
				type: "number",
				direction: "pull",
			},
		]);
	});

	it("fields: lists fields synced by default and configured mappings, including the sprint mapping", async () => {
		writeExistingConfig({
			fieldMappings: [
				{ backlog: "milestone", jira: "sprint", type: "sprint", boardId: 12 },
				{
					backlog: "frontmatter:client",
					jira: "customfield_10030",
					type: "string",
					direction: "pull",
				},
			],
		});
		await answer({ fieldsMenu: "save" });

		const result = await run({ step: "fields" });

		expect(result.skipped).toEqual(["fields"]);
		expect(printed()).toContain(
			"Synced by default: title ↔ summary, description, status, assignee, labels, priority",
		);
		expect(printed()).toContain("milestone ← Sprint (board 12)");
		expect(printed()).toContain(
			"frontmatter:client ← Client (customfield_10030)",
		);
	});

	it("fields: Esc while adding a field drops only that field and keeps the other pending ones", async () => {
		writeExistingConfig({ fieldMappings: [] });
		const asked = await answer({
			fieldsMenu: ["suggested", "search", "search", "save"],
			fieldsToSync: [["customfield_10030"]],
			// Esc in the field search, then Esc on the second field's line
			jiraField: [ESC, "customfield_10040"],
			fieldAction: ESC,
		});

		const result = await run({ step: "fields" });

		expect(result.completed).toEqual(["fields"]);
		expect(asked.filter((q) => q.name === "fieldsMenu")).toHaveLength(4);
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:client",
				jira: "customfield_10030",
				type: "string",
				direction: "pull",
			},
		]);
	});

	it("fields: Esc while changing an attribute returns to the field's line", async () => {
		writeExistingConfig({ fieldMappings: [] });
		await answer({
			fieldsMenu: ["search", "save"],
			jiraField: "customfield_10040",
			fieldAction: ["type", "direction", "accept"],
			fieldType: ESC,
			fieldDirection: "both",
		});

		await run({ step: "fields" });

		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:unused_text",
				jira: "customfield_10040",
				type: "string",
				direction: "both",
			},
		]);
	});

	it("fields: the target prompt lists taken targets and rejects them and reserved keys", async () => {
		writeExistingConfig({
			fieldMappings: [
				{
					backlog: "frontmatter:client",
					jira: "customfield_10030",
					type: "string",
					direction: "pull",
				},
			],
		});
		const asked = await answer({
			fieldsMenu: ["search", "save"],
			jiraField: "customfield_10040",
			fieldAction: ["target", "accept"],
			backlogTarget: (q: PromptObject) => {
				const validate = q.validate as (v: string) => string | true;
				expect(validate("frontmatter:client")).toMatch(/already mapped/);
				expect(validate("frontmatter:priority")).toMatch(/collides/);
				expect(validate("frontmatter:jira_key")).toMatch(/collides/);
				return "frontmatter:notes_text";
			},
		});

		await run({ step: "fields" });

		const target = asked.find((q) => q.name === "backlogTarget");
		expect(String(target?.message)).toContain("taken: frontmatter:client");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:client",
				jira: "customfield_10030",
				type: "string",
				direction: "pull",
			},
			{
				backlog: "frontmatter:notes_text",
				jira: "customfield_10040",
				type: "string",
				direction: "pull",
			},
		]);
	});

	it("fields: search marks default-synced and mapped fields, and Priority edits the priority value map", async () => {
		writeExistingConfig({
			fieldMappings: [
				{
					backlog: "frontmatter:client",
					jira: "customfield_10030",
					type: "string",
					direction: "pull",
				},
			],
		});
		const priority = {
			id: "priority",
			name: "Priority",
			schema: { type: "priority" },
		};
		const fields = await (
			fakeJira().searchFields as () => Promise<unknown[]>
		)();
		const jira = fakeJira({
			searchFields: mock(async () => [...fields, priority]),
		});
		const asked = await answer({
			fieldsMenu: ["search", "save"],
			jiraField: "priority",
			priorityValueMap: "P1=high, P2=medium",
		});

		const result = await run({ step: "fields" }, jira);

		expect(result.completed).toEqual(["fields"]);
		const search = asked.find((q) => q.name === "jiraField");
		const titles = new Map(
			(search?.choices as Array<{ title: string; value: string }>).map((c) => [
				c.value,
				c.title,
			]),
		);
		expect(titles.get("summary")).toContain("synced by default as title");
		expect(titles.get("priority")).toContain("synced by default");
		expect(titles.get("customfield_10030")).toContain(
			"mapped to frontmatter:client",
		);
		// No frontmatter target is offered for Priority
		expect(asked.some((q) => q.name === "backlogTarget")).toBe(false);
		expect(asked.some((q) => q.name === "fieldAction")).toBe(false);
		const validate = asked.find((q) => q.name === "priorityValueMap")
			?.validate as (v: string) => string | true;
		expect(validate("P1=urgent")).toMatch(/not a Backlog priority/);
		expect(readConfig().fieldMappings).toContainEqual({
			backlog: "priority",
			jira: "priority",
			type: "option",
			direction: "both",
			valueMap: { P1: "high", P2: "medium" },
		});
	});

	it("fields: editing the priority value map twice keeps one override", async () => {
		writeExistingConfig({
			fieldMappings: [
				{
					backlog: "priority",
					jira: "priority",
					type: "option",
					valueMap: { P1: "high" },
				},
			],
		});
		const asked = await answer({
			fieldsMenu: ["edit", "edit", "save"],
			editMapping: 0,
			priorityValueMap: ["P1=high, P2=low", "P1=high, P3=low"],
		});

		await run({ step: "fields" });

		expect(asked.find((q) => q.name === "priorityValueMap")?.initial).toBe(
			"P1=high",
		);
		expect(printed()).toContain("(changing)");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "priority",
				jira: "priority",
				type: "option",
				direction: "both",
				valueMap: { P1: "high", P3: "low" },
			},
		]);
	});

	it("fields: picking a configured field edits its mapping; a new target replaces the old one", async () => {
		writeExistingConfig({
			fieldMappings: [
				{
					backlog: "frontmatter:client",
					jira: "customfield_10030",
					type: "string",
					direction: "pull",
					valueMap: { Acme: "acme" },
				},
			],
		});
		await answer({
			fieldsMenu: ["edit", "save"],
			editMapping: 0,
			fieldAction: ["target", "direction", "accept"],
			backlogTarget: "frontmatter:customer",
			fieldDirection: "both",
		});

		await run({ step: "fields" });

		expect(printed()).toContain("(changing)");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:customer",
				jira: "customfield_10030",
				type: "string",
				direction: "both",
				valueMap: { Acme: "acme" },
			},
		]);
	});

	it("fields: removes configured mappings, including the sprint mapping", async () => {
		writeExistingConfig({
			fieldMappings: [
				{ backlog: "milestone", jira: "sprint", type: "sprint", boardId: 12 },
				{
					backlog: "frontmatter:client",
					jira: "customfield_10030",
					type: "string",
					direction: "pull",
				},
			],
		});
		await answer({
			fieldsMenu: ["remove", "remove", "save"],
			removeMapping: ["configured:milestone", "configured:frontmatter:client"],
		});

		const result = await run({ step: "fields" });

		expect(result.completed).toEqual(["fields"]);
		expect(printed()).toContain("(removing)");
		expect(readConfig().fieldMappings).toEqual([]);
	});

	it("fields: Esc at the menu with pending changes offers to save them", async () => {
		writeExistingConfig({ fieldMappings: [] });
		const asked = await answer({
			fieldsMenu: ["suggested", ESC, ESC],
			fieldsToSync: [["customfield_10030"]],
			// Keep editing, then save
			leaveFields: ["menu", "save"],
		});

		const result = await run({ step: "fields" });

		expect(result.completed).toEqual(["fields"]);
		expect(asked.filter((q) => q.name === "leaveFields")).toHaveLength(2);
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:client",
				jira: "customfield_10030",
				type: "string",
				direction: "pull",
			},
		]);
	});

	it("fields: Esc at the menu without changes leaves the step", async () => {
		writeExistingConfig({ fieldMappings: [] });
		const asked = await answer({ fieldsMenu: ESC });

		const result = await run({ step: "fields" });

		expect(result.skipped).toEqual(["fields"]);
		expect(asked.some((q) => q.name === "leaveFields")).toBe(false);
		expect(readConfig().fieldMappings).toEqual([]);
	});

	it("fields: Ctrl+C with pending changes offers to save them before quitting", async () => {
		writeExistingConfig({ fieldMappings: [] });
		await answer({
			fieldsMenu: ["suggested", CANCEL],
			fieldsToSync: [["customfield_10030"]],
			savePending: true,
		});

		const result = await run({ step: "fields" });

		expect(result.cancelledAt).toBe("fields");
		expect(readConfig().fieldMappings).toEqual([
			{
				backlog: "frontmatter:client",
				jira: "customfield_10030",
				type: "string",
				direction: "pull",
			},
		]);
	});

	it("fields: declining to save on Ctrl+C discards pending changes", async () => {
		writeExistingConfig({ fieldMappings: [] });
		await answer({
			fieldsMenu: ["suggested", CANCEL],
			fieldsToSync: [["customfield_10030"]],
			savePending: false,
		});

		const result = await run({ step: "fields" });

		expect(result.cancelledAt).toBe("fields");
		expect(readConfig().fieldMappings).toEqual([]);
	});

	it("filter: suggests the project JQL and shows how many issues match", async () => {
		writeExistingConfig();
		const asked = await answer({
			jqlFilter: (q: PromptObject) => q.initial,
		});

		await run({ step: "filter" });

		expect(asked.find((q) => q.name === "jqlFilter")?.initial).toBe(
			"project = API ORDER BY created DESC",
		);
		expect(printed()).toContain("120 issues match");
		expect(printed()).not.toMatch(/\b50\b/);
		expect((readConfig().jira as RawConfig).jqlFilter).toBe(
			"project = API ORDER BY created DESC",
		);
	});

	it("filter: counts by paging when Jira reports no total (Jira Cloud)", async () => {
		writeExistingConfig();
		await answer({ jqlFilter: "project = CR2" });
		const searchAllIssues = mock(async () => ({
			issues: Array.from({ length: 72 }, (_, i) => ({ key: `CR2-${i}` })),
			truncated: false,
		}));
		const jira = fakeJira({
			searchIssues: mock(async () => ({
				issues: [],
				total: -1,
				startAt: 0,
				maxResults: 1,
			})),
			searchAllIssues,
		});

		await run({ step: "filter" }, jira);

		expect(searchAllIssues).toHaveBeenCalledWith("project = CR2", {
			fields: "summary",
		});
		expect(printed()).toContain("72 issues match");
	});

	it("filter: warns when more issues match than one import handles", async () => {
		writeExistingConfig();
		await answer({ jqlFilter: "project = BIG" });
		const jira = fakeJira({
			searchIssues: mock(async () => ({
				issues: [],
				total: -1,
				startAt: 0,
				maxResults: 1,
			})),
			searchAllIssues: mock(async () => ({
				issues: Array.from({ length: 1000 }, (_, i) => ({ key: `B-${i}` })),
				truncated: true,
			})),
		});

		await run({ step: "filter" }, jira);

		expect(printed()).toContain("More than 1000 issues match");
		expect(printed()).toContain("up to 1000 issues");
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
		expect(printed()).toContain(
			"2. Import:               backlog-jira pull --import",
		);
		expect(printed()).toContain("git add .backlog-jira");
		expectUnmanagedKept(readConfig());
	});

	it("Esc inside a step returns to its question without saving it; Esc there goes to the previous step", async () => {
		writeExistingConfig();
		const asked = await answer({
			run_credentials: false,
			run_connection: [false, false],
			// Yes, then Esc on the question after Esc in the step, then skip
			run_project: [true, ESC, false],
			project: "WEB",
			issueType: ESC,
			run_status: false,
			run_sprints: false,
			run_fields: false,
			run_conflict: false,
			run_filter: false,
		});

		const result = await run();

		expect(
			asked.filter((q) => String(q.name).startsWith("run_")).map((q) => q.name),
		).toEqual([
			"run_credentials",
			"run_connection",
			"run_project",
			"run_project",
			"run_connection",
			"run_project",
			"run_status",
			"run_sprints",
			"run_fields",
			"run_conflict",
			"run_filter",
		]);
		expect(printed()).toContain("Back: nothing from this step was saved.");
		expect(result.cancelledAt).toBeUndefined();
		expect(result.completed).toEqual([]);
		expect(result.skipped).toEqual([...CONFIGURE_STEPS]);
		// The project picked before Esc was not kept
		expect(readConfig().jira).toMatchObject({
			projectKey: "API",
			issueType: "Task",
		});
	});

	it("Esc on the first step's question stays on it", async () => {
		writeExistingConfig();
		const asked = await answer({
			run_credentials: [ESC, false],
			run_connection: false,
			run_project: false,
			run_status: false,
			run_sprints: false,
			run_fields: false,
			run_conflict: false,
			run_filter: false,
		});

		const result = await run();

		expect(asked.filter((q) => q.name === "run_credentials")).toHaveLength(2);
		expect(result.cancelledAt).toBeUndefined();
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

describe("configure project list", () => {
	it("explains an empty project list", async () => {
		await answer({ projectKey: "OPS", issueType: "Task" });
		await run(
			{ step: "project" },
			fakeJira({ getAllProjects: mock(async () => []) }),
		);
		expect(printed()).toContain("Jira returned no projects");
	});
});

describe("configure logging", () => {
	it("silences the logger during the wizard so log lines cannot cover prompts", async () => {
		const { getLogLevel } = await import("../utils/logger.ts");
		const before = getLogLevel();
		let during = "";
		await answer({
			conflictStrategy: () => {
				during = getLogLevel();
				return "prompt";
			},
		});

		await run({ step: "conflict" });

		expect(during).toBe("silent");
		expect(getLogLevel()).toBe(before);
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
