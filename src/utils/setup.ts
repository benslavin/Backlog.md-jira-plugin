import { spawnSync } from "node:child_process";
import { addFieldMapping } from "../commands/map-fields.ts";
import type { JiraIssue, JiraTransition } from "../integrations/jira.ts";
import { type RawConfig, getSection, setSectionValues } from "./config-file.ts";
import {
	type FieldMappingDirection,
	SPRINT_MAPPING_TYPE,
	type SprintPullScope,
} from "./field-mapping.ts";

// ===== Credentials =====

export interface CredentialStatus {
	url?: string;
	/** JIRA_EMAIL, or JIRA_USERNAME as the MCP server also accepts */
	email?: string;
	hasApiToken: boolean;
	hasPersonalToken: boolean;
	/** Which authentication the exported variables allow, if any */
	auth: "cloud" | "server" | null;
	/** Variables to export for Jira Cloud (API token) authentication */
	missing: string[];
}

/**
 * Which Jira credentials are exported to this process. Only variables in the
 * process environment reach the MCP server; .env files are not read.
 */
export function detectCredentials(
	env: NodeJS.ProcessEnv = process.env,
): CredentialStatus {
	const value = (name: string) => {
		const v = env[name];
		return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
	};
	const url = value("JIRA_URL");
	const email = value("JIRA_EMAIL") ?? value("JIRA_USERNAME");
	const hasApiToken = value("JIRA_API_TOKEN") !== undefined;
	const hasPersonalToken = value("JIRA_PERSONAL_TOKEN") !== undefined;
	const auth = !url
		? null
		: hasPersonalToken
			? "server"
			: email && hasApiToken
				? "cloud"
				: null;

	const missing: string[] = [];
	if (!url) missing.push("JIRA_URL");
	if (!hasPersonalToken) {
		if (!email) missing.push("JIRA_EMAIL");
		if (!hasApiToken) missing.push("JIRA_API_TOKEN");
	}
	return { url, email, hasApiToken, hasPersonalToken, auth, missing };
}

/**
 * How to make the Jira credentials available to backlog-jira
 */
export function credentialHelpLines(): string[] {
	return [
		"backlog-jira reads credentials only from exported environment variables:",
		"  JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN (Jira Cloud), or",
		"  JIRA_URL and JIRA_PERSONAL_TOKEN (Jira Server / Data Center).",
		"Tokens are never stored in .backlog-jira/config.json.",
		"",
		"Option 1 - export in your shell (add to ~/.zshrc or ~/.bashrc to keep them):",
		'  export JIRA_URL="https://your-domain.atlassian.net"',
		'  export JIRA_EMAIL="you@example.com"',
		'  export JIRA_API_TOKEN="<token from https://id.atlassian.com/manage-profile/security/api-tokens>"',
		"",
		"Option 2 - a .env file in the project (keep it out of git). It is not read",
		"automatically; export its variables before running backlog-jira:",
		"  set -a; . ./.env; set +a",
		"",
		"Option 3 - direnv (https://direnv.net) exports them whenever you enter the project:",
		'  echo "dotenv" > .envrc   # or put the export lines in .envrc',
		"  direnv allow",
		"",
		"Plain assignments (JIRA_URL=... without export) are not passed to backlog-jira.",
	];
}

/**
 * .env content with the given variables set, keeping the other lines
 */
export function mergeEnvFile(
	existing: string,
	values: Record<string, string>,
): string {
	const names = new Set(Object.keys(values));
	const kept = existing
		.split("\n")
		.filter((line) => {
			const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
			return !(match && names.has(match[1]));
		})
		.join("\n")
		.replace(/\n+$/, "");
	// Single quotes keep values literal for both shells and dotenv parsers
	const lines = Object.entries(values).map(
		([name, value]) => `${name}='${value.replace(/'/g, "'\\''")}'`,
	);
	return `${kept ? `${kept}\n\n` : ""}${lines.join("\n")}\n`;
}

