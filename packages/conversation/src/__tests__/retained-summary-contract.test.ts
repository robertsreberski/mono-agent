import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createContinuityPackSupplier, renderContinuityPack } from "../continuity/pack.js";
import type { LedgerGeneration } from "../continuity/ledger.js";
import type { ConversationHarnessOptions } from "../harness/contracts.js";
import type { ContinuityPreparation, RetainedSummaryBinding } from "../tool-history/continuity-contracts.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";
import { retainContinuityText } from "../tool-history/continuity-payload.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";

const scope = { logicalConversationId: "fictional", currentConversationId: "fictional:bucket", currentRunId: "current" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "retained-summary-contract-"));
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
  resources.push({ root, writer });
  return { root, writer, reader: new ToolHistoryReader(root) };
}
function preparation(operationId = "cut-one", text = "Morgan chose the cobalt rectangle. 🦊"): ContinuityPreparation {
  const recordId = continuityRecordId(scope.currentConversationId, `summary:fiction-journal:${operationId}`);
  return { generationId: continuityGenerationId(), conversationId: scope.currentConversationId, logicalConversationId: scope.logicalConversationId,
    beforeDigest: hash("canonical"), afterDigest: hash("canonical"), action: "checkpoint", latestSummaryRecordId: recordId,
    records: [{ recordId, runId: "source-run", kind: "summary", sequence: 0, text, provenance: "generated",
      source: { epoch: "source-epoch", revision: 3, journalId: "fiction-journal", operationId },
      summary: { model: "faux:summary", operationId, trigger: "manual", coverage: { sourceDigest: hash("coverage") } } }] };
}
async function publish(f: Awaited<ReturnType<typeof fixture>>, input = preparation()) {
  await f.writer.prepareContinuity(input);
  const record = input.records[0]!;
  await f.writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: input.afterDigest,
    checkpoint: { status: "published", journalId: record.source!.journalId!, operationId: record.source!.operationId!,
      sourceDigest: record.summary!.coverage.sourceDigest, summaryDigest: retainContinuityText(record.text).sha256 } });
  return input;
}
function alter(f: Awaited<ReturnType<typeof fixture>>, sql: string) {
  const db = new DatabaseSync(f.reader.databasePath);
  try { db.exec(sql); } finally { db.close(); }
}

it("requires committed checkpoint publication, then resolves exact retained bytes after reader restart without writing", async () => {
  const f = await fixture(), input = preparation();
  await f.writer.prepareContinuity(input);
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
  await expect(f.writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: input.afterDigest }))
    .rejects.toMatchObject({ code: "continuity_publication_mismatch" });
  await publish(f, input);
  const before = await f.writer.stats();
  const proof = f.reader.eligibleRetainedSummary(scope)!;
  expect(proof).toEqual({ text: input.records[0]!.text, binding: { version: 1, logicalConversationId: scope.logicalConversationId,
    conversationId: scope.currentConversationId, generationId: input.generationId, recordId: input.records[0]!.recordId,
    sha256: hash(input.records[0]!.text), retainedBytes: Buffer.byteLength(input.records[0]!.text), sourceEpoch: "source-epoch", sourceRevision: 3,
    publication: { journalId: "fiction-journal", operationId: "cut-one", sourceDigest: hash("coverage"), summaryDigest: hash(input.records[0]!.text) } } });
  expect(new ToolHistoryReader(f.root).resolveRetainedSummary(scope, proof.binding)).toEqual(proof);
  expect(await f.writer.stats()).toEqual(before);
});

it("separates pinned eligibility from exact historical binding resolution without extending retention", async () => {
  const f = await fixture(); await publish(f);
  const first = f.reader.eligibleRetainedSummary(scope)!;
  await publish(f, preparation("cut-two", "A newer fictional summary."));
  expect(f.reader.eligibleRetainedSummary(scope)!.binding.recordId).not.toBe(first.binding.recordId);
  expect(f.reader.snapshotContinuity(scope).records.map(r => r.recordId)).not.toContain(first.binding.recordId);
  expect(f.reader.resolveRetainedSummary(scope, first.binding)).toEqual(first);
  alter(f, `UPDATE continuity_records SET retained_text=NULL WHERE record_id='${first.binding.recordId}'`);
  expect(f.reader.resolveRetainedSummary(scope, first.binding)).toBeUndefined();
});

