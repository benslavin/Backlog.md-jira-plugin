import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "./logger.ts";

export interface JiraMetadata {
	jiraKey?: string;
	jiraLastSync?: string;
	jiraSyncState?: string;
	jiraUrl?: string;
}

/**
 * Extract frontmatter from a markdown file
 * Returns the frontmatter object and the content without frontmatter
 * Handles YAML multi-line syntax (>-, |, etc.) and quoted values
 */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

	if (!frontmatterMatch) {
		return { frontmatter: {}, body: content };
	}

	const frontmatterYaml = frontmatterMatch[1];
	const body = frontmatterMatch[2];

	// Parse YAML frontmatter with support for multi-line values
	const frontmatter: Record<string, unknown> = {};
	const lines = frontmatterYaml.split("\n");
	let currentKey: string | null = null;
	let currentValue = "";
	let multilineMode: "none" | "folded" | "literal" = "none";
	let currentList: string[] | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Check for new key-value pair
		const keyMatch = line.match(/^([^:]+):\s*(.*)$/);

		// Block sequence item belonging to the current key (e.g. "  - item")
		const listItemMatch = line.match(/^\s*-\s+(.*)$/);
		if (
			currentKey &&
			multilineMode === "none" &&
			listItemMatch &&
			(currentList || currentValue === "")
		) {
			currentList = currentList ?? [];
			currentList.push(String(parseYamlValue(listItemMatch[1].trim(), "none")));
			continue;
		}

		if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
			// Save previous key-value if exists
			if (currentKey) {
				frontmatter[currentKey] =
					currentList ?? parseYamlValue(currentValue.trim(), multilineMode);
			}
			currentList = null;

			currentKey = keyMatch[1].trim();
			const valueStart = keyMatch[2].trim();

			// Check for multi-line indicators
			if (valueStart === ">" || valueStart === ">-") {
				multilineMode = "folded";
				currentValue = "";
			} else if (valueStart === "|" || valueStart === "|-") {
				multilineMode = "literal";
				currentValue = "";
			} else {
				multilineMode = "none";
				currentValue = valueStart;
			}
		} else if (
			currentKey &&
			multilineMode !== "none" &&
			(line.startsWith(" ") || line.startsWith("\t"))
		) {
			// Continuation of multi-line value
			const indentedLine = line.replace(/^[ \t]+/, "");
			if (currentValue) {
				currentValue +=
					multilineMode === "literal"
						? `\n${indentedLine}`
						: ` ${indentedLine}`;
			} else {
				currentValue = indentedLine;
			}
		}
	}

	// Save last key-value pair
	if (currentKey) {
		frontmatter[currentKey] =
			currentList ?? parseYamlValue(currentValue.trim(), multilineMode);
	}

	return { frontmatter, body };
}

/**
 * Parse a YAML value handling different types and quoting
 */
function parseYamlValue(
	value: string,
	multilineMode: "none" | "folded" | "literal",
): unknown {
	if (!value) {
		return "";
	}

	// Multi-line values are already processed, just return as string
	if (multilineMode !== "none") {
		return value;
	}

	// Handle arrays: [item1, item2]
	const arrayMatch = value.match(/^\[(.*)\]$/);
	if (arrayMatch) {
		return splitFlowSequence(arrayMatch[1])
			.map((v) => unquoteYamlScalar(v.trim()))
			.filter((v) => v);
	}

	return unquoteYamlScalar(value);
}

/**
 * Remove YAML quotes from a scalar, handling escaped quotes
 */
function unquoteYamlScalar(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

/**
 * Split the inside of a flow sequence on commas that are not inside quotes
 */
function splitFlowSequence(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
				i++;
				current += inner[i];
			} else if (ch === quote) {
				quote = null;
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
		} else if (ch === ",") {
			items.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	items.push(current);
	return items;
}

/**
 * Serialize frontmatter object to YAML format
 * Properly quotes values with special characters
 */
function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				// Block sequence style, matching how Backlog.md writes lists
				lines.push(`${key}:`);
				for (const item of value) {
					lines.push(`  - ${serializeYamlValue(item)}`);
				}
			}
		} else if (value !== undefined && value !== null) {
			const serializedValue = serializeYamlValue(value);
			lines.push(`${key}: ${serializedValue}`);
		}
	}

	return lines.join("\n");
}

/**
 * Serialize a value to YAML format with proper quoting
 * Values with special YAML characters should be quoted
 */
