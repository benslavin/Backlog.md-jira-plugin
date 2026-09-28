import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue } from "../integrations/jira.ts";
import {
	mapBacklogAssigneeToJira,
	mapJiraUserToBacklog,
} from "./assignee-mapping.ts";
import { getTaskFilePath, parseFrontmatter } from "./frontmatter.ts";
import { logger } from "./logger.ts";

/**
 * User-defined mappings between Jira fields and Backlog task fields.
 *
 * Configured as a top-level `fieldMappings` array in .backlog-jira/config.json:
 *
 * {
 *   "fieldMappings": [
 *     { "backlog": "frontmatter:story_points", "jira": "customfield_10016", "type": "number" },
 *     { "backlog": "milestone", "jira": "fixVersions", "type": "version" }
 *   ]
 * }
 *
 * Each mapping's direction decides which side it writes to: `pull` mappings
 * only write Jira values into Backlog, `push` mappings only write Backlog
 * values into Jira, and `both` mappings sync in both directions.
 */

export const FIELD_MAPPING_TYPES = [
	"string",
	"number",
	"date",
	"option",
	"multi-option",
	"user",
	"version",
	"array",
] as const;
export type FieldMappingType = (typeof FIELD_MAPPING_TYPES)[number];

export const FIELD_MAPPING_DIRECTIONS = ["pull", "push", "both"] as const;
export type FieldMappingDirection = (typeof FIELD_MAPPING_DIRECTIONS)[number];

/** Native Backlog fields that can be written with `backlog task edit` */
export const NATIVE_BACKLOG_TARGETS = [
	"milestone",
	"dependencies",
	"references",
	"priority",
	"labels",
] as const;
export type NativeBacklogTarget = (typeof NATIVE_BACKLOG_TARGETS)[number];

/** Native targets that are already part of the core synced payload */
const CORE_OVERRIDE_TARGETS: ReadonlySet<string> = new Set([
	"priority",
	"labels",
]);

/** Native targets that hold a list of values */
const ARRAY_NATIVE_TARGETS: ReadonlySet<string> = new Set([
	"dependencies",
	"references",
	"labels",
]);

export const FRONTMATTER_PREFIX = "frontmatter:";

/**
 * Frontmatter keys owned by Backlog.md that plugin-defined fields must not overwrite
 */
export const RESERVED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
	"id",
	"title",
	"status",
	"assignee",
	"reporter",
	"created_date",
	"updated_date",
	"created",
	"updated",
	"labels",
	"milestone",
	"dependencies",
	"references",
	"documentation",
	"parent",
	"parent_task_id",
	"subtasks",
	"priority",
	"ordinal",
	"type",
	"project",
	"due_date",
	"modified_files",
	"onStatusChange",
	"final_summary",
]);

export interface FieldMapping {
	/** Backlog target: a native field name or `frontmatter:<key>` */
	backlog: string;
	/** Jira field ID (customfield_NNNNN) or system field name (e.g. fixVersions) */
	jira: string;
	type: FieldMappingType;
	direction: FieldMappingDirection;
	/** Optional translation of Jira values to Backlog values */
	valueMap?: Record<string, string>;
}

/** A converted value in Backlog representation; null means "no value" */
export type MappedValue = string | string[] | null;

export class FieldMappingConfigError extends Error {
	constructor(public readonly errors: string[]) {
		super(
			`Invalid fieldMappings in .backlog-jira/config.json:\n${errors
				.map((e) => `  - ${e}`)
				.join("\n")}`,
		);
		this.name = "FieldMappingConfigError";
	}
}

