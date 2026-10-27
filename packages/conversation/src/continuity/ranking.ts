import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

// Shape recognizers, not words/annotations, entity names or probe meanings.
export const SCORE_SHAPES = [/\p{N}/u, /(?<![\p{L}\p{N}])\p{L}[\p{L}_-]{0,63}\p{N}[\p{L}\p{N}_-]*/u, /→|->|=>|≠/u] as const;
export interface RankedSpan { readonly key: string; readonly ordinal: number; readonly start: number; readonly end: number; readonly score: number; readonly offers: number }
export function signalScore(record: Pick<ContinuitySnapshotRecord, "kind" | "provenance" | "inputId" | "source" | "tool">, start: number, text: string): number {
  const owner = record.kind === "owner" && record.provenance === "host-owner" && !!record.inputId && record.inputId === record.source.attestation?.inputId;
  return (record.kind === "tool" ? 12 + Number(start > 0) * 12 + Number(!!record.tool?.state) * 2 : owner ? 10 : 4)
    + Number(SCORE_SHAPES[0].test(text)) * 8 + Number(SCORE_SHAPES[1].test(text)) * 8 + Number(SCORE_SHAPES[2].test(text)) * 4;
}
// Equal-signal window depth precedes recency: deterministic record diversity,
// without ordering by the spelling/hash/value of a fictional identifier.
const rankCompare = (a: RankedSpan, b: RankedSpan) => b.score - a.score || a.offers - b.offers || a.start - b.start || b.ordinal - a.ordinal;
const oldest = (a: RankedSpan, b: RankedSpan) => a.ordinal - b.ordinal || a.start - b.start;
class BoundedHeap {
  readonly values: RankedSpan[] = [];
  constructor(private readonly limit: number, private readonly compare: typeof rankCompare) {}
  offer(value: RankedSpan): void {
    const a = this.values;
    if (a.length === this.limit) {
      if (this.compare(value, a[0]!) >= 0) return;
      a[0] = value; let i = 0;
      for (;;) { let child = i * 2 + 1; if (child >= a.length) break;
        if (child + 1 < a.length && this.compare(a[child + 1]!, a[child]!) > 0) child++;
        if (this.compare(a[i]!, a[child]!) >= 0) break;
        [a[i], a[child]] = [a[child]!, a[i]!]; i = child; }
    } else {
      a.push(value); let i = a.length - 1;
      while (i) { const parent = (i - 1) >> 1; if (this.compare(a[parent]!, a[i]!) >= 0) break;
        [a[i], a[parent]] = [a[parent]!, a[i]!]; i = parent; }
    }
  }
}
/** At most 256 descriptors, independent of record/window count. */
export class RankedQueue {
  private readonly ranked = new BoundedHeap(192, rankCompare);
  private readonly fair = new BoundedHeap(64, oldest);
  offer(value: RankedSpan): void { this.ranked.offer(value); if (!value.offers) this.fair.offer(value); }
  finish(): RankedSpan[] { return [...new Map([...this.ranked.values, ...this.fair.values].map(s => [s.key, s])).values()].sort(rankCompare); }
}
