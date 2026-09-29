import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import { SPRINT_FIELD_SCHEMA } from "../integrations/jira-sprints.ts";
import { JiraClient } from "../integrations/jira.ts";
import {
	CONFLICT_STRATEGIES,
	type ConflictStrategy,
	type RawConfig,
	bootstrapConfigDir,
	getConfigDir,
	getSection,
	readConfigFile,
	setSectionValues,
	writeConfigFile,
} from "../utils/config-file.ts";
import {
	FIELD_MAPPING_DIRECTIONS,
	FIELD_MAPPING_TYPES,
	type FieldMappingDirection,
	type SprintPullScope,
	suggestTypeForSchema,
	validateBacklogTarget,
	validateFieldMappings,
} from "../utils/field-mapping.ts";
import { jiraClientOptionsFromConfig } from "../utils/jira-config.ts";
import { getLogLevel, logger, setLogLevel } from "../utils/logger.ts";
import {
	applyRequiredToolsets,
	applySprintSettings,
	buildStatusMappingConfig,
	credentialHelpLines,
	detectCredentials,
	discoverProjectStatuses,
	findSprintEntry,
	mergeEnvFile,
	readBacklogStatuses,
	suggestBacklogStatus,
	uncoveredJiraStatuses,
} from "../utils/setup.ts";
import { runDoctor } from "./doctor.ts";
import { addFieldMapping, removeFieldMapping } from "./map-fields.ts";

/** Wizard steps, in the order the full wizard runs them */
export const CONFIGURE_STEPS = [
	"credentials",
	"connection",
	"project",
	"status",
	"sprints",
	"fields",
	"conflict",
	"filter",
] as const;
export type ConfigureStep = (typeof CONFIGURE_STEPS)[number];

const STEP_INFO: Record<ConfigureStep, { title: string; about: string }> = {
	credentials: {
		title: "Credentials",
		about: "Check that JIRA_URL and a Jira token are exported to backlog-jira.",
	},
	connection: {
		title: "Connection check",
		about:
			"Start the MCP Atlassian server and call Jira with your credentials.",
	},
	project: {
		title: "Project and issue type",
		about:
			"Choose the Jira project and the issue type new tasks are created as.",
	},
	status: {
		title: "Status mapping",
		about: "Map each Jira status of the project to a Backlog status.",
	},
	sprints: {
		title: "Sprints",
		about: "Optionally sync the sprints of a Jira board as Backlog milestones.",
	},
	fields: {
		title: "Field mappings",
		about:
			"Optionally sync extra Jira fields (story points, versions, custom fields).",
	},
	conflict: {
		title: "Conflict strategy",
		about: "Choose what sync does when a field changed on both sides.",
	},
	filter: {
		title: "Import filter",
		about: "Choose the JQL of the Jira issues 'pull --import' brings in.",
	},
};

/** Maximum number of issues one `pull --import` run handles */
const IMPORT_LIMIT = 50;

/** Jira operations the wizard uses */
export type WizardJira = Pick<
	JiraClient,
	| "checkConnection"
	| "getAllProjects"
	| "getProjectIssueTypes"
	| "searchIssues"
	| "getTransitions"
	| "listBoards"
	| "searchFields"
	| "close"
>;

export interface ConfigureOptions {
	/** Run a single step instead of the whole wizard */
	step?: string;
	nonInteractive?: boolean;
	verbose?: boolean;
	/** Non-interactive values */
	projectKey?: string;
	issueType?: string;
	conflictStrategy?: string;
	jqlFilter?: string;
	enableAnnotations?: boolean;
	/** Project directory (defaults to the current directory) */
	cwd?: string;
	/** Jira client factory, for tests */
	createJira?: (config: RawConfig) => WizardJira;
	/** Backlog statuses, for tests (defaults to `backlog config get statuses`) */
	backlogStatuses?: () => string[];
	/** Final health check (defaults to doctor) */
	doctor?: () => Promise<{ ok: boolean }>;
}

export interface ConfigureResult {
	completed: ConfigureStep[];
	skipped: ConfigureStep[];
	/** The step the user cancelled (Ctrl+C) in, if any */
	cancelledAt?: ConfigureStep;
	/** Whether a check failed (connection, doctor) */
	failed: boolean;
}

type StepOutcome = "done" | "skipped" | "failed";

interface WizardContext {
	cwd: string;
	config: RawConfig;
	createJira: (config: RawConfig) => WizardJira;
	backlogStatuses: () => string[];
	/** Client reused while the MCP settings and credentials stay the same */
	jira?: { key: string; client: WizardJira };
}

class WizardCancelled extends Error {
	constructor() {
		super("Configuration cancelled");
		this.name = "WizardCancelled";
	}
}

/**
 * Ask one question; Ctrl+C (an undefined answer) cancels the wizard
 */
