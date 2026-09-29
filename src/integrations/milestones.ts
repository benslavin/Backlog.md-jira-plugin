import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SprintRegistry } from "../state/sprint-registry.ts";
import { logger } from "../utils/logger.ts";

/**
 * The one place the plugin changes Backlog.md milestones.
 *
 * Milestones are created, renamed and archived only through the
 * `backlog milestone` CLI. Backlog.md has no milestone edit command yet, so
 * due date and description updates prefer the CLI (`milestone edit` when the
 * installed CLI has it, else a same-title `milestone rename --due-date`) and
 * fall back to a guarded direct write that only touches milestones in the
 * sprint registry, and only their due_date and Description section.
 * Milestones are never removed, so tasks keep their milestone reference.
 */

export interface Milestone {
	id: string;
	title: string;
	/** YYYY-MM-DD */
	dueDate?: string;
	/** Text of the Description section */
	description?: string;
	archived: boolean;
	filePath: string;
}

export interface MilestoneUpdate {
	/** YYYY-MM-DD, or null to clear */
	dueDate?: string | null;
	/** Description text, or null to empty it */
	description?: string | null;
}

export type MilestoneUpdateMethod = "edit" | "rename" | "file";

export interface MilestoneUpdateResult {
	status: "updated" | "unchanged" | "refused";
	/** How each changed field was written */
	methods: Partial<Record<keyof MilestoneUpdate, MilestoneUpdateMethod>>;
	/** Why the fallback write was refused */
	reason?: string;
}

export interface MilestoneRefusal {
	milestoneId: string;
	title?: string;
	fields: Array<keyof MilestoneUpdate>;
	reason: string;
	at: string;
}

/** Runs the Backlog.md CLI and resolves with stdout; rejects on failure */
export type BacklogCliRunner = (args: string[], cwd: string) => Promise<string>;

const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getMilestoneRefusalsPath(cwd = process.cwd()): string {
	return join(cwd, ".backlog-jira", "milestone-refusals.json");
}

/**
 * Milestone update refusals recorded by the fallback writer, for doctor
 */
export function readMilestoneRefusals(cwd = process.cwd()): MilestoneRefusal[] {
	const path = getMilestoneRefusalsPath(cwd);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (Object.values(parsed) as MilestoneRefusal[])
			: [];
	} catch (error) {
		logger.debug({ error, path }, "Failed to read milestone refusals");
		return [];
	}
}

export const spawnBacklogCli: BacklogCliRunner = (args, cwd) =>
	new Promise((resolve, reject) => {
		logger.debug({ args, cwd }, "Executing Backlog CLI command");
		const proc = spawn("backlog", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else
				reject(
					new Error(
						`backlog ${args.join(" ")} failed with code ${code}: ${(stderr || stdout).trim()}`,
					),
				);
		});
		proc.on("error", reject);
	});

interface CliCapabilities {
	/** Options of `backlog milestone edit`, or null when there is no such command */
	edit: Set<string> | null;
	/** Options of `backlog milestone rename` */
	rename: Set<string>;
}

function helpOptions(help: string): Set<string> {
	return new Set(help.match(/--[a-z][a-z-]*/g) ?? []);
}

export class MilestoneAdapter {
	private readonly cwd: string;
	private readonly run: BacklogCliRunner;
	private readonly registry: () => SprintRegistry;
	private capabilities: CliCapabilities | null = null;

	constructor(
		options: {
			cwd?: string;
			runner?: BacklogCliRunner;
			/** Registry guarding fallback writes; loaded from cwd by default */
			registry?: SprintRegistry;
		} = {},
	) {
		this.cwd = options.cwd ?? process.cwd();
		this.run = options.runner ?? spawnBacklogCli;
		const registry = options.registry;
		this.registry = () => registry ?? SprintRegistry.load(this.cwd);
	}

	/**
	 * Active and archived milestones, read from the milestone files
	 */
	list(): Milestone[] {
		const backlogDir = join(this.cwd, "backlog");
		return [
			...readMilestoneDir(join(backlogDir, "milestones"), false),
			...readMilestoneDir(join(backlogDir, "archive", "milestones"), true),
		];
	}

	/**
	 * Milestone by id (case-insensitive)
	 */
	get(id: string): Milestone | undefined {
		const wanted = id.trim().toLowerCase();
		return this.list().find((m) => m.id.toLowerCase() === wanted);
	}

	/**
	 * Find a milestone by title the way Backlog.md detects alias conflicts
	 * (trimmed, case-insensitive); active milestones win over archived ones
	 */
	findByTitle(
		title: string,
		isAdoptable: (milestone: Milestone) => boolean = () => true,
	): Milestone | undefined {
		const wanted = title.trim().toLowerCase();
		const matches = this.list().filter(
			(m) => m.title.trim().toLowerCase() === wanted && isAdoptable(m),
		);
		return matches.find((m) => !m.archived) ?? matches[0];
	}

