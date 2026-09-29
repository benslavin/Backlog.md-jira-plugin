import { describe, expect, it } from "bun:test";
import type { BacklogTask } from "../integrations/backlog.ts";
import type { JiraIssue } from "../integrations/jira.ts";
import type { Snapshot } from "../state/types.ts";
import type { FieldMapping, FieldMappingDirection } from "./field-mapping.ts";
import {
	type MappedFieldState,
	detectMappedFieldConflicts,
	formatMappedFieldsSection,
	parseManualMappedValue,
	planMappedFieldMerge,
	recordSyncedSnapshots,
	verifyFieldMappings,
} from "./mapped-field-sync.ts";
import {
	type NormalizedPayload,
	computeHash,
	normalizeBacklogTask,
	normalizeJiraIssue,
} from "./normalizer.ts";
import { classifySyncState } from "./sync-state.ts";

const task: BacklogTask = {
	id: "task-1",
	title: "Test Task",
	description: "Description",
	status: "To Do",
	priority: "medium",
	labels: ["backend"],
	acceptanceCriteria: [],
};

function makeIssue(fields: Record<string, unknown> = {}): JiraIssue {
	return {
		key: "PROJ-1",
		id: "10001",
		summary: "Test Task",
		description: "Description",
		status: "To Do",
		issueType: "Task",
		priority: "Medium",
		labels: ["backend"],
		created: "",
		updated: "",
		fields: { key: "PROJ-1", id: "10001", ...fields },
	};
}

function points(direction: FieldMappingDirection): FieldMapping {
	return {
		backlog: "frontmatter:story_points",
		jira: "customfield_10016",
		type: "number",
		direction,
	};
}

