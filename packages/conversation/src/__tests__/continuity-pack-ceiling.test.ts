import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderContinuityPack } from "../continuity/pack.js";
import { ledgerHash, quote, fitLedgerSelection, renderLedger, selectLedgerSources, type LedgerGeneration } from "../continuity/ledger.js";
import { CONTINUITY_PACK_MAX_TOKENS, PACK_HEADER, fitsLedgerPrefix, fitsLedgerPrefixBytes, packTokens, packTokensOfBytes } from "../continuity/render-fit.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

// Fictional fixtures only. The 16k handover ceiling is an upper bound shared
// with the turn runtime; the 4k ledger prefix, 220-token marker reserve and
// whole-entry rule are unchanged.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function record(ordinal: number, text: string, kind: ContinuitySnapshotRecord["kind"] = "owner"): ContinuitySnapshotRecord {
  const inputId = `input-${ordinal}`;
  return { recordId: `fictional-${ordinal}`, generationId: "fictional-generation", conversationId: "fictional", runId: `run-${ordinal}`, inputId, kind,
    provenance: kind === "owner" ? "host-owner" : kind === "summary" ? "generated" : "unknown", sequence: 0, ordinal, sha256: kind === "summary" ? sha(text) : ledgerHash(text),
    originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated: false, redacted: false,
    source: { attestation: { inputId, requestDigest: "digest" } }, untrusted: true, text };
}
const protectedItems = Array.from({ length: 31 }, (_, i) => `- Fictional item ${i}; m${i}; cobalt chosen instead of coral; historical decision.`).join("\n");
/** About 10.6k incremental pack tokens once JSON-quoted. */
const mediumSummary = `## Goal\n${"Fictional background detail. ".repeat(1000)}\n\n## Historical events and corrections\n${protectedItems}\n\n## Pending items\n- Review the fictional diagram.`;
const entry = (summary: ContinuitySnapshotRecord) => `Generated summary evidence id=${quote(summary.recordId)} sha256=${quote(summary.sha256)}: ${quote(summary.text)}\n`;
const entryTokens = (summary: ContinuitySnapshotRecord) => packTokensOfBytes(Buffer.byteLength(PACK_HEADER + entry(summary))) - packTokensOfBytes(Buffer.byteLength(PACK_HEADER));
function ledger(entries: number, words: number, cite: ContinuitySnapshotRecord): { generation: LedgerGeneration; records: readonly ContinuitySnapshotRecord[] } {
  const span = { id: "pcited", recordId: cite.recordId, sha256: cite.sha256, start: 0, end: Buffer.byteLength(cite.text), digest: ledgerHash(cite.text), owner: false, kind: cite.kind, ordinal: cite.ordinal };
  return { records: [cite], generation: { id: "fictional-ledger", parent: null, conversationId: "fictional", logicalId: "fictional", manifest: "m", inputs: [], coveredOwners: [], uncovered: 0, spans: [span],
    entries: Array.from({ length: entries }, (_, i) => ({ kind: "artifact", value: `Fictional derived note ${i}: ${"orchard lantern ".repeat(words)}`, status: "unknown", sources: ["pcited"] })) } };
}