const FRONTMATTER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const JIRA_FIELD_PATTERN = /^(customfield_\d+|[A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Validate a Backlog target, returning an error message or null if valid
 */
export function validateBacklogTarget(target: string): string | null {
	if (target.startsWith(FRONTMATTER_PREFIX)) {
		const key = target.slice(FRONTMATTER_PREFIX.length);
		if (!FRONTMATTER_KEY_PATTERN.test(key)) {
			return `"${target}" is not a valid frontmatter key (use letters, digits, "_" or "-")`;
		}
		if (RESERVED_FRONTMATTER_KEYS.has(key)) {
			return `"${target}" collides with the Backlog core field "${key}"; map to the native target "${key}" or choose another key`;
		}
		if (key.toLowerCase().startsWith("jira_")) {
			return `"${target}" collides with plugin-owned jira_* metadata keys`;
		}
		return null;
	}

	if ((NATIVE_BACKLOG_TARGETS as readonly string[]).includes(target)) {
		return null;
	}

	return `unknown backlog target "${target}" (expected one of ${NATIVE_BACKLOG_TARGETS.join(", ")} or frontmatter:<key>)`;
}

/**
 * Validate a raw fieldMappings value from config.json
 * Returns the valid mappings and a list of human-readable errors
 */
export function validateFieldMappings(raw: unknown): {
	mappings: FieldMapping[];
	errors: string[];
} {
	const mappings: FieldMapping[] = [];
	const errors: string[] = [];

	if (raw === undefined || raw === null) {
		return { mappings, errors };
	}

	if (!Array.isArray(raw)) {
		return { mappings, errors: ["fieldMappings must be an array"] };
	}

	const seenTargets = new Set<string>();

	raw.forEach((entry, index) => {
		const label = `fieldMappings[${index}]`;

		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`${label}: must be an object`);
			return;
		}

		const e = entry as Record<string, unknown>;
		const entryErrors: string[] = [];

		if (typeof e.backlog !== "string" || !e.backlog.trim()) {
			entryErrors.push(`${label}: "backlog" is required`);
		} else {
			const targetError = validateBacklogTarget(e.backlog.trim());
			if (targetError) {
				entryErrors.push(`${label}: ${targetError}`);
			} else if (seenTargets.has(e.backlog.trim())) {
				entryErrors.push(
					`${label}: backlog target "${e.backlog.trim()}" is mapped more than once`,
				);
			}
		}

		if (typeof e.jira !== "string" || !e.jira.trim()) {
			entryErrors.push(`${label}: "jira" is required`);
		} else if (!JIRA_FIELD_PATTERN.test(e.jira.trim())) {
			entryErrors.push(
				`${label}: "${e.jira}" is not a valid Jira field ID (use customfield_NNNNN or a system field name)`,
			);
		}

		if (
			typeof e.type !== "string" ||
			!(FIELD_MAPPING_TYPES as readonly string[]).includes(e.type)
		) {
			entryErrors.push(
				`${label}: "type" must be one of ${FIELD_MAPPING_TYPES.join(", ")}`,
			);
		}

		if (
			e.direction !== undefined &&
			(typeof e.direction !== "string" ||
				!(FIELD_MAPPING_DIRECTIONS as readonly string[]).includes(e.direction))
		) {
			entryErrors.push(
				`${label}: "direction" must be one of ${FIELD_MAPPING_DIRECTIONS.join(", ")}`,
			);
		}

		if (e.valueMap !== undefined) {
			const valueMap = e.valueMap;
			if (
				!valueMap ||
				typeof valueMap !== "object" ||
				Array.isArray(valueMap) ||
				Object.values(valueMap).some((v) => typeof v !== "string")
			) {
				entryErrors.push(
					`${label}: "valueMap" must be an object of string values`,
				);
			}
		}

		if (entryErrors.length > 0) {
			errors.push(...entryErrors);
			return;
		}

		const backlog = (e.backlog as string).trim();
		seenTargets.add(backlog);
		mappings.push({
			backlog,
			jira: (e.jira as string).trim(),
			type: e.type as FieldMappingType,
			direction: (e.direction as FieldMappingDirection | undefined) ?? "pull",
			...(e.valueMap
				? { valueMap: e.valueMap as Record<string, string> }
				: undefined),
		});
	});

	return { mappings, errors };
}