function snapshot(
	side: "backlog" | "jira",
	payload: NormalizedPayload,
	hash: string,
): Snapshot {
	return {
		backlogId: "task-1",
		side,
		hash,
		payload: JSON.stringify(payload),
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Snapshots as written after a sync where story points were 3 on both sides
 */
function syncedAt3(mappings: FieldMapping[]) {
	const backlog = normalizeBacklogTask(task, {
		fieldMappings: mappings,
		frontmatter: { story_points: "3" },
	});
	const jira = normalizeJiraIssue(makeIssue({ customfield_10016: 3 }), {
		fieldMappings: mappings,
	});
	const hash = computeHash(backlog);
	return {
		backlog: snapshot("backlog", backlog, hash),
		jira: snapshot("jira", jira, hash),
		payloads: { backlog, jira },
	};
}

function currentState(
	mappings: FieldMapping[],
	backlogPoints: string,
	jiraPoints: number,
	taskOverrides: Partial<BacklogTask> = {},
) {
	const frontmatter = { story_points: backlogPoints };
	const issue = makeIssue({ customfield_10016: jiraPoints });
	return {
		frontmatter,
		issue,
		backlog: normalizeBacklogTask(
			{ ...task, ...taskOverrides },
			{ fieldMappings: mappings, frontmatter },
		),
		jira: normalizeJiraIssue(issue, { fieldMappings: mappings }),
	};
}

function classify(
	mappings: FieldMapping[],
	backlogPoints: string,
	jiraPoints: number,
	taskOverrides: Partial<BacklogTask> = {},
) {
	const snapshots = syncedAt3(mappings);
	const now = currentState(mappings, backlogPoints, jiraPoints, taskOverrides);
	return classifySyncState(
		computeHash(now.backlog),
		computeHash(now.jira),
		snapshots.backlog,
		snapshots.jira,
		{ backlog: now.backlog, jira: now.jira },
		{ fieldMappings: mappings },
	).state;
}

describe("direction-aware sync state", () => {
	it("is InSync when nothing changed", () => {
		expect(classify([points("both")], "3", 3)).toBe("InSync");
	});

	it("propagates both-way mapped changes from either side", () => {
		expect(classify([points("both")], "5", 3)).toBe("NeedsPush");
		expect(classify([points("both")], "3", 8)).toBe("NeedsPull");
	});

	it("detects a conflict when a both-way field changed on both sides", () => {
		expect(classify([points("both")], "5", 8)).toBe("Conflict");
	});

	it("restores pull-only fields edited in Backlog from Jira", () => {
		expect(classify([points("pull")], "5", 3)).toBe("NeedsPull");
	});

	it("restores push-only fields edited in Jira from Backlog", () => {
		expect(classify([points("push")], "3", 8)).toBe("NeedsPush");
	});

	it("does not treat edits to the other side's fields as a conflict", () => {
		// Backlog edited a pull-only field while Jira changed it too: Jira wins
		expect(classify([points("pull")], "5", 8)).toBe("NeedsPull");
		// Jira edited a push-only field while Backlog changed it too: Backlog wins
		expect(classify([points("push")], "5", 8)).toBe("NeedsPush");
	});

	it("still pushes real Backlog changes made alongside a pull-only edit", () => {
		expect(classify([points("pull")], "5", 3, { title: "Renamed" })).toBe(
			"NeedsPush",
		);
	});

	it("stays InSync when a pushed value reads back from Jira in another form", () => {
		// A user field pushed as @alice is reported back as a display name, so
		// the Jira payload never hashes like the synced Backlog payload
		const owner: FieldMapping = {
			backlog: "frontmatter:owner",
			jira: "customfield_2",
			type: "user",
			direction: "push",
		};
		const mappings = [owner];
		const backlog = normalizeBacklogTask(task, {
			fieldMappings: mappings,
			frontmatter: { owner: "@alice" },
		});
		const jira = normalizeJiraIssue(
			makeIssue({ customfield_2: { displayName: "Alice Smith" } }),
			{ fieldMappings: mappings },
		);
		const synced = computeHash(backlog);
		expect(computeHash(jira)).not.toBe(synced);

		const state = classifySyncState(
			computeHash(backlog),
			computeHash(jira),
			snapshot("backlog", backlog, synced),
			snapshot("jira", jira, synced),
			{ backlog, jira },
			{ fieldMappings: mappings },
		).state;
		expect(state).toBe("InSync");
	});

	it("treats a newly added push-only mapping as a Backlog change", () => {
		const oldBacklog = normalizeBacklogTask(task, { fieldMappings: [] });
		const oldJira = normalizeJiraIssue(makeIssue(), { fieldMappings: [] });
		const hash = computeHash(oldBacklog);
		const mappings = [points("push")];
		const now = currentState(mappings, "5", 3);

		const state = classifySyncState(
			computeHash(now.backlog),
			computeHash(now.jira),
			snapshot("backlog", oldBacklog, hash),
			snapshot("jira", oldJira, hash),
			{ backlog: now.backlog, jira: now.jira },
			{ fieldMappings: mappings },
		).state;
		expect(state).toBe("NeedsPush");
	});

	it("applies direction to priority mappings, which replace the core field", () => {
		const priority: FieldMapping = {
			backlog: "priority",
			jira: "customfield_1",
			type: "option",
			direction: "pull",
			valueMap: { P2: "medium" },
		};
		const mappings = [priority];
		const issue = makeIssue({ customfield_1: { value: "P2" } });
		const base = normalizeBacklogTask(task, {
			fieldMappings: mappings,
			frontmatter: {},
		});
		const jiraBase = normalizeJiraIssue(issue, { fieldMappings: mappings });
		const hash = computeHash(base);
		const edited = normalizeBacklogTask(
			{ ...task, priority: "high" },
			{ fieldMappings: mappings, frontmatter: {} },
		);

		const state = classifySyncState(
			computeHash(edited),
			computeHash(jiraBase),
			snapshot("backlog", base, hash),
			snapshot("jira", jiraBase, hash),
			{ backlog: edited, jira: jiraBase },
			{ fieldMappings: mappings },
		).state;
		expect(state).toBe("NeedsPull");
	});
});

function mappedState(
	mappings: FieldMapping[],
	backlogPoints: string,
	jiraPoints: number,
): MappedFieldState {
	const snapshots = syncedAt3(mappings);
	const now = currentState(mappings, backlogPoints, jiraPoints);
	return {
		current: { backlog: now.backlog, jira: now.jira },
		base: snapshots.payloads,
		frontmatter: now.frontmatter,
		issue: now.issue,
	};
}

describe("detectMappedFieldConflicts", () => {
	it("reports both-way fields changed on both sides with their values", () => {
		const mappings = [points("both")];
		expect(
			detectMappedFieldConflicts(mappedState(mappings, "5", 8), mappings),
		).toEqual([
			{
				field: "frontmatter:story_points",
				backlogValue: "5",
				jiraValue: "8",
				baseValue: "3",
				mapping: mappings[0],
			},
		]);
	});

	it("ignores one-sided changes and identical edits", () => {
		const mappings = [points("both")];
		expect(
			detectMappedFieldConflicts(mappedState(mappings, "5", 3), mappings),
		).toEqual([]);
		expect(
			detectMappedFieldConflicts(mappedState(mappings, "5", 5), mappings),
		).toEqual([]);
	});

	it("never reports one-way mappings as conflicts", () => {
		for (const direction of ["pull", "push"] as const) {
			const mappings = [points(direction)];
			expect(
				detectMappedFieldConflicts(mappedState(mappings, "5", 8), mappings),
			).toEqual([]);
		}
	});
});

describe("planMappedFieldMerge", () => {
	it("uses the chosen value for conflicting both-way fields", () => {
		const mappings = [points("both")];
		const plan = planMappedFieldMerge(
			mappedState(mappings, "5", 8),
			mappings,
			new Map([["frontmatter:story_points", "8"]]),
		);
		expect(plan).toEqual([{ mapping: mappings[0], value: "8" }]);
	});

	it("takes the changed side for one-sided changes", () => {
		const mappings = [points("both")];
		expect(
			planMappedFieldMerge(mappedState(mappings, "5", 3), mappings, new Map()),
		).toEqual([{ mapping: mappings[0], value: "5" }]);
		expect(
			planMappedFieldMerge(mappedState(mappings, "3", 8), mappings, new Map()),
		).toEqual([{ mapping: mappings[0], value: "8" }]);
	});

	it("lets the owner side win for one-way mappings", () => {
		const pull = [points("pull")];
		expect(
			planMappedFieldMerge(mappedState(pull, "5", 8), pull, new Map()),
		).toEqual([{ mapping: pull[0], value: "8" }]);
		const push = [points("push")];
		expect(
			planMappedFieldMerge(mappedState(push, "5", 8), push, new Map()),
		).toEqual([{ mapping: push[0], value: "5" }]);
	});

	it("skips fields that already match", () => {
		const mappings = [points("both")];
		expect(
			planMappedFieldMerge(mappedState(mappings, "5", 5), mappings, new Map()),
		).toEqual([]);
	});
});

describe("parseManualMappedValue", () => {
	it("splits list targets and keeps scalars", () => {
		expect(parseManualMappedValue(" 5 ", points("both"))).toBe("5");
		expect(parseManualMappedValue("", points("both"))).toBeNull();
		expect(
			parseManualMappedValue("a, b", {
				backlog: "labels",
				jira: "components",
				type: "array",
				direction: "both",
			}),
		).toEqual(["a", "b"]);
		expect(
			parseManualMappedValue("1.0, 1.1", {
				backlog: "milestone",
				jira: "fixVersions",
				type: "version",
				direction: "both",
			}),
		).toBe("1.0, 1.1");
	});
});

describe("formatMappedFieldsSection", () => {
	const mappings = [points("both")];

	it("shows Backlog and Jira values and flags differences", () => {
		const lines = formatMappedFieldsSection(
			mappings,
			{ story_points: "5" },
			makeIssue({ customfield_10016: 3 }),
		);
		expect(lines).toContain(
			"frontmatter:story_points ↔ customfield_10016 (number, both)",
		);
		expect(lines).toContain("  Backlog: 5");
		expect(lines).toContain("  Jira:    3  [differs]");
	});

	it("shows matching values without a flag and explains missing Jira data", () => {
		expect(
			formatMappedFieldsSection(
				mappings,
				{ story_points: "3" },
				makeIssue({ customfield_10016: 3 }),
			),
		).toContain("  Jira:    3");
		expect(
			formatMappedFieldsSection(
				mappings,
				{},
				null,
				"(task not linked to Jira)",
			),
		).toEqual([
			"",
			"Mapped Fields:",
			"-".repeat(50),
			"frontmatter:story_points ↔ customfield_10016 (number, both)",
			"  Backlog: (empty)",
			"  Jira:    (task not linked to Jira)",
		]);
	});

	it("prints nothing without mappings", () => {
		expect(formatMappedFieldsSection([], {}, null)).toEqual([]);
	});
});

describe("verifyFieldMappings", () => {
	const scope = { projectKey: "PROJ", issueType: "Task" };
	const known = [{ id: "customfield_10016" }, { id: "customfield_10020" }];

	it("flags pulled system fields MCP Atlassian does not return", () => {
		const results = verifyFieldMappings(
			[
				{ ...points("pull"), jira: "votes" },
				{ ...points("push"), backlog: "frontmatter:v", jira: "votes" },
				{
					...points("pull"),
					backlog: "frontmatter:e",
					jira: "timeoriginalestimate",
				},
				{ ...points("pull"), backlog: "frontmatter:d", jira: "duedate" },
			],
			[{ id: "votes" }, { id: "timeoriginalestimate" }, { id: "duedate" }],
			null,
			scope,
		);
		expect(results.map((r) => r.problems)).toEqual([
			[
				'MCP Atlassian does not return the Jira system field "votes", so it cannot be pulled; remove the mapping or make it "push"',
			],
			[],
			[],
			[],
		]);
	});

	it("flags fields that do not exist", () => {
		const [result] = verifyFieldMappings(
			[{ ...points("pull"), jira: "customfield_99999" }],
			known,
			null,
			scope,
		);
		expect(result.problems).toEqual([
			'Jira field "customfield_99999" does not exist',
		]);
	});

	it("flags written fields that are not on the issue type's screen", () => {
		const results = verifyFieldMappings(
			[points("both"), { ...points("pull"), backlog: "frontmatter:other" }],
			known,
			new Set(["summary"]),
			scope,
		);
		expect(results[0].problems).toEqual([
			'Jira field "customfield_10016" is not editable for PROJ / Task (not on the issue type\'s screen)',
		]);
		// pull-only mappings only need to exist
		expect(results[1].problems).toEqual([]);
	});

	it("passes editable fields", () => {
		const [result] = verifyFieldMappings(
			[points("push")],
			known,
			new Set(["customfield_10016"]),
			scope,
		);
		expect(result.problems).toEqual([]);
	});
});

describe("recordSyncedSnapshots", () => {
	function fakeStore() {
		const snapshots: Record<string, Snapshot> = {};
		return {
			snapshots,
			setSnapshot: (
				backlogId: string,
				side: "backlog" | "jira",
				hash: string,
				payload: unknown,
			) => {
				snapshots[side] = {
					backlogId,
					side,
					hash,
					payload: JSON.stringify(payload),
					updatedAt: "",
				};
			},
			updateSyncState: () => {},
		};
	}

	function classifyAfter(
		mappings: FieldMapping[],
		source: "backlog" | "jira",
		backlogPoints: string,
		jiraPoints: number,
	) {
		const store = fakeStore();
		const now = currentState(mappings, backlogPoints, jiraPoints);
		recordSyncedSnapshots(
			store,
			"task-1",
			{ backlog: now.backlog, jira: now.jira },
			source,
			mappings,
		);
		return classifySyncState(
			computeHash(now.backlog),
			computeHash(now.jira),
			store.snapshots.backlog,
			store.snapshots.jira,
			{ backlog: now.backlog, jira: now.jira },
			{ fieldMappings: mappings },
		).state;
	}

	it("stores both sides with the source hash when everything was written", () => {
		const store = fakeStore();
		const mappings = [points("both")];
		const now = currentState(mappings, "5", 5);
		recordSyncedSnapshots(
			store,
			"task-1",
			{ backlog: now.backlog, jira: now.jira },
			"backlog",
			mappings,
		);
		expect(store.snapshots.backlog.hash).toBe(computeHash(now.backlog));
		expect(store.snapshots.jira.hash).toBe(computeHash(now.backlog));
		expect(classifyAfter(mappings, "backlog", "5", 5)).toBe("InSync");
	});

	it("restores a pull-only field the push could not write", () => {
		expect(classifyAfter([points("pull")], "backlog", "5", 3)).toBe(
			"NeedsPull",
		);
	});

	it("restores a push-only field the pull could not write", () => {
		expect(classifyAfter([points("push")], "jira", "5", 3)).toBe("NeedsPush");
	});
});