function serializeYamlValue(value: unknown): string {
	if (typeof value !== "string") {
		return String(value);
	}

	// Check if value needs quoting (contains YAML special chars or starts with special chars)
	const needsQuoting =
		/[:\[\]{}#&*!|>'"%@`]|^[-?]/.test(value) || value.trim() !== value;

	if (needsQuoting) {
		// Use double quotes and escape any internal backslashes and double quotes
		const escaped = value.replace(/["\\]/g, "\\$&");
		return `"${escaped}"`;
	}

	return value;
}

/**
 * Add or update Jira metadata in a task file's frontmatter
 */
export function updateJiraMetadata(
	filePath: string,
	metadata: JiraMetadata,
): void {
	try {
		const content = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);

		// Update Jira fields - undefined values delete the field
		if ("jiraKey" in metadata) {
			if (metadata.jiraKey === undefined) {
				delete frontmatter.jira_key;
			} else {
				frontmatter.jira_key = metadata.jiraKey;
			}
		}
		if ("jiraLastSync" in metadata) {
			if (metadata.jiraLastSync === undefined) {
				delete frontmatter.jira_last_sync;
			} else {
				frontmatter.jira_last_sync = metadata.jiraLastSync;
			}
		}
		if ("jiraSyncState" in metadata) {
			if (metadata.jiraSyncState === undefined) {
				delete frontmatter.jira_sync_state;
			} else {
				frontmatter.jira_sync_state = metadata.jiraSyncState;
			}
		}
		if ("jiraUrl" in metadata) {
			if (metadata.jiraUrl === undefined) {
				delete frontmatter.jira_url;
			} else {
				frontmatter.jira_url = metadata.jiraUrl;
			}
		}

		// Reconstruct file
		const newFrontmatter = serializeFrontmatter(frontmatter);
		const newContent = `---\n${newFrontmatter}\n---\n${body}`;

		writeFileSync(filePath, newContent, "utf-8");
		logger.debug(
			{ filePath, metadata },
			"Updated Jira metadata in frontmatter",
		);
	} catch (error) {
		logger.error({ error, filePath }, "Failed to update Jira metadata");
		throw error;
	}
}

/**
 * Set or remove plugin-owned frontmatter fields in a task file
 * A null value removes the key; other keys are preserved.
 */
export function updateFrontmatterFields(
	filePath: string,
	fields: Record<string, string | string[] | null>,
): void {
	try {
		const content = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);

		for (const [key, value] of Object.entries(fields)) {
			if (value === null) {
				delete frontmatter[key];
			} else {
				frontmatter[key] = value;
			}
		}

		const newFrontmatter = serializeFrontmatter(frontmatter);
		writeFileSync(filePath, `---\n${newFrontmatter}\n---\n${body}`, "utf-8");
		logger.debug({ filePath, fields }, "Updated frontmatter fields");
	} catch (error) {
		logger.error({ error, filePath }, "Failed to update frontmatter fields");
		throw error;
	}
}

/**
 * Get Jira metadata from a task file
 */
export function getJiraMetadata(filePath: string): JiraMetadata {
	try {
		const content = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter(content);

		return {
			jiraKey: frontmatter.jira_key as string | undefined,
			jiraLastSync: frontmatter.jira_last_sync as string | undefined,
			jiraSyncState: frontmatter.jira_sync_state as string | undefined,
			jiraUrl: frontmatter.jira_url as string | undefined,
		};
	} catch (error) {
		logger.error({ error, filePath }, "Failed to get Jira metadata");
		throw error;
	}
}

/**
 * Find the file path for a given task ID
 * Looks in backlog/tasks/ directory
 */
export function getTaskFilePath(taskId: string): string {
	// Task files are named like: task-123 - Title.md
	// We need to find the file that starts with the task ID

	const { readdirSync } = require("node:fs");
	const { join } = require("node:path");

	const tasksDir = join(process.cwd(), "backlog", "tasks");
	const files = readdirSync(tasksDir);

	// Backlog.md may report IDs in upper case (TASK-1) while files are lower case
	const prefix = `${taskId} - `.toLowerCase();
	const file = files.find(
		(f: string) => f.toLowerCase().startsWith(prefix) && f.endsWith(".md"),
	);

	if (!file) {
		throw new Error(`Task file not found for ${taskId}`);
	}

	return join(tasksDir, file);
}
