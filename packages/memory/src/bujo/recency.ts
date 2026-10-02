import type { MemoryLabelHit } from "../store/db-labels.js";
import { AUTO_RECALL_MIN_SCORE } from "./recall.js";

const HALF_LIFE_MS = 30 * 86_400_000;
const MAX_RECENCY_TERM = 0.02;
const RELEVANCE_MARGIN = 0.15;

/** Deliberate BuJo ranking only. Never alter base scores, floors or candidate membership. */
export function rankDeliberateRecallHits<T extends { readonly score: number; readonly record: {
  readonly id: string; readonly type?: string; readonly createdAt?: string;
} }>(hits: readonly T[], labels: readonly MemoryLabelHit[], now: string): readonly T[] {
  const observed = Date.parse(now);
  const top = Math.max(...hits.map((hit) => hit.score));
  if (!Number.isFinite(observed) || top < AUTO_RECALL_MIN_SCORE) return hits;
  const floor = Math.max(AUTO_RECALL_MIN_SCORE, top - RELEVANCE_MARGIN);
  // Any fact/preference is durable, even a coarse fact on an event. Labelled
  // notes also stay outside this transient policy; labels are canonical.
  const durable = new Set(labels.filter((hit) => hit.label.kind === "fact" || hit.label.kind === "preference").map((hit) => hit.memoryId));
  const labelled = new Set(labels.map((hit) => hit.memoryId));
  const term = (hit: T): number => {
    if (durable.has(hit.record.id) || (hit.record.type !== "event"
      && !(hit.record.type === "note" && !labelled.has(hit.record.id)))) return 0;
    const created = Date.parse(hit.record.createdAt ?? "");
    // Future/invalid recording dates are not recency evidence.
    if (!Number.isFinite(created) || created > observed) return 0;
    return MAX_RECENCY_TERM * 2 ** (-(observed - created) / HALF_LIFE_MS);
  };
  const qualified = hits.filter((hit) => Number.isFinite(hit.score) && hit.score >= floor)
    .map((hit, index) => ({ hit, index, rank: hit.score + term(hit) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index).map(({ hit }) => hit);
  // Below-floor hits keep their positions; recency cannot rescue a weak hit.
  let index = 0;
  return hits.map((hit) => Number.isFinite(hit.score) && hit.score >= floor ? qualified[index++]! : hit);
}
