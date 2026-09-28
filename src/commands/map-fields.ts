import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { JiraClient } from "../integrations/jira.ts";
import {
	FIELD_MAPPING_DIRECTIONS,
	FIELD_MAPPING_TYPES,
	type FieldMapping,
	FieldMappingConfigError,
	isBuiltInPriorityMapping,
	suggestTypeForSchema,
	validateFieldMappings,
} from "../utils/field-mapping.ts";
import { getJiraClientOptions } from "../utils/jira-config.ts";
import { logger } from "../utils/logger.ts";

interface ConfigWithFieldMappings {
	fieldMappings?: unknown;
	[key: string]: unknown;
}

function getConfigPath(): string {
	return join(process.cwd(), ".backlog-jira", "config.json");
}

function readConfig(): ConfigWithFieldMappings {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		throw new Error("Configuration not found. Run 'backlog-jira init' first.");
	}
	return JSON.parse(readFileSync(configPath, "utf-8"));
}

function writeConfig(config: ConfigWithFieldMappings): void {
	writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Parse --value-map entries of the form "Jira value=Backlog value"
 */
export function parseValueMapEntries(
	entries: string[] = [],
): Record<string, string> | undefined {
	if (entries.length === 0) return undefined;
	const valueMap: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new Error(
				`Invalid --value-map entry "${entry}" (expected "Jira value=Backlog value")`,
			);
		}
		valueMap[entry.slice(0, separator).trim()] = entry
			.slice(separator + 1)
			.trim();
	}
	return valueMap;
}

/**
 * Add (or with force, replace) a mapping in a config object
 * Throws FieldMappingConfigError if the resulting mappings are invalid
 */
export function addFieldMapping(
	config: ConfigWithFieldMappings,
	mapping: {
		backlog: string;
		jira: string;
		type: string;
		direction?: string;
		valueMap?: Record<string, string>;
	},
	options: { force?: boolean } = {},
): ConfigWithFieldMappings {
	const existing = Array.isArray(config.fieldMappings)
		? [...config.fieldMappings]
		: [];
	const index = existing.findIndex(
		(m) => (m as { backlog?: unknown })?.backlog === mapping.backlog,
	);

	if (index >= 0 && !options.force) {
		throw new Error(
			`A mapping for "${mapping.backlog}" already exists. Use --force to replace it.`,
		);
	}

	const entry: Record<string, unknown> = {
		backlog: mapping.backlog,
		jira: mapping.jira,
		type: mapping.type,
		direction:
			mapping.direction ??
			(isBuiltInPriorityMapping(mapping) ? "both" : "pull"),
	};
	if (mapping.valueMap) entry.valueMap = mapping.valueMap;

	if (index >= 0) existing[index] = entry;
	else existing.push(entry);

	const { errors } = validateFieldMappings(existing);
	if (errors.length > 0) {
		throw new FieldMappingConfigError(errors);
	}

	return { ...config, fieldMappings: existing };
}

/**
 * Remove the mapping for a Backlog target from a config object
 */
export function removeFieldMapping(
	config: ConfigWithFieldMappings,
	backlogTarget: string,
): ConfigWithFieldMappings {
	const existing = Array.isArray(config.fieldMappings)
		? config.fieldMappings
		: [];
	const remaining = existing.filter(
		(m) => (m as { backlog?: unknown })?.backlog !== backlogTarget,
	);
	if (remaining.length === existing.length) {
		throw new Error(`No field mapping found for "${backlogTarget}"`);
	}
	return { ...config, fieldMappings: remaining };
}

function describeMapping(mapping: FieldMapping): string {
	const valueMap = mapping.valueMap
		? chalk.gray(
				` valueMap: ${Object.entries(mapping.valueMap)
					.map(([from, to]) => `${from}→${to}`)
					.join(", ")}`,
			)
		: "";
	const arrow =
		mapping.direction === "both"
			? "↔"
			: mapping.direction === "push"
				? "→"
				: "←";
	return `  ${chalk.cyan(mapping.backlog)} ${arrow} ${chalk.yellow(mapping.jira)} ${chalk.gray(`(${mapping.type}, ${mapping.direction})`)}${valueMap}`;
}

async function listFieldMappings(): Promise<void> {
	const config = readConfig();
	const { mappings, errors } = validateFieldMappings(config.fieldMappings);

	console.log(chalk.bold.cyan("\n📋 Field Mappings\n"));
	if (mappings.length === 0 && errors.length === 0) {
		console.log(chalk.gray("  No field mappings configured."));
		console.log(
			chalk.gray(
				"  Add one with: backlog-jira map-fields add <backlog-target> <jira-field> --type <type>",
			),
		);
	}
	for (const mapping of mappings) {
		console.log(describeMapping(mapping));
	}
	if (errors.length > 0) {
		console.log(chalk.red("\n❌ Invalid entries:"));
		for (const error of errors) {
			console.log(chalk.red(`  - ${error}`));
		}
		process.exitCode = 1;
	}
	console.log(
		chalk.gray(
			"\n  ← pull (Jira → Backlog)   → push (Backlog → Jira)   ↔ both\n",
		),
	);
}

