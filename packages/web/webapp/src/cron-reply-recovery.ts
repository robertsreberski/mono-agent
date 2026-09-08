import type { CronReplySnapshotKind } from "./types";

const STORAGE_KEY = "mono-agent:web:cron-reply-recovery:v1";
export const CRON_REPLY_RECOVERY_PERSISTED_LIMIT = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CronReplyRecoveryReference {
  readonly sourceId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly snapshotKind: CronReplySnapshotKind;
}

const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const referenceKey = (reference: Pick<CronReplyRecoveryReference, "sourceId" | "jobId" | "runId">): string =>
  JSON.stringify([reference.sourceId, reference.jobId, reference.runId]);

// sessionStorage makes unresolved operations available after a reload, but it
// is quota-limited and may throw or be unavailable. This page-lifetime registry
// is therefore authoritative while the current JavaScript realm lives. It has
// no capacity eviction: dropping an unresolved id can turn an explicit retry
// into a second canonical conversation after the server already completed it.
const memoryReferences = new Map<string, CronReplyRecoveryReference>();
const forgottenOperationIds = new Set<string>();

const parseReference = (value: unknown): CronReplyRecoveryReference | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!bounded(record.sourceId, 256)
    || !bounded(record.jobId, 256)
    || !bounded(record.runId, 256)
    || typeof record.operationId !== "string"
    || !UUID.test(record.operationId)
    || (record.snapshotKind !== "summary" && record.snapshotKind !== "detail")) return undefined;
  return {
    sourceId: record.sourceId,
    jobId: record.jobId,
    runId: record.runId,
    operationId: record.operationId,
    snapshotKind: record.snapshotKind,
  };
};

const readPersistedReferences = (): readonly CronReplyRecoveryReference[] => {
  try {
    const decoded = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(decoded)) return [];
    return decoded.slice(0, CRON_REPLY_RECOVERY_PERSISTED_LIMIT).flatMap((item) => {
      const parsed = parseReference(item);
      return parsed === undefined ? [] : [parsed];
    });
  } catch {
    return [];
  }
};

const write = (references: readonly CronReplyRecoveryReference[]): void => {
  try {
    if (references.length === 0) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(references.slice(0, CRON_REPLY_RECOVERY_PERSISTED_LIMIT)),
    );
  } catch {
    // Persistence is best effort. memoryReferences must remain authoritative
    // for this page even when this write is refused.
  }
};

const referencesNewestFirst = (): CronReplyRecoveryReference[] =>
  [...memoryReferences.values()].reverse();

export const readCronReplyRecoveryReferences = (): readonly CronReplyRecoveryReference[] => {
  // Persisted references are newest-first. Insert them oldest-first so the Map
  // retains the same ordering when converted back for a bounded write.
  for (const reference of [...readPersistedReferences()].reverse()) {
    if (forgottenOperationIds.has(reference.operationId)) continue;
    const key = referenceKey(reference);
    if (!memoryReferences.has(key)) memoryReferences.set(key, reference);
  }
  return referencesNewestFirst();
};

export const findCronReplyRecoveryReference = (
  sourceId: string,
  jobId: string,
  runId: string,
): CronReplyRecoveryReference | undefined => readCronReplyRecoveryReferences().find(
  (reference) => reference.sourceId === sourceId
    && reference.jobId === jobId
    && reference.runId === runId,
);

export const rememberCronReplyRecoveryReference = (reference: CronReplyRecoveryReference): void => {
  readCronReplyRecoveryReferences();
  const key = referenceKey(reference);
  const replaced = memoryReferences.get(key);
  if (replaced !== undefined && replaced.operationId !== reference.operationId) {
    forgottenOperationIds.add(replaced.operationId);
  }
  forgottenOperationIds.delete(reference.operationId);
  memoryReferences.delete(key);
  memoryReferences.set(key, reference);
  write(referencesNewestFirst());
};

export const forgetCronReplyRecoveryReference = (operationId: string): void => {
  readCronReplyRecoveryReferences();
  forgottenOperationIds.add(operationId);
  for (const [key, reference] of memoryReferences) {
    if (reference.operationId === operationId) memoryReferences.delete(key);
  }
  write(referencesNewestFirst());
};

/** Test isolation for the module-owned page-lifetime registry. */
export const resetCronReplyRecoveryMemory = (): void => {
  memoryReferences.clear();
  forgottenOperationIds.clear();
};
