import { spawnSync } from "node:child_process";
import { addFieldMapping } from "../commands/map-fields.ts";
import { SPRINT_FIELD_SCHEMA } from "../integrations/jira-sprints.ts";
import type { JiraIssue, JiraTransition } from "../integrations/jira.ts";
import {
	type RawConfig,
	createDefaultConfig,
	getSection,
	setSectionValues,
} from "./config-file.ts";
import {
	FIELD_MAPPING_TYPES,
	type FieldMappingDirection,
	type FieldMappingType,
	SPRINT_MAPPING_TYPE,
	type SprintPullScope,
	getJiraFieldValue,
	suggestTypeForSchema,
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
 * keep their previous mapping unless they are dropped.
 */
export function buildStatusMappingConfig(
	choices: Record<string, string | null>,
	previous: Record<string, string[]> = {},
	previousUnmapped: string[] = [],
	/** Jira statuses to remove from the previous mapping */
	dropped: string[] = [],
): { statusMapping: Record<string, string[]>; unmappedJiraStatuses: string[] } {
	// Statuses chosen now or dropped do not keep their previous entry
	const chosen = new Set(
		[...Object.keys(choices), ...dropped].map((s) => s.toLowerCase()),
	);
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

/**
 * Whether a status mapping is still the default `backlog-jira init` writes
 */
export function isDefaultStatusMapping(
	mapping: Record<string, string[]>,
): boolean {
	const backlog = getSection(createDefaultConfig(), "backlog");
	return JSON.stringify(mapping) === JSON.stringify(backlog.statusMapping);
}

export type StatusSource = "issues" | "transitions" | "site" | "unverified";

/** A Jira status offered in the status step's checkbox list */
export interface StatusOption {
	name: string;
	source: StatusSource;
	/** Issue types it was found on (issues) or reachable from (transitions) */
	issueTypes: string[];
	/** Ticked by default */
	selected: boolean;
}

/**
 * The Jira statuses to offer, most certain first:
 * - on issues: statuses the project's issues are in
 * - transitions: checked transition names of the project's issues
 * - site: checked Backlog statuses and mapping entries (any workflow on the
 *   site may use them; ticked only when the user configured the mapping)
 * - unverified: transition names Jira could not be asked about
 */
export function buildStatusOptions(
	perType: IssueTypeStatuses[],
	check: { statuses: string[]; checked: boolean } | null,
	previous: Record<string, string[]> = {},
	previousUnmapped: string[] = [],
): StatusOption[] {
	const options: StatusOption[] = [];
	const find = (name: string) =>
		options.find((o) => o.name.toLowerCase() === name.toLowerCase());
	for (const { issueType, statuses } of perType) {
		for (const status of statuses) {
			const option = find(status);
			if (option) option.issueTypes.push(issueType);
			else
				options.push({
					name: status,
					source: "issues",
					issueTypes: [issueType],
					selected: true,
				});
		}
	}

	const reachable = new Map<string, string[]>();
	for (const { issueType, candidates } of perType) {
		for (const candidate of candidates) {
			const key = candidate.toLowerCase();
			reachable.set(key, [...(reachable.get(key) ?? []), issueType]);
		}
	}
	const configured = isDefaultStatusMapping(previous)
		? new Set<string>()
		: new Set(
				[...Object.values(previous).flat(), ...previousUnmapped].map((s) =>
					String(s).toLowerCase(),
				),
			);

	if (check?.checked) {
		for (const status of check.statuses) {
			if (find(status)) continue;
			const types = reachable.get(status.toLowerCase());
			options.push(
				types
					? {
							name: status,
							source: "transitions",
							issueTypes: types,
							selected: true,
						}
					: {
							name: status,
							source: "site",
							issueTypes: [],
							selected: configured.has(status.toLowerCase()),
						},
			);
		}
	} else {
		for (const [key, types] of reachable) {
			const name =
				perType
					.flatMap((t) => t.candidates)
					.find((c) => c.toLowerCase() === key) ?? key;
			if (!find(name)) {
				options.push({
					name,
					source: "unverified",
					issueTypes: types,
					selected: false,
				});
			}
		}
	}
	return options;
}

/** Short label for where a status option came from */
export function describeStatusOption(option: StatusOption): string {
	const types = option.issueTypes.join(", ");
	switch (option.source) {
		case "issues":
			return `on ${types} issues`;
		case "transitions":
			return `reachable from ${types}`;
		case "site":
			return "used elsewhere on this Jira site";
		case "unverified":
			return `transition name on ${types}, not confirmed as a status`;
	}
}

// ===== Field mappings =====

/**
 * Fields the plugin already syncs, handles in another step, or that have no
 * useful Backlog representation
 */
const HIDDEN_FIELDS = new Set(
	[
		"summary",
		"description",
		"status",
		"statuscategorychangedate",
		"assignee",
		"reporter",
		"creator",
		"labels",
		"priority",
		"issuetype",
		"project",
		"created",
		"updated",
		"lastViewed",
		"comment",
		"attachment",
		"issuelinks",
		"subtasks",
		"parent",
		"watches",
		"votes",
		"worklog",
		"timetracking",
		"aggregatetimespent",
		"aggregatetimeestimate",
		"aggregatetimeoriginalestimate",
		"aggregateprogress",
		"progress",
		"workratio",
		"timespent",
		"timeestimate",
		"thumbnail",
		"security",
		"issuerestriction",
		"resolution",
		"resolutiondate",
	].map((id) => id.toLowerCase()),
);

/** Custom field schemas that are noise or handled elsewhere */
const HIDDEN_SCHEMAS = new Set([
	SPRINT_FIELD_SCHEMA,
	"com.pyxis.greenhopper.jira:gh-lexo-rank",
	"com.pyxis.greenhopper.jira:gh-epic-link",
	"com.pyxis.greenhopper.jira:gh-epic-status",
	"com.pyxis.greenhopper.jira:gh-epic-color",
	"com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
	"com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team",
]);

/** Names of fields most teams want in Backlog, when the project uses them */
const VALUABLE_FIELD =
	/story ?points?|story point estimate|due ?date|start date|components?|fix ?versions?|affects? versions?|target (start|end)|team|environment|severity/i;

type DiscoveredField = {
	id: string;
	name: string;
	custom?: boolean;
	schema?: { type?: string; items?: string; system?: string; custom?: string };
};

export interface FieldSuggestion {
	field: DiscoveredField;
	backlog: string;
	type: FieldMappingType;
	direction: FieldMappingDirection;
	/** Sampled project issues with a value */
	used: number;
	/** Well-known useful field */
	valuable: boolean;
	/** Ticked by default */
	selected: boolean;
}

function hasValue(value: unknown): boolean {
	let v = value;
	// MCP Atlassian wraps custom field values as { value, name }
	if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) {
		v = (v as { value: unknown }).value;
	}
	if (v === null || v === undefined) return false;
	if (typeof v === "string") return v.trim() !== "";
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v).length > 0;
	return true;
}

