export interface Mapping {
	backlogId: string;
	jiraKey: string;
	createdAt: string;
	updatedAt: string;
}

export interface Snapshot {
	backlogId: string;
	side: "backlog" | "jira";
	hash: string;
	payload: string;
	updatedAt: string;
}

export interface SyncState {
	backlogId: string;
	lastSyncAt: string | null;
	conflictState: string | null;
	strategy: string | null;
}

export interface OpLog {
	id: number;
	ts: string;
	op: string;
	backlogId: string | null;
	jiraKey: string | null;
	outcome: string;
	details: string | null;
}