it("does not promote forged generated-summary labels and pins from ordinary committed publication", async () => {
  const f = await fixture(), cut = preparation();
  const ordinary = { ...cut, action: "publish" as const, beforeDigest: null };
  await f.writer.prepareContinuity(ordinary);
  await f.writer.commitContinuity({ conversationId: ordinary.conversationId, generationId: ordinary.generationId, canonicalDigest: ordinary.afterDigest });
  expect(f.reader.latestContinuitySummary(scope)).toBeDefined();
  expect(renderContinuityPack(f.reader.snapshotContinuity(scope), []).counts.summary).toBe(1);
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
});

it.each([
  "UPDATE continuity_generations SET state='prepared'",
  "UPDATE continuity_generations SET committed_at_ms=NULL",
  "UPDATE continuity_records SET finalized=0",
  "UPDATE continuity_records SET provenance='unknown'",
  "UPDATE continuity_records SET retained_text='Altered fictional bytes'",
  "UPDATE continuity_records SET text_sha256='altered'",
  "UPDATE continuity_records SET retained_bytes=1",
  "UPDATE continuity_records SET truncated=1",
  "UPDATE continuity_records SET source_json='{}'",
  "UPDATE continuity_records SET source_json='null'",
  "UPDATE continuity_records SET summary_json=NULL",
  "UPDATE continuity_records SET summary_json='{}'",
  "UPDATE continuity_records SET retained_text=NULL",
  "UPDATE continuity_generations SET latest_summary_record_id=NULL",
])("returns no proof for damaged or missing publication provenance: %s", async sql => {
  const f = await fixture(); await publish(f);
  const binding = f.reader.eligibleRetainedSummary(scope)!.binding;
  alter(f, sql);
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
  expect(f.reader.resolveRetainedSummary(scope, binding)).toBeUndefined();
});

it("binds every identity, digest and source field, not just a caller's digest-shaped value", async () => {
  const f = await fixture(); await publish(f);
  const binding = f.reader.eligibleRetainedSummary(scope)!.binding;
  for (const key of ["logicalConversationId", "conversationId", "generationId", "recordId", "sha256", "sourceEpoch"] as const) {
    expect(f.reader.resolveRetainedSummary(scope, { ...binding, [key]: "different" }), key).toBeUndefined();
  }
  for (const key of ["sourceRevision", "retainedBytes"] as const) expect(f.reader.resolveRetainedSummary(scope, { ...binding, [key]: 99 }), key).toBeUndefined();
  for (const key of ["journalId", "operationId", "sourceDigest", "summaryDigest"] as const) {
    expect(f.reader.resolveRetainedSummary(scope, { ...binding, publication: { ...binding.publication, [key]: "different" } }), key).toBeUndefined();
  }
  expect(f.reader.resolveRetainedSummary(scope, { ...binding, version: 2 } as unknown as RetainedSummaryBinding)).toBeUndefined();
  expect(f.reader.resolveRetainedSummary(scope, undefined as unknown as RetainedSummaryBinding)).toBeUndefined();
});

it("requires physical/logical/run and continuation scope without comparing source and destination epochs", async () => {
  const f = await fixture(); await publish(f);
  const binding = f.reader.eligibleRetainedSummary(scope)!.binding;
  for (const wrong of [{ logicalConversationId: "foreign" }, { currentConversationId: "fictional:other-bucket" }, { currentRunId: "source-run" }, { historyBoundary: "missing" }]) {
    expect(f.reader.eligibleRetainedSummary({ ...scope, ...wrong })).toBeUndefined();
    expect(f.reader.resolveRetainedSummary({ ...scope, ...wrong }, binding)).toBeUndefined();
  }
  // An earlier canonical boundary cannot admit a later summary.
  alter(f, "UPDATE continuity_records SET kind='user',summary_json=NULL,provenance='unknown',run_id='boundary'");
  await publish(f, preparation("cut-later"));
  expect(f.reader.eligibleRetainedSummary({ ...scope, historyBoundary: "boundary" })).toBeUndefined();
});