/**
 * Load and validate fieldMappings from .backlog-jira/config.json
 * Throws FieldMappingConfigError if any entry is invalid
 */
export function loadFieldMappings(cwd = process.cwd()): FieldMapping[] {
	const configPath = join(cwd, ".backlog-jira", "config.json");
	if (!existsSync(configPath)) {
		return [];
	}

	let config: { fieldMappings?: unknown };
	try {
		config = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		logger.warn({ error }, "Failed to read config.json for field mappings");
		return [];
	}

	const { mappings, errors } = validateFieldMappings(config.fieldMappings);
	if (errors.length > 0) {
		throw new FieldMappingConfigError(errors);
	}
	return mappings;
}

/**
 * Mappings applied when pulling from Jira (direction pull or both)
 */
export function getPullMappings(mappings: FieldMapping[]): FieldMapping[] {
	return mappings.filter((m) => m.direction !== "push");
}

/**
 * Mappings applied when pushing to Jira (direction push or both)
 */
export function getPushMappings(mappings: FieldMapping[]): FieldMapping[] {
	return mappings.filter((m) => m.direction !== "pull");
}

/**
 * Whether a target is carried by the core payload (priority, labels)
 * rather than the mappedFields section
 */
export function isCoreOverrideTarget(target: string): boolean {
	return CORE_OVERRIDE_TARGETS.has(target);
}

/**
 * Frontmatter key that stores a Backlog target's value
 */
export function frontmatterKeyForTarget(target: string): string {
	return target.startsWith(FRONTMATTER_PREFIX)
		? target.slice(FRONTMATTER_PREFIX.length)
		: target;
}

// ===== Type adapters (Jira → Backlog) =====

/**
 * Read a field value from a Jira issue.
 * MCP Atlassian may return fields at the top level or nested under `fields`,
 * and may snake_case system field names (fixVersions → fix_versions).
 */
export function getJiraFieldValue(issue: JiraIssue, fieldId: string): unknown {
	const raw = issue.fields ?? {};
	const nested =
		raw.fields && typeof raw.fields === "object"
			? (raw.fields as Record<string, unknown>)
			: {};
	const snake = fieldId.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

	for (const key of [fieldId, snake]) {
		if (raw[key] !== undefined) return raw[key];
		if (nested[key] !== undefined) return nested[key];
	}
	return undefined;
}

/**
 * Reduce a Jira value (option, version, user, MCP wrapper) to a display string
 */
function scalarText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.length > 0 ? scalarText(value[0]) : null;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of [
			"value",
			"name",
			"displayName",
			"display_name",
			"emailAddress",
			"email",
			"key",
			"accountId",
			"id",
		]) {
			if (obj[key] !== undefined && obj[key] !== null) {
				return scalarText(obj[key]);
			}
		}
	}
	return null;
}

/**
 * Reduce a Jira value to a list of display strings
 */
function listText(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	// Unwrap MCP-style { value: [...] } wrappers
	if (
		!Array.isArray(value) &&
		typeof value === "object" &&
		Array.isArray((value as Record<string, unknown>).value)
	) {
		return listText((value as Record<string, unknown>).value);
	}
	const items = Array.isArray(value) ? value : [value];
	return items
		.map((item) => scalarText(item))
		.filter((item): item is string => item !== null);
}

function unwrapScalar(value: unknown): unknown {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"value" in (value as Record<string, unknown>)
	) {
		return unwrapScalar((value as Record<string, unknown>).value);
	}
	return value;
}

function applyValueMap(
	value: string,
	valueMap?: Record<string, string>,
): string {
	if (!valueMap) return value;
	if (value in valueMap) return valueMap[value];
	const lower = value.toLowerCase();
	for (const [from, to] of Object.entries(valueMap)) {
		if (from.toLowerCase() === lower) return to;
	}
	return value;
}

