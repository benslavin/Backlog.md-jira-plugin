import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import { SPRINT_FIELD_SCHEMA } from "../integrations/jira-sprints.ts";
import {
	DEFAULT_SEARCH_ALL_LIMIT,
	JiraClient,
	type JiraIssue,
} from "../integrations/jira.ts";
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
	BACKLOG_PRIORITIES,
	DEFAULT_PRIORITY_MAPPING,
	FIELD_MAPPING_DIRECTIONS,
	FIELD_MAPPING_TYPES,
	type FieldMappingDirection,
	PRIORITY_SYSTEM_FIELD,
	type SprintPullScope,
	isBuiltInPriorityMapping,
	isMcpReturnedField,
	suggestTypeForSchema,
	validateBacklogTarget,
	validateFieldMappings,
} from "../utils/field-mapping.ts";
import { jiraClientOptionsFromConfig } from "../utils/jira-config.ts";
import {
	flushLogger,
	getLogLevel,
	logger,
	setLogLevel,
} from "../utils/logger.ts";
import {
	DEFAULT_SYNCED_FIELDS,
	type FieldSuggestion,
	type IssueTypeStatuses,
	applyRequiredToolsets,
	applySprintSettings,
	buildStatusMappingConfig,
	buildStatusOptions,
	checkStatusNames,
	credentialHelpLines,
	describeStatusOption,
	detectCredentials,
	discoverProjectStatuses,
	findSprintEntry,
	mergeEnvFile,
	readBacklogStatuses,
	suggestBacklogStatus,
	suggestBacklogTarget,
	suggestFieldMappings,
	uncoveredJiraStatuses,
} from "../utils/setup.ts";
import { runDoctor } from "./doctor.ts";
import {
	addFieldMapping,
	parseValueMapEntries,
	removeFieldMapping,
} from "./map-fields.ts";

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

/** Project issues sampled to rank fields by use */
const FIELD_SAMPLE_SIZE = 50;

/** Jira operations the wizard uses */
export type WizardJira = Pick<
	JiraClient,
	| "checkConnection"
	| "getAllProjects"
	| "getProjectIssueTypes"
	| "searchIssues"
	| "searchAllIssues"
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

/** Esc: go back to the previous question or menu */
class WizardBack extends Error {
	constructor() {
		super("Back");
		this.name = "WizardBack";
	}
}

/**
 * Ask one question. Esc throws WizardBack; Ctrl+C (an undefined answer)
 * cancels the wizard. prompts handles Esc like Ctrl+C, so each prompt's exit
 * handler (Esc) is replaced once it renders to tell the two apart.
 */
async function ask<T>(question: prompts.PromptObject): Promise<T> {
	const name = String(question.name);
	let escaped = false;
	const onRender = question.onRender;
	const response = await prompts({
		...question,
		onRender(this: unknown, ...args: unknown[]) {
			const prompt = this as {
				exit?: () => void;
				abort?: () => void;
				escPatched?: boolean;
			};
			if (!prompt.escPatched) {
				prompt.escPatched = true;
				prompt.exit = () => {
					escaped = true;
					prompt.abort?.();
				};
			}
			return (onRender as ((...a: unknown[]) => void) | undefined)?.apply(
				this,
				args,
			);
		},
	});
	const answer = response?.[name];
	if (answer === undefined) {
		if (escaped) throw new WizardBack();
		throw new WizardCancelled();
	}
	return answer as T;
}

/**
 * onRender hook for multiselect prompts: once submitted, the summary line
 * lists short labels instead of the full choice titles
 */
