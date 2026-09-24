import type { MemoryType } from "../store/index.js";
import type { MemoryLabel } from "./labels.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
  /** Candidate-specific canonical entity ids emitted by batched BuJo capture. */
  readonly entityIds?: readonly string[];
  readonly labels?: readonly MemoryLabel[];
}

export const MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS = 160;
export const MAX_RECONCILIATION_TEXT_CODE_POINTS = 280;

/**
 * Clamp model-authored capture text to the bounded store contract.
 *
 * The 160-code-point cap is a host contract, not a model obligation: an
 * over-long sentence is trimmed here rather than rejected, because rejecting it
 * discards every other memory submitted in the same response. This restores the
 * tolerance the pre-structured-output capture path applied via
 * `normalizeCandidateText`. Only length is forgiving — malformed or unsafe text
 * still fails its caller's strict validation.
 */
export function clampCaptureText(value: string): string {
  // Slice by code point so an astral pair is never split into lone surrogates.
  return Array.from(value)
    .slice(0, MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS)
    .join("")
    .trim();
}

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
