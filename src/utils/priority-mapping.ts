import {
	BACKLOG_PRIORITIES,
	type FieldMapping,
	applyValueMap,
	loadPriorityMapping,
	reverseValueMap,
} from "./field-mapping.ts";
import { logger } from "./logger.ts";

/**
 * Valid Backlog.md priority values
 */
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number];

/**
 * Map Jira priority to Backlog.md priority through the built-in priority
 * field mapping. The default valueMap covers Highest, High, Medium, Low,
 * Lowest, Critical, Blocker, Major, Minor and Trivial; entries configured in
 * fieldMappings override it. Unknown values default to medium.
 *
 * @param mapping - Priority mapping to use; loaded from config.json when omitted
 */
export function mapJiraPriorityToBacklog(
	jiraPriority: string | undefined,
	mapping: Pick<FieldMapping, "valueMap"> = loadPriorityMapping(),
): BacklogPriority | undefined {
	if (!jiraPriority) {
		return undefined;
	}

	const translated = applyValueMap(jiraPriority.trim(), mapping.valueMap)
		.trim()
		.toLowerCase();
	const mapped = (BACKLOG_PRIORITIES as readonly string[]).includes(translated)
		? (translated as BacklogPriority)
		: undefined;

	if (!mapped) {
		logger.warn(
			{ jiraPriority },
			`Unknown Jira priority "${jiraPriority}", defaulting to medium`,
		);
		return "medium";
	}

	logger.debug(
		{ jiraPriority, backlogPriority: mapped },
		"Mapped Jira priority to Backlog",
	);

	return mapped;
}

/**
 * Map Backlog.md priority to Jira priority through the built-in priority
 * field mapping: the first valueMap entry for the Backlog value is used
 * (High, Medium, Low by default). Unknown values default to the Jira value
 * for medium.
 *
 * @param mapping - Priority mapping to use; loaded from config.json when omitted
 */
export function mapBacklogPriorityToJira(
	backlogPriority: string | undefined,
	mapping: Pick<FieldMapping, "valueMap"> = loadPriorityMapping(),
): string | undefined {
	if (!backlogPriority) {
		return undefined;
	}

	const normalized = backlogPriority.toLowerCase().trim();
	const mapped = hasJiraValueFor(normalized, mapping)
		? reverseValueMap(normalized, mapping.valueMap)
		: undefined;

	if (!mapped) {
		const jiraMedium = hasJiraValueFor("medium", mapping)
			? reverseValueMap("medium", mapping.valueMap)
			: "Medium";
		logger.warn(
			{ backlogPriority },
			`Unknown Backlog priority "${backlogPriority}", defaulting to ${jiraMedium}`,
		);
		return jiraMedium;
	}

	logger.debug(
		{ backlogPriority, jiraPriority: mapped },
		"Mapped Backlog priority to Jira",
	);

	return mapped;
}

/**
 * Whether the valueMap has a Jira value for a Backlog priority
 */
function hasJiraValueFor(
	backlogPriority: string,
	mapping: Pick<FieldMapping, "valueMap">,
): boolean {
	return (
		(BACKLOG_PRIORITIES as readonly string[]).includes(backlogPriority) &&
		Object.values(mapping.valueMap ?? {}).some(
			(to) => to.toLowerCase() === backlogPriority,
		)
	);
}
