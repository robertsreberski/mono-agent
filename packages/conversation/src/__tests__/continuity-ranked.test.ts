import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SCORE_SHAPES, RankedQueue, signalScore } from "../continuity/ranking.js";
import { fitLedgerSelection, ledgerHash, projectedLedgerPayloadBytes, selectLedgerSources, validateLedgerOutput, type LedgerGeneration } from "../continuity/ledger.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";
const scope = { currentConversationId: "fictional", logicalConversationId: "fictional" };
function row(ordinal: number, text = "Neutral.", kind: ContinuitySnapshotRecord["kind"] = "user"): ContinuitySnapshotRecord {
  return { recordId: `record-${ordinal}`, generationId: "fixture", conversationId: "fictional", runId: "past", kind, provenance: kind === "tool" ? "tool" : "unknown", source: {},
    ordinal, sequence: ordinal, sha256: ledgerHash(text), text, originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), redacted: false, truncated: false, untrusted: true,
    ...(kind === "tool" ? { tool: { name: "read_notes", state: "success", invocationId: "fixture", arguments: "{}" } } : {}) };
}
const select = (records: ContinuitySnapshotRecord[], prior?: LedgerGeneration) => selectLedgerSources({ records, omitted: 0, gaps: 0, upkeep: { watermark: records.at(-1)!.ordinal, excluded: [] } }, prior, 128000);
const fit = (records: ContinuitySnapshotRecord[], prior?: Parameters<typeof fitLedgerSelection>[2]) => fitLedgerSelection(select(records, prior?.generation), scope, prior, { maxTokens: 8000, deltaEntries: 8 });

