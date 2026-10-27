import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SCORE_SHAPES, RankedQueue, signalScore, templateShape, TEMPLATE_REPRESENTATIVES, RECORD_SPAN_LIMIT } from "../continuity/ranking.js";
import { fitLedgerSelection, ledgerHash, projectedLedgerPayloadBytes, selectLedgerSources, validateLedgerOutput, type LedgerGeneration } from "../continuity/ledger.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";
const word = (n: number) => String.fromCharCode(97 + Math.floor(n / 676) % 26, 97 + Math.floor(n / 26) % 26, 97 + n % 26);
const scope = { currentConversationId: "fictional", logicalConversationId: "fictional" };
function row(ordinal: number, text = "Neutral.", kind: ContinuitySnapshotRecord["kind"] = "user"): ContinuitySnapshotRecord {
  return { recordId: `record-${ordinal}`, generationId: "fixture", conversationId: "fictional", runId: "past", kind, provenance: kind === "tool" ? "tool" : "unknown", source: {},
    ordinal, sequence: ordinal, sha256: ledgerHash(text), text, originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), redacted: false, truncated: false, untrusted: true,
    ...(kind === "tool" ? { tool: { name: "read_notes", state: "success", invocationId: "fixture", arguments: "{}" } } : {}) };
}
const select = (records: ContinuitySnapshotRecord[], prior?: LedgerGeneration) => selectLedgerSources({ records, omitted: 0, gaps: 0, upkeep: { watermark: Math.max(...records.map(r => r.ordinal)), excluded: [] } }, prior, 128000);
const fit = (records: ContinuitySnapshotRecord[], prior?: Parameters<typeof fitLedgerSelection>[2]) => fitLedgerSelection(select(records, prior?.generation), scope, prior, { maxTokens: 8000, deltaEntries: 8 });

it("uses no annotation/probe words: production scoring and instructions do not copy generator phrases", () => {
  const generator = readFileSync(new URL("../../../../scripts/lib/continuity-generator.mjs", import.meta.url), "utf8");
  const phrases = generator.match(/[A-Za-z]{2,}(?: [A-Za-z]{2,}){2,}/g)!;
  expect(phrases.length).toBeGreaterThan(50);
  const prompt = select([]).prompt.toLowerCase().replace(/\s+/gu, " ");
  for (const phrase of phrases) {
    for (const pattern of SCORE_SHAPES) expect(pattern.test(phrase), `${pattern}: ${phrase}`).toBe(false);
    const words = phrase.toLowerCase().split(" ");
    for (let i = 0; i + 7 <= words.length; i++) expect(prompt).not.toContain(words.slice(i, i + 7).join(" "));
  }
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
  const result = fit(Array.from({ length: 150 }, (_, i) => row(i + 1, i < 30 ? `Plain archival ${word(i)} note.` : `Reference ${word(i)} ZZ-120.`, i < 30 ? "user" : "tool")));
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
  const records = Array.from({ length: 100 }, (_, i) => ({ ...row(i + 1, `Reference ${word(i)} ZZ-120.`, "tool"), recordId: "r".repeat(i < 70 ? 2900 : 500) + i }));
  const selection = select(records), result = fitLedgerSelection(selection, scope, undefined, { maxTokens: 8000, deltaEntries: 8 });
  expect(result.reason).toBeUndefined(); expect(result.projectedBytes).toBeLessThanOrEqual(131072);
  expect(result.projectedBytes).toBeGreaterThan(121000);
  expect(result.selection.spans.length).toBeLessThan(64);
  expect(projectedLedgerPayloadBytes(result.selection, scope)).toBe(result.projectedBytes);
});

it("suppresses repeated notification shapes without losing a correction or buried identifier", () => {
  const notifications = Array.from({ length: 80 }, (_, i) => row(i + 1, `Dispatch notice REF-${100 + i}: amount $${200 + i}.`, "tool"));
  const correction = row(81, "The register now records $275 instead of the previous $490.", "tool");
  const buried = row(82, "Ordinary background paragraph.\n\n".repeat(6000) + "Routing token DUSK-421 is in this directory.\n\n" + "Ordinary background paragraph.\n\n".repeat(6000), "tool");
  const records = [...notifications, correction, buried], selected = fit(records).selection;
  expect(selected.spans.filter(s => s.ordinal! <= 80).length).toBeLessThanOrEqual(TEMPLATE_REPRESENTATIVES);
  expect(selected.spans.some(s => s.recordId === correction.recordId)).toBe(true);
  expect(selected.spans.some(s => s.text.includes("DUSK-421"))).toBe(true);
  const renamed = [...records].reverse().map(r => {
    const text = r.text.replace(/REF-(\d+)/gu, "NODE-$1").replace("DUSK-421", "DAWN-842").replace(/\$(\d+)/gu, "€$1");
    return { ...r, text, sha256: ledgerHash(text), originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text) };
  });
  // Currency glyphs are not authority or quality; normalize only the numbers.
  const sameShapes = [...records].reverse().map(r => {
    const text = r.text.replace(/REF-(\d+)/gu, "TAG-$1").replace("DUSK-421", "DAWN-842");
    return { ...r, text, sha256: ledgerHash(text) };
  });
  expect(fit(sameShapes).selection.spans.map(s => [s.ordinal, s.start])).toEqual(selected.spans.map(s => [s.ordinal, s.start]));
  expect(fit(renamed).selection.spans.some(s => s.text.includes("DAWN-842"))).toBe(true);
  expect(templateShape("REF-120 owes 30.50")).toBe(templateShape("NODE-981 owes 82.75"));
});
it("caps each record and balances a long result's head with its interior across metadata sources", () => {
  const records = Array.from({ length: 40 }, (_, i) => {
    const r = row(i + 1, Array.from({ length: 30 }, (_, j) => `Packet ${word(i * 30 + j)}: reference Q-${100 + j}.`).join("\n\n"), "tool");
    return { ...r, tool: { ...r.tool!, name: i % 2 ? "read_archive" : "read_register" } };
  });
  const selected = fit(records).selection.spans;
  const counts = new Map<number, number>();
  for (const s of selected) counts.set(s.ordinal!, (counts.get(s.ordinal!) ?? 0) + 1);
  expect(Math.max(...counts.values())).toBeLessThanOrEqual(RECORD_SPAN_LIMIT);
  expect(counts.size).toBeGreaterThan(10);
  expect(selected.some(s => s.start === 0)).toBe(true);
  expect(selected.some(s => s.start > 0)).toBe(true);
});

it("does not let untrusted matching text suppress a host-attested owner representative", () => {
  const text = "Routing condition for REF-451 is unchanged.";
  const owner = { ...row(3, text, "owner"), provenance: "host-owner" as const, inputId: "input", source: { attestation: { inputId: "input", requestDigest: ledgerHash("input") } } };
  expect(fit([row(1, text, "tool"), row(2, text, "tool"), owner]).selection.spans.some(s => s.owner)).toBe(true);
});
