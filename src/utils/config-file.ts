import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FrontmatterStore } from "../state/store.ts";
import { CONFIG_DIR_GITIGNORE } from "./task-links.ts";

/**
 * config.json as stored on disk. Commands that edit it only replace the keys
 * they manage, so unknown keys and sections written by other commands or by
 * hand survive.
 */
export type RawConfig = Record<string, unknown>;

export const CONFLICT_STRATEGIES = [
	"prompt",
	"prefer-backlog",
	"prefer-jira",
] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export function getConfigDir(cwd = process.cwd()): string {
	return join(cwd, ".backlog-jira");
}

export function getConfigPath(cwd = process.cwd()): string {
	return join(getConfigDir(cwd), "config.json");
}

/**
 * The configuration `backlog-jira init` writes
 */
export function createDefaultConfig(): RawConfig {
	return {
		jira: {
			baseUrl: "",
			projectKey: "",
			issueType: "Task",
			jqlFilter: "",
		},
		backlog: {
			statusMapping: {
				"To Do": ["To Do", "Open", "Backlog"],
				"In Progress": ["In Progress"],
				Done: ["Done", "Closed", "Resolved"],
			},
		},
		sync: {
			conflictStrategy: "prompt",
			enableAnnotations: false,
			watchInterval: 60,
		},
	};
}

/**
 * Create .backlog-jira/ with a default config, the snapshots and logs
 * directories and its .gitignore. Existing files are left untouched.
 * Returns whether the directory was created.
 */
export function bootstrapConfigDir(cwd = process.cwd()): boolean {
	const configDir = getConfigDir(cwd);
	const created = !existsSync(configDir);
	mkdirSync(join(configDir, "logs"), { recursive: true });

	const configPath = getConfigPath(cwd);
	if (!existsSync(configPath)) {
		writeConfigFile(createDefaultConfig(), cwd);
	}

	// Creates the snapshots directory
	const store = new FrontmatterStore(configDir);
	store.close();

	const gitignorePath = join(configDir, ".gitignore");
	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, CONFIG_DIR_GITIGNORE);
	}
	return created;
}

/**
 * Read config.json; null when it does not exist.
 * Throws when it is not a JSON object.
 */
export function readConfigFile(cwd = process.cwd()): RawConfig | null {
	const configPath = getConfigPath(cwd);
	if (!existsSync(configPath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new Error(
			`${configPath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${configPath} must contain a JSON object`);
	}
	return parsed as RawConfig;
}

export function writeConfigFile(config: RawConfig, cwd = process.cwd()): void {
	writeFileSync(getConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A section of the config as an object (empty when missing or not an object)
 */
export function getSection(config: RawConfig, name: string): RawConfig {
	const section = config[name];
	return section && typeof section === "object" && !Array.isArray(section)
		? (section as RawConfig)
		: {};
}

/**
 * Set keys of a config section, keeping its other keys
 */
export function setSectionValues(
	config: RawConfig,
	name: string,
	values: RawConfig,
): RawConfig {
	config[name] = { ...getSection(config, name), ...values };
	return config;
}
