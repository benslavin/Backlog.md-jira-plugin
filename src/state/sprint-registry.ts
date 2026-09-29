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
	/** File content as last read or written (null: no file) */
	private diskText: string | null;
	/** Sprint ids changed through this instance */
	private readonly touched = new Set<string>();
	private fieldIdTouched = false;

	private constructor(
		readonly path: string,
		private root: Record<string, unknown>,
		private entries: Array<Record<string, unknown>>,
		diskText: string | null,
	) {
		// Compare against the canonical form of what was read, so an unchanged
		// registry is never rewritten (keeping hand formatting) and an empty
		// one is never created
		this.savedText = this.serialize();
		this.diskText = diskText;
	}

	/**
	 * Load the registry; an absent file yields an empty registry.
	 * Throws SprintRegistryError when the file is not a valid registry, so a
	 * damaged file is never silently overwritten.
	 */
	static load(cwd = process.cwd()): SprintRegistry {
		const path = getSprintRegistryPath(cwd);
		const read = SprintRegistry.read(path);
		return read
			? new SprintRegistry(path, read.root, read.entries, read.text)
			: new SprintRegistry(
					path,
					{ version: SPRINT_REGISTRY_VERSION, sprints: [] },
					[],
					null,
				);
	}

	private static read(path: string): {
		root: Record<string, unknown>;
		entries: Array<Record<string, unknown>>;
		text: string;
	} | null {
		if (!existsSync(path)) return null;
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

		return {
			root,
			entries: entries as Array<Record<string, unknown>>,
			text,
		};
	}

	/**
	 * Id of the Jira Sprint custom field as last discovered, so payloads can
	 * be normalized without asking Jira
	 */
	get sprintFieldId(): string | null {
		const id = this.root.sprintFieldId;
		return typeof id === "string" && id ? id : null;
	}

	set sprintFieldId(id: string | null) {
		if (id === this.sprintFieldId) return;
		if (id) this.root.sprintFieldId = id;
		else delete this.root.sprintFieldId;
		this.fieldIdTouched = true;
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
		this.touched.add(sprint.id);
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
		if (this.serialize() === this.savedText) return false;
		this.mergeExternalChanges();
		const text = this.serialize();
		mkdirSync(dirname(this.path), { recursive: true });
		ensureRegistryTracked(dirname(this.path));
		writeFileSync(this.path, text, "utf-8");
		this.savedText = text;
		this.diskText = text;
		this.touched.clear();
		this.fieldIdTouched = false;
		logger.debug(
			{ path: this.path, count: this.entries.length },
			"Saved sprint registry",
		);
		return true;
	}

	/**
	 * When another registry instance (e.g. a concurrent pull or push) wrote
	 * the file since it was read, start from the file and re-apply only the
	 * changes made through this instance, so neither side loses entries
	 */
	private mergeExternalChanges(): void {
		const current = existsSync(this.path)
			? readFileSync(this.path, "utf-8")
			: null;
		if (current === this.diskText) return;
		const fresh = SprintRegistry.read(this.path);
		if (!fresh) return;

		for (const id of this.touched) {
			const mine = this.find(id);
			if (!mine) continue;
			const index = fresh.entries.findIndex((e) => e.sprintId === id);
			if (index >= 0) fresh.entries[index] = mine;
			else fresh.entries.push(mine);
		}
		if (this.fieldIdTouched) {
			if (this.root.sprintFieldId) {
				fresh.root.sprintFieldId = this.root.sprintFieldId;
			} else {
				delete fresh.root.sprintFieldId;
			}
		}
		this.root = fresh.root;
		this.entries = fresh.entries;
		logger.debug(
			{ path: this.path },
			"Merged concurrent sprint registry changes",
		);
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