it.each(["epoch", "revision", "journalId", "operationId"] as const)("legacy source missing %s gains no new authority but renders unchanged", async key => {
  const f = await fixture(), cut = preparation(), record = cut.records[0]!, source = { ...record.source };
  delete source[key];
  // Missing journal/operation provenance cannot even pass checkpoint publication;
  // simulate a legacy row only after the host has committed a valid checkpoint.
  await publish(f, cut);
  const before = renderContinuityPack(f.reader.snapshotContinuity(scope), []).text;
  const db = new DatabaseSync(f.reader.databasePath);
  try { db.prepare("UPDATE continuity_records SET source_json=?").run(JSON.stringify(source)); } finally { db.close(); }
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
  expect(renderContinuityPack(f.reader.snapshotContinuity(scope), []).text).toBe(before);
});

it.each(["logical", "physical"] as const)("suppresses pending and completed %s purge without cached proof reuse", async purgeScope => {
  const f = await fixture(); await publish(f);
  const binding = f.reader.eligibleRetainedSummary(scope)!.binding;
  persistContinuityPurge(f.root, { scope: purgeScope, conversationId: purgeScope === "logical" ? scope.logicalConversationId : scope.currentConversationId });
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
  expect(f.reader.resolveRetainedSummary(scope, binding)).toBeUndefined();
  await f.writer.resetConversation(scope.logicalConversationId);
  expect(new ToolHistoryReader(f.root).resolveRetainedSummary(scope, binding)).toBeUndefined();
});

