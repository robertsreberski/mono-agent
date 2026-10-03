import type { ThreadSummary } from "./types";

/** Thread snapshots are JSON from the server; ignore malformed transient hints. */
export const runningManualCompaction = (thread: ThreadSummary | null | undefined): boolean => {
  const value: unknown = thread?.compaction;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "running" && record.trigger === "manual"
    && typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt));
};
