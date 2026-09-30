import { readConfigFile } from "./config-file.ts";
import { logger } from "./logger.ts";

/**
 * Parent and epic link settings in .backlog-jira/config.json:
 * - `sync.parentLinks` (default true): sync task parents with Jira parents
 * - `jira.epicLinkField`: the Epic Link custom field id, "parent" to link
 *   epics through the parent field, or unset to decide by deployment
 *   (Cloud: parent; Server/Data Center: the discovered Epic Link field)
 */
export interface HierarchyConfig {
	parentLinks: boolean;
	/** Configured epic link: a field id, "parent", or undefined (automatic) */
	epicLinkField?: string;
}

export function loadHierarchyConfig(cwd = process.cwd()): HierarchyConfig {
	try {
		const config = readConfigFile(cwd);
		const sync = config?.sync as { parentLinks?: unknown } | undefined;
		const jira = config?.jira as { epicLinkField?: unknown } | undefined;
		const epicLinkField =
			typeof jira?.epicLinkField === "string" && jira.epicLinkField.trim()
				? jira.epicLinkField.trim()
				: undefined;
		return {
			parentLinks: sync?.parentLinks !== false,
			...(epicLinkField ? { epicLinkField } : {}),
		};
	} catch (error) {
		// Invalid JSON is reported by the commands that load the config
		logger.debug({ error }, "Using default parent link settings");
		return { parentLinks: true };
	}
}