// ===== Status mapping =====

/**
 * Backlog statuses from the project's backlog config
 */
export function readBacklogStatuses(cwd = process.cwd()): string[] {
	const result = spawnSync("backlog", ["config", "get", "statuses"], {
		cwd,
		encoding: "utf-8",
	});
	const statuses =
		result.status === 0
			? String(result.stdout)
					.trim()
					.replace(/^\[|\]$/g, "")
					.split(",")
					.map((s) => s.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean)
			: [];
	return statuses.length > 0 ? statuses : ["To Do", "In Progress", "Done"];
}

export interface IssueTypeStatuses {
	issueType: string;
	/** Statuses issues of this type are in */
	statuses: string[];
	/**
	 * Transition names and targets from those statuses that no issue is in.
	 * MCP Atlassian does not return transition targets, and transitions are
	 * often, but not always, named after their target status, so these are
	 * only candidates until checked with checkStatusNames.
	 */
	candidates: string[];
}

type StatusSearch = {
	searchIssues(
		jql: string,
		options?: { maxResults?: number; fields?: string },
	): Promise<{ issues: JiraIssue[] }>;
};

function jqlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function addUnique(list: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed && !list.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
		list.push(trimmed);
	}
}

/**
 * Jira statuses used by each issue type of a project. MCP Atlassian has no
 * workflow API, so statuses are collected from the project's issues, and the
 * transitions available on a sample issue of each status add candidates.
 */
export async function discoverProjectStatuses(
	jira: StatusSearch & {
		getTransitions(issueKey: string): Promise<JiraTransition[]>;
	},
	projectKey: string,
	issueTypes: string[],
	options: { issuesPerType?: number } = {},
): Promise<IssueTypeStatuses[]> {
	const results: IssueTypeStatuses[] = [];
	for (const issueType of issueTypes) {
		const { issues } = await jira.searchIssues(
			`project = ${jqlString(projectKey)} AND issuetype = ${jqlString(issueType)} ORDER BY updated DESC`,
			{ maxResults: options.issuesPerType ?? 50, fields: "status,issuetype" },
		);
		const statuses: string[] = [];
		const samples = new Map<string, string>();
		for (const issue of issues) {
			if (!issue.status || issue.status === "Unknown") continue;
			addUnique(statuses, issue.status);
			if (!samples.has(issue.status)) samples.set(issue.status, issue.key);
		}
		const candidates: string[] = [];
		for (const key of samples.values()) {
			try {
				for (const transition of await jira.getTransitions(key)) {
					if (transition.to?.name) addUnique(candidates, transition.to.name);
					if (transition.name) addUnique(candidates, transition.name);
				}
			} catch {
				// Statuses seen on issues are still useful
			}
		}
		const known = new Set(statuses.map((s) => s.toLowerCase()));
		if (statuses.length > 0) {
			results.push({
				issueType,
				statuses,
				candidates: candidates.filter((c) => !known.has(c.toLowerCase())),
			});
		}
	}
	return results;
}

/** Names Jira rejects in a status JQL clause, from its error message */
export function rejectedStatusNames(message: string): string[] {
	const names: string[] = [];
	for (const match of message.matchAll(
		/value '([^']+)' does not exist for the field 'status'/gi,
	)) {
		addUnique(names, match[1]);
	}
	return names;
}

/**
 * Which candidate names are Jira statuses. A `status in (...)` query fails
 * naming each value that is not a status, so those are dropped and the
 * query retried. Jira checks names site-wide, so a status of another
 * project's workflow also passes. checked is false when Jira could not be
 * asked.
 */