function mapJiraUser(user: string): string {
	const mapped = mapJiraUserToBacklog(user);
	return mapped ?? user;
}

/**
 * Convert a raw Jira value to its Backlog representation using the mapping's type adapter
 */
export function convertJiraValue(
	raw: unknown,
	mapping: Pick<FieldMapping, "type" | "valueMap">,
): MappedValue {
	const { valueMap } = mapping;
	let converted: MappedValue;

	switch (mapping.type) {
		case "string":
		case "option":
			converted = scalarText(raw);
			break;
		case "number": {
			const value = unwrapScalar(raw);
			if (value === undefined || value === null || value === "") {
				converted = null;
				break;
			}
			const num = typeof value === "number" ? value : Number(value);
			converted = Number.isFinite(num) ? String(num) : null;
			break;
		}
		case "date": {
			const text = scalarText(raw);
			const match = text?.match(/^(\d{4}-\d{2}-\d{2})/);
			converted = match ? match[1] : null;
			break;
		}
		case "user": {
			const text = scalarText(raw);
			converted = text ? mapJiraUser(text) : null;
			break;
		}
		case "version": {
			const unwrapped =
				raw && typeof raw === "object" && !Array.isArray(raw)
					? unwrapScalar(raw)
					: raw;
			converted = Array.isArray(unwrapped)
				? listText(unwrapped)
				: scalarText(unwrapped);
			break;
		}
		case "multi-option":
		case "array":
			converted =
				typeof raw === "string"
					? raw
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: listText(raw);
			break;
	}

	if (converted === null) return null;
	if (Array.isArray(converted)) {
		const mapped = converted.map((v) => applyValueMap(v, valueMap));
		return mapped.length > 0 ? mapped : null;
	}
	return applyValueMap(converted, valueMap);
}

/**
 * Coerce a converted value to the shape expected by the Backlog target
 */
export function coerceForTarget(
	value: MappedValue,
	target: string,
): MappedValue {
	if (value === null) return null;
	if (ARRAY_NATIVE_TARGETS.has(target)) {
		return Array.isArray(value) ? value : [value];
	}
	if (target.startsWith(FRONTMATTER_PREFIX)) {
		return value;
	}
	// Scalar native targets (milestone, priority)
	if (Array.isArray(value)) {
		return value.length > 0 ? value.join(", ") : null;
	}
	return value;
}

/**
 * Convert a Jira issue's value for a mapping into the Backlog representation
 */
export function getMappedJiraValue(
	issue: JiraIssue,
	mapping: FieldMapping,
): MappedValue {
	const raw = getJiraFieldValue(issue, mapping.jira);
	return coerceForTarget(convertJiraValue(raw, mapping), mapping.backlog);
}

/**
 * Read a Backlog target's current value from task frontmatter
 */
export function getBacklogTargetValue(
	frontmatter: Record<string, unknown>,
	target: string,
): MappedValue {
	const value = frontmatter[frontmatterKeyForTarget(target)];
	if (value === undefined || value === null) return null;
	if (Array.isArray(value)) {
		const items = value.map((v) => String(v).trim()).filter(Boolean);
		return items.length > 0 ? items : null;
	}
	const text = String(value).trim();
	if (!text || text === "[]") return null;
	return text;
}

/**
 * Canonical string form of a mapped value used for hashing and comparison.
 * Lists are order-insensitive; priority is case-insensitive like the core payload.
 */
export function canonicalMappedValue(
	value: MappedValue,
	target: string,
): string {
	if (value === null) return "";
	if (Array.isArray(value)) {
		return JSON.stringify([...value].sort());
	}
	return target === "priority" ? value.toLowerCase() : value;
}

/**
 * Read a task's frontmatter from its file; returns {} when unavailable
 */
