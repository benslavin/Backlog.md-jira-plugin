import { spawn } from "node:child_process";
import { restorePluginFrontmatter } from "../utils/frontmatter.ts";
import { logger } from "../utils/logger.ts";
import { normalizeTaskId } from "../utils/task-links.ts";

// Task IDs as printed by the Backlog.md CLI: task-1, TASK-1, TASK-1.2
const TASK_ID = "[A-Za-z][A-Za-z0-9_]*-\\d+(?:\\.\\d+)*";

export interface BacklogTask {
	id: string;
	title: string;
	status: string;
	assignee?: string;
	labels?: string[];
	priority?: string;
	description?: string;
	acceptanceCriteria?: Array<{ index: number; text: string; checked: boolean }>;
	implementationPlan?: string;
	implementationNotes?: string;
	createdAt?: string;
	updatedAt?: string;
	/** Normalized ID of the parent task (task-1), when the task has one */
	parent?: string;
}

export interface BacklogTaskListItem {
	id: string;
	title: string;
	status: string;
	assignee?: string;
	labels?: string[];
	priority?: string;
}

/**
 * BacklogClient wraps the Backlog CLI for task operations
 */
export class BacklogClient {
	private cliPath: string;

	constructor(cliPath = "backlog") {
		this.cliPath = cliPath;
	}