function shortLabelsWhenDone(
	labels: Map<string, string>,
): (this: unknown) => void {
	return function (this: unknown) {
		const prompt = this as {
			done?: boolean;
			value?: Array<{ title: string; value: string }>;
		};
		if (!prompt.done || !Array.isArray(prompt.value)) return;
		for (const choice of prompt.value) {
			choice.title = labels.get(choice.value) ?? choice.title;
		}
	};
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
		if (projects.length === 0) {
			console.log(
				chalk.yellow(
					"  ⚠ Jira returned no projects. Check the connection (backlog-jira configure --step connection) or enter the key manually.",
				),
			);
		}
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
				/^[A-Za-z][A-Za-z0-9_]+$/.test(value.trim())
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

	const known = [...Object.values(previous).flat(), ...previousUnmapped].map(
		String,
	);
	let perType: IssueTypeStatuses[] = [];
	let check: { statuses: string[]; checked: boolean } | null = null;
	try {
		await withJira(ctx, async (jira) => {
			let types = [issueType];
			try {
				types = (await jira.getProjectIssueTypes(projectKey)).map(
					(t) => t.name,
				);
			} catch (error) {
				logger.debug({ error }, "Could not list issue types");
			}
			perType = await discoverProjectStatuses(jira, projectKey, types);
			if (perType.length === 0) return;

			// Statuses no issue is in yet: transition names, Backlog statuses
			// and the current mapping, if Jira knows them as statuses
			const onIssues = new Set(
				perType.flatMap((t) => t.statuses).map((s) => s.toLowerCase()),
			);
			const candidates: string[] = [];
			for (const name of [
				...perType.flatMap((t) => t.candidates),
				...backlogStatuses,
				...known,
			]) {
				if (
					!onIssues.has(name.toLowerCase()) &&
					!candidates.some((c) => c.toLowerCase() === name.toLowerCase())
				) {
					candidates.push(name);
				}
			}
			if (candidates.length === 0) return;
			check = await checkStatusNames(jira, projectKey, candidates);
		});
	} catch (error) {
		console.log(
			chalk.yellow(
				`  ⚠ Could not read Jira statuses of ${projectKey}: ${describeError(error)}`,
			),
		);
	}

	const statusOptions = buildStatusOptions(
		perType,
		check,
		previous,
		previousUnmapped,
	);
	console.log(
		`  Backlog statuses: ${chalk.cyan(backlogStatuses.join(", "))}\n`,
	);

	const jiraStatuses: string[] = [];
	const addStatus = (status: string) => {
		if (!jiraStatuses.some((s) => s.toLowerCase() === status.toLowerCase())) {
			jiraStatuses.push(status);
		}
	};
	if (statusOptions.length > 0) {
		const width = Math.max(...statusOptions.map((o) => o.name.length));
		for (const status of await ask<string[]>({
			type: "multiselect",
			name: "jiraStatuses",
			message: `Jira statuses in ${projectKey}'s workflow`,
			hint: "space toggles, enter confirms",
			instructions: false,
			choices: statusOptions.map((option) => ({
				title: `${option.name.padEnd(width)}  ${chalk.gray(describeStatusOption(option))}`,
				value: option.name,
				selected: option.selected,
			})),
			onRender: shortLabelsWhenDone(
				new Map(statusOptions.map((o) => [o.name, o.name])),
			),
		})) {
			addStatus(status);
		}
	} else {
		console.log(chalk.yellow(`  No Jira statuses found for ${projectKey}.`));
	}
	for (const status of splitList(
		await ask<string>({
			type: "text",
			name: "extraStatuses",
			message:
				statusOptions.length > 0
					? "Other Jira statuses, if any (comma-separated, Enter to skip):"
					: "Jira statuses (comma-separated):",
			initial: statusOptions.length > 0 ? "" : known.join(", "),
		}),
	)) {
		addStatus(status);
	}
	if (jiraStatuses.length === 0) {
		console.log(
			chalk.yellow("  No statuses to map; keeping the current mapping."),
		);
		return "skipped";
	}
	// Remove from the mapping: statuses offered but unticked, and mapped
	// statuses Jira says do not exist (e.g. init's defaults)
	const confirmed = check as { statuses: string[]; checked: boolean } | null;
	const isOffered = (name: string) =>
		statusOptions.some((o) => o.name.toLowerCase() === name.toLowerCase());
	const notStatuses = confirmed?.checked
		? known.filter(
				(name) =>
					!isOffered(name) &&
					!confirmed.statuses.some(
						(s) => s.toLowerCase() === name.toLowerCase(),
					),
			)
		: [];
	const dropped = [...statusOptions.map((o) => o.name), ...notStatuses].filter(
		(name) => !jiraStatuses.some((s) => s.toLowerCase() === name.toLowerCase()),
	);

	// Propose the whole mapping; only statuses picked to change are asked about
	const choices: Record<string, string | null> = {};
	for (const status of jiraStatuses) {
		const wasUnmapped = previousUnmapped.some(
			(s) => s.toLowerCase() === status.toLowerCase(),
		);
		choices[status] = wasUnmapped
			? null
			: suggestBacklogStatus(status, backlogStatuses, previous);
	}
	const width = Math.max(...jiraStatuses.map((s) => s.length));
	const describeChoice = (status: string) =>
		choices[status] ?? chalk.gray("unmapped (pulled as-is)");
	const printMapping = () => {
		for (const status of jiraStatuses) {
			console.log(`    ${status.padEnd(width)}  →  ${describeChoice(status)}`);
		}
	};
	console.log("\n  Proposed mapping (Jira → Backlog):");
	printMapping();
	console.log();
	const decision = await ask<string>({
		type: "select",
		name: "statusDecision",
		message: "Use this mapping?",
		choices: [
			{ title: "Yes", value: "accept" },
			{ title: "Change some statuses", value: "change" },
		],
		initial: 0,
	});
	if (decision === "change") {
		const UNMAPPED = "__unmapped__";
		const toChange = await ask<string[]>({
			type: "multiselect",
			name: "statusesToChange",
			message: "Statuses to change",
			hint: "space toggles, enter confirms",
			instructions: false,
			choices: jiraStatuses.map((status) => ({
				title: `${status.padEnd(width)}  →  ${describeChoice(status)}`,
				value: status,
			})),
			onRender: shortLabelsWhenDone(new Map(jiraStatuses.map((j) => [j, j]))),
		});
		for (const status of toChange) {
			const options = [
				...backlogStatuses.map((s) => ({ title: s, value: s })),
				{
					title: "Leave unmapped (pull the Jira status name as-is)",
					value: UNMAPPED,
				},
			];
			const current = choices[status];
			const answer = await ask<string>({
				type: "select",
				name: "backlogStatus",
				message: `Jira "${status}" →`,
				choices: options,
				initial:
					current === null
						? options.length - 1
						: Math.max(0, backlogStatuses.indexOf(current)),
			});
			choices[status] = answer === UNMAPPED ? null : answer;
		}
		if (toChange.length > 0) {
			console.log("\n  Mapping (Jira → Backlog):");
			printMapping();
		}
	}

	const { statusMapping, unmappedJiraStatuses } = buildStatusMappingConfig(
		choices,
		previous,
		previousUnmapped,
		dropped,
	);
	const uncovered = uncoveredJiraStatuses(
		jiraStatuses,
		statusMapping,
		unmappedJiraStatuses,
	);
	setSectionValues(ctx.config, "backlog", { statusMapping });
	const section = getSection(ctx.config, "backlog");
	section.unmappedJiraStatuses =
		unmappedJiraStatuses.length > 0 ? unmappedJiraStatuses : undefined;

	console.log(chalk.green("  ✓ Status mapping saved"));
	if (dropped.length > 0) {
		console.log(chalk.gray(`    Removed: ${dropped.join(", ")}`));
	}
	if (uncovered.length > 0) {
		console.log(chalk.yellow(`    Not covered: ${uncovered.join(", ")}`));
	}
	const unused = backlogStatuses.filter((s) => !statusMapping[s]);
	if (unused.length > 0) {
		console.log(
			chalk.gray(
				`    Backlog statuses with no Jira status (cannot be pushed): ${unused.join(", ")}`,
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

type DiscoveredField = Awaited<ReturnType<WizardJira["searchFields"]>>[number];

interface PlannedMapping {
	backlog: string;
	jira: string;
	type: string;
	direction: string;
	/** Label of the Jira field */
	label: string;
	valueMap?: Record<string, string>;
	/** Target of the configured mapping this one replaces */
	replaces?: string;
	/** The sprint mapping (set up in the sprints step) */
	sprint?: boolean;
}

/** Unsaved changes of the field mappings menu */
interface FieldsDraft {
	configured: PlannedMapping[];
	/** Targets of configured mappings to remove */
	removals: Set<string>;
	pending: PlannedMapping[];
}

function describeField(f: DiscoveredField): string {
	const schema = f.schema?.type
		? f.schema.items
			? `${f.schema.type}<${f.schema.items}>`
			: f.schema.type
		: "unknown";
	const suggested = suggestTypeForSchema(f.schema);
	return `${f.name} (${f.id}) [${schema}]${suggested ? ` → ${suggested}` : ""}`;
}

function fieldLabel(fields: DiscoveredField[], id: string): string {
	const field = fields.find((f) => f.id === id);
	return field ? `${field.name} (${field.id})` : id;
}

function arrowFor(direction: string): string {
	return direction === "both" ? "↔" : direction === "push" ? "→" : "←";
}

function describePlanned(p: PlannedMapping): string {
	const valueMap = p.valueMap
		? ` ${chalk.gray(
				`values: ${Object.entries(p.valueMap)
					.map(([from, to]) => `${from}=${to}`)
					.join(", ")}`,
			)}`
		: "";
	return `${p.backlog} ${arrowFor(p.direction)} ${p.label}  ${chalk.gray(`${p.type}, ${p.direction}`)}${valueMap}`;
}

function draftChanges(draft: FieldsDraft): number {
	return draft.pending.length + draft.removals.size;
}

/** Configured mappings that stay: not removed and not replaced */
function keptConfigured(draft: FieldsDraft): PlannedMapping[] {
	return draft.configured.filter(
		(c) =>
			!draft.removals.has(c.backlog) &&
			!draft.pending.some((p) => p.replaces === c.backlog),
	);
}

/**
 * Backlog targets in use once the draft is saved, except those of the
 * mapping being edited
 */
function takenTargets(draft: FieldsDraft, editing?: PlannedMapping): string[] {
	const own = new Set(
		[editing?.backlog, editing?.replaces].filter(
			(t): t is string => t !== undefined,
		),
	);
	return [
		...keptConfigured(draft).map((c) => c.backlog),
		...draft.pending.filter((p) => p !== editing).map((p) => p.backlog),
	].filter((t) => !own.has(t));
}

function printDraft(draft: FieldsDraft): void {
	console.log(
		`\n  ${chalk.bold("Synced by default:")} ${DEFAULT_SYNCED_FIELDS.map((f) =>
			f.jira === f.backlog ? f.jira : `${f.backlog} ↔ ${f.jira}`,
		).join(", ")}`,
	);
	console.log(`  ${chalk.bold("Configured:")}`);
	if (draft.configured.length === 0) console.log(chalk.gray("    none"));
	for (const c of draft.configured) {
		const note = draft.removals.has(c.backlog)
			? chalk.red("  (removing)")
			: draft.pending.some((p) => p.replaces === c.backlog)
				? chalk.yellow("  (changing)")
				: "";
		console.log(`    ${describePlanned(c)}${note}`);
	}
	if (draft.pending.length > 0) {
		console.log(`  ${chalk.bold("Pending, not saved yet:")}`);
		for (const p of draft.pending) {
			console.log(chalk.green(`    + ${describePlanned(p)}`));
		}
	}
	console.log("");
}

/**
 * Put an edited mapping into the draft: replacing its pending entry, or
 * pending as a change of a configured mapping, or as a new mapping
 */
function stageMapping(
	draft: FieldsDraft,
	entry: PlannedMapping,
	original?: PlannedMapping,
): void {
	const pendingIndex = original ? draft.pending.indexOf(original) : -1;
	if (pendingIndex >= 0) {
		draft.pending[pendingIndex] = { ...entry, replaces: original?.replaces };
		return;
	}
	if (original && draft.configured.includes(original)) {
		const unchanged =
			entry.backlog === original.backlog &&
			entry.type === original.type &&
			entry.direction === original.direction &&
			JSON.stringify(entry.valueMap) === JSON.stringify(original.valueMap);
		if (unchanged) return;
		draft.removals.delete(original.backlog);
		draft.pending.push({ ...entry, replaces: original.backlog });
		return;
	}
	draft.pending.push(entry);
}

/**
 * Show a mapping on one line and let the user accept it or change its
 * target, type or direction. Esc on the line throws WizardBack; Esc in a
 * change goes back to the line.
 */
async function editMapping(
	draft: FieldsDraft,
	start: PlannedMapping,
): Promise<PlannedMapping> {
	const entry = { ...start };
	for (;;) {
		const action = await ask<string>({
			type: "select",
			name: "fieldAction",
			message: `${entry.label}: ${entry.backlog}, ${entry.type}, ${entry.direction}`,
			hint: "Esc goes back",
			choices: [
				{ title: "Accept", value: "accept" },
				{ title: "Change Backlog target", value: "target" },
				{ title: "Change value type", value: "type" },
				{ title: "Change direction", value: "direction" },
			],
			initial: 0,
		});
		if (action === "accept") return entry;
		try {
			if (action === "target") {
				const taken = takenTargets(draft, start);
				entry.backlog = (
					await ask<string>({
						type: "text",
						name: "backlogTarget",
						message: `Backlog target (milestone, dependencies, references, priority, labels or frontmatter:<key>)${
							taken.length > 0 ? `; taken: ${taken.join(", ")}` : ""
						}:`,
						initial: entry.backlog,
						validate: (value: string) => {
							const target = value.trim();
							const error = validateBacklogTarget(target);
							if (error) return error;
							if (taken.includes(target)) {
								return `"${target}" is already mapped; choose another target or remove that mapping first`;
							}
							return true;
						},
					})
				).trim();
			} else if (action === "type") {
				entry.type = await ask<string>({
					type: "select",
					name: "fieldType",
					message: "Value type:",
					choices: FIELD_MAPPING_TYPES.map((t) => ({ title: t, value: t })),
					initial: Math.max(
						0,
						FIELD_MAPPING_TYPES.indexOf(
							entry.type as (typeof FIELD_MAPPING_TYPES)[number],
						),
					),
				});
			} else {
				entry.direction = await ask<string>({
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
					initial: Math.max(
						0,
						FIELD_MAPPING_DIRECTIONS.indexOf(
							entry.direction as FieldMappingDirection,
						),
					),
				});
			}
		} catch (error) {
			if (!(error instanceof WizardBack)) throw error;
		}
	}
}

/**
 * Jira's system priority syncs with Backlog priority by default; picking it
 * edits how Jira priorities translate (the built-in mapping's value map)
 */
async function editPriorityValueMap(draft: FieldsDraft): Promise<void> {
	const other = [...keptConfigured(draft), ...draft.pending].find(
		(m) => m.backlog === "priority" && m.jira !== PRIORITY_SYSTEM_FIELD,
	);
	if (other) {
		console.log(
			chalk.yellow(
				`  Backlog priority is mapped to ${other.label}; remove that mapping to use Jira's priority again.`,
			),
		);
		return;
	}
	const isOverride = (m: PlannedMapping) =>
		m.backlog === "priority" && m.jira === PRIORITY_SYSTEM_FIELD;
	const original =
		draft.pending.find(isOverride) ?? draft.configured.find(isOverride);
	const current = original?.valueMap ?? {};
	console.log(
		chalk.gray(
			`  Jira priority syncs with Backlog priority (${BACKLOG_PRIORITIES.join(", ")}) by default: ${Object.entries(
				DEFAULT_PRIORITY_MAPPING.valueMap ?? {},
			)
				.map(([from, to]) => `${from}=${to}`)
				.join(", ")}.`,
		),
	);
	const parse = (value: string) =>
		parseValueMapEntries(
			value
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean),
		);
	const input = await ask<string>({
		type: "text",
		name: "priorityValueMap",
		message:
			"Extra or changed translations, as Jira priority=Backlog priority, comma separated (empty keeps the defaults):",
		initial: Object.entries(current)
			.map(([from, to]) => `${from}=${to}`)
			.join(", "),
		validate: (value: string) => {
			try {
				for (const to of Object.values(parse(value) ?? {})) {
					if (!(BACKLOG_PRIORITIES as readonly string[]).includes(to)) {
						return `"${to}" is not a Backlog priority (${BACKLOG_PRIORITIES.join(", ")})`;
					}
				}
				return true;
			} catch (error) {
				return describeError(error);
			}
		},
	});
	const valueMap = parse(input);
	if (!valueMap) {
		// Back to the defaults
		if (original && draft.pending.includes(original)) {
			draft.pending.splice(draft.pending.indexOf(original), 1);
		}
		const configured = draft.configured.find(isOverride);
		if (configured) draft.removals.add(configured.backlog);
		return;
	}
	stageMapping(
		draft,
		{
			backlog: "priority",
			jira: PRIORITY_SYSTEM_FIELD,
			type: "option",
			direction: "both",
			label: "Priority (priority)",
			valueMap,
		},
		original,
	);
}

/**
 * Pick any Jira field; fields synced by default, configured or pending are
 * marked, and picking one edits its mapping instead of adding another
 */
async function searchField(
	draft: FieldsDraft,
	fields: DiscoveredField[],
): Promise<void> {
	const defaults = new Map(DEFAULT_SYNCED_FIELDS.map((f) => [f.jira, f]));
	const mappedTo = (id: string) =>
		draft.pending.find((p) => p.jira === id) ??
		keptConfigured(draft).find((c) => c.jira === id && !c.sprint);
	const jira =
		fields.length > 0
			? await ask<string>({
					type: "autocomplete",
					name: "jiraField",
					message: "Jira field (type to filter, Esc goes back):",
					choices: fields.map((f) => {
						const synced = defaults.get(f.id);
						const mapped = mappedTo(f.id);
						const note = synced
							? f.id === PRIORITY_SYSTEM_FIELD
								? "synced by default; edit its value map"
								: `synced by default as ${synced.backlog}`
							: mapped
								? `mapped to ${mapped.backlog}${draft.pending.includes(mapped) ? " (pending)" : ""}`
								: "";
						return {
							title: `${describeField(f)}${note ? `  ${chalk.gray(`· ${note}`)}` : ""}`,
							value: f.id,
						};
					}),
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

	if (jira === PRIORITY_SYSTEM_FIELD) return editPriorityValueMap(draft);
	const synced = defaults.get(jira);
	if (synced) {
		console.log(
			chalk.gray(
				`  ${fieldLabel(fields, jira)} already syncs with the Backlog ${synced.backlog}.`,
			),
		);
		return;
	}
	const existing = mappedTo(jira);
	if (existing) {
		stageMapping(draft, await editMapping(draft, existing), existing);
		return;
	}
	const field = fields.find((f) => f.id === jira);
	const entry: PlannedMapping = {
		backlog: suggestBacklogTarget(field?.name ?? jira, takenTargets(draft)),
		jira,
		type: suggestTypeForSchema(field?.schema) ?? "string",
		direction: "pull",
		label: fieldLabel(fields, jira),
	};
	stageMapping(draft, await editMapping(draft, entry));
}

/** Tick suggested fields; they are added as pending with their suggestions */
async function addSuggestedFields(
	draft: FieldsDraft,
	suggestions: FieldSuggestion[],
	sampleSize: number,
): Promise<void> {
	const width = Math.max(...suggestions.map((s) => s.field.name.length));
	const usage = (used: number) =>
		sampleSize === 0
			? ""
			: used > 0
				? `${used}/${sampleSize} issues`
				: "not used yet";
	const usageWidth = Math.max(...suggestions.map((s) => usage(s.used).length));
	const picked = await ask<string[]>({
		type: "multiselect",
		name: "fieldsToSync",
		message: "Fields to sync into Backlog",
		hint: "space toggles, enter adds them as pending, Esc goes back",
		instructions: false,
		choices: suggestions.map((s) => ({
			title: `${s.field.name.padEnd(width)}  ${chalk.gray(usage(s.used).padEnd(usageWidth))}  → ${s.backlog} ${chalk.gray(`(${s.type})`)}`,
			value: s.field.id,
			selected: s.selected,
		})),
		onRender: shortLabelsWhenDone(
			new Map(suggestions.map((sg) => [sg.field.id, sg.field.name] as const)),
		),
	});
	for (const s of suggestions) {
		if (picked.includes(s.field.id)) {
			draft.pending.push({
				backlog: s.backlog,
				jira: s.field.id,
				type: s.type,
				direction: s.direction,
				label: `${s.field.name} (${s.field.id})`,
			});
		}
	}
}

async function removeMapping(draft: FieldsDraft): Promise<void> {
	const choices = [
		...draft.pending.map((p, i) => ({
			title: `${describePlanned(p)} ${chalk.gray("(pending)")}`,
			value: `pending:${i}`,
		})),
		...keptConfigured(draft).map((c) => ({
			title: describePlanned(c),
			value: `configured:${c.backlog}`,
		})),
	];
	const picked = await ask<string>({
		type: "select",
		name: "removeMapping",
		message: "Remove which mapping? (Esc goes back)",
		choices,
	});
	const [kind, ref] = [
		picked.slice(0, picked.indexOf(":")),
		picked.slice(picked.indexOf(":") + 1),
	];
	if (kind === "pending") {
		const [removed] = draft.pending.splice(Number(ref), 1);
		// Removing a pending change of a configured mapping keeps the original
		if (removed?.replaces) {
			console.log(
				chalk.gray(
					`  Change dropped; ${removed.replaces} stays as configured.`,
				),
			);
		}
	} else {
		draft.removals.add(ref);
	}
}

/** Apply the draft to the config; returns how many changes were saved */
function saveDraft(ctx: WizardContext, draft: FieldsDraft): number {
	let saved = 0;
	for (const target of draft.removals) {
		try {
			ctx.config = removeFieldMapping(ctx.config, target);
			saved++;
			console.log(chalk.green(`  ✓ removed ${target}`));
		} catch (error) {
			console.log(chalk.red(`  ✗ ${target}: ${describeError(error)}`));
		}
	}
	for (const entry of draft.pending) {
		try {
			let config = ctx.config;
			if (entry.replaces && entry.replaces !== entry.backlog) {
				config = removeFieldMapping(config, entry.replaces);
			}
			ctx.config = addFieldMapping(
				config,
				{
					backlog: entry.backlog,
					jira: entry.jira,
					type: entry.type,
					direction: entry.direction,
					valueMap: entry.valueMap,
				},
				// Targets were checked against the draft; replacing is intended
				{ force: true },
			);
			saved++;
			console.log(
				chalk.green(
					`  ✓ ${entry.backlog} ${arrowFor(entry.direction)} ${entry.jira} (${entry.type}, ${entry.direction})`,
				),
			);
		} catch (error) {
			console.log(chalk.red(`  ✗ ${entry.backlog}: ${describeError(error)}`));
		}
	}
	return saved;
}

/**
 * Field mappings are edited from a menu that lists the fields synced by
 * default, the configured mappings and the pending changes. Nothing is
 * written until Save; Esc in a sub-menu returns to the menu, and leaving
 * with pending changes (Esc or Ctrl+C) offers to save them.
 */
async function fieldsStep(ctx: WizardContext): Promise<StepOutcome> {
	const { projectKey } = jiraSection(ctx);
	let fields: DiscoveredField[] = [];
	let sample: JiraIssue[] = [];
	try {
		await withJira(ctx, async (jira) => {
			fields = await jira.searchFields("", 1000);
			if (!projectKey) return;
			try {
				sample = (
					await jira.searchIssues(
						`project = "${projectKey}" ORDER BY updated DESC`,
						{ maxResults: FIELD_SAMPLE_SIZE, fields: "*all" },
					)
				).issues;
			} catch (error) {
				logger.debug({ error }, "Could not sample project issues");
			}
		});
	} catch (error) {
		console.log(
			chalk.yellow(`  ⚠ Could not list Jira fields: ${describeError(error)}`),
		);
	}
	// Sprints are set up in their own step, and system fields MCP Atlassian
	// does not return cannot be pulled
	fields = fields
		.filter(
			(f) => f.schema?.custom !== SPRINT_FIELD_SCHEMA && isMcpReturnedField(f),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	const { mappings, sprintMapping } = validateFieldMappings(
		ctx.config.fieldMappings,
	);
	const draft: FieldsDraft = {
		configured: [
			...(sprintMapping
				? [
						{
							backlog: "milestone",
							jira: "sprint",
							type: "sprint",
							direction: sprintMapping.direction,
							label: `Sprint (board ${sprintMapping.boardId})`,
							sprint: true,
						},
					]
				: []),
			...mappings.map((m) => ({
				backlog: m.backlog,
				jira: m.jira,
				type: m.type,
				direction: m.direction,
				label: fieldLabel(fields, m.jira),
				valueMap: m.valueMap,
			})),
		],
		removals: new Set(),
		pending: [],
	};

	const save = (): StepOutcome => {
		if (draftChanges(draft) === 0) return "skipped";
		const saved = saveDraft(ctx, draft);
		if (draft.pending.length > 0 && saved > 0) {
			console.log(
				chalk.gray(
					"  Values fill in on the next pull. Translate values with: backlog-jira map-fields add <target> <field> --type <type> --value-map 'Jira=Backlog' --force",
				),
			);
		}
		return saved > 0 ? "done" : "skipped";
	};

	let first = true;
	try {
		for (;;) {
			const suggestions = suggestFieldMappings(fields, sample, {
				mappedTargets: takenTargets(draft),
				mappedFields: [
					...keptConfigured(draft).map((c) => c.jira),
					...draft.pending.map((p) => p.jira),
				],
			});
			printDraft(draft);
			if (first && suggestions.length > 0) {
				console.log(
					chalk.gray(
						sample.length > 0
							? `  ${suggestions.length} more fields have values on the ${sample.length} most recently updated ${projectKey} issues.`
							: "  No project issues to sample; commonly useful fields are suggested.",
					),
				);
			}
			first = false;
			const changes = draftChanges(draft);
			const editable = [
				...draft.pending,
				...keptConfigured(draft).filter((c) => !c.sprint),
			];
			const removable = draft.pending.length + keptConfigured(draft).length;
			const action = await ask<string>({
				type: "select",
				name: "fieldsMenu",
				message: "Field mappings",
				hint: "Esc leaves the step",
				choices: [
					...(suggestions.length > 0
						? [
								{
									title: `Add suggested fields (${suggestions.length})…`,
									value: "suggested",
								},
							]
						: []),
					{ title: "Search all Jira fields…", value: "search" },
					...(editable.length > 0
						? [{ title: "Edit a mapping…", value: "edit" }]
						: []),
					...(removable > 0
						? [{ title: "Remove a mapping…", value: "remove" }]
						: []),
					{
						title:
							changes > 0
								? `Save ${changes} change${changes === 1 ? "" : "s"} and continue`
								: "Done, no changes",
						value: "save",
					},
					...(changes > 0
						? [{ title: "Discard changes and continue", value: "discard" }]
						: []),
				],
				initial: 0,
			}).catch(async (error) => {
				if (!(error instanceof WizardBack)) throw error;
				if (draftChanges(draft) === 0) return "discard";
				return ask<string>({
					type: "select",
					name: "leaveFields",
					message: `Save ${draftChanges(draft)} pending change${draftChanges(draft) === 1 ? "" : "s"} before leaving?`,
					choices: [
						{ title: "Save", value: "save" },
						{ title: "Discard", value: "discard" },
						{ title: "Keep editing", value: "menu" },
					],
				}).catch((inner) => {
					if (inner instanceof WizardBack) return "menu";
					throw inner;
				});
			});

			if (action === "save") return save();
			if (action === "discard") return "skipped";
			try {
				if (action === "suggested") {
					await addSuggestedFields(draft, suggestions, sample.length);
				} else if (action === "search") {
					await searchField(draft, fields);
				} else if (action === "edit") {
					const picked = await ask<number>({
						type: "select",
						name: "editMapping",
						message: "Edit which mapping? (Esc goes back)",
						choices: editable.map((m, i) => ({
							title: `${describePlanned(m)}${draft.pending.includes(m) ? chalk.gray(" (pending)") : ""}`,
							value: i,
						})),
					});
					const original = editable[picked];
					if (isBuiltInPriorityMapping(original)) {
						await editPriorityValueMap(draft);
					} else {
						stageMapping(draft, await editMapping(draft, original), original);
					}
				} else if (action === "remove") {
					await removeMapping(draft);
				}
			} catch (error) {
				// Esc in a sub-menu returns to the menu, keeping the draft
				if (!(error instanceof WizardBack)) throw error;
			}
		}
	} catch (error) {
		if (!(error instanceof WizardCancelled) || draftChanges(draft) === 0) {
			throw error;
		}
		const keep = await ask<boolean>({
			type: "confirm",
			name: "savePending",
			message: `Save ${draftChanges(draft)} pending field mapping change${draftChanges(draft) === 1 ? "" : "s"} before quitting?`,
			initial: true,
		}).catch(() => false);
		if (keep) save();
		throw error;
	}
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
			"  'backlog-jira pull --import' imports the unlinked issues matching this JQL.",
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
				const count = await withJira(ctx, async (jira) => {
					const first = await jira.searchIssues(jql, {
						maxResults: 1,
						fields: "summary",
					});
					if (typeof first.total === "number" && first.total >= 0) {
						return { total: first.total, truncated: false };
					}
					// Jira Cloud reports no total: count by paging
					const all = await jira.searchAllIssues(jql, { fields: "summary" });
					return { total: all.issues.length, truncated: all.truncated };
				});
				console.log(
					`  ${count.truncated ? "More than " : ""}${count.total} issue${count.total === 1 ? "" : "s"} match`,
				);
				if (count.truncated || count.total > DEFAULT_SEARCH_ALL_LIMIT) {
					console.log(
						chalk.yellow(
							`  One import run handles up to ${DEFAULT_SEARCH_ALL_LIMIT} issues; narrow the filter or import in batches with --jql.`,
						),
					);
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
	console.log("  2. Import:               backlog-jira pull --import");
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
	// The wizard reports errors itself; log lines (written asynchronously by
	// a logger transport) would print over its prompts
	if (!options.verbose) setLogLevel("silent");
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
			const outcomes = new Map<ConfigureStep, StepOutcome>();
			const summary = (): ConfigureResult => ({
				completed: steps.filter((s) => outcomes.get(s) === "done"),
				skipped: steps.filter(
					(s) => outcomes.has(s) && outcomes.get(s) !== "done",
				),
				failed: [...outcomes.values()].includes("failed"),
			});
			let index = 0;
			while (index < steps.length) {
				const name = steps[index];
				const info = STEP_INFO[name];
				console.log(
					chalk.bold.green(
						`\n${step ? "" : `Step ${index + 1}/${steps.length}: `}${info.title}`,
					),
				);
				console.log(chalk.gray(`  ${info.about}\n`));
				// Esc inside a step drops what the step changed so far
				const before = structuredClone(ctx.config);
				try {
					if (!step) {
						let run: boolean;
						try {
							run = await ask<boolean>({
								type: "confirm",
								name: `run_${name}`,
								message: `Set up ${info.title.toLowerCase()} now?`,
								initial: true,
							});
						} catch (error) {
							if (!(error instanceof WizardBack)) throw error;
							// Esc here goes back to the previous step
							if (index > 0) index--;
							else console.log(chalk.gray("  First step; Ctrl+C quits."));
							continue;
						}
						if (!run) {
							console.log(
								chalk.gray(
									`  Skipped. Later: backlog-jira configure --step ${name}`,
								),
							);
							outcomes.set(name, "skipped");
							index++;
							continue;
						}
					}
					const outcome = await STEP_RUNNERS[name](ctx);
					writeConfigFile(ctx.config, cwd);
					outcomes.set(name, outcome);
					if (outcome === "failed" && !step && name === "connection") {
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
							return summary();
						}
					}
					index++;
				} catch (error) {
					if (error instanceof WizardBack) {
						ctx.config = before;
						writeConfigFile(ctx.config, cwd);
						outcomes.delete(name);
						if (step) {
							console.log(chalk.gray("  Left unchanged."));
							outcomes.set(name, "skipped");
							index++;
						} else {
							console.log(
								chalk.gray("  Back: nothing from this step was saved."),
							);
						}
						continue;
					}
					if (error instanceof WizardCancelled) {
						writeConfigFile(ctx.config, cwd);
						console.log(
							chalk.yellow(
								`\n✗ Setup cancelled. Completed steps are saved; resume with: backlog-jira configure --step ${name}\n`,
							),
						);
						return { ...summary(), cancelledAt: name };
					}
					throw error;
				}
			}
			const result = summary();

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
					// The wizard reports errors itself; log lines (written asynchronously by
					// a logger transport) would print over its prompts
					if (!options.verbose) setLogLevel("silent");
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
