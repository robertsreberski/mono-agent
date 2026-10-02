import type { MemoryBlock } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "../store/index.js";

import { MARKER_FOR } from "./grammar.js";
import { semanticRecallAuthorities } from "./semantic.js";

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
  options: { readonly maxLines?: number; readonly asOf?: string; readonly now?: string; readonly semanticAuthorities?: ReadonlyMap<string, number> } = {},
): readonly T[] {
  const top = hits[0]?.score;
  if (top === undefined || !Number.isFinite(top) || top < POSSIBLY_RELEVANT_MIN_SCORE) return [];
  const maxLines = Math.max(1, Math.min(options.maxLines ?? POSSIBLY_RELEVANT_MAX_LINES, POSSIBLY_RELEVANT_MAX_LINES));
  const window: T[] = [];
  for (const hit of hits) {
    if (hit.score < top - POSSIBLY_RELEVANT_WINDOW) break;
    window.push(hit);
  }
  // Authority only filters/reorders the already-qualified window. Ineligible
  // leaders never lower the reference score or widen the fifty-hit lookup.
  const authorities = options.semanticAuthorities;
  const prioritized = authorities === undefined
    ? [...window.filter((hit) => recallLineStatus(hit.record, options.asOf, options.now) === "current"),
      ...window.filter((hit) => recallLineStatus(hit.record, options.asOf, options.now) !== "current")]
    : window.filter((hit) => authorities.has(hit.record.id ?? ""))
      .sort((a, b) => (authorities.get(b.record.id ?? "") ?? 0) - (authorities.get(a.record.id ?? "") ?? 0));
  // Deduplicate identical text after currency preference, so a current copy wins.
  const seen = new Set<string>();
  const unique = prioritized.filter((hit) => {
    const key = hit.record.text.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, maxLines)
    .sort((a, b) => (a.record.createdAt ?? "").localeCompare(b.record.createdAt ?? ""));
}

export interface PossiblyRelevantRecord {
  readonly id?: string;
  readonly text: string;
  readonly type?: "task" | "event" | "note";
  readonly createdAt?: string;
  readonly status?: string;
  readonly validTo?: string;
  /** The store's structured due date; for dated events only, this is the event date. */
  readonly dueAt?: string;
  readonly supersededBy?: string;
}

/* Date-only values end after the host's local calendar day; timestamps are instants. */
export function recallLineEndDate(record: PossiblyRelevantRecord, asOf?: string, now?: string): string | undefined {
  if (asOf === undefined) return undefined;
  const value = record.validTo ?? (record.type === "event" ? record.dueAt : undefined);
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value && value < asOf
      ? value : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const instant = Date.parse(value);
  const observed = Date.parse(now ?? new Date().toISOString());
  return Number.isFinite(instant) && Number.isFinite(observed) && instant < observed ? value : undefined;
}

/** Reader-facing currency on the host's local `asOf` (YYYY-MM-DD) and observation instant. */
export function recallLineStatus(record: PossiblyRelevantRecord, asOf?: string, now?: string): "current" | "superseded" | "ended" {
  if (record.supersededBy !== undefined || record.status === "invalidated" || record.status === "dropped") return "superseded";
  return recallLineEndDate(record, asOf, now) === undefined ? "current" : "ended";
}

/** Shared formatting contract for standalone stores and the app's automatic block. */
export const POSSIBLY_RELEVANT_HEADING = "## Memory (possibly relevant — may be unrelated; verify before relying)";
const POSSIBLY_RELEVANT_LINE_BYTES = 360;

export interface FormattedRecallRecord extends PossiblyRelevantRecord {
  readonly id: string;
  readonly type?: "task" | "event" | "note";
  readonly status?: "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";
  readonly isInsight?: boolean;
}

/** Never emit a partial line or split a UTF-8 code point at either byte bound. */
export function formatPossiblyRelevantBlock<T extends { readonly record: FormattedRecallRecord }>(
  hits: readonly T[],
  attributions: ReadonlyMap<string, string>,
  maxBytes: number,
  asOf?: string,
  now?: string,
): { readonly content: string; readonly truncated: boolean; readonly shown: readonly T[] } | undefined {
  const lines = [POSSIBLY_RELEVANT_HEADING, ""];
  const shown: T[] = [];
  let truncated = false;
  for (const hit of hits) {
    const record = hit.record;
    const recorded = /^\d{4}-\d{2}-\d{2}/u.exec(record.createdAt ?? "")?.[0];
    const status = recallLineStatus(record, asOf, now);
    const currency = status === "ended" ? `ended ${recallLineEndDate(record, asOf, now)}` : status;
    const note = [recorded === undefined ? undefined : `recorded ${recorded}`, currency,
      record.type === "task" && record.status !== undefined && record.status !== "open" ? record.status : undefined,
      record.type === "task" && status === "current" ? "task/plan recorded" : undefined,
      attributions.get(record.id)]
      .filter((part) => part !== undefined).join("; ");
    const body = record.type === "task" ? `${record.text}${record.isInsight === true ? " *" : ""}`
      : record.type === undefined || record.status === undefined ? record.text
      : `${MARKER_FOR(record.type, record.status)} ${record.text}${record.isInsight === true ? " *" : ""}`;
    const text = clampLineBytes(body.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim(), POSSIBLY_RELEVANT_LINE_BYTES);
    const line = `- ${text}${note.length > 0 ? ` (${note})` : ""}`;
    if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > maxBytes) { truncated = true; continue; }
    lines.push(line);
    shown.push(hit);
  }
  if (shown.length === 0) return undefined;
  return { content: lines.join("\n"), truncated, shown };
}

function clampLineBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const cut = new TextDecoder("utf-8").decode(Buffer.from(text, "utf8").subarray(0, maxBytes - 3)).replace(/\uFFFD+$/u, "");
  return `${cut}…`;
}

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number; trackAccess?: boolean; abortSignal?: AbortSignal; asOf?: string; now?: string; semanticOnly?: boolean } = {},
): Promise<MemoryBlock | undefined> {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? POSSIBLY_RELEVANT_MAX_BYTES, POSSIBLY_RELEVANT_MAX_BYTES));
  const topK = Math.max(1, Math.min(options.topK ?? POSSIBLY_RELEVANT_MAX_LINES, POSSIBLY_RELEVANT_MAX_LINES));
  const outcome = await db.recallWithOutcome(query, {
    topK: AUTO_RECALL_BACKEND_HITS,
    trackAccess: false,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  options.abortSignal?.throwIfAborted();
  // Standalone callers enforce audience policy. Lexical-only/degraded results
  // remain available through explicit recall, never as automatic context.
  if (outcome.retrievalMode !== "hybrid" || outcome.degradation !== undefined) return undefined;
  const semanticAuthorities = options.semanticOnly === true ? semanticRecallAuthorities(
    db.labelsForMemories(outcome.hits.map((hit) => hit.record.id)), db.labelsForEntity.bind(db),
    options.asOf ?? new Date().toISOString().slice(0, 10), options.now,
  ) : undefined;
  const hits = selectPossiblyRelevantRecallHits(outcome.hits, {
    ...(semanticAuthorities === undefined ? {} : { semanticAuthorities }),
    maxLines: topK, ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const block = formatPossiblyRelevantBlock(hits, new Map(), maxBytes, options.asOf, options.now);
  if (block === undefined) return undefined;
  if (options.trackAccess !== false) db.recordAccess(block.shown.map((hit) => hit.record.id));
  return { kind: "markdown", content: block.content, source: "memory-bujo", truncated: block.truncated,
    ...(options.semanticOnly === true ? { traceContent: false } : {}) };
}