async function discoverFields(options: {
	search?: string;
	customOnly?: boolean;
}): Promise<void> {
	const jira = new JiraClient({ ...getJiraClientOptions(), silentMode: true });
	try {
		const fields = await jira.searchFields(options.search ?? "");
		const filtered = options.customOnly
			? fields.filter((f) => f.custom || f.id.startsWith("customfield_"))
			: fields;

		if (filtered.length === 0) {
			console.log(chalk.yellow("No Jira fields found."));
			return;
		}

		console.log(chalk.bold.cyan(`\n🔎 Jira fields (${filtered.length})\n`));
		const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
		const idWidth = Math.max(...sorted.map((f) => f.id.length), 2);
		for (const field of sorted) {
			const schemaType = field.schema?.type
				? field.schema.items
					? `${field.schema.type}<${field.schema.items}>`
					: field.schema.type
				: "unknown";
			const suggested = suggestTypeForSchema(field.schema);
			console.log(
				`  ${chalk.yellow(field.id.padEnd(idWidth))}  ${field.name} ${chalk.gray(`[${schemaType}]`)}${suggested ? chalk.green(` → --type ${suggested}`) : ""}`,
			);
		}
		console.log();
	} finally {
		await jira.close();
	}
}

/**
 * Register map-fields command with CLI
 */
export function registerMapFieldsCommand(program: Command): void {
	const mapFieldsCmd = program
		.command("map-fields")
		.description(
			"Manage custom Jira → Backlog field mappings (applied on pull)",
		);

	const run =
		<A extends unknown[]>(label: string, fn: (...args: A) => Promise<void>) =>
		async (...args: A) => {
			try {
				await fn(...args);
			} catch (error) {
				logger.error({ error }, `${label} failed`);
				console.error(
					chalk.red(
						`Error: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
				process.exit(1);
			}
		};

	mapFieldsCmd
		.command("list")
		.alias("show")
		.description("List configured field mappings")
		.action(run("List field mappings", listFieldMappings));

	mapFieldsCmd
		.command("add")
		.description("Add a field mapping")
		.argument(
			"<backlog-target>",
			"milestone, dependencies, references, priority, labels, or frontmatter:<key>",
		)
		.argument(
			"<jira-field>",
			"Jira field ID (customfield_NNNNN) or system field name (e.g. fixVersions)",
		)
		.requiredOption(
			"--type <type>",
			`One of: ${FIELD_MAPPING_TYPES.join(", ")}`,
		)
		.option(
			"--direction <direction>",
			`One of: ${FIELD_MAPPING_DIRECTIONS.join(", ")} (pull: Jira → Backlog, push: Backlog → Jira; default: pull, or both for priority ↔ priority)`,
		)
		.option(
			"--value-map <entry>",
			'Translate a Jira value, e.g. "Highest=high" (repeatable)',
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option("--force", "Replace an existing mapping for the same target")
		.action(
			run(
				"Add field mapping",
				async (
					backlogTarget: string,
					jiraField: string,
					options: {
						type: string;
						direction?: string;
						valueMap?: string[];
						force?: boolean;
					},
				) => {
					const config = addFieldMapping(
						readConfig(),
						{
							backlog: backlogTarget,
							jira: jiraField,
							type: options.type,
							direction: options.direction,
							valueMap: parseValueMapEntries(options.valueMap),
						},
						{ force: options.force },
					);
					writeConfig(config);
					console.log(
						chalk.green(
							`✓ Added field mapping: ${backlogTarget} ← ${jiraField}`,
						),
					);
					console.log(
						chalk.gray(
							"  Run 'backlog-jira pull' to apply it to mapped tasks.",
						),
					);
				},
			),
		);

	mapFieldsCmd
		.command("remove")
		.alias("rm")
		.description("Remove the field mapping for a Backlog target")
		.argument("<backlog-target>", "Backlog target of the mapping to remove")
		.action(
			run("Remove field mapping", async (backlogTarget: string) => {
				writeConfig(removeFieldMapping(readConfig(), backlogTarget));
				console.log(chalk.green(`✓ Removed field mapping: ${backlogTarget}`));
			}),
		);

	mapFieldsCmd
		.command("discover")
		.description("List Jira fields with their IDs and types")
		.option("--search <keyword>", "Only show fields matching a keyword")
		.option("--custom-only", "Only show custom fields")
		.action(run("Discover fields", discoverFields));
}