	/**
	 * Execute a Backlog CLI command
	 */
	private async execute(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			logger.debug(
				{ command: this.cliPath, args },
				"Executing Backlog CLI command",
			);

			const proc = spawn(this.cliPath, args, {
				stdio: ["inherit", "pipe", "pipe"],
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
				if (code !== 0) {
					logger.error({ code, stderr, args }, "Backlog CLI command failed");
					reject(new Error(`Backlog CLI failed with code ${code}: ${stderr}`));
				} else {
					logger.debug(
						{ args, outputLength: stdout.length },
						"Backlog CLI command succeeded",
					);
					resolve(stdout);
				}
			});

			proc.on("error", (error) => {
				logger.error({ error, args }, "Failed to spawn Backlog CLI");
				reject(error);
			});
		});
	}

	/**
	 * Test if Backlog CLI is accessible
	 */
	async test(): Promise<boolean> {
		try {
			await this.execute(["--version"]);
			logger.debug("Backlog CLI is accessible");
			return true;
		} catch (error) {
			logger.error({ error }, "Backlog CLI test failed");
			return false;
		}
	}

	/**
	 * List tasks with optional filters
	 */
	async listTasks(options?: {
		status?: string;
		assignee?: string;
		labels?: string[];
		priority?: string;
	}): Promise<BacklogTaskListItem[]> {
		const args = ["task", "list", "--plain"];

		if (options?.status) {
			args.push("-s", options.status);
		}
		if (options?.assignee) {
			args.push("-a", options.assignee);
		}
		if (options?.labels && options.labels.length > 0) {
			args.push("-l", options.labels.join(","));
		}
		if (options?.priority) {
			args.push("--priority", options.priority);
		}

		try {
			const output = await this.execute(args);
			return this.parseTaskList(output);
		} catch (error) {
			logger.error({ error, options }, "Failed to list tasks");
			throw error;
		}
	}

	/**
	 * Get detailed information about a specific task
	 */
	async getTask(taskId: string): Promise<BacklogTask> {
		try {
			const output = await this.execute(["task", taskId, "--plain"]);
			return this.parseTaskDetail(output);
		} catch (error) {
			logger.error({ error, taskId }, "Failed to get task");
			throw error;
		}
	}

	/**
	 * Update a task with various operations
	 */
	async updateTask(
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			status?: string;
			assignee?: string;
			labels?: string[];
			clearLabels?: boolean;
			priority?: string;
			milestone?: string;
			clearMilestone?: boolean;
			dependencies?: string[];
			clearDependencies?: boolean;
			references?: string[];
			clearReferences?: boolean;
			notes?: string;
			appendNotes?: string;
			plan?: string;
			addAc?: string[];
			removeAc?: number[];
			checkAc?: number[];
			uncheckAc?: number[];
		},
	): Promise<void> {
		const args = ["task", "edit", taskId];

		if (updates.title) {
			args.push("-t", updates.title);
		}
		if (updates.description) {
			args.push("-d", this.escapeMultiline(updates.description));
		}
		if (updates.status) {
			args.push("-s", updates.status);
		}
		if (updates.assignee) {
			args.push("-a", updates.assignee);
		}
		if (updates.labels) {
			args.push("-l", updates.labels.join(","));
		}
		if (updates.clearLabels) {
			args.push("--clear-labels");
		}
		if (updates.priority) {
			args.push("--priority", updates.priority);
		}
		if (updates.milestone) {
			args.push("--milestone", updates.milestone);
		} else if (updates.clearMilestone) {
			args.push("--clear-milestone");
		}
		if (updates.dependencies && updates.dependencies.length > 0) {
			args.push("--dep", updates.dependencies.join(","));
		} else if (updates.clearDependencies) {
			args.push("--clear-deps");
		}
		if (updates.references && updates.references.length > 0) {
			for (const ref of updates.references) {
				args.push("--ref", ref);
			}
		} else if (updates.clearReferences) {
			args.push("--clear-refs");
		}
		if (updates.notes) {
			args.push("--notes", this.escapeMultiline(updates.notes));
		}
		if (updates.appendNotes) {
			args.push("--append-notes", this.escapeMultiline(updates.appendNotes));
		}
		if (updates.plan) {
			args.push("--plan", this.escapeMultiline(updates.plan));
		}
		if (updates.addAc) {
			for (const ac of updates.addAc) {
				args.push("--ac", ac);
			}
		}
		if (updates.removeAc) {
			// Process in reverse order to avoid index shifting
			for (const index of updates.removeAc.sort((a, b) => b - a)) {
				args.push("--remove-ac", index.toString());
			}
		}
		if (updates.checkAc) {
			for (const index of updates.checkAc) {
				args.push("--check-ac", index.toString());
			}
		}
		if (updates.uncheckAc) {
			for (const index of updates.uncheckAc) {
				args.push("--uncheck-ac", index.toString());
			}
		}

		try {
			await this.execute(args);
			logger.info({ taskId, updates }, "Task updated successfully");
			this.restorePluginMetadata(taskId);
		} catch (error) {
			logger.error({ error, taskId, updates }, "Failed to update task");
			throw error;
		}
	}

	/**
	 * `backlog task edit` drops frontmatter keys Backlog.md does not know,
	 * including jira_* metadata and mapped fields; put them back.
	 */
	private restorePluginMetadata(taskId: string): void {
		try {
			restorePluginFrontmatter(taskId);
		} catch (error) {
			logger.warn({ error, taskId }, "Failed to restore plugin frontmatter");
		}
	}

	/**
	 * Create a new task
	 * Returns the created task ID
	 */
	async createTask(options: {
		title: string;
		description?: string;
		status?: string;
		assignee?: string;
		labels?: string[];
		priority?: string;
		ac?: string[];
		/** Parent task ID; the task is created as its subtask */
		parent?: string;
	}): Promise<string> {
		const args = ["task", "create", options.title];

		if (options.parent) {
			args.push("-p", options.parent);
		}
		if (options.description) {
			args.push("-d", this.escapeMultiline(options.description));
		}
		if (options.status) {
			args.push("-s", options.status);
		}
		if (options.assignee) {
			args.push("-a", options.assignee);
		}
		if (options.labels && options.labels.length > 0) {
			args.push("-l", options.labels.join(","));
		}
		if (options.priority) {
			args.push("--priority", options.priority);
		}
		if (options.ac) {
			for (const ac of options.ac) {
				args.push("--ac", ac);
			}
		}

		try {
			const output = await this.execute(args);
			const taskId = this.parseCreatedTaskId(output);
			if (taskId) {
				logger.info(
					{ taskId, title: options.title },
					"Task created successfully",
				);
				return taskId;
			}
			throw new Error(`Failed to parse task ID from output: ${output}`);
		} catch (error) {
			logger.error({ error, options }, "Failed to create task");
			throw error;
		}
	}

	/**
	 * Extract the new task ID from `backlog task create` output.
	 * Backlog.md 1.5x prints "Created task TASK-1"; older versions "Created task-1".
	 */
	private parseCreatedTaskId(output: string): string | null {
		const match =
			output.match(new RegExp(`Created task\\s+(${TASK_ID})`, "i")) ??
			output.match(/\b(task-\d+(?:\.\d+)*)\b/i) ??
			output.trim().match(new RegExp(`^(${TASK_ID})$`));
		return match ? normalizeTaskId(match[1]) : null;
	}

	/**
	 * Parse task list output from --plain format.
	 * Supports the Backlog.md 1.5x layout, grouped by status:
	 *   In Progress:
	 *     [HIGH] TASK-1 - Title (ac: 0/1)
	 * and the older one-line layout:
	 *   task-1 - Title (Status) [@assignee] [labels] [priority]
	 */
	private parseTaskList(output: string): BacklogTaskListItem[] {
		const tasks: BacklogTaskListItem[] = [];
		const lines = output.trim().split("\n");

		const groupedLine = new RegExp(
			`^\\s+(?:\\[([^\\]]+)\\]\\s+)?(${TASK_ID})\\s+-\\s+(.+?)(?:\\s+\\(ac:\\s*\\d+\\/\\d+\\))?$`,
		);
		const legacyLine = new RegExp(
			`^(${TASK_ID})\\s+-\\s+(.+?)(?:\\s+\\((.+?)\\))?(?:\\s+\\[@(.+?)\\])?(?:\\s+\\[(.+?)\\])?(?:\\s+\\[(.+?)\\])?$`,
		);
		let groupStatus: string | undefined;

		for (const line of lines) {
			// Skip empty lines and section dividers
			if (!line.trim() || line.startsWith("===") || line.startsWith("---")) {
				continue;
			}

			const grouped = line.match(groupedLine);
			if (grouped) {
				const [, priority, id, title] = grouped;
				tasks.push({
					id: normalizeTaskId(id),
					title: title.trim(),
					status: groupStatus || "Unknown",
					priority: priority ? priority.toLowerCase() : undefined,
				});
				continue;
			}

			const match = line.match(legacyLine);
			if (match) {
				const [, id, title, status, assignee, labelsStr, priority] = match;
				tasks.push({
					id: normalizeTaskId(id),
					title: title.trim(),
					status: status || "Unknown",
					assignee: assignee || undefined,
					labels: labelsStr
						? labelsStr.split(",").map((l) => l.trim())
						: undefined,
					priority: priority || undefined,
				});
				continue;
			}

			// Status group header, e.g. "In Progress:"
			if (!/^\s/.test(line) && line.trimEnd().endsWith(":")) {
				groupStatus = line.trim().slice(0, -1);
			}
		}

		logger.debug({ count: tasks.length }, "Parsed task list");
		return tasks;
	}

	/**
	 * Parse task detail output from --plain format
	 */
	private parseTaskDetail(output: string): BacklogTask {
		const lines = output.split("\n");
		const task: Partial<BacklogTask> = {};
		let currentSection: string | null = null;
		let sectionContent: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Parse header info
			if (line.startsWith("Task ")) {
				const match = line.match(
					new RegExp(`^Task\\s+(${TASK_ID})\\s+-\\s+(.+)$`),
				);
				if (match) {
					task.id = normalizeTaskId(match[1]);
					task.title = match[2];
				}
			} else if (line.startsWith("Status:")) {
				task.status = line
					.replace("Status:", "")
					.trim()
					// Remove all possible Backlog.md status emojis:
					// ○ (To Do), ◐ (partially filled), ◒ (In Progress), ● (Blocked), ✔ (Done), ◆ (Review), ▣ (Testing)
					.replace(/^[○◐◒●✔◆▣]\s*/, "");
			} else if (line.startsWith("Assignee:")) {
				task.assignee = line.replace("Assignee:", "").trim().replace(/^@/, "");
			} else if (line.startsWith("Labels:")) {
				const labelsStr = line.replace("Labels:", "").trim();
				task.labels = labelsStr
					? labelsStr.split(",").map((l) => l.trim())
					: [];
			} else if (line.startsWith("Priority:")) {
				task.priority = line.replace("Priority:", "").trim();
			} else if (line.startsWith("Created:")) {
				task.createdAt = line.replace("Created:", "").trim();
			} else if (line.startsWith("Updated:")) {
				task.updatedAt = line.replace("Updated:", "").trim();
			} else if (line.startsWith("Parent:")) {
				// "Parent: TASK-1 - Parent title"
				const parent = line
					.replace("Parent:", "")
					.trim()
					.match(new RegExp(`^(${TASK_ID})`));
				if (parent) task.parent = normalizeTaskId(parent[1]);
			} else if (line.match(/^[-=]{2,}$/)) {
				// Section dividers - skip them, they're just visual separators
			} else if (line.endsWith(":") && !line.startsWith(" ")) {
				// Section header - save previous section first
				if (currentSection && sectionContent.length > 0) {
					this.assignSection(task, currentSection, sectionContent.join("\n"));
				}
				// Set new section (remove the colon)
				currentSection = line.replace(":", "").trim();
				sectionContent = [];
			} else if (currentSection || line.startsWith("- [")) {
				// Section content or AC line
				if (line.startsWith("- [")) {
					// Acceptance criteria
					if (!task.acceptanceCriteria) {
						task.acceptanceCriteria = [];
					}
					const acMatch = line.match(/^-\s+\[([ x])\]\s+#(\d+)\s+(.+)$/);
					if (acMatch) {
						task.acceptanceCriteria.push({
							index: Number.parseInt(acMatch[2]),
							text: acMatch[3],
							checked: acMatch[1] === "x",
						});
					}
				} else if (line.trim()) {
					sectionContent.push(line);
				}
			}
		}

		// Save last section
		if (currentSection && sectionContent.length > 0) {
			this.assignSection(task, currentSection, sectionContent.join("\n"));
		}

		if (!task.id) {
			throw new Error("Failed to parse task ID from output");
		}

		logger.debug({ taskId: task.id }, "Parsed task detail");
		return task as BacklogTask;
	}

	/**
	 * Assign parsed content to appropriate task field
	 */
	private assignSection(
		task: Partial<BacklogTask>,
		section: string,
		content: string,
	): void {
		const trimmed = content.trim();
		if (!trimmed) return;

		switch (section) {
			case "Description":
				task.description = trimmed;
				break;
			case "Implementation Plan":
				task.implementationPlan = trimmed;
				break;
			case "Implementation Notes":
				task.implementationNotes = trimmed;
				break;
		}
	}

	/**
	 * Escape multiline strings for cross-platform CLI compatibility
	 * On Unix/Mac: Use literal newlines
	 * On Windows: May need different handling
	 */
	private escapeMultiline(text: string): string {
		// For now, preserve the text as-is
		// The CLI should handle literal newlines in arguments
		return text;
	}
}
