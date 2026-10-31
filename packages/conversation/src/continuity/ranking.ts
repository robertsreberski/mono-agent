import { createHash } from "node:crypto";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

// Shape recognizers, not words/annotations, entity names or probe meanings.
export const SCORE_SHAPES = [/\p{N}/u, /(?<![\p{L}\p{N}])\p{L}[\p{L}_-]{0,63}\p{N}[\p{L}\p{N}_-]*/u, /→|->|=>|≠/u] as const;
export const TEMPLATE_REPRESENTATIVES = 2;
export const RECORD_SPAN_LIMIT = 8;
export interface RankedSpan { readonly key: string; readonly ordinal: number; readonly start: number; readonly end: number; readonly score: number; readonly offers: number; readonly source?: string }
/** Ephemeral comparison shape only; original bytes remain the evidence. No
 * vocabulary, entity spelling, model annotations or evaluator input is used. */
export function templateShape(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{L}\p{N}]+(?:[-_.,:/][\p{L}\p{N}]+)*/gu,
    token => /\p{N}/u.test(token) ? /\p{L}/u.test(token) ? "[ID]" : "[N]" : token).replace(/\s+/gu, " ").trim();
}
export function signalScore(record: Pick<ContinuitySnapshotRecord, "kind" | "provenance" | "inputId" | "source" | "tool">, start: number, text: string, offers = 0): number {
  const owner = record.kind === "owner" && record.provenance === "host-owner" && !!record.inputId && record.inputId === record.source.attestation?.inputId;
  const words = templateShape(text.slice(0, 2048)).match(/[\p{L}\p{N}]+/gu) ?? [];
  const density = Math.floor(3 * new Set(words).size / Math.max(1, words.length));
  return (record.kind === "tool" ? 12 + Number(start > 0) * 2 + Number(!!record.tool?.state) * 2 : owner ? 10 : 4)
    // A bounded shape-only bonus closes the numeric/ID scoring deficit for
    // short never-offered attested-owner paragraphs. Source round robin and fitting
    // still bound owner floods; no text vocabulary or inferred authority.
    + Number(owner && offers === 0 && Buffer.byteLength(text) <= 256) * 16
    + Number(SCORE_SHAPES[0].test(text)) * 8 + Number(SCORE_SHAPES[1].test(text)) * 8 + Number(SCORE_SHAPES[2].test(text)) * 4 + density;
}
const rankCompare = (a: RankedSpan, b: RankedSpan) => b.score - a.score || a.offers - b.offers || a.start - b.start || b.ordinal - a.ordinal;
const oldest = (a: RankedSpan, b: RankedSpan) => a.ordinal - b.ordinal || a.start - b.start;
/** Scope-local, bounded by the scan's 65,536 windows. Retains hashes and at most
 * two descriptors per shape, never bodies. Count all windows, even ineligible
 * ones, so representation/exhaustion cannot erase a template's frequency. */
export class RankedQueue {
  private readonly templates = new Map<string, { count: number; representatives: RankedSpan[] }>();
  private windows = 0;
  readonly diagnostics = { templates: 0, repeated: 0, templateSuppressed: 0, recordSuppressed: 0, sources: 0 };
  observe(text: string, owner = false): string {
    if (++this.windows > 65536) throw new Error("scan_capacity");
    const key = createHash("sha256").update(JSON.stringify([owner, templateShape(text)])).digest("hex");
    const group = this.templates.get(key) ?? { count: 0, representatives: [] }; group.count++;
    this.templates.set(key, group); return key;
  }
  offer(value: RankedSpan, template?: string): void {
    // Already-scored supplied descriptors need no second frequency adjustment.
    const key = template ?? value.key;
    if (!this.templates.has(key)) {
      if (++this.windows > 65536) throw new Error("scan_capacity");
      this.templates.set(key, { count: 1, representatives: [] });
    }
    const representatives = this.templates.get(key)!.representatives;
    representatives.push(value); representatives.sort(oldest);
    if (representatives.length > TEMPLATE_REPRESENTATIVES) { representatives.pop(); this.diagnostics.templateSuppressed++; }
  }
  finish(): RankedSpan[] {
    this.diagnostics.templates = this.templates.size; this.diagnostics.repeated = [...this.templates.values()].filter(g => g.count > 2).length;
    this.diagnostics.recordSuppressed = 0;
    const records = new Map<number, RankedSpan[]>();
    for (const { count, representatives } of this.templates.values()) for (const s of representatives) {
      // Two occurrences may be distinct revisions; frequent structural repeats
      // get a strong logarithmic penalty, including previously offered spans.
      const score = s.score - (count > 2 ? 24 * Math.ceil(Math.log2(count / 2)) : 0);
      const group = records.get(s.ordinal) ?? []; group.push({ ...s, score }); records.set(s.ordinal, group);
    }
    const sources = new Map<string, RankedSpan[][]>();
    for (const values of records.values()) {
      values.sort(rankCompare);
      // Pair the best window with its complementary head/interior, then share
      // remaining capacity between ranked and oldest never-offered windows.
      const best = values[0]!, complement = values.find(s => (s.start === 0) !== (best.start === 0));
      const pool = [best, ...(complement ? [complement] : []), ...values.filter(s => !s.offers).sort(oldest).slice(0, 2), ...values];
      const limited = [...new Map(pool.map(s => [s.key, s])).values()].slice(0, RECORD_SPAN_LIMIT);
      this.diagnostics.recordSuppressed += values.length - limited.length;
      const source = best.source ?? "other", group = sources.get(source) ?? []; group.push(limited); sources.set(source, group);
    }
    // Two-level round robin: records within a metadata source (kind/tool), then
    // sources. Pairs balance heads/interiors without one long result monopolizing
    // the queue. A sole source can still use otherwise idle slots.
    this.diagnostics.sources = sources.size;
    const groups = [...sources.values()].map(group => {
      group.sort((a, b) => rankCompare(a[0]!, b[0]!));
      const ordered: RankedSpan[] = [];
      for (let depth = 0; depth < RECORD_SPAN_LIMIT; depth += 2) for (const record of group) ordered.push(...record.slice(depth, depth + 2));
      return ordered;
    }).sort((a, b) => rankCompare(a[0]!, b[0]!));
    const ranked: RankedSpan[] = [];
    for (let depth = 0; ranked.length < 192 && groups.some(g => depth < g.length); depth += 2) for (const group of groups) {
      ranked.push(...group.slice(depth, depth + Math.min(2, 192 - ranked.length)));
    }
    const fair = [...sources.values()].flat(2).filter(s => !s.offers).sort(oldest).slice(0, 64);
    return [...new Map([...ranked, ...fair].map(s => [s.key, s])).values()];
  }
}
