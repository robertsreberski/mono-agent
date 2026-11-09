// Genuine engine JSONL checkpoints and private generated receipts; no inference or real stores.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { bindE2Checkpoint, readE2Checkpoint, verifyE2NativeLineage, e2PhaseWork, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX, e2BodySummaryDigests } from "../lib/continuity-e2-lineage.mjs";
import { writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { E2_REAL_CONTROLLER } from "../lib/continuity-e2-policy.mjs";
import { SOL } from "../lib/continuity-e2-protocol.mjs";
const roots = [], split = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const readArtifact = (...args) => guardedAuthorization("e2-validation").readArtifact(...args);
const readPrivate = (...args) => guardedState("e2-validation").readPrivate(...args);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function fixture(texts = ["Fictional committed evidence."], assembled = texts.join(split), details = { readFiles: [], modifiedFiles: [] }, plannedPatch = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-lineage-"))); roots.push(root); vi.stubEnv("HOME", root);
  await mkdir(join(root, "e2-summary-results"), { mode: 0o700 });
  const planned = { index: 0, kind: "proof", arm: "pressure", variant: "ceiling", phase: "whole", ...plannedPatch }, slot = { slotId: "a".repeat(64), holds: [] }, state = { schedule: [planned], slots: [slot] };
  const work = e2PhaseWork(root, planned); await mkdir(work, { recursive: true, mode: 0o700 });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") }), session = await repo.create({ id: "fictional-session", cwd: work });
  await session.beginTurn("fictional-turn"); await session.openOperation("fictional-compaction", { model: { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } });
  const checkpointId = await session.appendCompaction({ summary: assembled, retainedTail: [], tokensBefore: 100, details });
  await session.closeOperation("fictional-compaction", "completed"); await session.endTurn("fictional-turn", "completed"); await session.sync();
  const reference = { journalId: session.metadata.journalId, checkpointId, checkpoint: 0 }, journalPath = session.metadata.path; await session.close(); await repo.close();
  const rawUsage = { input_tokens: 10, output_tokens: 10 };
  for (const [i, text] of texts.entries()) {
    const round = i + 1, payloadDigest = "b".repeat(64), message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
    const result = await writeE2SummaryResult({ runId: "fictional-run", slotId: slot.slotId, e2: { paidRole: "summary", model: SOL, round, outputRoot: root } }, message, rawUsage, "default", payloadDigest);
    slot.holds.push({ requestId: `fictional-run:${round}`, round, model: SOL, payloadDigest, summaryReceipt: { ...result.evidence, verified: true, durable: false },
      settlement: { kind: "settled", rawUsage, tier: "default" } });
  }
  const bind = () => bindE2Checkpoint({ root, state, planned, slot, summaries: slot.holds, reference, readPrivate, readArtifact });
  return { root, state, planned, slot, reference, journalPath, assembled, bind };
}
const body = text => Buffer.from(JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: E2_SUMMARY_PREFIX + text + E2_SUMMARY_SUFFIX }] }] }));
it("binds the actual committed checkpoint to generated receipts and exact decompressed body text", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  expect(lineage.textSha256).toBe(digest(f.assembled)); expect(lineage.generated).toHaveLength(1);
  const hold = { lineageScope: "proof", lineage };
  await expect(verifyE2NativeLineage(body(f.assembled), hold, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).resolves.toBeUndefined();
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
it("refuses omission, digest-only claims, changed text, wrong roles and arbitrary substring placement", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  for (const bytes of [body(f.assembled + " changed"), body(lineage.textSha256), Buffer.from(JSON.stringify({ input: [{ role: "user", content: f.assembled }] })),
    Buffer.from(JSON.stringify({ input: [{ role: "assistant", content: E2_SUMMARY_PREFIX + f.assembled + E2_SUMMARY_SUFFIX }] })),
    Buffer.from(JSON.stringify({ instructions: f.assembled, input: [] }))]) {
    await expect(verifyE2NativeLineage(bytes, { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  }
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof" }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("rechecks the private checkpoint before fetch and rejects post-ACK mutation", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  const bytes = (await readFile(f.journalPath, "utf8")).replaceAll(f.assembled, "Fictional altered evidence."); await writeFile(f.journalPath, bytes, { mode: 0o600 });
  await expect(verifyE2NativeLineage(body(f.assembled), { lineageScope: "proof", lineage }, f.state, { outputRoot: f.root, index: 0 }, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("accepts only the complete quoted generated-summary record in a shipping continuity pack", () => {
  const text = "Fictional quoted evidence.\nNext line.", header = "### Conversation continuity pack (historical evidence)\n";
  const encoded = `${header}Generated summary evidence id="chr1_${"a".repeat(43)}" sha256="${"a".repeat(64)}": ${JSON.stringify(text)}\n`;
  expect(e2BodySummaryDigests({ input: [{ role: "user", content: encoded }] })).toEqual([digest(text)]);
  expect(e2BodySummaryDigests({ input: [{ role: "user", content: encoded.replace(header, "") }] })).toEqual([]);
});

it("refuses reused or incomplete checkpoints with a fixed integrity code", async () => {
  const f = await fixture(), lineage = await f.bind(); f.slot.checkpoints = [{ journalId: lineage.journalId, checkpointId: lineage.checkpointId }];
  await expect(f.bind()).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await writeFile(f.journalPath, (await readFile(f.journalPath)).subarray(0, -1));
  await expect(readE2Checkpoint(f.root, f.planned, lineage, readArtifact)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});

it("carries verified seed lineage into the planned cancellation resume, not recovery after a loss", async () => {
  const f = await fixture(["Fictional seed summary."], undefined, undefined, { arm: "cancel", phase: "seed" });
  const lineage = await f.bind(); f.slot.lineages = { proof: lineage }; f.slot.terminal = "own_abort_after_send";
  for (const h of f.slot.holds) { h.paidRole = "summary"; h.summaryReceipt.durable = true; }
  const resumed = { ...f.planned, index: 1, phase: "resume" }, slot = { slotId: "c".repeat(64), holds: [] };
  const state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 1, schedule: [f.planned, resumed], slots: [f.slot, slot] };
  const metadata = await e2ExecutionPolicy.beforeAdmission(f.root, slot.slotId, slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, state, {});
  expect(metadata).toEqual({ lineageScope: "proof", lineage });
  await expect(verifyE2NativeLineage(body(f.assembled), metadata, state, { outputRoot: f.root, index: 1 }, readArtifact)).resolves.toBeUndefined();
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
