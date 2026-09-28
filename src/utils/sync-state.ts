import type { Snapshot } from "../state/store.ts";
import { logger } from "./logger.ts";
import { type NormalizedPayload, computeHash } from "./normalizer.ts";

/**
 * Sync state classification
 */
export type SyncState =
	| "InSync" // Both sides match the last snapshot
	| "NeedsPush" // Backlog changed, Jira unchanged
	| "NeedsPull" // Jira changed, Backlog unchanged
	| "Conflict" // Both sides changed
	| "Unknown"; // No snapshot exists yet

export interface SyncStateResult {
	state: SyncState;
	backlogHash: string;
	jiraHash: string;
	baseBacklogHash?: string;
	baseJiraHash?: string;
	changedFields?: string[];
}

/**
 * Classify the sync state using 3-way merge logic
 *
 * Given current hashes and base snapshots, determines what action is needed:
 * - InSync: No changes on either side
 * - NeedsPush: Backlog changed, Jira didn't
 * - NeedsPull: Jira changed, Backlog didn't
 * - Conflict: Both changed
 * - Unknown: No baseline exists
 */
export function classifySyncState(
	currentBacklogHash: string,
	currentJiraHash: string,
	backlogSnapshot: Snapshot | null,
	jiraSnapshot: Snapshot | null,
	currentPayloads?: { backlog: NormalizedPayload; jira: NormalizedPayload },
): SyncStateResult {
	logger.debug(
		{
			currentBacklogHash,
			currentJiraHash,
			hasBacklogSnapshot: !!backlogSnapshot,
			hasJiraSnapshot: !!jiraSnapshot,
		},
		"Classifying sync state",
	);

	// If no snapshots exist, we can't determine state
	if (!backlogSnapshot || !jiraSnapshot) {
		return {
			state: "Unknown",
			backlogHash: currentBacklogHash,
			jiraHash: currentJiraHash,
		};
	}

	const baseBacklogHash = backlogSnapshot.hash;
	const baseJiraHash = jiraSnapshot.hash;

	// Check if either side changed
	let backlogChanged = currentBacklogHash !== baseBacklogHash;
	let jiraChanged = currentJiraHash !== baseJiraHash;

	// When the set of mapped fields differs from the snapshot (mappings were
	// added or removed), compare only the fields both know about so that the
	// config change itself isn't seen as a change on both sides.
	if (currentPayloads) {
		const adjusted = detectChangesAcrossMappingChange(
			currentPayloads,
			backlogSnapshot,
			jiraSnapshot,
		);
		if (adjusted) {
			backlogChanged = adjusted.backlogChanged;
			jiraChanged = adjusted.jiraChanged;
		}
	}

	logger.debug(
		{
			backlogChanged,
			jiraChanged,
			baseBacklogHash,
			baseJiraHash,
		},
		"Change detection",
	);

	// Determine state
	let state: SyncState;
	if (!backlogChanged && !jiraChanged) {
		state = "InSync";
	} else if (backlogChanged && !jiraChanged) {
		state = "NeedsPush";
	} else if (!backlogChanged && jiraChanged) {
		state = "NeedsPull";
	} else {
		// Both changed
		state = "Conflict";
	}

	return {
		state,
		backlogHash: currentBacklogHash,
		jiraHash: currentJiraHash,
		baseBacklogHash,
		baseJiraHash,
	};
}

function mappedFieldKeys(payload: Partial<NormalizedPayload> | null): string[] {
	return Object.keys(payload?.mappedFields ?? {}).sort();
}

function parseSnapshotPayload(
	snapshot: Snapshot,
): Partial<NormalizedPayload> | null {
	try {
		return JSON.parse(snapshot.payload) as Partial<NormalizedPayload>;
	} catch {
		return null;
	}
}

function restrictMappedFields(
	payload: NormalizedPayload,
	keys: string[],
): NormalizedPayload {
	const mappedFields: Record<string, string> = {};
	for (const key of keys) {
		mappedFields[key] = payload.mappedFields?.[key] ?? "";
	}
	return { ...payload, mappedFields };
}

/**
 * Change detection for when field mappings were added or removed since the
 * last snapshot. Returns null when the mapped field set is unchanged.
 *
 * - Fields known to both the snapshot and the current config are compared as usual
 * - Newly mapped fields count as a Jira-side change when the Backlog value
 *   doesn't already match Jira (Jira is the source for pulled mappings)
 * - Fields no longer mapped are ignored
 */
export function detectChangesAcrossMappingChange(
	current: { backlog: NormalizedPayload; jira: NormalizedPayload },
	backlogSnapshot: Snapshot,
	jiraSnapshot: Snapshot,
): { backlogChanged: boolean; jiraChanged: boolean } | null {
	const currentKeys = mappedFieldKeys(current.jira);
	const baseBacklogPayload = parseSnapshotPayload(backlogSnapshot);
	const baseJiraPayload = parseSnapshotPayload(jiraSnapshot);
	const baseKeys = mappedFieldKeys(baseJiraPayload);

	if (JSON.stringify(currentKeys) === JSON.stringify(baseKeys)) {
		return null;
	}

	const commonKeys = currentKeys.filter((k) => baseKeys.includes(k));

	// The stored hash is authoritative when the snapshot had exactly the
	// common keys; otherwise recompute it from the stored payload.
	const baseHash = (
		snapshot: Snapshot,
		payload: Partial<NormalizedPayload> | null,
	): string => {
		if (
			!payload ||
			JSON.stringify(mappedFieldKeys(payload)) === JSON.stringify(commonKeys)
		) {
			return snapshot.hash;
		}
		return computeHash(
			restrictMappedFields(payload as NormalizedPayload, commonKeys),
		);
	};

	const backlogChanged =
		computeHash(restrictMappedFields(current.backlog, commonKeys)) !==
		baseHash(backlogSnapshot, baseBacklogPayload);
	let jiraChanged =
		computeHash(restrictMappedFields(current.jira, commonKeys)) !==
		baseHash(jiraSnapshot, baseJiraPayload);

	const newKeys = currentKeys.filter((k) => !baseKeys.includes(k));
	for (const key of newKeys) {
		if (
			(current.backlog.mappedFields?.[key] ?? "") !==
			(current.jira.mappedFields?.[key] ?? "")
		) {
			jiraChanged = true;
		}
	}

	logger.debug(
		{ currentKeys, baseKeys, backlogChanged, jiraChanged },
		"Mapped field set changed since snapshot",
	);

	return { backlogChanged, jiraChanged };
}

/**
 * Determine if a conflict can be auto-resolved
 * Returns the resolution strategy if possible, null otherwise
 */
export function canAutoResolveConflict(
	backlogPayload: unknown,
	jiraPayload: unknown,
	baseBacklogPayload: unknown,
	baseJiraPayload: unknown,
): { canResolve: boolean; strategy?: "use_backlog" | "use_jira" | "merge" } {
	// Simple heuristics for auto-resolution:
	// 1. If changes don't overlap fields, can merge
	// 2. If one side has more complete data, prefer it
	// 3. Otherwise, requires manual resolution

	// For now, be conservative and require manual resolution
	// This can be enhanced later with field-level merge logic

	logger.debug(
		"Auto-resolution not yet implemented, defaulting to manual resolution",
	);

	return { canResolve: false };
}
