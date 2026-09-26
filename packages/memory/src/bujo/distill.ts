import type { MemoryType } from "../store/index.js";
import type { MemoryLabel } from "./labels.js";
import type { CaptureSource } from "./capture-labels.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
  /** Candidate-specific canonical entity ids emitted by batched BuJo capture. */
  readonly entityIds?: readonly string[];
  readonly labels?: readonly MemoryLabel[];
  /** Host-bounded origin of the claim in its captured turn, when known. */
  readonly source?: CaptureSource;
}

export const MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS = 160;
export const MAX_RECONCILIATION_TEXT_CODE_POINTS = MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS;

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
  const points = Array.from(value);
  if (points.length <= MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS) return value;
  const prefix = points.slice(0, MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS).join("");
  // Prefer the last complete sentence; never cut a multi-fact answer midway
  // through its next fact. Single unpunctuated sentences retain the old cap.
  const end = sentenceEnds(prefix).filter((index) => index >= 24).at(-1);
  if (end !== undefined) return prefix.slice(0, end + 1).trim();
  const clause = [...prefix.matchAll(/[,;:—](?=\s)/gu)].filter((match) => match.index! >= 40).at(-1);
  if (clause !== undefined) return prefix.slice(0, clause.index!).trim();
  const wordEnd = prefix.lastIndexOf(" ");
  return (wordEnd >= 40 ? prefix.slice(0, wordEnd) : prefix).trim();
}

/** Sentence boundaries shared by extraction and length clamping. */
export function splitCaptureSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const end of sentenceEnds(text)) {
    const sentence = text.slice(start, end + 1).trim();
    if (sentence) parts.push(sentence);
    start = end + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [text];
}

function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(/[.!?](?=\s|$)/gu)) {
    const end = match.index!;
    // Length bound only: a period after a single letter is an initial.
    if (/(?:^|[^\p{L}])\p{L}\.$/u.test(text.slice(Math.max(0, end - 2), end + 1))) continue;
    ends.push(end);
  }
  return ends;
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
  const text = clampCaptureText(normalized);
  return text.length === 0 ? undefined : text;
}
