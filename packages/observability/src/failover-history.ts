import { isRecord, stringField } from "./guards.js";
import type { FailoverAttempt } from "./types.js";

function failoverModel(model: unknown): string | undefined {
  if (typeof model === "string" && model.trim().length > 0) return model.trim();
  if (isRecord(model)) return stringField(model, "reference") ?? stringField(model, "model");
  return undefined;
}

function positiveIntegerField(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Canonicalize the router's loosely typed failover history into the stable shape
 * persisted in local summaries. Idempotent on already-normalized data.
 */
export function normalizeFailoverHistory(value: unknown): FailoverAttempt[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const attempts: FailoverAttempt[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const model = failoverModel(entry.model);
    const failureKind = stringField(entry, "failureKind");
    const subkind = stringField(entry, "retryableSubkind") ?? stringField(entry, "subkind");
    const requestId = stringField(entry, "requestId");
    const retryIndex = positiveIntegerField(entry, "retryIndex");
    if (model === undefined && failureKind === undefined && subkind === undefined && requestId === undefined) continue;
    attempts.push({
      ...(model === undefined ? {} : { model }),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(subkind === undefined ? {} : { subkind }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryIndex === undefined ? {} : { retryIndex }),
    });
  }
  return attempts.length === 0 ? undefined : attempts;
}