	/**
	 * Adopt an existing milestone with the same title, or create one through
	 * `backlog milestone add`
	 */
	async ensure(
		milestone: { title: string; dueDate?: string; description?: string },
		options: { isAdoptable?: (milestone: Milestone) => boolean } = {},
	): Promise<{ milestone: Milestone; created: boolean }> {
		const existing = this.findByTitle(milestone.title, options.isAdoptable);
		if (existing) {
			logger.debug(
				{ id: existing.id, title: existing.title },
				"Adopted existing milestone",
			);
			return { milestone: existing, created: false };
		}

		const args = ["milestone", "add"];
		if (milestone.description) {
			args.push(`--description=${milestone.description}`);
		}
		if (milestone.dueDate) {
			args.push(`--due-date=${checkDueDate(milestone.dueDate)}`);
		}
		args.push("--", milestone.title.trim());
		const output = await this.run(args, this.cwd);

		const id = output.match(/^Created milestone .*\(([^()\s]+)\)\.?\s*$/m)?.[1];
		const created =
			(id ? this.get(id) : undefined) ??
			this.list().find(
				(m) =>
					!m.archived &&
					m.title.trim().toLowerCase() === milestone.title.trim().toLowerCase(),
			);
		if (!created) {
			throw new Error(
				`Created milestone "${milestone.title}" but could not find its file`,
			);
		}
		logger.info({ id: created.id, title: created.title }, "Created milestone");
		return { milestone: created, created: true };
	}

	/**
	 * Rename an active milestone through `backlog milestone rename`, which
	 * also updates local tasks referencing it. Archived milestones cannot be
	 * renamed by the CLI and are left unchanged (returns false).
	 */
	async rename(id: string, title: string): Promise<boolean> {
		const milestone = this.require(id);
		if (milestone.title === title.trim()) return false;
		if (milestone.archived) {
			logger.warn(
				{ id, title },
				"Archived milestones cannot be renamed through the Backlog CLI",
			);
			return false;
		}
		await this.run(
			["milestone", "rename", "--", milestone.id, title.trim()],
			this.cwd,
		);
		logger.info({ id, from: milestone.title, to: title }, "Renamed milestone");
		return true;
	}

	/**
	 * Archive a milestone through `backlog milestone archive`; tasks keep
	 * their milestone reference. Returns false when it is already archived.
	 */
	async archive(id: string): Promise<boolean> {
		const milestone = this.require(id);
		if (milestone.archived) return false;
		await this.run(["milestone", "archive", "--", milestone.id], this.cwd);
		logger.info({ id }, "Archived milestone");
		return true;
	}

	/**
	 * Update a milestone's due date and description.
	 * Uses `backlog milestone edit` when available, a same-title
	 * `backlog milestone rename --due-date` for the due date otherwise, and
	 * the guarded fallback write for whatever the CLI cannot change.
	 */
	async update(
		id: string,
		update: MilestoneUpdate,
	): Promise<MilestoneUpdateResult> {
		let milestone = this.require(id);
		const methods: MilestoneUpdateResult["methods"] = {};
		const pending: MilestoneUpdate = {};

		const dueDate =
			update.dueDate === undefined
				? undefined
				: update.dueDate && checkDueDate(update.dueDate);
		if (dueDate !== undefined && (dueDate || undefined) !== milestone.dueDate) {
			pending.dueDate = dueDate;
		}
		if (
			update.description !== undefined &&
			(update.description ?? "").trim() !== (milestone.description ?? "")
		) {
			pending.description = update.description;
		}
		if (Object.keys(pending).length === 0) {
			return { status: "unchanged", methods };
		}

		const caps = await this.getCapabilities();

		if (caps.edit && !milestone.archived) {
			const args = ["milestone", "edit"];
			const handled: Array<keyof MilestoneUpdate> = [];
			if (pending.dueDate !== undefined) {
				if (pending.dueDate && caps.edit.has("--due-date")) {
					args.push(`--due-date=${pending.dueDate}`);
					handled.push("dueDate");
				} else if (!pending.dueDate && caps.edit.has("--clear-due-date")) {
					args.push("--clear-due-date");
					handled.push("dueDate");
				}
			}
			if (pending.description !== undefined && caps.edit.has("--description")) {
				args.push(`--description=${pending.description ?? ""}`);
				handled.push("description");
			}
			if (handled.length > 0) {
				args.push("--", milestone.id);
				await this.run(args, this.cwd);
				for (const field of handled) {
					methods[field] = "edit";
					delete pending[field];
				}
			}
		}

		if (pending.dueDate !== undefined && !milestone.archived) {
			const flag = pending.dueDate ? "--due-date" : "--clear-due-date";
			if (caps.rename.has(flag)) {
				await this.run(
					[
						"milestone",
						"rename",
						pending.dueDate ? `--due-date=${pending.dueDate}` : flag,
						"--no-update-tasks",
						"--",
						milestone.id,
						milestone.title,
					],
					this.cwd,
				);
				methods.dueDate = "rename";
				delete pending.dueDate;
			}
		}

		if (Object.keys(pending).length > 0) {
			milestone = this.require(id);
			const refusal = this.fallbackWrite(milestone, pending);
			if (refusal) {
				this.recordRefusal(milestone, pending, refusal);
				return {
					status: Object.keys(methods).length > 0 ? "updated" : "refused",
					methods,
					reason: refusal,
				};
			}
			for (const field of Object.keys(pending) as Array<
				keyof MilestoneUpdate
			>) {
				methods[field] = "file";
			}
		}

		this.clearRefusal(milestone.id);
		logger.info({ id, methods }, "Updated milestone");
		return { status: "updated", methods };
	}

