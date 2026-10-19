import { describe, expect, it } from "bun:test";
import type { Snapshot } from "../state/store.ts";
import { type NormalizedPayload, computeHash } from "./normalizer.ts";
import { classifySyncState } from "./sync-state.ts";

describe("sync-state", () => {
	describe("classifySyncState", () => {
		it("should return Unknown when no snapshots exist", () => {
			const result = classifySyncState("hash1", "hash2", null, null);

			expect(result.state).toBe("Unknown");
			expect(result.backlogHash).toBe("hash1");
			expect(result.jiraHash).toBe("hash2");
		});

		it("should return Unknown when only backlog snapshot exists", () => {
			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: "baseHash",
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState("hash1", "hash2", backlogSnapshot, null);

			expect(result.state).toBe("Unknown");
		});

		it("should return Unknown when only jira snapshot exists", () => {
			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: "baseHash",
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState("hash1", "hash2", null, jiraSnapshot);

			expect(result.state).toBe("Unknown");
		});

		it("should return InSync when both sides match snapshots", () => {
			const baseHash = "sameHash";

			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState(
				baseHash,
				baseHash,
				backlogSnapshot,
				jiraSnapshot,
			);

			expect(result.state).toBe("InSync");
			expect(result.backlogHash).toBe(baseHash);
			expect(result.jiraHash).toBe(baseHash);
			expect(result.baseBacklogHash).toBe(baseHash);
			expect(result.baseJiraHash).toBe(baseHash);
		});

		it("should return NeedsPush when only Backlog changed", () => {
			const baseHash = "originalHash";
			const newBacklogHash = "changedBacklogHash";

			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState(
				newBacklogHash,
				baseHash,
				backlogSnapshot,
				jiraSnapshot,
			);

			expect(result.state).toBe("NeedsPush");
			expect(result.backlogHash).toBe(newBacklogHash);
			expect(result.jiraHash).toBe(baseHash);
			expect(result.baseBacklogHash).toBe(baseHash);
			expect(result.baseJiraHash).toBe(baseHash);
		});

		it("should return NeedsPull when only Jira changed", () => {
			const baseHash = "originalHash";
			const newJiraHash = "changedJiraHash";

			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState(
				baseHash,
				newJiraHash,
				backlogSnapshot,
				jiraSnapshot,
			);

			expect(result.state).toBe("NeedsPull");
			expect(result.backlogHash).toBe(baseHash);
			expect(result.jiraHash).toBe(newJiraHash);
			expect(result.baseBacklogHash).toBe(baseHash);
			expect(result.baseJiraHash).toBe(baseHash);
		});

		it("should return Conflict when both sides changed", () => {
			const baseHash = "originalHash";
			const newBacklogHash = "changedBacklogHash";
			const newJiraHash = "changedJiraHash";

			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: baseHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const result = classifySyncState(
				newBacklogHash,
				newJiraHash,
				backlogSnapshot,
				jiraSnapshot,
			);

			expect(result.state).toBe("Conflict");
			expect(result.backlogHash).toBe(newBacklogHash);
			expect(result.jiraHash).toBe(newJiraHash);
			expect(result.baseBacklogHash).toBe(baseHash);
			expect(result.baseJiraHash).toBe(baseHash);
		});

		it("should handle different base hashes for backlog and jira", () => {
			const baseBacklogHash = "baseBacklog";
			const baseJiraHash = "baseJira";
			const currentHash = "current";

			const backlogSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "backlog",
				hash: baseBacklogHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			const jiraSnapshot: Snapshot = {
				backlogId: "task-1",
				side: "jira",
				hash: baseJiraHash,
				payload: "{}",
				updatedAt: new Date().toISOString(),
			};

			// Both changed from different bases
			const result = classifySyncState(
				currentHash,
				currentHash,
				backlogSnapshot,
				jiraSnapshot,
			);

			expect(result.state).toBe("Conflict");
			expect(result.baseBacklogHash).toBe(baseBacklogHash);
			expect(result.baseJiraHash).toBe(baseJiraHash);
		});
	});
});

