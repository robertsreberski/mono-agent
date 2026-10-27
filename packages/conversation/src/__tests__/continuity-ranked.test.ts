import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { SCORE_SHAPES, RankedQueue, signalScore, templateShape, TEMPLATE_REPRESENTATIVES, RECORD_SPAN_LIMIT } from "../continuity/ranking.js";
import { fitLedgerSelection, ledgerHash, renderLedger, projectedLedgerPayloadBytes, selectLedgerSources, validateLedgerOutput, type LedgerGeneration } from "../continuity/ledger.js";
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

// Fixed function-word list, not selected from benchmark content. Content words remain.
const STOPWORDS = new Set("a an and are as at be been but by for from has have i if in is it its me my of on or our s so that the their them then there they this to was we were will with you your".split(" "));
const grams = (text: string) => {
  const words = (text.toLowerCase().match(/[a-z]+/gu) ?? []).filter(word => !STOPWORDS.has(word));
  return words.slice(2).map((_, i) => words.slice(i, i + 3).join(" "));
};
function literals(text: string, templatesOnly = false): string[] {
  const file = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true), chunks: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) chunks.push([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(" "));
    else if (ts.isNoSubstitutionTemplateLiteral(node) || !templatesOnly && ts.isStringLiteral(node)) chunks.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file); return chunks;
}
it("rejects stopword-stripped generator string/template trigrams in the production prompt and ranking constants", () => {
  const generator = readFileSync(new URL("../../../../scripts/lib/continuity-generator.mjs", import.meta.url), "utf8");
  const generatorLiterals = literals(generator), generatorGrams = new Set(generatorLiterals.flatMap(grams));
  expect(generatorLiterals.length).toBeGreaterThan(20); expect(generatorGrams.size).toBeGreaterThan(100);
  expect(literals("`alpha ${value} of beta ${other} gamma`", true).flatMap(grams)).toContain("alpha beta gamma");
  expect(literals('"alpha of beta gamma"').flatMap(grams)).toContain("alpha beta gamma");
  // No exceptions currently needed. Any future entry requires a generic-grammar justification.
  const allowlist: Record<string, string> = {};
  const overlaps = (text: string) => grams(text).filter(gram => generatorGrams.has(gram) && !(gram in allowlist));
  const prompt = select([]).prompt;
  const ranking = readFileSync(new URL("../continuity/ranking.ts", import.meta.url), "utf8");
  expect(overlaps(prompt)).toEqual([]);
  expect(literals(ranking).flatMap(overlaps)).toEqual([]);
  for (const phrase of generator.match(/[A-Za-z]{2,}(?: [A-Za-z]{2,}){2,}/gu)!) for (const pattern of SCORE_SHAPES) expect(pattern.test(phrase), `${pattern}: ${phrase}`).toBe(false);
  const forbidden = [...generatorGrams].find(gram => !(gram in allowlist))!;
  expect(overlaps(prompt + "\n" + forbidden)).toContain(forbidden); // Three words suffice, even across interpolations.
  for (const reason of Object.values(allowlist)) expect(reason.length).toBeGreaterThan(20);
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


it("offers fitted sources chronologically without changing ranked selection or citations", () => {
  const records = [row(19, "Reference OAK-891.", "tool"), row(3, "An archival observation."), row(8, "Reference ASH-452.", "tool")];
  const selected = select(records), fitted = fit(records).selection;
  for (const selection of [selected, fitted]) {
    const before = JSON.stringify(selection.spans);
    const offered = selection.prompt.split("\nSources:\n")[1]!.trim().split("\n").map(line => JSON.parse(line) as { id: string; ordinal: number });
    expect(offered.map(s => s.ordinal)).toEqual([...selection.spans].map(s => s.ordinal).sort((a, b) => a! - b!));
    expect(new Set(offered.map(s => s.id))).toEqual(new Set(selection.spans.map(s => s.id)));
    expect(JSON.stringify(selection.spans)).toBe(before);
    expect(selection.prompt).toContain("Source ordinal is host order.");
  }
});

it("renders an earlier diagram sketch before its release regardless of model entry order", () => {
  const records = [row(3, "Origami diagram saved with state DRAFT.", "tool"), row(9, "Origami diagram updated to state FINAL.", "tool"), row(90, "Uncited unrelated observation.")];
  const selection = select(records), id = (ordinal: number) => selection.spans.find(s => s.ordinal === ordinal)!.id;
  const entries = [
    { kind: "artifact", value: "Diagram state FINAL.", status: "unknown", sources: [id(9)] },
    { kind: "artifact", value: "Diagram state DRAFT (prose wrongly says later).", status: "unknown", sources: [id(3)] },
    { kind: "artifact", value: "Combined observations.", status: "unknown", sources: [id(3), id(9)] },
  ];
  const generation = validateLedgerOutput(JSON.stringify({ entries, covered: [id(3), id(9)] }), selection, scope);
  const before = JSON.stringify(generation), text = renderLedger(generation, records), lines = text.split("\n").filter(l => l.startsWith("Derived "));
  expect(lines.map(l => l.match(/order=(\d+)/u)![1])).toEqual(["3", "9", "9"]);
  expect(lines[0]).toContain(entries[1]!.value); expect(lines[1]).toContain(entries[0]!.value);
  expect(text).not.toContain("order=90"); expect(JSON.stringify(generation)).toBe(before);
  // Extending a generation cannot change an existing entry's cited position.
  expect(renderLedger({ ...generation, entries: [...generation.entries].reverse() }, records).split("\n").find(l => l.includes(entries[1]!.value))).toBe(lines[0]);
  const legacy = { ...generation, spans: generation.spans.map(({ ordinal: _ordinal, ...span }) => span) };
  expect(renderLedger(legacy, records).split("\n").filter(l => l.startsWith("Derived ")).every(l => l.includes("order=unknown"))).toBe(true);
});


it("projects long host positions inside the existing rendered line and payload ceilings", () => {
  const record = row(Number.MAX_SAFE_INTEGER - 1, "An archival observation.");
  const fitted = fit([record]);
  const generation = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "artifact", value: "x".repeat(512), status: "unknown", sources: [fitted.selection.spans[0]!.id] }], covered: [fitted.selection.spans[0]!.id] }), fitted.selection, scope);
  const text = renderLedger(generation, [record]);
  expect(text).toContain(`order=${record.ordinal}`);
  expect(text.split("\n").filter(l => l.startsWith("Derived ")).every(l => Buffer.byteLength(l + "\n") <= 1024)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(generation))).toBeLessThanOrEqual(fitted.projectedBytes);
});