export function readTaskFrontmatter(taskId: string): Record<string, unknown> {
	try {
		const content = readFileSync(getTaskFilePath(taskId), "utf-8");
		return parseFrontmatter(content).frontmatter;
	} catch (error) {
		logger.debug({ taskId, error }, "Could not read task frontmatter");
		return {};
	}
}

// ===== Pull application =====

export interface MappedCliUpdates {
	milestone?: string;
	clearMilestone?: boolean;
	dependencies?: string[];
	clearDependencies?: boolean;
	references?: string[];
	clearReferences?: boolean;
	priority?: string;
	labels?: string[];
	clearLabels?: boolean;
}

export interface MappedFieldUpdates {
	/** Native Backlog fields, applied via `backlog task edit` */
	cli: MappedCliUpdates;
	/** Plugin-owned frontmatter fields; null removes the key */
	frontmatter: Record<string, string | string[] | null>;
}

/**
 * Build the Backlog updates needed to bring mapped fields in line with Jira
 * Only pull/both mappings are applied; unchanged values produce no update.
 */
export function buildMappedFieldUpdates(
	issue: JiraIssue,
	currentFrontmatter: Record<string, unknown>,
	mappings: FieldMapping[],
): MappedFieldUpdates {
	return buildBacklogValueUpdates(
		getPullMappings(mappings).map((mapping) => ({
			mapping,
			value: getMappedJiraValue(issue, mapping),
		})),
		currentFrontmatter,
	);
}

/**
 * Build the Backlog updates that set each mapping's target to the given value
 * (in Backlog representation). Values that already match produce no update.
 * Callers are responsible for honouring mapping direction.
 */
export function buildBacklogValueUpdates(
	values: Array<{ mapping: FieldMapping; value: MappedValue }>,
	currentFrontmatter: Record<string, unknown>,
): MappedFieldUpdates {
	const updates: MappedFieldUpdates = { cli: {}, frontmatter: {} };

	for (const { mapping, value } of values) {
		const target = mapping.backlog;
		const newValue = coerceForTarget(value, target);
		const currentValue = getBacklogTargetValue(currentFrontmatter, target);

		if (
			canonicalMappedValue(newValue, target) ===
			canonicalMappedValue(currentValue, target)
		) {
			continue;
		}

		if (target.startsWith(FRONTMATTER_PREFIX)) {
			updates.frontmatter[frontmatterKeyForTarget(target)] = newValue;
			continue;
		}

		switch (target as NativeBacklogTarget) {
			case "milestone":
				if (newValue === null) updates.cli.clearMilestone = true;
				else updates.cli.milestone = newValue as string;
				break;
			case "dependencies":
				if (newValue === null) updates.cli.clearDependencies = true;
				else updates.cli.dependencies = newValue as string[];
				break;
			case "references":
				if (newValue === null) updates.cli.clearReferences = true;
				else updates.cli.references = newValue as string[];
				break;
			case "labels":
				if (newValue === null) updates.cli.clearLabels = true;
				else updates.cli.labels = newValue as string[];
				break;
			case "priority":
				if (newValue === null) {
					logger.warn(
						{ jiraField: mapping.jira },
						"Mapped priority is empty; Backlog priority cannot be cleared via CLI, leaving it unchanged",
					);
				} else {
					updates.cli.priority = (newValue as string).toLowerCase();
				}
				break;
		}
	}

	return updates;
}

/**
 * Whether a MappedFieldUpdates has anything to apply
 */
export function hasMappedFieldUpdates(updates: MappedFieldUpdates): boolean {
	return (
		Object.keys(updates.cli).length > 0 ||
		Object.keys(updates.frontmatter).length > 0
	);
}

/**
 * Jira field IDs that must be requested when fetching issues.
 * Push mappings are included so their Jira values can be compared and shown.
 */
export function getMappedJiraFieldIds(mappings: FieldMapping[]): string[] {
	return [...new Set(mappings.map((m) => m.jira))];
}

