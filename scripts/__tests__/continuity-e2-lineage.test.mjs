// Genuine engine JSONL checkpoints and private generated receipts; no inference or real stores.
import { afterEach, expect, it, vi } from "vitest";
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { bindE2Checkpoint, readE2Checkpoint, verifyE2NativeLineage, e2PhaseWork, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX, e2BodySummaryDigests, e2ArchivePath } from "../lib/continuity-e2-lineage.mjs";
import { writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { E2_REAL_CONTROLLER } from "../lib/continuity-e2-policy.mjs";
import { SOL } from "../lib/continuity-e2-protocol.mjs";
import { lineageFixture } from "./fixtures/e2-lineage-fixture.mjs";
const roots = [], split = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const readArtifact = (...args) => guardedAuthorization("e2-validation").readArtifact(...args);
const readPrivate = (...args) => guardedState("e2-validation").readPrivate(...args);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function fixture(...args) {
  const f = await lineageFixture(...args); roots.push(f.root); vi.stubEnv("HOME", f.root); return f;
}
const body = text => Buffer.from(JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: E2_SUMMARY_PREFIX + text + E2_SUMMARY_SUFFIX }] }] }));
it("binds the actual committed checkpoint to generated receipts and exact decompressed body text", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  expect(lineage.textSha256).toBe(digest(f.assembled)); expect(lineage.generated).toHaveLength(1);
  const hold = { lineageScope: "proof", lineage };
  await expect(verifyE2NativeLineage(body(f.assembled), hold, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1, none: false });
  expect(await readE2Checkpoint(f.root, f.planned, lineage, readArtifact)).toMatchObject({ summary: f.assembled });
});
it("matches split-turn assembly and file metadata exactly, rather than response-envelope hashes", async () => {
  const texts = ["Fictional history.", "Fictional split turn."], details = { readFiles: ["fictional.txt"], modifiedFiles: [] };
  const f = await fixture(texts, texts.join(split) + "\n\n<read-files>\nfictional.txt\n</read-files>", details), lineage = await f.bind();
  expect(lineage.textSha256).toBe(digest(f.assembled)); expect(lineage.generated).toHaveLength(2);
  expect(lineage.generated.map(g => g.sha256)).not.toContain(lineage.textSha256);
});
it("refuses a purported checkpoint that merely contains, but does not assemble, the generated output", async () => {
  const f = await fixture(["Fictional generated evidence."], "Unreceipted prefix: Fictional generated evidence.");
  await expect(f.bind()).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("allows observable absence, but refuses changed text, wrong roles and stale hold authority", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  for (const bytes of [body(f.assembled + " changed"), body(lineage.textSha256),
    Buffer.from(JSON.stringify({ input: [{ role: "assistant", content: E2_SUMMARY_PREFIX + f.assembled + E2_SUMMARY_SUFFIX }] }))]) {
    await expect(verifyE2NativeLineage(bytes, { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  }
  for (const bytes of [Buffer.from(JSON.stringify({ input: [{ role: "user", content: f.assembled }] })), Buffer.from('{"input":[]}')])
    await expect(verifyE2NativeLineage(bytes, { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toEqual({ native: 0, branch: 0, pack: 0, none: true });
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof" }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("rechecks the private checkpoint before fetch and rejects post-ACK mutation", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  const path = e2ArchivePath(f.root, lineage.archiveSha256);
  const bytes = (await readFile(path, "utf8")).replaceAll(f.assembled, "Fictional altered evidence."); await writeFile(path, bytes, { mode: 0o600 });
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("accepts only the complete quoted generated-summary record in a shipping continuity pack", () => {
  const text = "Fictional quoted evidence.\nNext line.", header = "### Conversation continuity pack (historical evidence)\n";
  const encoded = `${header}Generated summary evidence id="chr1_${"a".repeat(43)}" sha256="${digest(text)}": ${JSON.stringify(text)}\n`;
  expect(e2BodySummaryDigests({ input: [{ role: "user", content: encoded }] })).toEqual([digest(text)]);
  expect(e2BodySummaryDigests({ input: [{ role: "user", content: encoded.replace(header, "") }] })).toEqual([]);
});

it("refuses reused or incomplete checkpoints with a fixed integrity code", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.checkpoints = [{ journalId: lineage.journalId, checkpointId: lineage.checkpointId }];
  await expect(f.bind()).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await writeFile(f.journalPath, (await readFile(f.journalPath)).subarray(0, -1));
  await expect(readE2Checkpoint(f.root, f.planned, lineage, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});

it.each([["cancel", "ceiling"], ["pressure", "restart"]])("carries verified %s/%s seed lineage into only the registered resume", async (arm, variant) => {
  const f = await fixture(["Fictional seed summary."], undefined, undefined, { arm, variant, phase: "seed" });
  const lineage = await f.bind(); f.slot.lineages = { proof: lineage }; f.slot.terminal = "own_abort_after_send";
  if (arm === "pressure") await rm(f.journalPath);
  for (const h of f.slot.holds) { h.paidRole = "summary"; h.summaryReceipt.durable = true; }
  const resumed = { ...f.planned, index: 1, phase: "resume" }, slot = { slotId: "c".repeat(64), holds: [] };
  const state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 1, schedule: [f.planned, resumed], slots: [f.slot, slot] };
  const metadata = await e2ExecutionPolicy.beforeAdmission(f.root, slot.slotId, slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, state, {});
  expect(metadata).toEqual({ lineageScope: "proof", lineage });
  await expect(verifyE2NativeLineage(body(f.assembled), metadata, state, { outputRoot: f.root, index: 1 }, readArtifact)).resolves.toMatchObject({ native: 1, none: false });
  delete slot.lineages; f.slot.terminal = "lost";
  await expect(e2ExecutionPolicy.beforeAdmission(f.root, slot.slotId, slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, state, {})).rejects.toMatchObject({ code: "e2_compaction_invalid" });
});
it("does not borrow the main branch's summary authority for a prefix baseline", async () => {
  const f = await fixture(), protocolPath = join(f.root, "protocol.json"), bytes = JSON.stringify({ branches: [{ checkpoints: [{}, {}] }, { checkpoints: [{}] }] });
  await writeFile(protocolPath, bytes, { mode: 0o600 });
  const planned = { kind: "replay", index: 0 }, slot = { slotId: "d".repeat(64), holds: [], lineages: { 0: { textSha256: "f".repeat(64) } } };
  const state = { schema: E2_REAL_CONTROLLER, cursor: 0, schedule: [planned], slots: [slot] }, pilot = { registration: { protocol: { path: protocolPath, sha256: digest(bytes) } } };
  const metadata = await e2ExecutionPolicy.beforeAdmission(f.root, slot.slotId, slot, { paidRole: "probe", checkpoint: 2 }, readPrivate, state, pilot);
  expect(metadata).toEqual({ lineageScope: 1 });
  expect(e2PhaseWork(f.root, planned, 0)).not.toBe(e2PhaseWork(f.root, planned, 1));
});
it("pins the recognized summary encodings to the shipping source serializers", async () => {
  const source = await readFile(new URL("../../packages/turn/src/engine/compaction-kit/messages.ts", import.meta.url), "utf8");
  expect(source.match(/const COMPACTION_SUMMARY_PREFIX = `([\s\S]*?)`;/u)[1]).toBe(E2_SUMMARY_PREFIX);
  expect(source.match(/const COMPACTION_SUMMARY_SUFFIX = `([\s\S]*?)`;/u)[1]).toBe(E2_SUMMARY_SUFFIX);
  const pack = await readFile(new URL("../../packages/conversation/src/continuity/pack.ts", import.meta.url), "utf8");
  expect(pack).toContain('const id = quote(record.recordId);');
  expect(pack).toContain('Generated summary evidence id=${id} sha256=${quote(record.sha256)}: ${quote(record.text)}');
});

it("refuses ill-formed Unicode rather than equating it with a replacement-character digest", async () => {
  const f = await fixture(["\ufffd"]), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  await expect(verifyE2NativeLineage(body("\ud800"), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});

async function nextCompaction(f, slot = f.slot, history = f.assembled) {
  const text = "Fictional subsequent split turn.", assembled = history + split + text;
  const work = e2PhaseWork(f.root, f.planned), repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") });
  const session = await repo.open(f.metadata), turnId = `fictional-next-turn-${slot.holds.length}`, operationId = `fictional-next-compaction-${slot.holds.length}`;
  await session.beginTurn(turnId);
  await session.openOperation(operationId, { model: { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } });
  const checkpointId = await session.appendCompaction({ summary: assembled, retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
  await session.closeOperation(operationId, "completed"); await session.endTurn(turnId, "completed"); await session.sync(); await session.close(); await repo.close();
  const round = slot.holds.length + 1, payloadDigest = "b".repeat(64), rawUsage = { input_tokens: 10, output_tokens: 10 };
  const result = await writeE2SummaryResult({ runId: "fictional-run", slotId: slot.slotId, e2: { paidRole: "summary", model: SOL, round, outputRoot: f.root } }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }, rawUsage, "default", payloadDigest);
  const hold = { requestId: `fictional-run:${round}`, paidRole: "summary", round, model: SOL, payloadDigest, summaryReceipt: { ...result.evidence, verified: true, durable: false }, settlement: { kind: "settled", rawUsage, tier: "default" } };
  slot.holds.push(hold);
  return { assembled, hold, reference: { ...f.reference, checkpointId } };
}
it("binds two compactions in one journal using verified historical lineage, never a stale native checkpoint", async () => {
  const f = await fixture(), prior = await f.bind(); f.slot.lineages = { proof: prior };
  const next = await nextCompaction(f);
  const bind = () => bindE2Checkpoint({ root: f.root, state: f.state, planned: f.planned, slot: f.slot, summaries: [next.hold], reference: next.reference, readPrivate, readArtifact });
  const lineage = await bind(); expect(lineage.textSha256).toBe(digest(next.assembled));
  await expect(readE2Checkpoint(f.root, f.planned, prior, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  // The historical archive remains valid even when the live journal advances.
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage: prior }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1 });
  f.slot.lineages.proof = lineage;
  await expect(verifyE2NativeLineage(body(next.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1 });
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage: prior }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  // Every predecessor remains digest bound, even if the request has no summary.
  await writeFile(e2ArchivePath(f.root, prior.archiveSha256), "{}\n", { mode: 0o600 });
  await expect(verifyE2NativeLineage(Buffer.from('{"input":[]}'), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it.each(["probe", "summary"])("binds a resume compaction after the seed when its first paid request is %s", async paidRole => {
  const f = await fixture(["Fictional seed summary."], undefined, undefined, { arm: "cancel", phase: "seed" });
  const prior = await f.bind(); f.slot.lineages = { proof: prior }; f.slot.terminal = "own_abort_after_send";
  for (const h of f.slot.holds) h.summaryReceipt.durable = true;
  const planned = { ...f.planned, index: 1, phase: "resume" }, slot = { slotId: "c".repeat(64), holds: [] };
  const state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 1, schedule: [f.planned, planned], slots: [f.slot, slot] };
  await e2ExecutionPolicy.beforeAdmission(f.root, slot.slotId, slot, { paidRole, checkpoint: 0 }, readPrivate, state, {});
  expect(slot.lineages.proof).toEqual(prior);
  const next = await nextCompaction(f, slot);
  const lineage = await bindE2Checkpoint({ root: f.root, state, planned, slot, summaries: [next.hold], reference: next.reference, readPrivate, readArtifact });
  expect(lineage.phase).toBe(1); expect(lineage.textSha256).toBe(digest(next.assembled)); slot.lineages.proof = lineage;
  await expect(verifyE2NativeLineage(body(next.assembled), { lineageScope: "proof", lineage }, state, { outputRoot: f.root, index: 1 }, readArtifact)).resolves.toMatchObject({ native: 1, none: false });
});
it.each(["summary", "probe", "continuation"].flatMap(role => [false, true].map(lineage => [role, lineage])))("refuses %s after a lost seed without a stop, including preexisting lineage=%s", async (paidRole, existing) => {
  const seed = { kind: "proof", phase: "seed", arm: "cancel", variant: "restart" }, planned = { ...seed, phase: "resume" };
  const slot = { holds: [], ...(existing ? { lineages: { proof: { textSha256: "f".repeat(64) } } } : {}) };
  const state = { schema: E2_REAL_CONTROLLER, cursor: 1, stop: null, schedule: [seed, planned], slots: [{ terminal: "lost", holds: [] }, slot] };
  await expect(e2ExecutionPolicy.beforeAdmission("unused", "unused", slot, { paidRole, checkpoint: 0 }, readPrivate, state, {})).rejects.toMatchObject({ code: "e2_compaction_invalid" });
});

it("requires lineage for the current summary scope, not an empty or unrelated map", async () => {
  const f = await fixture(); await f.bind(); for (const h of f.slot.holds) { h.summaryReceipt.durable = true; h.checkpoint = 0; }
  f.slot.lineages = {};
  const state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 0 };
  await expect(e2ExecutionPolicy.beforeAdmission(f.root, f.slot.slotId, f.slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, state, {})).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  f.slot.lineages = { unrelated: { textSha256: "f".repeat(64) } };
  await expect(e2ExecutionPolicy.beforeAdmission(f.root, f.slot.slotId, f.slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, state, {})).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});

it("does not demand main-branch summary lineage for an untouched prefix baseline", async () => {
  const f = await fixture(), lineage = await f.bind(); for (const h of f.slot.holds) { h.summaryReceipt.durable = true; h.checkpoint = 0; }
  f.slot.lineages = { 0: lineage };
  const protocolPath = join(f.root, "scope-protocol.json"), bytes = JSON.stringify({ branches: [{ checkpoints: [{}] }, { checkpoints: [{}] }] });
  await writeFile(protocolPath, bytes, { mode: 0o600 });
  const planned = { kind: "replay", index: 0 }, state = { schema: E2_REAL_CONTROLLER, cursor: 0, schedule: [planned], slots: [f.slot] };
  const pilot = { registration: { protocol: { path: protocolPath, sha256: digest(bytes) } } };
  await expect(e2ExecutionPolicy.beforeAdmission(f.root, f.slot.slotId, f.slot, { paidRole: "probe", checkpoint: 1 }, readPrivate, state, pilot)).resolves.toEqual({ lineageScope: 1 });
});

it("rejects a stale seed predecessor even if it was once valid in the same scope", async () => {
  const f = await fixture(undefined, undefined, undefined, { arm: "pressure", variant: "restart", phase: "seed" });
  const prior = await f.bind(); f.slot.lineages = { proof: prior };
  const next = await nextCompaction(f);
  const current = await bindE2Checkpoint({ ...f.options, summaries: [next.hold], reference: next.reference });
  f.slot.lineages.proof = current; f.slot.terminal = "completed";
  const planned = { ...f.planned, index: 1, phase: "resume" }, slot = { slotId: "c".repeat(64), holds: [], lineages: { proof: prior } };
  const state = { schedule: [f.planned, planned], slots: [f.slot, slot] };
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage: prior }, state, { outputRoot: f.root, index: 1 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("assembles a later checkpoint from archived history after the predecessor journal retires", async () => {
  const f = await fixture(), prior = await f.bind(); f.slot.lineages = { proof: prior };
  await rm(f.journalPath);
  const repo = new JsonlSessionRepo({ sessionsRoot: join(f.work, "sessions") }), session = await repo.create({ id: "fictional-new-epoch", cwd: f.work });
  f.metadata = { ...session.metadata }; await session.close(); await repo.close();
  const next = await nextCompaction(f);
  const lineage = await bindE2Checkpoint({ ...f.options, summaries: [next.hold], reference: { ...next.reference, journalId: f.metadata.journalId } });
  f.slot.lineages.proof = lineage;
  await expect(verifyE2NativeLineage(body(next.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1 });
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1 });
});

it.each(["registered-older", "cold-empty"])("binds a new split checkpoint after %s restoration without inventing summary history", async kind => {
  const f = await fixture(), prior = await f.bind(); f.slot.lineages = { proof: prior };
  const first = await nextCompaction(f);
  f.slot.lineages.proof = await bindE2Checkpoint({ ...f.options, summaries: [first.hold], reference: first.reference });
  const restored = await nextCompaction(f, f.slot, kind === "cold-empty" ? "No prior history." : f.assembled);
  const lineage = await bindE2Checkpoint({ ...f.options, summaries: [restored.hold], reference: restored.reference });
  f.slot.lineages.proof = lineage;
  await expect(verifyE2NativeLineage(body(restored.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toMatchObject({ native: 1 });
});
