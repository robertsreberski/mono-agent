import type { MemoryType } from "../store/index.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
  /** Candidate-specific canonical entity ids emitted by batched BuJo capture. */
  readonly entityIds?: readonly string[];
}

export const MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS = 160;
export const MAX_RECONCILIATION_TEXT_CODE_POINTS = 280;

/** Normalize legacy reconciliation text to its bounded one-line representation. */
export function normalizeReconciliationText(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\p{Cs}/gu, "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/<!--mem/gu, "")
    .trim();
  const text = Array.from(normalized).slice(0, MAX_RECONCILIATION_TEXT_CODE_POINTS).join("");
  return text.length === 0 ? undefined : text;
}