it.each(["reset", "delete"] as const)("suppresses a prepared %s and permits only the retained redacted representation", async action => {
  const f = await fixture(); await publish(f, preparation("redacted", "Keep cobalt. token=sk-abcdefghijklmnopqrstuvwxyz1234567890"));
  const proof = f.reader.eligibleRetainedSummary(scope)!;
  expect(proof.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
  expect(proof.binding.sha256).toBe(hash(proof.text));
  await f.writer.prepareContinuity({ generationId: continuityGenerationId(), conversationId: scope.currentConversationId,
    logicalConversationId: scope.logicalConversationId, action, beforeDigest: hash("canonical"), afterDigest: action === "delete" ? null : hash("reset"), records: [] });
  expect(f.reader.resolveRetainedSummary(scope, proof.binding)).toBeUndefined();
});

it("exposes only the final successful renderer entry with exact UTF-8 location and whole-pack commitment", async () => {
  const f = await fixture(); await publish(f);
  const snapshot = f.reader.snapshotContinuity(scope), record = snapshot.records[0]!;
  const pack = renderContinuityPack(snapshot, [], 8000, undefined, false, true), selection = pack.summarySelection!;
  const entry = Buffer.from(pack.text!).subarray(selection.entry.startByte, selection.entry.endByte).toString();
  expect(entry).toBe(`Generated summary evidence id=${JSON.stringify(record.recordId)} sha256=${JSON.stringify(record.sha256)}: ${JSON.stringify(record.text)}\n`);
  expect(selection).toMatchObject({ recordId: record.recordId, generationId: record.generationId, sha256: record.sha256,
    retainedBytes: record.retainedBytes, packSha256: hash(pack.text!), entry: { sha256: hash(entry) } });
  expect(renderContinuityPack({ records: [], omitted: 0, gaps: 0 }, []).summarySelection).toBeUndefined();
  expect(renderContinuityPack(snapshot, [], 0).summarySelection).toBeUndefined();
  const large = { ...record, text: "Whole summary. ".repeat(1000) };
  const omitted = renderContinuityPack({ ...snapshot, records: [large] }, [], 700);
  expect(omitted.text).toContain("Generated summary omitted");
  expect(omitted.summarySelection).toBeUndefined();
  // The small summary is chosen, but later whole-summary omission disclosures
  // exhaust final headroom. Tentative selection must not survive that failure.
  const rejected = renderContinuityPack({ ...snapshot, records: [record,
    ...Array.from({ length: 15 }, (_, i) => ({ ...large, recordId: `oversized-${i}` }))] }, [], 700);
  expect(rejected.degradedReason).toBe("headroom"); expect(rejected.summarySelection).toBeUndefined();
});

it.each(["omission", "headroom", "purge", "source_changed", "unavailable"])("clears supplier selection after %s, outside all projected messages", async reason => {
  const f = await fixture(); await publish(f, preparation("supplier", "Whole fictional summary. ".repeat(120)));
  const options = { toolHistory: { ...f, logicalConversationId: () => scope.logicalConversationId, continuityEnabled: true } } as unknown as ConversationHarnessOptions;
  const request = { conversationId: scope.currentConversationId, userMessage: "Current fictional request.", abortSignal: new AbortController().signal };
  const supplier = createContinuityPackSupplier(options, request, scope.currentRunId)!;
  const first = supplier([], 8000, "cold", () => {});
  expect(supplier.selectedSummary()).toBeDefined();
  expect(Object.keys(first[0]!)).toEqual(["role", "content", "timestamp"]);
  let maxTokens = 8000;
  if (reason === "omission") maxTokens = 500;
  if (reason === "headroom") maxTokens = 0;
  if (reason === "purge") persistContinuityPurge(f.root, { scope: "logical", conversationId: scope.logicalConversationId });
  if (reason === "source_changed") vi.spyOn(f.reader, "continuitySnapshotVisible").mockReturnValue(false);
  if (reason === "unavailable") {
    vi.spyOn(f.reader, "continuitySnapshotVisible").mockImplementation(() => { throw new Error("Fictional source unavailable"); });
  }
  supplier([], maxTokens, "retry", () => {});
  expect(supplier.selectedSummary()).toBeUndefined();
});

it("does not leak a fallback layout's summary selection when the final ledger layout omits it", async () => {
  const f = await fixture(); await publish(f, preparation("ledger", "Whole fictional summary. ".repeat(90)));
  const snapshot = f.reader.snapshotContinuity(scope);
  const generation: LedgerGeneration = { id: "fiction-ledger", parent: null, conversationId: scope.currentConversationId,
    logicalId: scope.logicalConversationId, manifest: "fixture", inputs: [], spans: [], coveredOwners: [], uncovered: 0,
    entries: [{ kind: "artifact", value: "Derived fictional detail. ".repeat(8), status: "unknown", sources: [] }] };
  // Find the existing whole-entry admission boundary; no budget or ranking changes.
  const budget = Array.from({ length: 1500 }, (_, i) => 500 + i).find(limit => {
    const fallback = renderContinuityPack(snapshot, [], limit);
    const final = renderContinuityPack(snapshot, [], limit, { generation, records: snapshot.records });
    return fallback.counts.summary === 1 && final.ledgerEntries === 1 && final.counts.summary === 0;
  });
  expect(budget).toBeDefined();
  const final = renderContinuityPack(snapshot, [], budget!, { generation, records: snapshot.records });
  expect(final.text).toContain("Generated summary omitted");
  expect(final.summarySelection).toBeUndefined();
});

it.each(["unavailable", "boundary_unavailable"] as const)("supplies no selection for an initially %s snapshot", async degradedReason => {
  const f = await fixture();
  expect(f.reader.eligibleRetainedSummary(scope)).toBeUndefined();
  vi.spyOn(f.reader, "snapshotContinuity").mockReturnValue({ records: [], omitted: 0, gaps: 1, degradedReason });
  const supplier = createContinuityPackSupplier({ toolHistory: { ...f, logicalConversationId: () => scope.logicalConversationId, continuityEnabled: true } } as unknown as ConversationHarnessOptions,
    { conversationId: scope.currentConversationId, userMessage: "Current.", abortSignal: new AbortController().signal }, scope.currentRunId)!;
  expect(supplier([], 8000, "cold", () => {})[0]!.content).toContain("coverage gap");
  expect(supplier.selectedSummary()).toBeUndefined();
});
