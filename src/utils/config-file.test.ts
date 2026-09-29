import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, uniqueTestDir, writeJson } from "../../test/helpers/fs.ts";
import {
	type RawConfig,
	bootstrapConfigDir,
	getConfigPath,
	readConfigFile,
	setSectionValues,
} from "./config-file.ts";
import { jiraClientOptionsFromConfig } from "./jira-config.ts";

describe("config file", () => {
	let dir: string;
	beforeEach(() => {
		dir = uniqueTestDir("config-file-test");
	});
	afterEach(() => cleanupDir(dir));

	it("bootstraps .backlog-jira/ once and keeps an existing config", () => {
		expect(bootstrapConfigDir(dir)).toBe(true);
		expect(existsSync(join(dir, ".backlog-jira", "snapshots"))).toBe(true);
		expect(existsSync(join(dir, ".backlog-jira", ".gitignore"))).toBe(true);
		writeJson(getConfigPath(dir), { custom: 1 });

		expect(bootstrapConfigDir(dir)).toBe(false);
		expect(readConfigFile(dir)).toEqual({ custom: 1 });
	});

	it("returns null for a missing config and rejects invalid JSON", () => {
		expect(readConfigFile(dir)).toBeNull();
		bootstrapConfigDir(dir);
		writeFileSync(getConfigPath(dir), "{ nope");
		expect(() => readConfigFile(dir)).toThrow("contains invalid JSON");
		writeFileSync(getConfigPath(dir), "[]");
		expect(() => readConfigFile(dir)).toThrow("must contain a JSON object");
	});

	it("sets section values without dropping other keys", () => {
		const config: RawConfig = {
			jira: { projectKey: "A", extra: true },
			other: 1,
		};
		setSectionValues(config, "jira", { projectKey: "B" });
		setSectionValues(config, "sync", { conflictStrategy: "prompt" });
		expect(config).toEqual({
			jira: { projectKey: "B", extra: true },
			other: 1,
			sync: { conflictStrategy: "prompt" },
		});
	});
});

describe("jiraClientOptionsFromConfig", () => {
	it("reads mcp settings and copies env vars", () => {
		const envVars = { TOOLSETS: "default,jira_agile" };
		const options = jiraClientOptionsFromConfig({
			mcp: {
				useExternalServer: true,
				serverCommand: "uvx",
				serverArgs: ["mcp-atlassian"],
				envVars,
			},
		});
		expect(options).toMatchObject({
			useExternalServer: true,
			serverCommand: "uvx",
			serverArgs: ["mcp-atlassian"],
			dockerArgs: ["mcp-atlassian"],
			extraEnv: envVars,
		});
		expect(options.extraEnv).not.toBe(envVars);
		expect(jiraClientOptionsFromConfig({})).toEqual({});
	});
});
