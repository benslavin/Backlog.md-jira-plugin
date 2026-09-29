import type { Command } from "commander";
import { FrontmatterStore } from "../state/store.ts";
import {
	type ResolvedId,
	createIdIndex,
	describeResolution,
	resolutionState,
	resolveIds,
} from "../utils/id-resolver.ts";
import { logger } from "../utils/logger.ts";

/** Header of the --plain output: one tab-separated row per ID */
export const PLAIN_HEADER = "input\ttask\tjira\tstate";

const STATE_ICONS = {
	linked: "✓",
	"unlinked-task": "○",
	"unlinked-jira": "○",
	unknown: "?",
} as const;

/**
 * Resolve task IDs and Jira keys against the local links (no Jira calls)
 */
export function resolveCommand(
	ids: string[],
	options: { plain?: boolean } = {},
): { lines: string[]; resolved: ResolvedId[] } {
	const store = new FrontmatterStore();
	try {
		const resolved = resolveIds(ids, createIdIndex(store));
		const lines = options.plain
			? [PLAIN_HEADER, ...resolved.map((r) => describeResolution(r, true))]
			: resolved.map(
					(r) => `${STATE_ICONS[resolutionState(r)]} ${describeResolution(r)}`,
				);
		return { lines, resolved };
	} finally {
		store.close();
	}
}

/**
 * Register resolve command with CLI
 */
export function registerResolveCommand(program: Command): void {
	program
		.command("resolve <ids...>")
		.description(
			"Show the counterpart of each Backlog task ID or Jira key (TASK-1 ⇄ CR2-77)",
		)
		.option(
			"--plain",
			`Tab-separated rows for agents: ${PLAIN_HEADER.replaceAll("\t", ", ")} (linked, unlinked-task, unlinked-jira or unknown)`,
		)
		.action((ids: string[], options: { plain?: boolean }) => {
			try {
				for (const line of resolveCommand(ids, options).lines) {
					console.log(line);
				}
			} catch (error) {
				logger.error({ error }, "Resolve command failed");
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
		});
}