export function frontmatterTargetFor(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `frontmatter:${slug || "field"}`;
}

/**
 * Fields worth offering for a project: supported by a mapping type, not
 * already synced or mapped, ranked by how many sampled issues use them.
 * Unused fields are only offered when they are well-known useful fields.
 */
export function suggestFieldMappings(
	fields: DiscoveredField[],
	sampleIssues: JiraIssue[],
	options: {
		/** Backlog targets and Jira fields already mapped */
		mappedTargets?: string[];
		mappedFields?: string[];
		limit?: number;
	} = {},
): FieldSuggestion[] {
	const mappedFields = new Set(
		(options.mappedFields ?? []).map((f) => f.toLowerCase()),
	);
	const takenTargets = new Set(
		(options.mappedTargets ?? []).map((t) => t.toLowerCase()),
	);
	const suggestions: FieldSuggestion[] = [];
	for (const field of fields) {
		if (HIDDEN_FIELDS.has(field.id.toLowerCase())) continue;
		if (field.schema?.custom && HIDDEN_SCHEMAS.has(field.schema.custom))
			continue;
		if (mappedFields.has(field.id.toLowerCase())) continue;
		const type = suggestTypeForSchema(field.schema);
		if (!type || !FIELD_MAPPING_TYPES.includes(type)) continue;

		const used = sampleIssues.filter((issue) =>
			hasValue(getJiraFieldValue(issue, field.id)),
		).length;
		const valuable = VALUABLE_FIELD.test(field.name);
		if (used === 0 && !valuable) continue;

		// Jira Cloud calls story points "Story point estimate" in team-managed
		// projects; use one key for both
		const base = /^story ?points?( estimate)?$|^story point estimate$/i.test(
			field.name.trim(),
		)
			? "frontmatter:story_points"
			: frontmatterTargetFor(field.name);
		let backlog = base;
		for (let n = 2; takenTargets.has(backlog.toLowerCase()); n++) {
			backlog = `${base}_${n}`;
		}
		suggestions.push({
			field,
			backlog,
			type,
			direction: "pull",
			used,
			valuable,
			selected: valuable && used > 0,
		});
	}
	suggestions.sort(
		(a, b) =>
			b.used - a.used ||
			Number(b.valuable) - Number(a.valuable) ||
			a.field.name.localeCompare(b.field.name),
	);
	const limited = suggestions.slice(0, options.limit ?? 20);
	// Distinct targets among the suggestions themselves
	const seen = new Set(takenTargets);
	for (const s of limited) {
		let target = s.backlog;
		for (let n = 2; seen.has(target.toLowerCase()); n++) {
			target = `${s.backlog}_${n}`;
		}
		s.backlog = target;
		seen.add(target.toLowerCase());
	}
	return limited;
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
