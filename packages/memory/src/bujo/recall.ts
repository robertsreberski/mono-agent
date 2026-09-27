import type { MemoryBlock } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "../store/index.js";

import { MARKER_FOR } from "./grammar.js";

/** Calibrated score reference shared with explicit recall's insufficiency status. */
export const AUTO_RECALL_MIN_SCORE = 0.65;
/** Additional hits must remain close to the strongest result; raw embedding scores are not calibrated probabilities. */
export const AUTO_RECALL_MAX_BYTES = 8_000;
/** One lookup can satisfy automatic context and the explicit tool's maximum request. */
export const AUTO_RECALL_BACKEND_HITS = 50;

/**
 * Turn-start "possibly relevant" block: at most this many lines. The main model
 * judges relevance; selection only bounds the block. Measured on real nomic
 * stores (English, Polish, Spanish probes); see docs/memory/capture-and-recall.md.
 */
export const POSSIBLY_RELEVANT_MAX_LINES = 3;
/** Hybrid-score floor for the strongest line; below it nothing is shown. */
export const POSSIBLY_RELEVANT_MIN_SCORE = 0.62;
/** Further lines must score within this distance of the strongest line. */
export const POSSIBLY_RELEVANT_WINDOW = 0.04;
/** Byte budget for the whole possibly-relevant block, heading included. */
export const POSSIBLY_RELEVANT_MAX_BYTES = 1_500;

/**
 * Language-neutral selection for the possibly-relevant block: scores only, no
 * query grammar. The strongest hit must reach the floor; further hits must stay
 * within the window below it. Identical texts are shown once, current lines are
 * preferred over superseded or ended ones, and the chosen lines are returned
 * oldest first so the latest statement reads last. Input is the backend's
 * relevance-sorted hybrid result; callers drop lexical-only results.
 */
export function selectPossiblyRelevantRecallHits<T extends {
  readonly score: number;
  readonly record: PossiblyRelevantRecord;
}>(
  hits: readonly T[],
  options: { readonly maxLines?: number; readonly asOf?: string } = {},
): readonly T[] {
  const top = hits[0]?.score;
  if (top === undefined || !Number.isFinite(top) || top < POSSIBLY_RELEVANT_MIN_SCORE) return [];
  const maxLines = Math.max(1, Math.min(options.maxLines ?? POSSIBLY_RELEVANT_MAX_LINES, POSSIBLY_RELEVANT_MAX_LINES));
  const window: T[] = [];
  for (const hit of hits) {
    if (hit.score < top - POSSIBLY_RELEVANT_WINDOW) break;
    window.push(hit);
  }
  const current = window.filter((hit) => recallLineStatus(hit.record, options.asOf) === "current");
  const other = window.filter((hit) => recallLineStatus(hit.record, options.asOf) !== "current");
  // Deduplicate identical text after currency preference, so a current copy wins.
  const seen = new Set<string>();
  const unique = [...current, ...other].filter((hit) => {
    const key = hit.record.text.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, maxLines)
    .sort((a, b) => (a.record.createdAt ?? "").localeCompare(b.record.createdAt ?? ""));
}

export interface PossiblyRelevantRecord {
  readonly text: string;
  readonly createdAt?: string;
  readonly status?: string;
  readonly validTo?: string;
  readonly supersededBy?: string;
}

/** Reader-facing currency of a recalled line on `asOf` (YYYY-MM-DD). */
export function recallLineStatus(record: PossiblyRelevantRecord, asOf?: string): "current" | "superseded" | "ended" {
  if (record.supersededBy !== undefined || record.status === "invalidated" || record.status === "dropped") return "superseded";
  if (record.validTo !== undefined && asOf !== undefined && record.validTo.slice(0, 10) < asOf) return "ended";
  return "current";
}

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number; trackAccess?: boolean; abortSignal?: AbortSignal } = {},
): Promise<MemoryBlock | undefined> {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? POSSIBLY_RELEVANT_MAX_BYTES, POSSIBLY_RELEVANT_MAX_BYTES));
  const topK = Math.max(1, Math.min(options.topK ?? POSSIBLY_RELEVANT_MAX_LINES, POSSIBLY_RELEVANT_MAX_LINES));
  const outcome = await db.recallWithOutcome(query, {
    topK: Math.max(topK, 8),
    trackAccess: false,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  options.abortSignal?.throwIfAborted();
  // The standalone store has no host identity signal. Never inject lexical-only
  // results; semantic scores alone bound a possibly-relevant, not factual, block.
  const hits = outcome.retrievalMode === "hybrid" && outcome.degradation === undefined
    ? selectPossiblyRelevantRecallHits(outcome.hits, { maxLines: topK }) : [];
  // No hits → no block. A header-only block carries no signal and only adds
  // noise/tokens to whatever surface injects it; returning undefined lets
  // callers skip injection via their existing `block === undefined` guard.
  if (hits.length === 0) {
    return undefined;
  }
  if (options.trackAccess !== false) db.recordAccess(hits.map((hit) => hit.record.id));
  const lines = ["## Memory (possibly relevant; verify before use)", ""];
  for (const hit of hits) {
    const star = hit.record.isInsight ? " *" : "";
    // Marker reflects type *and* status (e.g. a done task renders `- [x]`, not `- [ ]`); recall
    // surfaces done/scheduled/migrated records, so a type-only marker would misrepresent their state.
    lines.push(`- ${MARKER_FOR(hit.record.type, hit.record.status)} ${hit.record.text}${star}`);
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = clampToBytes(content, maxBytes);
    truncated = true;
  }
  return { kind: "markdown", content, source: "memory-bujo", truncated };
}

function clampToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // Cut on a UTF-8 boundary by decoding a sliced buffer leniently.
  return new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes)).replace(/�+$/u, "");
}