it("quotes a ~10.6k-token summary whole at the 16k default that an explicit 8k ceiling omits", () => {
  const summary = record(1, mediumSummary, "summary");
  const cost = entryTokens(summary);
  expect(cost).toBeGreaterThan(10_000); expect(cost).toBeLessThan(11_000);
  const source = { records: [summary, record(2, "Fictional rule: confirm before sending.")], omitted: 0, gaps: 0 };
  const legacy = renderContinuityPack(source, [], 8000);
  expect(legacy.summarySelection).toBeUndefined(); expect(legacy.counts.summary).toBe(0);
  expect(legacy.degradedReason).toBe("summary_headroom");
  expect(legacy.text).toContain(`Generated summary omitted: entry_tokens=${cost}; content_headroom_tokens=`);
  const pack = renderContinuityPack(source, []);
  expect(pack.counts).toMatchObject({ summary: 1, owner: 1 }); expect(pack.degradedReason).toBeUndefined();
  expect(pack.tokens).toBeLessThanOrEqual(CONTINUITY_PACK_MAX_TOKENS);
  // Adequate headroom: the whole quotation, owner rule and marker leave >4k unused.
  expect(CONTINUITY_PACK_MAX_TOKENS - pack.tokens).toBeGreaterThan(4000);
  const selection = pack.summarySelection!, bytes = Buffer.from(pack.text!);
  expect(selection).toMatchObject({ recordId: summary.recordId, sha256: summary.sha256, retainedBytes: Buffer.byteLength(mediumSummary), packSha256: sha(pack.text!) });
  expect(bytes.subarray(selection.entry.startByte, selection.entry.endByte).toString("utf8")).toBe(entry(summary));
  expect(selection.entry.sha256).toBe(sha(entry(summary)));
});

it.each([
  ["unicode", "Żółty 🦊 kobalt — ŻÓŁTY Ω 字. "],
  ["escaping", 'Quote "x" \\ back <tag> & tab\t\u0001 newline\n'],
])("admits a whole %s summary exactly at the 16k marker boundary and never a fragment", (_name, unit) => {
  // Size the entry so the exact boundary falls between the old and new ceilings.
  let text = unit;
  while (packTokens(PACK_HEADER + entry(record(9, text + unit, "summary"))) + 220 <= CONTINUITY_PACK_MAX_TOKENS) text += unit;
  const summary = record(9, text, "summary"), line = entry(summary);
  const boundary = packTokens(PACK_HEADER + line) + 220;
  expect(boundary).toBeGreaterThan(8000); expect(boundary).toBeLessThanOrEqual(CONTINUITY_PACK_MAX_TOKENS);
  const source = { records: [summary], omitted: 0, gaps: 0 };
  const exact = renderContinuityPack(source, [], boundary), atDefault = renderContinuityPack(source, []);
  for (const pack of [exact, atDefault]) {
    expect(pack.counts.summary).toBe(1); expect(pack.text!.indexOf(line)).toBe(PACK_HEADER.length);
    expect(Buffer.byteLength(pack.text!)).toBeLessThanOrEqual(47952);
    const selection = pack.summarySelection!;
    expect(Buffer.from(pack.text!).subarray(selection.entry.startByte, selection.entry.endByte).toString("utf8")).toBe(line);
    // Escaped text round-trips to the exact retained bytes.
    expect(JSON.parse(line.slice(line.indexOf(": ") + 2, -1))).toBe(text);
  }
  const overflow = renderContinuityPack(source, [], boundary - 1);
  expect(overflow.counts.summary).toBe(0); expect(overflow.summarySelection).toBeUndefined();
  expect(overflow.text).not.toContain(quote(text).slice(1, 200)); expect(overflow.text).toContain("whole entry required");
  // One more unit exceeds even the 16k ceiling: omitted whole at the default.
  const larger = record(9, text + unit + unit, "summary");
  expect(renderContinuityPack({ records: [larger], omitted: 0, gaps: 0 }, [])).toMatchObject({ counts: { summary: 0 }, degradedReason: "summary_headroom" });
});