export async function checkStatusNames(
	jira: StatusSearch,
	projectKey: string,
	candidates: string[],
): Promise<{ statuses: string[]; checked: boolean }> {
	let remaining: string[] = [];
	for (const c of candidates) addUnique(remaining, c);
	const query = (names: string[]) =>
		jira.searchIssues(
			`project = ${jqlString(projectKey)} AND status in (${names.map(jqlString).join(", ")})`,
			{ maxResults: 1, fields: "status" },
		);

	for (let attempt = 0; remaining.length > 0 && attempt < 5; attempt++) {
		try {
			await query(remaining);
			return { statuses: remaining, checked: true };
		} catch (error) {
			const rejected = new Set(
				rejectedStatusNames(
					error instanceof Error ? error.message : String(error),
				).map((n) => n.toLowerCase()),
			);
			if (rejected.size === 0) break;
			const before = remaining.length;
			remaining = remaining.filter((n) => !rejected.has(n.toLowerCase()));
			if (remaining.length === before) break;
		}
	}
	if (remaining.length === 0) return { statuses: [], checked: true };

	// Unrecognised error text: ask about each name, if Jira answers at all
	try {
		await jira.searchIssues(`project = ${jqlString(projectKey)}`, {
			maxResults: 1,
			fields: "status",
		});
	} catch {
		return { statuses: [], checked: false };
	}
	const statuses: string[] = [];
	for (const name of remaining) {
		try {
			await query([name]);
			statuses.push(name);
		} catch {
			// Not a status
		}
	}
	return { statuses, checked: true };
}

