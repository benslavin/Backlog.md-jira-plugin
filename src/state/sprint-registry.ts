import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	JiraSprint,
	JiraSprintState,
} from "../integrations/jira-sprints.ts";
import { logger } from "../utils/logger.ts";

/**
 * Registry linking Jira sprints to the Backlog milestones that represent them.
 *
 * Stored in .backlog-jira/sprints.json and keyed by Jira sprint id, so the
 * link survives sprint renames and duplicate sprint names. Entries are kept
 * as an ordered array (not an object keyed by id, whose numeric keys
 * JavaScript would reorder), and unknown keys are preserved, so reading and
 * writing the file never reorders or drops unrelated content.
 *
 * {
 *   "version": 1,
 *   "sprints": [
 *     { "sprintId": "37", "milestoneId": "m-2", "boardId": "5", "name": "Sprint 12",
 *       "state": "active", "startDate": "...", "endDate": "...", "goal": "..." }
 *   ]
 * }
 */

export const SPRINT_REGISTRY_VERSION = 1;

/** Line re-including the registry in the generated .backlog-jira/.gitignore */
export const SPRINTS_GITIGNORE_RULE = "!sprints.json";

export interface SprintRegistryEntry {
	sprintId: string;
	milestoneId: string;
	boardId?: string;
	/** Last known sprint data */
	name: string;
	state: JiraSprintState;
	startDate?: string;
	endDate?: string;
	completeDate?: string;
	goal?: string;
}

/** Sprint data fields copied from Jira into an entry */
const SPRINT_DATA_KEYS = [
	"boardId",
	"name",
	"state",
	"startDate",
	"endDate",
	"completeDate",
	"goal",
] as const;

export class SprintRegistryError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`Invalid sprint registry ${path}: ${message}`);
		this.name = "SprintRegistryError";
	}
}

export function getSprintRegistryPath(cwd = process.cwd()): string {
	return join(cwd, ".backlog-jira", "sprints.json");
}

export class SprintRegistry {
	/** Serialized content as last loaded or saved, to detect changes */
	private savedText: string;

	private constructor(
		readonly path: string,
		private readonly root: Record<string, unknown>,
		private readonly entries: Array<Record<string, unknown>>,
	) {
		// Compare against the canonical form of what was read, so an unchanged
		// registry is never rewritten (keeping hand formatting) and an empty
		// one is never created
		this.savedText = this.serialize();
	}

	/**
	 * Load the registry; an absent file yields an empty registry.
	 * Throws SprintRegistryError when the file is not a valid registry, so a
	 * damaged file is never silently overwritten.
	 */
	static load(cwd = process.cwd()): SprintRegistry {
		const path = getSprintRegistryPath(cwd);
		if (!existsSync(path)) {
			return new SprintRegistry(
				path,
				{ version: SPRINT_REGISTRY_VERSION, sprints: [] },
				[],
			);
		}

		const text = readFileSync(path, "utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new SprintRegistryError(
				path,
				`not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SprintRegistryError(path, "expected a JSON object");
		}
		const root = parsed as Record<string, unknown>;
		if (root.sprints === undefined) root.sprints = [];
		if (!Array.isArray(root.sprints)) {
			throw new SprintRegistryError(path, '"sprints" must be an array');
		}

		const seen = new Set<string>();
		const entries = root.sprints as unknown[];
		entries.forEach((entry, index) => {
			const label = `sprints[${index}]`;
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new SprintRegistryError(path, `${label} must be an object`);
			}
			const e = entry as Record<string, unknown>;
			for (const key of ["sprintId", "milestoneId"]) {
				if (typeof e[key] === "number") e[key] = String(e[key]);
				if (typeof e[key] !== "string" || !(e[key] as string).trim()) {
					throw new SprintRegistryError(path, `${label} is missing "${key}"`);
				}
			}
			const sprintId = e.sprintId as string;
			if (seen.has(sprintId)) {
				throw new SprintRegistryError(
					path,
					`${label} repeats sprint ${sprintId}`,
				);
			}
			seen.add(sprintId);
		});

		return new SprintRegistry(
			path,
			root,
			entries as Array<Record<string, unknown>>,
		);
	}

	/** All entries in file order */
	list(): SprintRegistryEntry[] {
		return this.entries.map(
			(e) => ({ ...e }) as unknown as SprintRegistryEntry,
		);
	}

	/** Entry for a Jira sprint id */
	get(sprintId: string | number): SprintRegistryEntry | undefined {
		const entry = this.find(String(sprintId));
		return entry ? ({ ...entry } as unknown as SprintRegistryEntry) : undefined;
	}

	/** Entry linked to a Backlog milestone id */
	findByMilestone(milestoneId: string): SprintRegistryEntry | undefined {
		const id = milestoneId.trim().toLowerCase();
		const entry = this.entries.find(
			(e) => String(e.milestoneId).toLowerCase() === id,
		);
		return entry ? ({ ...entry } as unknown as SprintRegistryEntry) : undefined;
	}

	/**
	 * Record a sprint's link to a milestone and its latest data.
	 * Existing entries are updated in place, keeping their position, key order
	 * and unknown keys; new sprints are appended.
	 */
	upsert(sprint: JiraSprint, milestoneId: string): SprintRegistryEntry {
		let entry = this.find(sprint.id);
		if (!entry) {
			entry = { sprintId: sprint.id, milestoneId };
			this.entries.push(entry);
		}
		entry.milestoneId = milestoneId;
		for (const key of SPRINT_DATA_KEYS) {
			const value = sprint[key];
			if (value === undefined || value === "") {
				// Board ids are never unlearned, and a closed sprint keeps its
				// complete date when a source (e.g. board listing) omits it
				const keep =
					key === "boardId" ||
					(key === "completeDate" && sprint.state === "closed");
				if (!keep) delete entry[key];
			} else {
				entry[key] = value;
			}
		}
		return { ...entry } as unknown as SprintRegistryEntry;
	}

	/** Whether there are changes not yet written to disk */
	isDirty(): boolean {
		return this.serialize() !== this.savedText;
	}

	/**
	 * Write the registry when it changed; returns whether the file was written
	 */
	save(): boolean {
		const text = this.serialize();
		if (text === this.savedText) return false;
		mkdirSync(dirname(this.path), { recursive: true });
		ensureRegistryTracked(dirname(this.path));
		writeFileSync(this.path, text, "utf-8");
		this.savedText = text;
		logger.debug(
			{ path: this.path, count: this.entries.length },
			"Saved sprint registry",
		);
		return true;
	}

	private find(sprintId: string): Record<string, unknown> | undefined {
		return this.entries.find((e) => e.sprintId === sprintId);
	}

	private serialize(): string {
		this.root.sprints = this.entries;
		return `${JSON.stringify(this.root, null, 2)}\n`;
	}
}

/**
 * The generated .backlog-jira/.gitignore ignores everything; the registry is
 * shared project metadata, so re-include it for git like link records.
 */
function ensureRegistryTracked(configDir: string): void {
	const gitignorePath = join(configDir, ".gitignore");
	if (!existsSync(gitignorePath)) return;
	try {
		const content = readFileSync(gitignorePath, "utf-8");
		if (content.split(/\r?\n/).includes(SPRINTS_GITIGNORE_RULE)) return;
		const separator = content.endsWith("\n") || content === "" ? "" : "\n";
		writeFileSync(
			gitignorePath,
			`${content}${separator}${SPRINTS_GITIGNORE_RULE}\n`,
			"utf-8",
		);
	} catch (error) {
		logger.debug({ error }, "Could not update .backlog-jira/.gitignore");
	}
}