it("keeps the 4k ledger prefix rule at 16k: the ledger competes only for its own prefix space", () => {
  const cite = record(50, "Fictional calendar view.\n\nNo conflicts found.", "user");
  for (let bytes = 0; bytes <= 20_000; bytes += 97) {
    expect(fitsLedgerPrefixBytes(bytes, CONTINUITY_PACK_MAX_TOKENS)).toBe(fitsLedgerPrefixBytes(bytes, 4000));
    expect(fitsLedgerPrefixBytes(bytes, 1e9)).toBe(fitsLedgerPrefixBytes(bytes, 4000));
  }
  const summary = record(1, mediumSummary, "summary"), owners = Array.from({ length: 30 }, (_, i) => record(i + 2, `Fictional rule ${i}: keep cobalt. `.repeat(8)));
  const records = [summary, ...owners, cite], snapshot = { records, omitted: 0, gaps: 0 };
  // A ledger that fits the unchanged 4k prefix is shown before the whole summary.
  const fitting = ledger(12, 20, cite);
  const shown = renderContinuityPack(snapshot, [], undefined, fitting);
  expect(shown.ledgerEntries).toBe(12); expect(shown.counts.summary).toBe(1);
  expect(shown.text!.indexOf("### Continuity ledger")).toBeLessThan(shown.text!.indexOf("Generated summary evidence"));
  expect(shown.tokens).toBeLessThanOrEqual(CONTINUITY_PACK_MAX_TOKENS);
  // A larger summary that fits 16k alone is omitted whole beside the admitted
  // ledger: the prefix keeps priority and nothing is clipped.
  let grown = mediumSummary;
  while (renderContinuityPack({ records: [record(1, grown + "Fictional extra detail. ".repeat(40), "summary"), cite], omitted: 0, gaps: 0 }, []).counts.summary === 1) grown += "Fictional extra detail. ".repeat(40);
  const competing = { records: [record(1, grown, "summary"), cite], omitted: 0, gaps: 0 };
  expect(renderContinuityPack(competing, []).counts.summary).toBe(1);
  const beside = renderContinuityPack(competing, [], undefined, fitting);
  expect(beside.ledgerEntries).toBe(12); expect(beside.counts.summary).toBe(0); expect(beside.degradedReason).toBe("summary_headroom");
  // A ledger beyond the 4k prefix stays omitted even though 16k has room for it.
  const oversized = ledger(24, 30, cite), rendered = renderLedger(oversized.generation, oversized.records);
  expect(packTokens(PACK_HEADER + rendered) + 700).toBeGreaterThan(4000);
  expect(packTokens(PACK_HEADER + rendered) + 700).toBeLessThan(CONTINUITY_PACK_MAX_TOKENS);
  expect(fitsLedgerPrefix(rendered, CONTINUITY_PACK_MAX_TOKENS)).toBe(false);
  const disclosed = renderContinuityPack(snapshot, [], undefined, oversized);
  expect(disclosed.ledgerEntries).toBe(0); expect(disclosed.text).toContain("Continuity ledger omitted: 24 derived entries exceed the ledger space");
  expect(disclosed.counts.summary).toBe(1);
});

it("defaults ledger selection/fitting to the same 16k ceiling without enlarging the 4k prefix", () => {
  const records = Array.from({ length: 40 }, (_, i) => record(i + 1, `Fictional owner paragraph ${i}: ${"cedar ribbon ".repeat(40)}`));
  const snapshot = { records, omitted: 0, gaps: 0 }, scope = { currentConversationId: "fictional", logicalConversationId: "fictional" };
  const selection = selectLedgerSources(snapshot);
  expect(selectLedgerSources(snapshot, undefined, 64000, { maxTokens: CONTINUITY_PACK_MAX_TOKENS })).toEqual(selection);
  const fitted = fitLedgerSelection(selection, scope);
  expect(fitLedgerSelection(selection, scope, undefined, { maxTokens: CONTINUITY_PACK_MAX_TOKENS, deltaEntries: 24 })).toEqual(fitted);
  // The prefix rule clamps to 4k, so 8k, 16k and larger requests fit identically.
  expect(fitLedgerSelection(selection, scope, undefined, { maxTokens: 8000, deltaEntries: 24 })).toEqual(fitted);
  expect(fitLedgerSelection(selection, scope, undefined, { maxTokens: 64000, deltaEntries: 24 })).toEqual(fitted);
});

