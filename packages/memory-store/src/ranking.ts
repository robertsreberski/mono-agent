import type { RecallWeights } from "./types.js";

export interface FusedItem {
  readonly id: string;
  readonly rrfScore: number;
}

/** Reciprocal Rank Fusion across any number of ranked id lists (best-first). */
export function rrfFuse(lists: readonly (readonly string[])[], k: number): FusedItem[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface ReScoreInput {
  readonly rrfScore: number;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly lastAccessedAt?: string;
}

/** Final relevance: RRF + recency decay + salience + insight, weighted. */
export function reScore(input: ReScoreInput, weights: RecallWeights, decayGamma: number, now: Date): number {
  const recency = recencyDecay(input.lastAccessedAt, decayGamma, now);
  return (
    weights.rrf * input.rrfScore +
    weights.recency * recency +
    weights.salience * input.salience +
    weights.insight * (input.isInsight ? 1 : 0)
  );
}

function recencyDecay(lastAccessedAt: string | undefined, gamma: number, now: Date): number {
  if (lastAccessedAt === undefined) return 0;
  const ts = new Date(lastAccessedAt).getTime();
  // A malformed timestamp parses to NaN; left unguarded it would make reScore return NaN and
  // destabilise sorting. Treat it as no recency contribution.
  if (Number.isNaN(ts)) return 0;
  const days = Math.max(0, (now.getTime() - ts) / 86_400_000);
  return gamma ** days;
}