async function ask<T>(question: prompts.PromptObject): Promise<T> {
	const name = String(question.name);
	const response = await prompts(question);
	const answer = response?.[name];
	if (answer === undefined) throw new WizardCancelled();
	return answer as T;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultCreateJira(config: RawConfig): WizardJira {
	return new JiraClient({
		...jiraClientOptionsFromConfig(config),
		silentMode: true,
	});
}

/**
 * Run fn with a Jira client built from the given (by default the wizard's
 * current) config. The client, and so its MCP server, is reused across steps
 * until the MCP settings or credentials change.
 */
async function withJira<T>(
	ctx: WizardContext,
	fn: (jira: WizardJira) => Promise<T>,
	config: RawConfig = ctx.config,
): Promise<T> {
	const key = JSON.stringify([
		config.mcp ?? null,
		...[
			"JIRA_URL",
			"JIRA_EMAIL",
			"JIRA_USERNAME",
			"JIRA_API_TOKEN",
			"JIRA_PERSONAL_TOKEN",
		].map((name) => process.env[name] ?? null),
	]);
	if (ctx.jira?.key !== key) {
		await closeJira(ctx);
		ctx.jira = { key, client: ctx.createJira(config) };
	}
	return fn(ctx.jira.client);
}

async function closeJira(ctx: WizardContext): Promise<void> {
	const client = ctx.jira?.client;
	ctx.jira = undefined;
	await client?.close().catch(() => {});
}

function jiraSection(ctx: WizardContext): {
	projectKey: string;
	issueType: string;
	jqlFilter: string;
} {
	const jira = getSection(ctx.config, "jira");
	return {
		projectKey: typeof jira.projectKey === "string" ? jira.projectKey : "",
		issueType: typeof jira.issueType === "string" ? jira.issueType : "Task",
		jqlFilter: typeof jira.jqlFilter === "string" ? jira.jqlFilter : "",
	};
}

// ===== Steps =====

async function credentialsStep(ctx: WizardContext): Promise<StepOutcome> {
	let status = detectCredentials();
	const mark = (ok: boolean) => (ok ? chalk.green("✓") : chalk.red("✗"));
	console.log(`  ${mark(!!status.url)} JIRA_URL        ${status.url ?? ""}`);
	if (status.hasPersonalToken) {
		console.log(`  ${mark(true)} JIRA_PERSONAL_TOKEN (set, hidden)`);
	} else {
		console.log(
			`  ${mark(!!status.email)} JIRA_EMAIL      ${status.email ?? ""}`,
		);
		console.log(
			`  ${mark(status.hasApiToken)} JIRA_API_TOKEN  ${status.hasApiToken ? "(set, hidden)" : ""}`,
		);
	}

	if (!status.auth) {
		console.log(
			chalk.yellow(
				`\n  Not exported to this process: ${status.missing.join(", ")}\n`,
			),
		);
		for (const line of credentialHelpLines()) {
			console.log(chalk.gray(`  ${line}`));
		}
		console.log();

		const enterNow = await ask<boolean>({
			type: "confirm",
			name: "enterCredentials",
			message:
				"Enter credentials for this session so setup can continue? (not saved to config.json)",
			initial: true,
		});
		if (!enterNow) {
			console.log(
				chalk.gray(
					"  Export the variables, then run: backlog-jira configure --step credentials",
				),
			);
			return "skipped";
		}
		const values = await promptCredentials(ctx);
		for (const [name, value] of Object.entries(values)) {
			process.env[name] = value;
		}
		status = detectCredentials();
		await offerEnvFile(ctx, values);
	} else {
		console.log(chalk.green("\n  Credentials are exported."));
	}

	// The URL is not secret; keep it in config.json for reference
	if (status.url) {
		setSectionValues(ctx.config, "jira", {
			baseUrl: status.url.replace(/\/+$/, ""),
		});
	}
	return status.auth ? "done" : "skipped";
}

async function promptCredentials(
	ctx: WizardContext,
): Promise<Record<string, string>> {
	const instance = await ask<"cloud" | "server">({
		type: "select",
		name: "instanceType",
		message: "Jira deployment:",
		choices: [
			{
				title: "Jira Cloud (atlassian.net) - email + API token",
				value: "cloud",
			},
			{
				title: "Jira Server / Data Center - personal access token",
				value: "server",
			},
		],
	});
	const baseUrl = getSection(ctx.config, "jira").baseUrl;
	const url = await ask<string>({
		type: "text",
		name: "jiraUrl",
		message: "Jira URL:",
		initial:
			process.env.JIRA_URL ||
			(typeof baseUrl === "string" && baseUrl) ||
			(instance === "cloud" ? "https://your-domain.atlassian.net" : ""),
		validate: (value: string) => {
			try {
				const parsed = new URL(value.trim());
				return /^https?:$/.test(parsed.protocol)
					? true
					: "URL must start with http:// or https://";
			} catch {
				return "Enter a URL such as https://your-domain.atlassian.net";
			}
		},
	});
	const values: Record<string, string> = {
		JIRA_URL: url.trim().replace(/\/+$/, ""),
	};
	if (instance === "cloud") {
		console.log(
			chalk.gray(
				"  Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens",
			),
		);
		values.JIRA_EMAIL = (
			await ask<string>({
				type: "text",
				name: "jiraEmail",
				message: "Jira account email:",
				initial: process.env.JIRA_EMAIL ?? "",
				validate: (value: string) =>
					value.includes("@")
						? true
						: "Enter the email you log in to Jira with",
			})
		).trim();
		values.JIRA_API_TOKEN = await ask<string>({
			type: "password",
			name: "jiraApiToken",
			message: "API token:",
			validate: (value: string) => (value.trim() ? true : "Token is required"),
		});
	} else {
		values.JIRA_PERSONAL_TOKEN = await ask<string>({
			type: "password",
			name: "jiraPersonalToken",
			message: "Personal access token:",
			validate: (value: string) => (value.trim() ? true : "Token is required"),
		});
	}
	return values;
}

async function offerEnvFile(
	ctx: WizardContext,
	values: Record<string, string>,
): Promise<void> {
	const save = await ask<boolean>({
		type: "confirm",
		name: "saveEnvFile",
		message: "Also write them to .env for later runs? (added to .gitignore)",
		initial: false,
	});
	if (!save) {
		console.log(
			chalk.gray(
				"  They are set for this session only. Export them before running backlog-jira again.",
			),
		);
		return;
	}
	const envPath = join(ctx.cwd, ".env");
	const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
	writeFileSync(envPath, mergeEnvFile(existing, values), { mode: 0o600 });
	console.log(chalk.green(`  ✓ Wrote ${envPath}`));

	const gitignorePath = join(ctx.cwd, ".gitignore");
	const gitignore = existsSync(gitignorePath)
		? readFileSync(gitignorePath, "utf-8")
		: "";
	if (!gitignore.split("\n").some((line) => line.trim() === ".env")) {
		writeFileSync(
			gitignorePath,
			`${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.env\n`,
		);
		console.log(chalk.green("  ✓ Added .env to .gitignore"));
	}
	console.log(
		chalk.yellow(
			"  backlog-jira does not read .env itself: load it with direnv ('dotenv' in .envrc) or 'set -a; . ./.env; set +a'.",
		),
	);
}

async function connectionStep(ctx: WizardContext): Promise<StepOutcome> {
	if (!detectCredentials().auth) {
		console.log(
			chalk.red(
				"  ✗ Credentials are not exported, so the MCP server cannot log in to Jira.",
			),
		);
		console.log(
			chalk.gray("    Run: backlog-jira configure --step credentials"),
		);
		return "failed";
	}
	console.log(chalk.gray("  Starting the MCP Atlassian server..."));
	const result = await withJira(ctx, (jira) => jira.checkConnection());
	if (result.ok) {
		console.log(chalk.green("  ✓ Connected to Jira"));
		return "done";
	}
	console.log(chalk.red("  ✗ Connection failed:"));
	for (const line of (result.error ?? "Unknown error").split("\n")) {
		console.log(chalk.red(`    ${line}`));
	}
	console.log(
		chalk.gray(
			"    Check the credentials, that Docker is running (or mcp.useExternalServer), and proxy settings in mcp.envVars.",
		),
	);
	return "failed";
}

async function projectStep(ctx: WizardContext): Promise<StepOutcome> {
	const current = jiraSection(ctx);
	// A restricted TOOLSETS must include the project tools setup relies on
	const envVars = getSection(getSection(ctx.config, "mcp"), "envVars");
	if (typeof envVars.TOOLSETS === "string") applyRequiredToolsets(ctx.config);

	let projects: Array<{ key: string; name: string }> = [];
	try {
		projects = await withJira(ctx, (jira) => jira.getAllProjects());
	} catch (error) {
		console.log(
			chalk.yellow(`  ⚠ Could not list Jira projects: ${describeError(error)}`),
		);
	}

	let projectKey: string;
	const manualKey = () =>
		ask<string>({
			type: "text",
			name: "projectKey",
			message: "Jira project key (e.g. PROJ):",
			initial: current.projectKey,
			validate: (value: string) =>
				/^[A-Za-z][A-Za-z0-9_]*$/.test(value.trim())
					? true
					: "Enter a project key such as PROJ",
		});
	if (projects.length > 0) {
		const sorted = [...projects].sort((a, b) => a.key.localeCompare(b.key));
		const choices = [
			...sorted.map((p) => ({ title: `${p.key} - ${p.name}`, value: p.key })),
			{ title: "Enter a key manually", value: "__manual__" },
		];
		const index = sorted.findIndex((p) => p.key === current.projectKey);
		const choice = await ask<string>({
			type: "autocomplete",
			name: "project",
			message: "Jira project (type to filter):",
			choices,
			initial: index >= 0 ? index : 0,
			suggest: filterChoices,
		});
		projectKey = choice === "__manual__" ? await manualKey() : choice;
	} else {
		projectKey = await manualKey();
	}
	projectKey = projectKey.trim().toUpperCase();

	let issueTypes: Array<{ name: string }> = [];
	try {
		issueTypes = await withJira(ctx, (jira) =>
			jira.getProjectIssueTypes(projectKey),
		);
	} catch (error) {
		console.log(
			chalk.yellow(
				`  ⚠ Could not list issue types of ${projectKey}: ${describeError(error)}`,
			),
		);
	}
	let issueType: string;
	if (issueTypes.length > 0) {
		const names = issueTypes.map((t) => t.name);
		const index = names.findIndex(
			(n) => n.toLowerCase() === current.issueType.toLowerCase(),
		);
		issueType = await ask<string>({
			type: "select",
			name: "issueType",
			message: "Issue type for tasks created in Jira:",
			choices: names.map((n) => ({ title: n, value: n })),
			initial: index >= 0 ? index : 0,
		});
	} else {
		issueType = await ask<string>({
			type: "text",
			name: "issueType",
			message: "Issue type for tasks created in Jira:",
			initial: current.issueType,
			validate: (value: string) => (value.trim() ? true : "Required"),
		});
	}

	setSectionValues(ctx.config, "jira", {
		projectKey,
		issueType: issueType.trim(),
	});
	console.log(
		chalk.green(`  ✓ Project ${projectKey}, issue type ${issueType}`),
	);
	return "done";
}

function filterChoices(
	input: string,
	choices: Array<{ title: string }>,
): Promise<Array<{ title: string }>> {
	const needle = input.trim().toLowerCase();
	return Promise.resolve(
		needle
			? choices.filter((c) => c.title.toLowerCase().includes(needle))
			: choices,
	);
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

async function statusStep(ctx: WizardContext): Promise<StepOutcome> {
	const { projectKey, issueType } = jiraSection(ctx);
	if (!projectKey) {
		console.log(
			chalk.yellow(
				"  Choose a project first: backlog-jira configure --step project",
			),
		);
		return "skipped";
	}
	const backlog = getSection(ctx.config, "backlog");
	const previous = (
		backlog.statusMapping && typeof backlog.statusMapping === "object"
			? backlog.statusMapping
			: {}
	) as Record<string, string[]>;
	const previousUnmapped = Array.isArray(backlog.unmappedJiraStatuses)
		? backlog.unmappedJiraStatuses.map(String)
		: [];
	const backlogStatuses = ctx.backlogStatuses();

	let perType: Array<{ issueType: string; statuses: string[] }> = [];
	try {
		perType = await withJira(ctx, async (jira) => {
			let types = [issueType];
			try {
				types = (await jira.getProjectIssueTypes(projectKey)).map(
					(t) => t.name,
				);
			} catch (error) {
				logger.debug({ error }, "Could not list issue types");
			}
			return discoverProjectStatuses(jira, projectKey, types);
		});
	} catch (error) {
		console.log(
			chalk.yellow(
				`  ⚠ Could not read Jira statuses of ${projectKey}: ${describeError(error)}`,
			),
		);
	}

	console.log(`  Backlog statuses: ${chalk.cyan(backlogStatuses.join(", "))}`);
	const jiraStatuses: string[] = [];
	const addStatus = (status: string) => {
		if (!jiraStatuses.some((s) => s.toLowerCase() === status.toLowerCase())) {
			jiraStatuses.push(status);
		}
	};
	if (perType.length > 0) {
		console.log(`  Jira statuses of ${projectKey} by issue type:`);
		for (const entry of perType) {
			console.log(
				`    ${entry.issueType.padEnd(12)} ${chalk.yellow(entry.statuses.join(", "))}`,
			);
			for (const status of entry.statuses) addStatus(status);
		}
		console.log(
			chalk.gray(
				"  (Found from the project's issues and their transitions; add statuses no issue has used yet below.)",
			),
		);
		for (const status of splitList(
			await ask<string>({
				type: "text",
				name: "extraStatuses",
				message: "Other Jira statuses to map (comma-separated, optional):",
				initial: "",
			}),
		)) {
			addStatus(status);
		}
	} else {
		console.log(
			chalk.yellow(
				`  No Jira statuses found for ${projectKey}. Enter them manually.`,
			),
		);
		const known = [...Object.values(previous).flat(), ...previousUnmapped].map(
			String,
		);
		for (const status of splitList(
			await ask<string>({
				type: "text",
				name: "extraStatuses",
				message: "Jira statuses (comma-separated):",
				initial: known.join(", "),
			}),
		)) {
			addStatus(status);
		}
	}
	if (jiraStatuses.length === 0) {
		console.log(
			chalk.yellow("  No statuses to map; keeping the current mapping."),
		);
		return "skipped";
	}

	const UNMAPPED = "__unmapped__";
	const choices: Record<string, string | null> = {};
	for (const status of jiraStatuses) {
		const wasUnmapped = previousUnmapped.some(
			(s) => s.toLowerCase() === status.toLowerCase(),
		);
		const suggestion = suggestBacklogStatus(status, backlogStatuses, previous);
		const options = [
			...backlogStatuses.map((s) => ({ title: s, value: s })),
			{ title: "Leave unmapped (keep the Jira status name)", value: UNMAPPED },
		];
		const answer = await ask<string>({
			type: "select",
			name: "backlogStatus",
			message: `Jira "${status}" →`,
			choices: options,
			initial: wasUnmapped
				? options.length - 1
				: Math.max(0, backlogStatuses.indexOf(suggestion)),
		});
		choices[status] = answer === UNMAPPED ? null : answer;
	}

	const { statusMapping, unmappedJiraStatuses } = buildStatusMappingConfig(
		choices,
		previous,
		previousUnmapped,
	);
	const uncovered = uncoveredJiraStatuses(
		jiraStatuses,
		statusMapping,
		unmappedJiraStatuses,
	);
	const values: RawConfig = { statusMapping };
	setSectionValues(ctx.config, "backlog", values);
	const section = getSection(ctx.config, "backlog");
	if (unmappedJiraStatuses.length > 0) {
		section.unmappedJiraStatuses = unmappedJiraStatuses;
	} else {
		section.unmappedJiraStatuses = undefined;
	}

	console.log(chalk.green("  ✓ Status mapping:"));
	for (const [backlogStatus, list] of Object.entries(statusMapping)) {
		console.log(`    ${backlogStatus.padEnd(14)} ← ${list.join(", ")}`);
	}
	if (unmappedJiraStatuses.length > 0) {
		console.log(
			chalk.gray(`    Left unmapped: ${unmappedJiraStatuses.join(", ")}`),
		);
	}
	if (uncovered.length > 0) {
		console.log(chalk.yellow(`    Not covered: ${uncovered.join(", ")}`));
	}
	const unused = backlogStatuses.filter((s) => !statusMapping[s]);
	if (unused.length > 0) {
		console.log(
			chalk.gray(
				`    Backlog statuses without a Jira status (cannot be pushed): ${unused.join(", ")}`,
			),
		);
	}
	return "done";
}

async function sprintsStep(ctx: WizardContext): Promise<StepOutcome> {
	const { projectKey } = jiraSection(ctx);
	const existing = findSprintEntry(ctx.config);
	// List boards with the toolsets sprint sync will use
	const listingConfig = applyRequiredToolsets(structuredClone(ctx.config));

	let boards: Awaited<ReturnType<WizardJira["listBoards"]>> = [];
	try {
		boards = await withJira(
			ctx,
			(jira) => jira.listBoards(projectKey ? { projectKey } : undefined),
			listingConfig,
		);
	} catch (error) {
		console.log(
			chalk.yellow(`  ⚠ Could not list Jira boards: ${describeError(error)}`),
		);
	}
	const sprintBoards = boards.filter((b) => b.supportsSprints);
	if (boards.length > 0) {
		console.log(
			`  Boards${projectKey ? ` of ${projectKey}` : ""} (sprint sync needs a board with sprints):`,
		);
		for (const board of boards) {
			console.log(
				`    ${board.id.padEnd(6)} ${board.name} ${chalk.gray(`[${board.type}]`)}${board.supportsSprints ? "" : chalk.gray(" (no sprints)")}`,
			);
		}
	} else {
		console.log(chalk.gray("  No boards found."));
	}
	if (existing) {
		console.log(
			`  Current: board ${String(existing.boardId)}, ${String(existing.direction ?? "both")}`,
		);
	}

	const choices = [
		...sprintBoards.map((b) => ({
			title: `Sync sprints of board ${b.id} - ${b.name}`,
			value: b.id,
		})),
		{ title: "Enter a board id", value: "__manual__" },
		...(existing ? [{ title: "Turn sprint sync off", value: "__off__" }] : []),
		{
			title: existing ? "Keep the current setting" : "No sprint sync",
			value: "__skip__",
		},
	];
	const currentIndex = existing
		? sprintBoards.findIndex((b) => b.id === String(existing.boardId))
		: -1;
	let boardId = await ask<string>({
		type: "select",
		name: "board",
		message: "Sprint sync:",
		choices,
		initial:
			currentIndex >= 0
				? currentIndex
				: sprintBoards.length > 0 && !existing
					? 0
					: choices.length - 1,
	});
	if (boardId === "__skip__") return "skipped";
	if (boardId === "__off__") {
		ctx.config = removeFieldMapping(ctx.config, String(existing?.backlog));
		console.log(chalk.green("  ✓ Sprint sync turned off"));
		return "done";
	}
	if (boardId === "__manual__") {
		boardId = (
			await ask<string>({
				type: "text",
				name: "boardId",
				message: "Board id:",
				initial: existing ? String(existing.boardId) : "",
				validate: (value: string) =>
					/^\d+$/.test(value.trim()) ? true : "Enter the numeric board id",
			})
		).trim();
	}

	const directions: FieldMappingDirection[] = ["both", "pull", "push"];
	const direction = await ask<FieldMappingDirection>({
		type: "select",
		name: "sprintDirection",
		message: "Direction:",
		choices: [
			{ title: "both - Jira sprints ↔ Backlog milestones", value: "both" },
			{ title: "pull - Jira → Backlog only", value: "pull" },
			{ title: "push - Backlog → Jira only", value: "push" },
		],
		initial: Math.max(
			0,
			directions.indexOf(existing?.direction as FieldMappingDirection),
		),
	});
	const createSprints =
		direction === "pull"
			? false
			: await ask<boolean>({
					type: "confirm",
					name: "createSprints",
					message:
						"Create a Jira sprint when a pushed milestone matches none? (otherwise it is reported)",
					initial: existing?.createSprints === true,
				});
	const archiveClosedSprints = await ask<boolean>({
		type: "confirm",
		name: "archiveClosedSprints",
		message: "Archive the milestone when its sprint closes?",
		initial: existing?.archiveClosedSprints !== false,
	});
	const pullScope: SprintPullScope =
		direction === "push"
			? "all"
			: await ask<SprintPullScope>({
					type: "select",
					name: "pullScope",
					message: "Issues 'pull --import' brings in:",
					choices: [
						{
							title: "all - every issue matching the import filter",
							value: "all",
						},
						{
							title:
								"open - only issues in open sprints (sprint in openSprints())",
							value: "open",
						},
					],
					initial: existing?.pullScope === "open" ? 1 : 0,
				});

	try {
		ctx.config = applySprintSettings(ctx.config, {
			boardId,
			direction,
			createSprints,
			archiveClosedSprints,
			pullScope,
		});
	} catch (error) {
		console.log(chalk.red(`  ✗ ${describeError(error)}`));
		return "failed";
	}
	const toolsets = getSection(
		getSection(ctx.config, "mcp"),
		"envVars",
	).TOOLSETS;
	console.log(
		chalk.green(
			`  ✓ Sprints of board ${boardId} sync as milestones (${direction})`,
		),
	);
	console.log(
		chalk.gray(
			`    mcp.envVars.TOOLSETS=${String(toolsets)} keeps the jira_agile tools enabled`,
		),
	);
	return "done";
}

async function fieldsStep(ctx: WizardContext): Promise<StepOutcome> {
	const { mappings, sprintMapping } = validateFieldMappings(
		ctx.config.fieldMappings,
	);
	if (mappings.length > 0 || sprintMapping) {
		console.log("  Current mappings:");
		if (sprintMapping) {
			console.log(`    milestone ↔ sprint (board ${sprintMapping.boardId})`);
		}
		for (const m of mappings) {
			console.log(`    ${m.backlog} ← ${m.jira} (${m.type}, ${m.direction})`);
		}
	}

	type Field = Awaited<ReturnType<WizardJira["searchFields"]>>[number];
	let fields: Field[] = [];
	try {
		fields = await withJira(ctx, (jira) => jira.searchFields("", 1000));
	} catch (error) {
		console.log(
			chalk.yellow(`  ⚠ Could not list Jira fields: ${describeError(error)}`),
		);
	}
	// Sprints are set up in their own step
	fields = fields
		.filter((f) => f.schema?.custom !== SPRINT_FIELD_SCHEMA)
		.sort((a, b) => a.name.localeCompare(b.name));
	const byId = new Map(fields.map((f) => [f.id, f]));
	const describe = (f: Field) => {
		const schema = f.schema?.type
			? f.schema.items
				? `${f.schema.type}<${f.schema.items}>`
				: f.schema.type
			: "unknown";
		const suggested = suggestTypeForSchema(f.schema);
		return `${f.name} (${f.id}) [${schema}]${suggested ? ` → ${suggested}` : ""}`;
	};

	let added = 0;
	for (;;) {
		const more = await ask<boolean>({
			type: "confirm",
			name: "addField",
			message:
				added === 0 ? "Add a field mapping?" : "Add another field mapping?",
			initial: false,
		});
		if (!more) break;

		const jiraField =
			fields.length > 0
				? await ask<string>({
						type: "autocomplete",
						name: "jiraField",
						message: "Jira field (type to filter):",
						choices: fields.map((f) => ({ title: describe(f), value: f.id })),
						suggest: filterChoices,
					})
				: (
						await ask<string>({
							type: "text",
							name: "jiraField",
							message: "Jira field id (customfield_NNNNN or a system field):",
							validate: (value: string) => (value.trim() ? true : "Required"),
						})
					).trim();
		const field = byId.get(jiraField);
		const slug = (field?.name ?? jiraField)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "");
		const backlog = (
			await ask<string>({
				type: "text",
				name: "backlogTarget",
				message:
					"Backlog target (milestone, dependencies, references, priority, labels or frontmatter:<key>):",
				initial: `frontmatter:${slug}`,
				validate: (value: string) =>
					validateBacklogTarget(value.trim()) ?? true,
			})
		).trim();
		const suggested = suggestTypeForSchema(field?.schema);
		const type = await ask<string>({
			type: "select",
			name: "fieldType",
			message: "Value type:",
			choices: FIELD_MAPPING_TYPES.map((t) => ({ title: t, value: t })),
			initial: suggested ? FIELD_MAPPING_TYPES.indexOf(suggested) : 0,
		});
		const direction = await ask<string>({
			type: "select",
			name: "fieldDirection",
			message: "Direction:",
			choices: FIELD_MAPPING_DIRECTIONS.map((d) => ({
				title:
					d === "pull"
						? "pull - Jira → Backlog"
						: d === "push"
							? "push - Backlog → Jira"
							: "both",
				value: d,
			})),
			initial: 0,
		});

		const mapping = { backlog, jira: jiraField, type, direction };
		try {
			let force = false;
			if (
				Array.isArray(ctx.config.fieldMappings) &&
				ctx.config.fieldMappings.some(
					(m) => (m as { backlog?: unknown })?.backlog === backlog,
				)
			) {
				force = await ask<boolean>({
					type: "confirm",
					name: "replaceMapping",
					message: `A mapping for "${backlog}" exists. Replace it?`,
					initial: false,
				});
				if (!force) continue;
			}
			ctx.config = addFieldMapping(ctx.config, mapping, { force });
			added++;
			console.log(
				chalk.green(`  ✓ ${backlog} ← ${jiraField} (${type}, ${direction})`),
			);
		} catch (error) {
			console.log(chalk.red(`  ✗ ${describeError(error)}`));
		}
	}
	if (added > 0) {
		console.log(
			chalk.gray(
				"  Value maps: backlog-jira map-fields add <target> <field> --type <type> --value-map 'Jira=Backlog' --force",
			),
		);
	}
	return added > 0 ? "done" : "skipped";
}

async function conflictStep(ctx: WizardContext): Promise<StepOutcome> {
	const current = getSection(ctx.config, "sync").conflictStrategy;
	const strategy = await ask<ConflictStrategy>({
		type: "select",
		name: "conflictStrategy",
		message: "When a field changed in both Backlog and Jira:",
		choices: [
			{
				title: "prompt - ask which side to keep for each conflicting field",
				value: "prompt",
			},
			{
				title: "prefer-backlog - keep the Backlog value",
				value: "prefer-backlog",
			},
			{ title: "prefer-jira - keep the Jira value", value: "prefer-jira" },
		],
		initial: Math.max(
			0,
			CONFLICT_STRATEGIES.indexOf(current as ConflictStrategy),
		),
	});
	setSectionValues(ctx.config, "sync", { conflictStrategy: strategy });
	console.log(chalk.green(`  ✓ Conflict strategy: ${strategy}`));
	return "done";
}

async function filterStep(ctx: WizardContext): Promise<StepOutcome> {
	const { projectKey, jqlFilter } = jiraSection(ctx);
	const suggested = projectKey
		? `project = ${projectKey} ORDER BY created DESC`
		: "";
	console.log(
		chalk.gray(
			`  'backlog-jira pull --import' imports up to ${IMPORT_LIMIT} unlinked issues matching this JQL per run.`,
		),
	);
	if (findSprintEntry(ctx.config)?.pullScope === "open") {
		console.log(
			chalk.gray('  pullScope "open" adds: AND sprint in openSprints()'),
		);
	}
	for (;;) {
		const jql = (
			await ask<string>({
				type: "text",
				name: "jqlFilter",
				message: "Import filter (JQL):",
				initial: jqlFilter || suggested,
				validate: (value: string) =>
					value.trim() ? true : "Enter a JQL query",
			})
		).trim();

		let problem: string | null = null;
		if (detectCredentials().auth) {
			try {
				const result = await withJira(ctx, (jira) =>
					jira.searchIssues(jql, { maxResults: 1, fields: "summary" }),
				);
				if (typeof result.total === "number" && result.total >= 0) {
					console.log(
						`  ${result.total} issue${result.total === 1 ? "" : "s"} match`,
					);
					if (result.total > IMPORT_LIMIT) {
						console.log(
							chalk.yellow(
								`  More than ${IMPORT_LIMIT} issues match: one import run takes the first ${IMPORT_LIMIT}. Import in batches with narrower filters (pull --import --jql '...'), e.g. by sprint or created date.`,
							),
						);
					}
				}
			} catch (error) {
				problem = describeError(error);
			}
		}
		if (problem) {
			console.log(chalk.red(`  ✗ Jira rejected the filter: ${problem}`));
			const keep = await ask<boolean>({
				type: "confirm",
				name: "keepFilter",
				message: "Keep this filter anyway?",
				initial: false,
			});
			if (!keep) continue;
		}
		setSectionValues(ctx.config, "jira", { jqlFilter: jql });
		console.log(chalk.green(`  ✓ Import filter: ${jql}`));
		return "done";
	}
}

const STEP_RUNNERS: Record<
	ConfigureStep,
	(ctx: WizardContext) => Promise<StepOutcome>
> = {
	credentials: credentialsStep,
	connection: connectionStep,
	project: projectStep,
	status: statusStep,
	sprints: sprintsStep,
	fields: fieldsStep,
	conflict: conflictStep,
	filter: filterStep,
};

// ===== Wizard =====

function printNextSteps(): void {
	console.log(chalk.bold.cyan("\nNext steps:"));
	console.log(
		"  1. Preview the import:   backlog-jira pull --import --dry-run",
	);
	console.log(
		`  2. Import:               backlog-jira pull --import   (at most ${IMPORT_LIMIT} issues per run; narrow with --jql to import more)`,
	);
	console.log(
		'  3. Commit the setup:     git add .backlog-jira && git commit -m "Configure backlog-jira"',
	);
	console.log(
		chalk.gray(
			`\n  Revisit a step any time: backlog-jira configure --step <${CONFIGURE_STEPS.join("|")}>\n`,
		),
	);
}

/**
 * Configure the plugin: the guided wizard, a single step (--step), or
 * non-interactive mode for CI. Returns instead of exiting the process.
 */
export async function runConfigure(
	options: ConfigureOptions = {},
): Promise<ConfigureResult> {
	const originalLogLevel = getLogLevel();
	if (!options.verbose) setLogLevel("warn");
	try {
		if (options.nonInteractive) return configureNonInteractive(options);

		const step = options.step?.trim().toLowerCase();
		if (step && !CONFIGURE_STEPS.includes(step as ConfigureStep)) {
			throw new Error(
				`Unknown step "${options.step}". Steps: ${CONFIGURE_STEPS.join(", ")}`,
			);
		}
		const steps: ConfigureStep[] = step
			? [step as ConfigureStep]
			: [...CONFIGURE_STEPS];

		const cwd = options.cwd ?? process.cwd();
		if (bootstrapConfigDir(cwd)) {
			console.log(
				chalk.gray(`Created ${getConfigDir(cwd)}/ with default settings.`),
			);
		}
		const ctx: WizardContext = {
			cwd,
			config: readConfigFile(cwd) ?? {},
			createJira: options.createJira ?? defaultCreateJira,
			backlogStatuses:
				options.backlogStatuses ?? (() => readBacklogStatuses(cwd)),
		};

		if (!step) {
			console.log(chalk.bold.cyan("\n🔧 backlog-jira setup\n"));
			console.log(
				chalk.gray(
					`${steps.length} steps; skip any of them and come back later with --step <name>. Each step is saved as it completes.`,
				),
			);
		}

		try {
			const result: ConfigureResult = {
				completed: [],
				skipped: [],
				failed: false,
			};
			for (const [index, name] of steps.entries()) {
				const info = STEP_INFO[name];
				console.log(
					chalk.bold.green(
						`\n${step ? "" : `Step ${index + 1}/${steps.length}: `}${info.title}`,
					),
				);
				console.log(chalk.gray(`  ${info.about}\n`));
				try {
					if (!step) {
						const run = await ask<boolean>({
							type: "confirm",
							name: `run_${name}`,
							message: `Set up ${info.title.toLowerCase()} now?`,
							initial: true,
						});
						if (!run) {
							console.log(
								chalk.gray(
									`  Skipped. Later: backlog-jira configure --step ${name}`,
								),
							);
							result.skipped.push(name);
							continue;
						}
					}
					const outcome = await STEP_RUNNERS[name](ctx);
					writeConfigFile(ctx.config, cwd);
					if (outcome === "done") result.completed.push(name);
					else result.skipped.push(name);
					if (outcome === "failed") {
						result.failed = true;
						if (!step && name === "connection") {
							const proceed = await ask<boolean>({
								type: "confirm",
								name: "continueOffline",
								message:
									"Continue without a connection? (later steps fall back to manual entry)",
								initial: true,
							});
							if (!proceed) {
								console.log(
									chalk.gray(
										"  Fix the connection, then run: backlog-jira configure",
									),
								);
								return result;
							}
						}
					}
				} catch (error) {
					if (error instanceof WizardCancelled) {
						writeConfigFile(ctx.config, cwd);
						console.log(
							chalk.yellow(
								`\n✗ Setup cancelled. Completed steps are saved; resume with: backlog-jira configure --step ${name}\n`,
							),
						);
						return { ...result, cancelledAt: name };
					}
					throw error;
				}
			}

			console.log(
				chalk.gray(`\n  Saved ${join(getConfigDir(cwd), "config.json")}`),
			);
			if (!step) {
				// doctor starts its own MCP server
				await closeJira(ctx);
				console.log(
					chalk.bold.cyan("\nChecking the setup (backlog-jira doctor)\n"),
				);
				setLogLevel("info");
				try {
					const doctor = await (options.doctor ?? runDoctor)();
					if (!doctor.ok) result.failed = true;
				} catch (error) {
					console.log(chalk.red(`  ✗ doctor failed: ${describeError(error)}`));
					result.failed = true;
				} finally {
					if (!options.verbose) setLogLevel("warn");
				}
				printNextSteps();
			}
			return result;
		} finally {
			// Stops the MCP server
			await closeJira(ctx);
		}
	} finally {
		setLogLevel(
			originalLogLevel as
				| "trace"
				| "debug"
				| "info"
				| "warn"
				| "error"
				| "fatal",
		);
	}
}

/**
 * Non-interactive configuration for CI: creates .backlog-jira/ if needed and
 * applies the given values and JIRA_URL, keeping everything else
 */
function configureNonInteractive(options: ConfigureOptions): ConfigureResult {
	const cwd = options.cwd ?? process.cwd();
	bootstrapConfigDir(cwd);
	const config = readConfigFile(cwd) ?? {};

	if (
		options.conflictStrategy !== undefined &&
		!CONFLICT_STRATEGIES.includes(options.conflictStrategy as ConflictStrategy)
	) {
		throw new Error(
			`Invalid conflict strategy "${options.conflictStrategy}". Use one of: ${CONFLICT_STRATEGIES.join(", ")}`,
		);
	}

	const credentials = detectCredentials();
	const jira: RawConfig = {};
	if (credentials.url) jira.baseUrl = credentials.url.replace(/\/+$/, "");
	if (options.projectKey)
		jira.projectKey = options.projectKey.trim().toUpperCase();
	if (options.issueType) jira.issueType = options.issueType.trim();
	if (options.jqlFilter !== undefined)
		jira.jqlFilter = options.jqlFilter.trim();
	setSectionValues(config, "jira", jira);

	const sync: RawConfig = {};
	if (options.conflictStrategy)
		sync.conflictStrategy = options.conflictStrategy;
	if (options.enableAnnotations) sync.enableAnnotations = true;
	if (Object.keys(sync).length > 0) setSectionValues(config, "sync", sync);

	writeConfigFile(config, cwd);
	console.log(`Saved ${join(getConfigDir(cwd), "config.json")}`);

	if (!credentials.auth) {
		console.log(
			chalk.yellow(
				`Warning: not exported to this process: ${credentials.missing.join(", ")} (or JIRA_URL and JIRA_PERSONAL_TOKEN)`,
			),
		);
	}
	const projectKey = getSection(config, "jira").projectKey;
	if (!projectKey) {
		console.log(
			chalk.yellow("Warning: jira.projectKey is not set (use --project-key)"),
		);
	}
	return { completed: [], skipped: [], failed: false };
}

/**
 * CLI entry point
 */
export async function configureCommand(
	options: ConfigureOptions = {},
): Promise<void> {
	const result = await runConfigure(options);
	// prompts keeps stdin open, so exit explicitly
	process.exit(result.failed ? 1 : 0);
}