	private require(id: string): Milestone {
		const milestone = this.get(id);
		if (!milestone) throw new Error(`Milestone not found: ${id}`);
		return milestone;
	}

	private async getCapabilities(): Promise<CliCapabilities> {
		if (this.capabilities) return this.capabilities;
		const help = await this.run(["milestone", "--help"], this.cwd);
		const hasEdit = /^\s+edit\b/m.test(help);
		this.capabilities = {
			edit: hasEdit
				? helpOptions(await this.run(["milestone", "edit", "--help"], this.cwd))
				: null,
			rename: helpOptions(
				await this.run(["milestone", "rename", "--help"], this.cwd),
			),
		};
		logger.debug(
			{
				edit: this.capabilities.edit && [...this.capabilities.edit],
				rename: [...this.capabilities.rename],
			},
			"Detected Backlog milestone CLI capabilities",
		);
		return this.capabilities;
	}

	/**
	 * Write the given fields directly into the milestone file.
	 * Returns a refusal reason, or null when written.
	 */
	private fallbackWrite(
		milestone: Milestone,
		update: MilestoneUpdate,
	): string | null {
		let registered: boolean;
		try {
			registered = !!this.registry().findByMilestone(milestone.id);
		} catch (error) {
			return `sprint registry unreadable: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!registered) {
			return `milestone ${milestone.id} is not a sprint milestone in .backlog-jira/sprints.json`;
		}

		const original = readFileSync(milestone.filePath, "utf-8");
		const result = rewriteMilestoneFile(original, milestone.id, update);
		if ("error" in result) {
			return `${milestone.filePath} does not match the expected milestone format: ${result.error}`;
		}
		if (result.content !== original) {
			writeFileSync(milestone.filePath, result.content, "utf-8");
		}
		return null;
	}

	private recordRefusal(
		milestone: Milestone,
		update: MilestoneUpdate,
		reason: string,
	): void {
		logger.warn({ id: milestone.id, reason }, "Refused milestone update");
		this.writeRefusals((refusals) => {
			refusals[milestone.id] = {
				milestoneId: milestone.id,
				title: milestone.title,
				fields: Object.keys(update) as Array<keyof MilestoneUpdate>,
				reason,
				at: new Date().toISOString(),
			};
		});
	}

	private clearRefusal(id: string): void {
		this.writeRefusals((refusals) => {
			delete refusals[id];
		});
	}

	private writeRefusals(
		change: (refusals: Record<string, MilestoneRefusal>) => void,
	): void {
		const path = getMilestoneRefusalsPath(this.cwd);
		let refusals: Record<string, MilestoneRefusal> = {};
		if (existsSync(path)) {
			try {
				refusals = JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				refusals = {};
			}
		}
		const before = JSON.stringify(refusals);
		change(refusals);
		if (JSON.stringify(refusals) === before) return;
		mkdirSync(join(this.cwd, ".backlog-jira"), { recursive: true });
		writeFileSync(path, `${JSON.stringify(refusals, null, 2)}\n`, "utf-8");
	}
}

function checkDueDate(value: string): string {
	const date = value.trim();
	if (!DUE_DATE_PATTERN.test(date) || Number.isNaN(Date.parse(date))) {
		throw new Error(`Invalid milestone due date "${value}" (use YYYY-MM-DD)`);
	}
	return date;
}

// ===== Milestone files =====

const FRONTMATTER_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
const DESCRIPTION_HEADING = "## Description";

/**
 * Parse a YAML scalar as written by Backlog.md ("double", 'single' or bare)
 */
function parseScalar(raw: string): string {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value);
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function splitFrontmatter(
	content: string,
): { lines: string[]; body: string; bodyStart: number } | null {
	if (!content.startsWith("---\n")) return null;
	const end = content.indexOf("\n---\n", 3);
	if (end < 0) return null;
	return {
		lines: content.slice(4, end).split("\n"),
		body: content.slice(end + 5),
		bodyStart: end + 5,
	};
}

/** Start and end offsets (within body) of the Description section text */
function descriptionRange(
	body: string,
): { start: number; end: number; count: number } | null {
	const headings = [...body.matchAll(/^## Description[ \t]*$/gm)];
	if (headings.length === 0) return null;
	const heading = headings[0];
	const start = (heading.index ?? 0) + heading[0].length;
	const next = body.slice(start).search(/^## /m);
	return {
		start,
		end: next < 0 ? body.length : start + next,
		count: headings.length,
	};
}

/**
 * Parse a milestone file leniently for listing
 */
export function parseMilestoneFile(
	content: string,
	filePath: string,
	archived: boolean,
): Milestone | null {
	const parts = splitFrontmatter(content.replace(/\r\n/g, "\n"));
	if (!parts) return null;
	const fields: Record<string, string> = {};
	for (const line of parts.lines) {
		const match = line.match(FRONTMATTER_LINE);
		if (match) fields[match[1]] = parseScalar(match[2] ?? "");
	}
	if (!fields.id || !fields.title) return null;

	const milestone: Milestone = {
		id: fields.id,
		title: fields.title,
		archived,
		filePath,
	};
	if (fields.due_date) milestone.dueDate = fields.due_date;
	const range = descriptionRange(parts.body);
	if (range) {
		const description = parts.body.slice(range.start, range.end).trim();
		if (description) milestone.description = description;
	}
	return milestone;
}

function readMilestoneDir(dir: string, archived: boolean): Milestone[] {
	if (!existsSync(dir)) return [];
	const milestones: Milestone[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(dir, file);
		try {
			const milestone = parseMilestoneFile(
				readFileSync(filePath, "utf-8"),
				filePath,
				archived,
			);
			if (milestone) milestones.push(milestone);
		} catch (error) {
			logger.debug({ error, filePath }, "Skipping unreadable milestone file");
		}
	}
	return milestones;
}

/**
 * Rewrite only the due_date frontmatter line and the Description section
 * text of a milestone file, leaving every other byte unchanged.
 * Refuses (returns an error) when the file is not in the format Backlog.md
 * writes, so unexpected content is never mangled.
 */
export function rewriteMilestoneFile(
	content: string,
	milestoneId: string,
	update: MilestoneUpdate,
): { content: string } | { error: string } {
	if (content.includes("\r")) return { error: "CRLF line endings" };
	const parts = splitFrontmatter(content);
	if (!parts) return { error: "missing --- frontmatter block" };

	const keys = new Map<string, number[]>();
	for (const [index, line] of parts.lines.entries()) {
		const match = line.match(FRONTMATTER_LINE);
		if (!match) {
			return { error: `unexpected frontmatter line "${line}"` };
		}
		keys.set(match[1], [...(keys.get(match[1]) ?? []), index]);
	}
	for (const key of ["id", "title", "due_date"]) {
		if ((keys.get(key)?.length ?? 0) > 1) {
			return { error: `repeated "${key}" in frontmatter` };
		}
	}
	const idLine = keys.get("id")?.[0];
	if (idLine === undefined || !keys.has("title")) {
		return { error: "frontmatter lacks id or title" };
	}
	const fileId = parseScalar(parts.lines[idLine].slice("id:".length));
	if (fileId.toLowerCase() !== milestoneId.toLowerCase()) {
		return { error: `file id "${fileId}" does not match ${milestoneId}` };
	}

	const lines = [...parts.lines];
	if (update.dueDate !== undefined) {
		const dueLine = keys.get("due_date")?.[0];
		const newLine = update.dueDate
			? `due_date: ${JSON.stringify(checkDueDate(update.dueDate))}`
			: null;
		if (dueLine !== undefined) {
			if (newLine) lines[dueLine] = newLine;
			else lines.splice(dueLine, 1);
		} else if (newLine) {
			lines.splice((keys.get("title")?.[0] ?? idLine) + 1, 0, newLine);
		}
	}

	let body = parts.body;
	if (update.description !== undefined) {
		const range = descriptionRange(body);
		if (!range) return { error: `no "${DESCRIPTION_HEADING}" section` };
		if (range.count > 1) {
			return { error: `more than one "${DESCRIPTION_HEADING}" section` };
		}
		const text = (update.description ?? "").trim();
		const followed = range.end < body.length;
		const section = `\n${text ? `\n${text}\n` : ""}${followed ? "\n" : ""}`;
		body = body.slice(0, range.start) + section + body.slice(range.end);
	}

	return { content: `---\n${lines.join("\n")}\n---\n${body}` };
}
