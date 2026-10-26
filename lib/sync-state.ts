export type SyncState = {
  phase: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  kind: "directory" | "members";
  message: string;
  updatedAt: string;
};
export const syncStateKey = (queueName: string, sessionId: string) => `${queueName}:session-sync:${sessionId}`;
export const groupSyncStateKey = (queueName: string, groupId: string) => `${queueName}:group-sync:${groupId}`;