it("uses no annotation/probe words: production scoring patterns match none of the generator's verbatim natural-language phrases", () => {
  const generator = readFileSync(new URL("../../../../scripts/lib/continuity-generator.mjs", import.meta.url), "utf8");
  const phrases = generator.match(/[A-Za-z]{2,}(?: [A-Za-z]{2,}){2,}/g)!;
  expect(phrases.length).toBeGreaterThan(50);
  for (const pattern of SCORE_SHAPES) for (const phrase of phrases) expect(pattern.test(phrase), `${pattern}: ${phrase}`).toBe(false);
});
it("ranks equivalently after renaming/permuting fictional identifiers and quotation labels", () => {
  const records = [row(1, "ID AB-120; 450.", "tool"), row(2, "ID CD-340; 670.", "tool"), row(3, "Neutral archival prose.")];
  const renamed = [row(1, "ID XY-980; 670.", "tool"), row(2, "ID AB-120; 450.", "tool"), records[2]!];
  expect(select(records).ranked?.map(s => [s.ordinal, s.score])).toEqual(select(renamed).ranked?.map(s => [s.ordinal, s.score]));
  const source = records[0]!;
  expect(signalScore(source, 0, "Hypothetical quotation only: AB-120")).toBe(signalScore(source, 0, "Independent archival words: CD-340"));
});
it("bounds descriptor queues and reserves fitting oldest never-offered evidence without starving high signal", () => {
  const queue = new RankedQueue();
  for (let i = 1; i <= 10000; i++) queue.offer({ key: `${i}`, ordinal: i, start: 0, end: 1, score: i % 7, offers: 0 });
  expect(queue.finish().length).toBeLessThanOrEqual(256);
  expect(queue.finish().filter(s => s.ordinal <= 64)).toHaveLength(64);
  const result = fit(Array.from({ length: 150 }, (_, i) => row(i + 1, i < 30 ? "Plain archival note." : "Reference ZZ-120.", i < 30 ? "user" : "tool")));
  const quota = result.selection.maxEntries! * 2;
  expect(result.selection.spans.slice(0, quota).map(s => s.ordinal)).toEqual(Array.from({ length: quota }, (_, i) => i + 1));
  expect(result.selection.spans.some(s => s.ordinal! > 100)).toBe(true);
  expect(result.selection.spans.length).toBeLessThanOrEqual(8 * result.selection.maxEntries!);
});
it("skips a ranked non-fitting lineage candidate and fits later smaller candidates", () => {
  const old = Array.from({ length: 4 }, (_, i) => row(i + 1, "x".repeat(1024 * 1024 - 1024)));
  const legacy: LedgerGeneration = { id: "legacy", parent: null, ...scope, conversationId: "fictional", logicalId: "fictional", manifest: ledgerHash("[]"), inputs: old.map(r => ({ recordId: r.recordId, sha256: r.sha256 })), entries: [], spans: [], coveredOwners: [], uncovered: 0 };
  const result = fit([row(5, "Reference ZZ-120. " + "x".repeat(12000), "tool"), row(6, "Small archival note.")], { generation: legacy, records: old, retainedBytes: old.reduce((n, r) => n + r.retainedBytes, 0) });
  expect(result.selection.spans.map(s => s.ordinal)).toEqual([6]);
  expect(result.lineageBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});
it("compacts a validated 230-span prior's prompt and new generations to citations, preserving all purge lineage", () => {
  const records = Array.from({ length: 230 }, (_, i) => row(i + 1, "Old archival note."));
  const selected = select(records);
  const spans = records.map((r, i) => ({ id: `old${i}`, recordId: r.recordId, sha256: r.sha256, digest: r.sha256, start: 0, end: Buffer.byteLength(r.text), ordinal: r.ordinal, owner: false, kind: r.kind }));
  const prior: LedgerGeneration = { id: "legacy", parent: null, conversationId: "fictional", logicalId: "fictional", manifest: ledgerHash(JSON.stringify(spans)), spans,
    inputs: records.map(r => ({ recordId: r.recordId, sha256: r.sha256 })), entries: [{ kind: "open_work", value: "Prior state.", status: "unknown", sources: ["old0"] }], coveredSpans: spans.map(s => s.id), coveredOwners: [], uncovered: 0 };
  const fresh = row(231, "Fresh archival note.");
  const selection = selectLedgerSources({ records: [fresh], omitted: 0, gaps: 0, upkeep: { watermark: 231, excluded: [] } }, prior, 64000);
  const result = fitLedgerSelection(selection, scope, { generation: prior, records, retainedBytes: records.reduce((n, r) => n + r.retainedBytes, 0) }, { maxTokens: 8000, deltaEntries: 8 });
  expect(result.reason).toBeUndefined();
  const prefix = JSON.parse(result.selection.prompt.split("\n").find(line => line.startsWith('{"prior":'))!);
  expect(prefix.prior.spans).toHaveLength(1);
  const generation = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Fresh state.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), result.selection, scope, prior);
  expect(generation.spans).toHaveLength(2); expect(generation.inputs).toHaveLength(231); expect(prior.spans).toHaveLength(230);
  expect(validateLedgerOutput('{"entries":[],"covered":[]}', result.selection, scope, prior).spans).toHaveLength(1);
  expect(selected.spans.length).toBeLessThanOrEqual(256);
});
it("bootstrap admission is payload-bound near 131072 bytes, not a promised span count", () => {
  const records = Array.from({ length: 100 }, (_, i) => ({ ...row(i + 1, "Reference ZZ-120.", "tool"), recordId: "r".repeat(i < 70 ? 2900 : 500) + i }));
  const selection = select(records), result = fitLedgerSelection(selection, scope, undefined, { maxTokens: 8000, deltaEntries: 8 });
  expect(result.reason).toBeUndefined(); expect(result.projectedBytes).toBeLessThanOrEqual(131072);
  expect(result.projectedBytes).toBeGreaterThan(121000);
  expect(result.selection.spans.length).toBeLessThan(64);
  expect(projectedLedgerPayloadBytes(result.selection, scope)).toBe(result.projectedBytes);
});
