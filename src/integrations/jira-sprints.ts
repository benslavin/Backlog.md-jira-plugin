/**
 * Jira Software (Agile) sprint and board types, plus parsers for the shapes
 * MCP Atlassian and Jira return them in.
 */

export type JiraSprintState = "future" | "active" | "closed";

export interface JiraSprint {
	id: string;
	name: string;
	state: JiraSprintState;
	startDate?: string;
	endDate?: string;
	completeDate?: string;
	goal?: string;
	boardId?: string;
}

export type JiraBoardType = "scrum" | "kanban" | "simple" | string;

export interface JiraBoard {
	id: string;
	name: string;
	type: JiraBoardType;
	/** Kanban boards have no sprints; scrum and team-managed boards may */
	supportsSprints: boolean;
}

/** Custom field schema type of the Jira Software Sprint field */
export const SPRINT_FIELD_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";

const SPRINT_STATES: readonly JiraSprintState[] = [
	"future",
	"active",
	"closed",
];

function text(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s && s !== "<null>" ? s : undefined;
}

function sprintState(value: unknown): JiraSprintState | undefined {
	const state = text(value)?.toLowerCase();
	return SPRINT_STATES.find((s) => s === state);
}

/**
 * Parse a legacy Jira Server sprint string such as
 * `com.atlassian.greenhopper.service.sprint.Sprint@1a[id=1,rapidViewId=2,state=CLOSED,name=Sprint 1,...]`
 */
function parseLegacySprintString(value: string): Record<string, string> | null {
	const match = value.match(/\[(.*)\]\s*$/s);
	if (!match) return null;
	const record: Record<string, string> = {};
	// Split only at commas that start a new key=value pair, so names may contain commas
	for (const part of match[1].split(/,(?=[A-Za-z]+=)/)) {
		const eq = part.indexOf("=");
		if (eq > 0) record[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return record;
}

/**
 * Parse one sprint from an Agile API object, an MCP simplified sprint dict
 * (snake_case dates) or a legacy Jira Server sprint string.
 * Returns null when the value is not a recognisable sprint.
 */
export function parseSprint(value: unknown): JiraSprint | null {
	let raw: Record<string, unknown> | null = null;
	if (typeof value === "string") {
		raw = parseLegacySprintString(value);
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		raw = value as Record<string, unknown>;
	}
	if (!raw) return null;

	const id = text(raw.id);
	const name = text(raw.name);
	const state = sprintState(raw.state);
	if (!id || id === "-1" || !name || !state) return null;

	const sprint: JiraSprint = { id, name, state };
	const startDate = text(raw.startDate ?? raw.start_date);
	const endDate = text(raw.endDate ?? raw.end_date);
	const completeDate = text(raw.completeDate ?? raw.complete_date);
	const goal = text(raw.goal);
	const boardId = text(
		raw.boardId ??
			raw.originBoardId ??
			raw.origin_board_id ??
			raw.board_id ??
			raw.rapidViewId,
	);
	if (startDate) sprint.startDate = startDate;
	if (endDate) sprint.endDate = endDate;
	if (completeDate) sprint.completeDate = completeDate;
	if (goal) sprint.goal = goal;
	if (boardId && boardId !== "-1") sprint.boardId = boardId;
	return sprint;
}

/**
 * Parse an issue's Sprint field value into typed sprints.
 * Accepts the raw Jira array, a single sprint, MCP `{ value: [...] }`
 * wrappers and legacy Jira Server sprint strings. Unparseable entries are
 * dropped; an empty or missing value yields [].
 */
export function parseSprintFieldValue(value: unknown): JiraSprint[] {
	if (value === undefined || value === null) return [];
	if (
		!Array.isArray(value) &&
		typeof value === "object" &&
		"value" in (value as Record<string, unknown>) &&
		!("id" in (value as Record<string, unknown>))
	) {
		return parseSprintFieldValue((value as Record<string, unknown>).value);
	}
	const items = Array.isArray(value) ? value : [value];
	return items
		.map((item) => parseSprint(item))
		.filter((sprint): sprint is JiraSprint => sprint !== null);
}

/**
 * Find the Sprint custom field among Jira field definitions by its
 * gh-sprint schema, independent of the site-specific customfield id.
 */
export function findSprintFieldId(
	fields: Array<{ id?: string; schema?: { custom?: string } }>,
): string | null {
	const field = fields.find((f) => f.schema?.custom === SPRINT_FIELD_SCHEMA);
	return field?.id ?? null;
}

/**
 * Parse a board from the Agile API or an MCP simplified board dict
 */
export function parseBoard(value: unknown): JiraBoard | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const id = text(raw.id);
	if (!id || id === "-1") return null;
	const type = text(raw.type)?.toLowerCase() ?? "unknown";
	return {
		id,
		name: text(raw.name) ?? "",
		type,
		supportsSprints: type !== "kanban",
	};
}