// Every caller-visible budget ≥ 4k collapses to the unchanged 4k ledger prefix,
// so reverting a ledger default or the inner prefix clamp from the shared
// ceiling to a literal is behaviourally invisible. Pin the sites to the named
// constant at source level; the runtime drift guard covers the offered budget.
it("pins every pack ceiling site to its package-local named constant (source contract)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = async (path: string) => await readFile(new URL(path, import.meta.url), "utf8");
  const ceilingLiterals = (text: string) => text.match(/\b(?:8|16)_?000\b/gu) ?? [];
  const renderFit = await source("../continuity/render-fit.ts"), pack = await source("../continuity/pack.ts"), ledger = await source("../continuity/ledger.ts");
  const run = await source("../../../turn/src/execution/pi/run.ts");
  expect(renderFit).toMatch(/^export const CONTINUITY_PACK_MAX_TOKENS = 16_000;$/mu);
  expect(renderFit).toMatch(/fitsLedgerPrefixBytes = [^\n]*<= Math\.min\(4000, Math\.max\(0, Math\.min\(CONTINUITY_PACK_MAX_TOKENS, Math\.floor\(maxTokens\)\)\)\);$/mu);
  expect(pack).toMatch(/export function renderContinuityPack\([^)]*?maxTokens = CONTINUITY_PACK_MAX_TOKENS,/u);
  expect(pack).toMatch(/const limit = Math\.max\(0, Math\.min\(CONTINUITY_PACK_MAX_TOKENS, Math\.floor\(maxTokens\)\)\);/u);
  expect(ledger).toMatch(/export function selectLedgerSources\([^\n]*\} = \{ maxTokens: CONTINUITY_PACK_MAX_TOKENS \}\): LedgerSelection \{/u);
  expect(ledger).toMatch(/\}, limits: \{ maxTokens: number; deltaEntries: number \} = \{ maxTokens: CONTINUITY_PACK_MAX_TOKENS, deltaEntries: 24 \}\)/u);
  expect(run).toMatch(/^const CONTINUITY_PACK_MAX_TOKENS = 16_000;$/mu);
  expect(run).toMatch(/const maxTokens = Math\.max\(0, Math\.min\(CONTINUITY_PACK_MAX_TOKENS, Math\.floor\(Math\.min\(window, policy\.triggerTokens\) - fixed - input - reserve\)\)\);/u);
  // The only ceiling literals are the two constant definitions themselves.
  expect([ceilingLiterals(renderFit), ceilingLiterals(pack), ceilingLiterals(ledger)]).toEqual([["16_000"], [], []]);
  expect(run.match(/\b16_?000\b/gu)).toEqual(["16_000"]);
});

it("exercises the upkeep oversized-owner branch with the default ledger budget", () => {
  // snapshot.upkeep enables the budget-dependent oversized check (ledger.ts
  // selectLedgerSources). Its admission rule is the 4k prefix for any budget at
  // or above 4k, and tighter below it.
  const owner = record(1, `Fictional owner paragraph: ${"keep cobalt and confirm the orchard plan. ".repeat(160)}`);
  const snapshot = { records: [owner], omitted: 0, gaps: 0, upkeep: { watermark: 1, excluded: [] } };
  const byDefault = selectLedgerSources(snapshot);
  expect(byDefault.oversizedProgress).toBeUndefined(); expect(byDefault.spans.length).toBeGreaterThan(0);
  for (const maxTokens of [4000, 8000, CONTINUITY_PACK_MAX_TOKENS, 1e9]) expect(selectLedgerSources(snapshot, undefined, 64000, { maxTokens })).toEqual(byDefault);
  const tight = selectLedgerSources(snapshot, undefined, 64000, { maxTokens: 2500 });
  expect(tight.spans).toEqual([]); expect(tight.oversizedProgress).toBeDefined(); expect(tight.oversizedAdvance).toBe(true);
});