describe("classifySyncState across the sides", () => {
	const payload = (
		changes: Partial<NormalizedPayload> = {},
	): NormalizedPayload => ({
		title: "Fix login",
		description: "Steps:\n\n1. Open the page",
		status: "todo",
		priority: "high",
		labels: ["backend"],
		acceptanceCriteria: [{ text: "Users can log in", checked: false }],
		...changes,
	});
	const snapshot = (
		side: "backlog" | "jira",
		stored: NormalizedPayload,
		hash = computeHash(stored),
	): Snapshot => ({
		backlogId: "task-1",
		side,
		hash,
		payload: JSON.stringify(stored),
		updatedAt: new Date().toISOString(),
	});
	const classify = (
		current: { backlog: NormalizedPayload; jira: NormalizedPayload },
		base: { backlog: NormalizedPayload; jira: NormalizedPayload },
		backlogJiraDescription?: string,
	) =>
		classifySyncState(
			computeHash(current.backlog),
			computeHash(current.jira),
			snapshot("backlog", base.backlog),
			snapshot("jira", base.jira),
			current,
			{ fieldMappings: [], sprintMapping: null, backlogJiraDescription },
		);

	it("is InSync with a rebaseline when the payloads match but the snapshots are stale", () => {
		// A parser fix: the Backlog snapshot holds the truncated description
		const current = { backlog: payload(), jira: payload() };
		const result = classify(current, {
			backlog: payload({ description: "Steps:" }),
			jira: payload(),
		});

		expect(result.state).toBe("InSync");
		expect(result.rebaseline).toBe(true);
	});

	it("is InSync with a rebaseline when both sides made the same change", () => {
		const current = {
			backlog: payload({ status: "done" }),
			jira: payload({ status: "done" }),
		};
		const result = classify(current, { backlog: payload(), jira: payload() });

		expect(result.state).toBe("InSync");
		expect(result.rebaseline).toBe(true);
	});

	it("needs no rebaseline when the snapshots are current", () => {
		const current = { backlog: payload(), jira: payload() };
		const result = classify(current, current);

		expect(result.state).toBe("InSync");
		expect(result.rebaseline).toBeUndefined();
	});

	it("compares descriptions that differ only in whitespace as equal", () => {
		const current = {
			backlog: payload({ description: "Steps:  \n\n\n\n1. Open the page" }),
			jira: payload({ description: "Steps:\r\n\r\n1. Open the page" }),
		};
		const result = classify(current, {
			backlog: payload({ description: "Steps:" }),
			jira: payload(),
		});

		expect(result.state).toBe("InSync");
		expect(result.rebaseline).toBe(true);
	});

	it("keeps descriptions that differ in content, including Markdown conversions, as changes", () => {
		for (const jiraDescription of [
			"Steps:\n\n1. Open the login page",
			"Steps:\n\n# Open the page",
		]) {
			const current = {
				backlog: payload(),
				jira: payload({ description: jiraDescription }),
			};
			const result = classify(current, {
				backlog: payload({ description: "Steps:" }),
				jira: payload(),
			});

			expect(result.state).toBe("Conflict");
			expect(result.rebaseline).toBeUndefined();
		}
	});

	it("compares the description push would write with the Jira description", () => {
		const jiraDescription =
			"Steps:\n\n1. Open the page\n\nAcceptance Criteria:\n- [ ] Users can log in";
		const current = {
			backlog: payload(),
			jira: payload({ description: jiraDescription }),
		};
		const base = {
			backlog: payload({ description: "Steps:" }),
			jira: payload(),
		};

		expect(classify(current, base, `${jiraDescription}\n`).state).toBe(
			"InSync",
		);
		expect(
			classify(
				current,
				base,
				`${jiraDescription}\n\nImplementation Plan:\n1. Fix`,
			).state,
		).toBe("Conflict");
	});

	it("leaves a real one-sided change as it was classified", () => {
		const base = { backlog: payload(), jira: payload() };

		expect(
			classify(
				{ backlog: payload({ title: "Fix logins" }), jira: payload() },
				base,
			).state,
		).toBe("NeedsPush");
		expect(
			classify({ backlog: payload(), jira: payload({ status: "done" }) }, base)
				.state,
		).toBe("NeedsPull");
	});

	it("compares the parent and mapped fields across the sides", () => {
		const linked = (parent: string, milestone: string) =>
			payload({ parent, mappedFields: { milestone } });
		const base = {
			backlog: linked("PROJ-1", "Sprint 1"),
			jira: linked("PROJ-1", "Sprint 1"),
		};

		const same = classify(
			{
				backlog: linked("PROJ-2", "Sprint 2"),
				jira: linked("PROJ-2", "Sprint 2"),
			},
			base,
		);
		expect(same.state).toBe("InSync");
		expect(same.rebaseline).toBe(true);

		expect(
			classify(
				{
					backlog: linked("PROJ-2", "Sprint 2"),
					jira: linked("PROJ-3", "Sprint 2"),
				},
				base,
			).state,
		).toBe("Conflict");
		expect(
			classify(
				{
					backlog: linked("PROJ-2", "Sprint 2"),
					jira: linked("PROJ-2", "Sprint 3"),
				},
				base,
			).state,
		).toBe("Conflict");
	});

	it("leaves tasks without snapshots Unknown", () => {
		const result = classifySyncState(
			computeHash(payload()),
			computeHash(payload()),
			null,
			null,
			{ backlog: payload(), jira: payload() },
		);

		expect(result.state).toBe("Unknown");
	});
});