/**
 * Fields returned by MCP Atlassian's jira_get_issue when no fields are requested.
 * Requesting fields replaces this default set, so it must be included.
 */
export const DEFAULT_ISSUE_FIELDS = [
	"summary",
	"description",
	"status",
	"assignee",
	"reporter",
	"labels",
	"priority",
	"created",
	"updated",
	"issuetype",
];

/**
 * The `fields` parameter for fetching issues with mapped fields included,
 * or undefined when no mappings need extra fields
 */
export function getIssueFieldsParam(
	mappings: FieldMapping[],
): string | undefined {
	const extra = getMappedJiraFieldIds(mappings).filter(
		(id) => !DEFAULT_ISSUE_FIELDS.includes(id),
	);
	if (extra.length === 0) return undefined;
	return [...DEFAULT_ISSUE_FIELDS, ...extra].join(",");
}

/**
 * Suggest an adapter type for a Jira field schema (as returned by field discovery)
 */
export function suggestTypeForSchema(schema?: {
	type?: string;
	items?: string;
	system?: string;
	custom?: string;
}): FieldMappingType | undefined {
	if (!schema?.type) return undefined;
	switch (schema.type) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "date":
		case "datetime":
			return "date";
		case "option":
		case "option-with-child":
			return "option";
		case "user":
			return "user";
		case "version":
			return "version";
		case "array":
			switch (schema.items) {
				case "option":
					return "multi-option";
				case "version":
					return "version";
				default:
					return "array";
			}
		default:
			return undefined;
	}
}

// ===== Type adapters (Backlog → Jira) =====

/** A Backlog value that cannot be converted for its Jira field */
export class FieldValueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FieldValueError";
	}
}

/** System fields that always hold a list in Jira */
const JIRA_LIST_FIELDS: ReadonlySet<string> = new Set([
	"fixVersions",
	"versions",
	"components",
	"labels",
]);

/** Jira account IDs (Cloud) in their legacy and current formats */
const ACCOUNT_ID_PATTERN = /^([0-9a-f]{24}|[0-9]{5,}:[a-f0-9-]+)$/;

/**
 * Translate a Backlog value back to its Jira value using a mapping's valueMap.
 * Exact matches win, then case-insensitive; the first matching entry is used.
 */
function reverseValueMap(
	value: string,
	valueMap?: Record<string, string>,
): string {
	if (!valueMap) return value;
	for (const [from, to] of Object.entries(valueMap)) {
		if (to === value) return from;
	}
	const lower = value.toLowerCase();
	for (const [from, to] of Object.entries(valueMap)) {
		if (to.toLowerCase() === lower) return from;
	}
	return value;
}

/** Backlog value as a list; comma-separated text is split */
function toList(value: MappedValue): string[] {
	if (value === null) return [];
	const items = Array.isArray(value) ? value : value.split(",");
	return items.map((v) => v.trim()).filter(Boolean);
}

/** Backlog value as a single string; lists are joined */
function toScalar(value: MappedValue): string | null {
	if (value === null) return null;
	const text = Array.isArray(value) ? value.join(", ") : value;
	return text.trim() || null;
}

/**
 * Jira user field value for a Backlog user. Account IDs are sent as
 * `{ accountId }`; other identifiers as `{ name }` (Server/DC), and can be
 * resolved to account IDs by the caller for Jira Cloud.
 */
function toJiraUser(user: string): { accountId: string } | { name: string } {
	const mapped = mapBacklogAssigneeToJira(user) ?? user.replace(/^@/, "");
	return ACCOUNT_ID_PATTERN.test(mapped)
		? { accountId: mapped }
		: { name: mapped };
}

/**
 * Convert a Backlog value to the Jira field value expected by the REST API,
 * using the mapping's type adapter. Empty values clear the field (null for
 * single-value fields, [] for list fields).
 * Throws FieldValueError when the value cannot be represented.
 */