const DONE_WORDS =
	/\b(done|closed|resolved|complete|completed|released|shipped|fixed|won'?t|cancel+ed|rejected|duplicate)\b/i;
const TODO_WORDS =
	/\b(to ?do|open|backlog|new|reopened|selected|ready|triage|planned)\b/i;

/**
 * The Backlog status a Jira status most likely corresponds to: its current
 * mapping, a status of the same name, or a guess from common workflow names
 */
export function suggestBacklogStatus(
	jiraStatus: string,
	backlogStatuses: string[],
	currentMapping: Record<string, string[]> = {},
): string {
	const lower = jiraStatus.trim().toLowerCase();
	for (const [backlogStatus, jiraStatuses] of Object.entries(currentMapping)) {
		if (
			backlogStatuses.includes(backlogStatus) &&
			Array.isArray(jiraStatuses) &&
			jiraStatuses.some((s) => String(s).toLowerCase() === lower)
		) {
			return backlogStatus;
		}
	}
	const same = backlogStatuses.find((s) => s.toLowerCase() === lower);
	if (same) return same;

	const first = backlogStatuses[0];
	const last = backlogStatuses[backlogStatuses.length - 1];
	if (DONE_WORDS.test(jiraStatus)) return last;
	if (TODO_WORDS.test(jiraStatus)) return first;
	// Anything else is work in progress: the middle status, if there is one
	return (
		backlogStatuses.find((s) => /progress/i.test(s)) ??
		backlogStatuses[Math.min(1, backlogStatuses.length - 1)] ??
		first
	);
}

/**
 * Build backlog.statusMapping from a choice per Jira status (null leaves the
 * status unmapped, so it is kept as-is on pull). Jira statuses not chosen now
 * keep their previous mapping.
 */
export function buildStatusMappingConfig(
	choices: Record<string, string | null>,
	previous: Record<string, string[]> = {},
	previousUnmapped: string[] = [],
): { statusMapping: Record<string, string[]>; unmappedJiraStatuses: string[] } {
	const chosen = new Set(Object.keys(choices).map((s) => s.toLowerCase()));
	const statusMapping: Record<string, string[]> = {};
	const add = (backlogStatus: string, jiraStatus: string) => {
		const list = statusMapping[backlogStatus] ?? [];
		if (!list.some((s) => s.toLowerCase() === jiraStatus.toLowerCase())) {
			list.push(jiraStatus);
		}
		statusMapping[backlogStatus] = list;
	};

	for (const [backlogStatus, jiraStatuses] of Object.entries(previous)) {
		if (!Array.isArray(jiraStatuses)) continue;
		for (const jiraStatus of jiraStatuses) {
			if (!chosen.has(String(jiraStatus).toLowerCase())) {
				add(backlogStatus, String(jiraStatus));
			}
		}
	}
	for (const [jiraStatus, backlogStatus] of Object.entries(choices)) {
		if (backlogStatus) add(backlogStatus, jiraStatus);
	}

	const unmapped = new Map<string, string>();
	for (const s of previousUnmapped) {
		if (!chosen.has(s.toLowerCase())) unmapped.set(s.toLowerCase(), s);
	}
	for (const [jiraStatus, backlogStatus] of Object.entries(choices)) {
		if (!backlogStatus) unmapped.set(jiraStatus.toLowerCase(), jiraStatus);
	}
	return { statusMapping, unmappedJiraStatuses: [...unmapped.values()] };
}

/**
 * Jira statuses neither mapped nor explicitly left unmapped
 */
export function uncoveredJiraStatuses(
	jiraStatuses: string[],
	statusMapping: Record<string, string[]>,
	unmapped: string[] = [],
): string[] {
	const covered = new Set(
		[...Object.values(statusMapping).flat(), ...unmapped].map((s) =>
			String(s).toLowerCase(),
		),
	);
	return jiraStatuses.filter((s) => !covered.has(s.toLowerCase()));
}

// ===== Sprints =====

/** MCP Atlassian toolsets the plugin calls besides the default ones */
export const REQUIRED_TOOLSETS = ["jira_projects", "jira_agile"] as const;

/**
 * TOOLSETS value that keeps the toolsets sprint sync and setup need enabled
 * while keeping any toolsets already configured
 */
export function mergeToolsets(existing?: string): string {
	const tokens = (existing ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (tokens.some((t) => t.toLowerCase() === "all")) return existing ?? "all";
	const result = tokens.length > 0 ? tokens : ["default"];
	for (const toolset of REQUIRED_TOOLSETS) {
		if (!result.includes(toolset)) result.push(toolset);
	}
	return result.join(",");
}

/**
 * Set mcp.envVars.TOOLSETS so the jira_agile tools stay enabled,
 * keeping the other mcp settings
 */
export function applyRequiredToolsets(config: RawConfig): RawConfig {
	const mcp = getSection(config, "mcp");
	const envVars =
		mcp.envVars && typeof mcp.envVars === "object"
			? (mcp.envVars as Record<string, string>)
			: {};
	return setSectionValues(config, "mcp", {
		envVars: { ...envVars, TOOLSETS: mergeToolsets(envVars.TOOLSETS) },
	});
}

export interface SprintSettings {
	boardId: string;
	direction: FieldMappingDirection;
	createSprints: boolean;
	archiveClosedSprints: boolean;
	pullScope: SprintPullScope;
}

/**
 * The configured sprint mapping entry, if any (not validated)
 */
export function findSprintEntry(
	config: RawConfig,
): Record<string, unknown> | undefined {
	return Array.isArray(config.fieldMappings)
		? (config.fieldMappings as Array<Record<string, unknown>>).find(
				(m) => m?.type === SPRINT_MAPPING_TYPE,
			)
		: undefined;
}

/**
 * Write the sprint ↔ milestone mapping (replacing any milestone mapping) with
 * the same validation as map-fields, and enable the jira_agile toolset
 */
export function applySprintSettings(
	config: RawConfig,
	settings: SprintSettings,
): RawConfig {
	const existing = Array.isArray(config.fieldMappings)
		? (config.fieldMappings as Array<Record<string, unknown>>).filter(
				// Only one sprint mapping is allowed, whatever it targets
				(m) => !(m?.type === SPRINT_MAPPING_TYPE && m.backlog !== "milestone"),
			)
		: undefined;
	const updated = addFieldMapping(
		existing ? { ...config, fieldMappings: existing } : config,
		{
			backlog: "milestone",
			jira: "sprint",
			type: SPRINT_MAPPING_TYPE,
			...settings,
		},
		{ force: true },
	);
	return applyRequiredToolsets(updated);
}
