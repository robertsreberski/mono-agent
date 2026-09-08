import type { CronReplySnapshotKind } from "./types";

const STORAGE_KEY = "mono-agent:web:cron-reply-recovery:v1";
const MAX_REFERENCES = 32;
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

export const readCronReplyRecoveryReferences = (): readonly CronReplyRecoveryReference[] => {
  try {
    const decoded = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(decoded)) return [];
    return decoded.slice(0, MAX_REFERENCES).flatMap((item) => {
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
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(references.slice(0, MAX_REFERENCES)));
  } catch {
    // Recovery is best-effort browser state; the durable server operation remains authoritative.
  }
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
  write([
    reference,
    ...readCronReplyRecoveryReferences().filter((candidate) =>
      candidate.operationId !== reference.operationId
      && !(candidate.sourceId === reference.sourceId
        && candidate.jobId === reference.jobId
        && candidate.runId === reference.runId)),
  ]);
};

export const forgetCronReplyRecoveryReference = (operationId: string): void => {
  write(readCronReplyRecoveryReferences().filter((reference) => reference.operationId !== operationId));
};
