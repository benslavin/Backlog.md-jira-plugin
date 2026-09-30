/**
 * Jira issue hierarchy: epic > standard issue > subtask.
 *
 * MCP Atlassian returns an issue's parent as Jira's own object under
 * `parent` ({ key, fields: { issuetype: { name, subtask, hierarchyLevel } } })
 * when `parent` is requested. Jira Server/Data Center (and older
 * company-managed projects) link epics through the Epic Link custom field
 * instead, which MCP Atlassian passes through as { value: "KEY" }.
 */

/** Schema of the Jira Software Epic Link custom field */
export const EPIC_LINK_SCHEMA = "com.pyxis.greenhopper.jira:gh-epic-link";

/** Level of an issue in Jira's hierarchy */
export type IssueKind = "epic" | "standard" | "subtask";

/** How an issue is linked to its parent */
export type ParentLinkVia = "parent" | "epicLink";

export interface JiraParentRef {
	key: string;
	/** Issue type name of the parent, when Jira reported it */
	issueType?: string;
	/** Kind of the parent, when it can be told from its issue type */
	kind?: IssueKind;
	via: ParentLinkVia;
}

const EPIC_TYPE = /^epic$/i;
const SUBTASK_TYPE = /^sub-?task$/i;

/**
 * Kind of an issue type from its name and, when known, Jira's subtask flag
 * and hierarchy level. Undefined when the type says nothing (no name).
 */
export function kindOfIssueType(type: {
	name?: unknown;
	subtask?: unknown;
	hierarchyLevel?: unknown;
}): IssueKind | undefined {
	if (type.subtask === true || type.hierarchyLevel === -1) return "subtask";
	if (typeof type.hierarchyLevel === "number" && type.hierarchyLevel >= 1) {
		return "epic";
	}
	const name = typeof type.name === "string" ? type.name.trim() : "";
	if (EPIC_TYPE.test(name)) return "epic";
	if (SUBTASK_TYPE.test(name)) return "subtask";
	if (type.subtask === false || type.hierarchyLevel === 0) return "standard";
	return name ? "standard" : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** An issue key from a plain string, { key } or an MCP { value } wrapper */
function keyOf(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	const obj = asRecord(value);
	if (!obj) return null;
	if (typeof obj.key === "string" && obj.key.trim()) return obj.key.trim();
	if ("value" in obj) return keyOf(obj.value);
	return null;
}

function readField(fields: Record<string, unknown>, fieldId: string): unknown {
	if (fields[fieldId] !== undefined) return fields[fieldId];
	const nested = asRecord(fields.fields);
	return nested?.[fieldId];
}

/**
 * The parent of an issue from its raw fields: the `parent` field, else the
 * Epic Link field when its id is given. Null when the issue has neither.
 */
export function parseIssueParent(
	fields: Record<string, unknown> | undefined,
	epicLinkFieldId?: string | null,
): JiraParentRef | null {
	if (!fields) return null;
	const parent = readField(fields, "parent");
	const parentKey = keyOf(parent);
	if (parentKey) {
		const parentFields = asRecord(asRecord(parent)?.fields);
		const type = asRecord(parentFields?.issuetype ?? parentFields?.issue_type);
		const kind = type ? kindOfIssueType(type) : undefined;
		return {
			key: parentKey,
			...(typeof type?.name === "string" ? { issueType: type.name } : {}),
			...(kind ? { kind } : {}),
			via: "parent",
		};
	}
	if (epicLinkFieldId) {
		const epicKey = keyOf(readField(fields, epicLinkFieldId));
		if (epicKey) return { key: epicKey, kind: "epic", via: "epicLink" };
	}
	return null;
}

/**
 * Kind of an issue: from its issue type, or, for custom type names, from its
 * parent (an issue under a non-epic parent is a subtask)
 */
export function kindOfIssue(issue: {
	issueType: string;
	parent?: JiraParentRef | null;
	fields?: Record<string, unknown>;
}): IssueKind {
	const raw = issue.fields
		? (asRecord(readField(issue.fields, "issuetype")) ??
			asRecord(readField(issue.fields, "issue_type")))
		: null;
	const kind = kindOfIssueType({ ...(raw ?? {}), name: issue.issueType });
	if (kind && kind !== "standard") return kind;
	const parent = issue.parent;
	if (parent && parent.via === "parent" && parent.kind === "standard") {
		return "subtask";
	}
	return "standard";
}

/**
 * Whether JIRA_URL points to Jira Cloud (the rule MCP Atlassian uses).
 * Cloud links epics with `parent`; Server/Data Center with Epic Link.
 */
export function isJiraCloudUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return [".atlassian.net", ".jira.com", ".jira-dev.com"].some((suffix) =>
			host.endsWith(suffix),
		);
	} catch {
		return false;
	}
}

/**
 * Id of the Epic Link custom field among a site's fields, by its schema,
 * else by its name; null when the site has none
 */
export function findEpicLinkFieldId(
	fields: Array<{
		id: string;
		name?: string;
		schema?: { custom?: string };
	}>,
): string | null {
	const bySchema = fields.find((f) => f.schema?.custom === EPIC_LINK_SCHEMA);
	if (bySchema) return bySchema.id;
	const byName = fields.find(
		(f) => f.id.startsWith("customfield_") && /^epic link$/i.test(f.name ?? ""),
	);
	return byName?.id ?? null;
}
