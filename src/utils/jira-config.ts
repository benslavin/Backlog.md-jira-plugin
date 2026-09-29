import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraClientOptions } from "../integrations/jira.ts";
import { logger } from "./logger.ts";

interface McpConfig {
	useExternalServer?: boolean;
	serverCommand?: string;
	serverArgs?: string[];
	fallbackToDocker?: boolean;
	envVars?: Record<string, string>;
}

/**
 * JiraClient options from a parsed config.json
 * - mcp.serverArgs for Docker args (e.g., --dns, --dns-search)
 * - mcp.useExternalServer/serverCommand/serverArgs for external server
 * - mcp.envVars to pass extra env vars into MCP process/container
 */
export function jiraClientOptionsFromConfig(
	config: unknown,
): JiraClientOptions {
	const mcp = (config as { mcp?: McpConfig } | null)?.mcp;
	const options: JiraClientOptions = {};
	if (!mcp || typeof mcp !== "object") return options;

	if (mcp.serverArgs && Array.isArray(mcp.serverArgs)) {
		logger.debug(
			{ dockerArgs: mcp.serverArgs },
			"Using Docker args from config.json",
		);
		options.dockerArgs = mcp.serverArgs;
		// Reuse serverArgs for external server too (naming overlap in config)
		options.serverArgs = mcp.serverArgs;
	}
	if (typeof mcp.useExternalServer === "boolean") {
		options.useExternalServer = mcp.useExternalServer;
	}
	if (typeof mcp.fallbackToDocker === "boolean") {
		options.fallbackToDocker = mcp.fallbackToDocker;
	}
	if (typeof mcp.serverCommand === "string") {
		options.serverCommand = mcp.serverCommand;
	}
	if (mcp.envVars && typeof mcp.envVars === "object") {
		// Copied: the client adds its own defaults to extraEnv
		options.extraEnv = { ...mcp.envVars };
	}
	return options;
}

/**
 * Get JiraClient options from .backlog-jira/config.json
 */
export function getJiraClientOptions(cwd = process.cwd()): JiraClientOptions {
	try {
		const configPath = join(cwd, ".backlog-jira", "config.json");
		if (!existsSync(configPath)) {
			return {} as JiraClientOptions;
		}
		return jiraClientOptionsFromConfig(
			JSON.parse(readFileSync(configPath, "utf-8")),
		);
	} catch (error) {
		logger.warn({ error }, "Failed to read MCP config from config.json");
		return {} as JiraClientOptions;
	}
}