export function convertBacklogValue(
	value: MappedValue,
	mapping: Pick<FieldMapping, "type" | "jira" | "valueMap">,
): unknown {
	const { valueMap } = mapping;
	const mapped: MappedValue =
		value === null
			? null
			: Array.isArray(value)
				? value.map((v) => reverseValueMap(v, valueMap))
				: reverseValueMap(value, valueMap);

	switch (mapping.type) {
		case "string":
			return toScalar(mapped);
		case "number": {
			const text = toScalar(mapped);
			if (text === null) return null;
			const num = Number(text);
			if (!Number.isFinite(num)) {
				throw new FieldValueError(`"${text}" is not a number`);
			}
			return num;
		}
		case "date": {
			const text = toScalar(mapped);
			if (text === null) return null;
			const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
			if (!match || Number.isNaN(Date.parse(match[1]))) {
				throw new FieldValueError(`"${text}" is not a YYYY-MM-DD date`);
			}
			return match[1];
		}
		case "option": {
			const text = toScalar(mapped);
			return text === null ? null : { value: text };
		}
		case "multi-option":
			return toList(mapped).map((v) => ({ value: v }));
		case "user": {
			const text = toScalar(mapped);
			return text === null ? null : toJiraUser(text);
		}
		case "version":
			if (Array.isArray(mapped) || JIRA_LIST_FIELDS.has(mapping.jira)) {
				return toList(mapped).map((name) => ({ name }));
			}
			return toScalar(mapped) === null ? null : { name: toScalar(mapped) };
		case "array":
			return mapping.jira === "components"
				? toList(mapped).map((name) => ({ name }))
				: toList(mapped);
	}
}

export interface MappedJiraChange {
	mapping: FieldMapping;
	backlogValue: MappedValue;
	jiraValue: MappedValue;
}

export interface MappedJiraFieldUpdates {
	/** Jira field ID → value to send */
	fields: Record<string, unknown>;
	changes: MappedJiraChange[];
	/** Mappings whose Backlog value could not be converted */
	errors: Array<{ mapping: FieldMapping; error: string }>;
}

/**
 * Build the Jira field updates for push/both mappings whose Backlog value
 * differs from Jira. Pass `issue: null` when creating an issue; every
 * non-empty Backlog value is then included.
 */
export function buildMappedJiraFields(
	frontmatter: Record<string, unknown>,
	issue: JiraIssue | null,
	mappings: FieldMapping[],
): MappedJiraFieldUpdates {
	return buildJiraValueUpdates(
		getPushMappings(mappings).map((mapping) => ({
			mapping,
			value: getBacklogTargetValue(frontmatter, mapping.backlog),
		})),
		issue,
	);
}

/**
 * Build the Jira field updates that set each mapping's Jira field to the
 * given value (in Backlog representation). Values that already match the
 * issue produce no update; with `issue: null` empty values are skipped.
 * Callers are responsible for honouring mapping direction.
 */
export function buildJiraValueUpdates(
	values: Array<{ mapping: FieldMapping; value: MappedValue }>,
	issue: JiraIssue | null,
): MappedJiraFieldUpdates {
	const result: MappedJiraFieldUpdates = {
		fields: {},
		changes: [],
		errors: [],
	};

	for (const { mapping, value } of values) {
		const backlogValue = coerceForTarget(value, mapping.backlog);
		const jiraValue = issue ? getMappedJiraValue(issue, mapping) : null;

		if (issue === null && backlogValue === null) continue;
		if (
			issue !== null &&
			canonicalMappedValue(backlogValue, mapping.backlog) ===
				canonicalMappedValue(jiraValue, mapping.backlog)
		) {
			continue;
		}

		try {
			result.fields[mapping.jira] = convertBacklogValue(backlogValue, mapping);
			result.changes.push({ mapping, backlogValue, jiraValue });
		} catch (error) {
			result.errors.push({
				mapping,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return result;
}
