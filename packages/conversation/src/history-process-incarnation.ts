import { HISTORY_PROCESS_INCARNATION_SCHEMA, readProcessIncarnation, type ProcessIncarnation } from "./process-incarnation.js";

export interface HistoryProcessIncarnation extends Omit<ProcessIncarnation, "schema"> {
  readonly schema: typeof HISTORY_PROCESS_INCARNATION_SCHEMA;
}

/** Stable history evidence. Unavailable (including timeout) is not death proof. */
export async function readHistoryProcessIncarnation(pid: number): Promise<HistoryProcessIncarnation | undefined> {
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
    return await readProcessIncarnation(pid, HISTORY_PROCESS_INCARNATION_SCHEMA) as HistoryProcessIncarnation | undefined;
  } catch { return undefined; }
}

/** v1/unknown persisted identities must never be compared with stable v2 evidence. */
export function historyProcessIncarnationFromJson(value: unknown): HistoryProcessIncarnation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schema === HISTORY_PROCESS_INCARNATION_SCHEMA
    && typeof record.bootSessionId === "string" && record.bootSessionId.length > 0
    && typeof record.processStartId === "string" && record.processStartId.length > 0
    ? record as unknown as HistoryProcessIncarnation : undefined;
}

