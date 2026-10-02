import { assertMemoryLabelDate } from "./labels.js";

/** A timezone-bearing instant must not normalize impossible civil components. */
export function parseRecordingInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parts = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (parts === null || Number(parts[1]) > 23 || Number(parts[2]) > 59 || Number(parts[3]) > 59
    || (parts[4] !== undefined && (Number(parts[4]) > 23 || Number(parts[5]) > 59))) return undefined;
  try { assertMemoryLabelDate(value.slice(0, 10)); } catch { return undefined; }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

/** Extraction and public/retained reconciliation share the canonical due= contract. */
export function assertIntentionEnd(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("intent_end_invalid");
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    try { assertMemoryLabelDate(value); return; } catch { /* Stable code only. */ }
  } else if (/^\d{4}-\d{2}-\d{2}T23:59:59\.999(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && parseRecordingInstant(value) !== undefined) return;
  throw new Error("intent_end_invalid");
}

export function assertIntentionProposal(candidate: { readonly type?: unknown; readonly intentState?: unknown; readonly validTo?: unknown }): void {
  if (candidate.intentState !== undefined && (candidate.type !== "note" || typeof candidate.intentState !== "string"
    || !["planned", "pending", "done", "abandoned"].includes(candidate.intentState))) throw new Error("intent_proposal_invalid");
  if (candidate.validTo !== undefined) {
    if (candidate.intentState === undefined) throw new Error("intent_end_invalid");
    assertIntentionEnd(candidate.validTo);
  }
}
