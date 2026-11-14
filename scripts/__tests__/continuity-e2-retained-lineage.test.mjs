// Fictional real publication/admission; shipping wire conversion and controller gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { e2ProtectedSummaryPolicies } from "../lib/continuity-e2-summary-plan.mjs";
import { rehearseE2Protected, E2_PROTECTED_TEXT } from "../lib/continuity-e2-protected.mjs";
import { bindE2Checkpoint, e2PhaseWork, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX, E2_BRANCH_PREFIX } from "../lib/continuity-e2-lineage.mjs";
import { bindE2NativeCompaction } from "../lib/continuity-e2-journals.mjs";
import { e2NativeCompactionSnapshot } from "../lib/continuity-e2-compaction.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
import { convertResponsesMessages } from "../../packages/turn/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { createHistorySummaryContext, createPrefixSummaryContext } from "../../packages/turn/dist/engine/compaction-kit/compaction.js";
const interception = vi.hoisted(() => ({ read: null }));
vi.mock("../lib/continuity-guarded-authorization.mjs", async original => {
  const module = await original();
  return { ...module, guardedAuthorization: (...args) => {
    const native = module.guardedAuthorization(...args);
    return { ...native, readArtifact: (...a) => interception.read?.(...a) ?? native.readArtifact(...a) };
  } };
});
const roots = [], denied = () => { throw Error("Network forbidden in retained lineage proof"); };
beforeEach(() => { vi.stubGlobal("fetch", denied); for (const client of [http, https]) for (const method of ["request", "get"]) vi.spyOn(client, method).mockImplementation(denied); syncBuiltinESMExports(); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); interception.read = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); syncBuiltinESMExports(); });
const model = { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272000, maxTokens: 128000 };
async function fixture(carrier, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-retained-"))); roots.push(root); vi.stubEnv("HOME", root);
  await mkdir(join(root, "e2-summary-results"), { mode: 0o700 });
  const planned = { index: 0, kind: "proof", arm: "pressure", variant: "ceiling", phase: "whole" }, slot = { slotId: "a".repeat(64), holds: [], lineages: {} }, state = { schedule: [planned], slots: [slot] };
  state.summaryPolicies = await e2ProtectedSummaryPolicies([{ ...model, ...(hooks.fallback && carrier === "quotation" ? { contextWindow: 32000, maxTokens: 4096 } : {}) }]);
  const readArtifact = path => readFile(path), readPrivate = async path => JSON.parse(await readFile(path, "utf8")), work = e2PhaseWork(root, planned);
  let round = 0;
  const resultHold = async (text, key, payloadDigest, extra = {}) => {
    const n = ++round, message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }, rawUsage = { input_tokens: 10, output_tokens: 10 };
    const receipt = await writeE2SummaryResult({ runId: "fictional-retained", slotId: slot.slotId, e2: { paidRole: "summary", model: key, round: n, outputRoot: root } }, message, rawUsage, "default", payloadDigest);
    return { requestId: `fictional-retained:${n}`, round: n, model: key, tools: [], paidRole: "summary", payloadDigest, checkpoint: 0, lineageScope: "proof", lineage: slot.lineages.proof,
      summaryReceipt: { ...receipt.evidence, verified: true, durable: false }, settlement: { kind: "settled", rawUsage, tier: "default" }, ...extra };
  };
  const wire = context => Buffer.from(JSON.stringify({ model: model.id, store: false, stream: true, instructions: context.systemPrompt,
    input: convertResponsesMessages({ ...model, api: "openai-codex-responses", input: ["text"] }, context, new Set(["openai-codex"]), { includeSystemPrompt: false }) }));
  const gate = async (raw, context, text = E2_PROTECTED_TEXT, mutate = () => {}) => {
    let bytes = wire(context); const operationId = [...raw.validator.openOperations].at(-1), operationDigest = digest(operationId);
    slot.compaction = { checkpoint: 0, operationDigest, nativeSnapshot: [{ retainedAdmission: true }] };
    const hold = await resultHold(text, `${model.provider}:${model.id}`, digest(bytes), { operationDigest });
    hold.nativeCompaction = await bindE2NativeCompaction(work, operationDigest, hold.payloadDigest, readArtifact);
    const change = await mutate({ bytes, hold, slot, state, raw, work }); if (change) { bytes = change; hold.payloadDigest = digest(bytes); hold.nativeCompaction.payloadDigest = hold.payloadDigest; }
    await e2ExecutionPolicy.verifyBody(root, hold, state, 0, { permit: { epoch: "fictional", permitId: "fictional" }, body: bytes.toString("base64") });
    return hold;
  };
  const f = { root, work, slot, state, planned, wire, gate, readArtifact, readPrivate, resultHold };
  await rehearseE2Protected({ work, model, carrier, ...hooks,
    onPublication: async ({ summary, checkpoint }) => {
      f.original = summary;
      const hold = await resultHold(summary, checkpoint.model, "b".repeat(64));
      // The durable evidence model is the public provider:model string.
      slot.lineages.proof = await bindE2Checkpoint({ root, state, planned, slot, summaries: [hold], reference: { journalId: checkpoint.journalId, checkpointId: checkpoint.checkpointId, checkpoint: 0 }, readPrivate, readArtifact });
      await hooks.onPublication?.(f);
    },
    onAdmission: async args => hooks.onAdmission?.(f, args),
    onSummary: async args => { if (hooks.onSummary) return hooks.onSummary(f, args); const hold = await gate(args.raw, args.context, args.text); expect(hold.retainedPredecessor).toBeDefined(); slot.holds.push(hold); },
  });
  return f;
}
it.each(["quotation", "carry"])("authenticates the redacted %s predecessor at the exact payload hold", async carrier => {
  const f = await fixture(carrier, { refusal: true });
  expect(f.slot.holds).toHaveLength(2);
  for (const h of f.slot.holds) expect(h.retainedPredecessor).toMatchObject({ operationDigest: h.operationDigest, payloadDigest: h.payloadDigest, textSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
}, 60000);

it.each(["quotation", "carry"].flatMap(carrier => ["altered", "forged", "original", "wrong-scope", "wrong-destination", "missing-receipt", "wrong-seed", "covered", "wrong-operation", "wrong-coverage", "no-lineage", "native", "branch", "forged-split", "omitted-history"].map(kind => [carrier, kind])))("refuses %s %s before the local inference boundary", async (carrier, kind) => {
  let inferred = 0;
  await expect(fixture(carrier, { onSummary: async (f, { raw, context, text, active }) => {
    try { await f.gate(raw, context, text, async ({ bytes, hold, state, slot }) => {
      if (kind === "altered") { const body = JSON.parse(bytes); body.input[0].content[0].text = body.input[0].content[0].text.replace(active.text, active.text + " altered"); return Buffer.from(JSON.stringify(body)); }
      if (kind === "original") { const body = JSON.parse(bytes); body.input[0].content[0].text = body.input[0].content[0].text.replace(active.text, f.original); return Buffer.from(JSON.stringify(body)); }
      if (kind === "forged") { const body = JSON.parse(bytes); body.input[0].content[0].text = body.input[0].content[0].text.replace(active.text, "Fictional forged predecessor."); return Buffer.from(JSON.stringify(body)); }
      if (kind === "forged-split") return f.wire(createPrefixSummaryContext([]));
      if (kind === "omitted-history") return f.wire(createHistorySummaryContext([], { previousSummary: active.text }));
      if (kind === "no-lineage") { slot.lineages = {}; hold.lineage = undefined; }
      if (kind === "wrong-scope") { hold.lineageScope = 0; slot.lineages[0] = slot.lineages.proof; }
      if (kind === "wrong-operation") { hold.operationDigest = digest("fictional-other-operation"); slot.compaction.operationDigest = hold.operationDigest; }
      if (["native", "branch"].includes(kind)) return f.wire({ messages: [{ role: "user", content: kind === "native" ? E2_SUMMARY_PREFIX + active.text + E2_SUMMARY_SUFFIX : E2_BRANCH_PREFIX + active.text + "</summary>", timestamp: 1 }] });
      if (["wrong-destination", "missing-receipt", "wrong-seed", "covered", "wrong-coverage"].includes(kind)) {
        const rows = (await readFile(raw.metadata.path, "utf8")).trimEnd().split("\n").map(JSON.parse);
        const r = rows.find(r => ["retained_summary_admitted", "reseed_predecessor_admitted"].includes(r.kind));
        if (kind === "wrong-destination") r.payload.destination.epoch = "fictional-wrong-epoch";
        if (kind === "wrong-seed") r.payload.seed.messageDigest = "e".repeat(64);
        if (kind === "wrong-coverage") r.payload.binding.publication.sourceDigest = "f".repeat(64);
        if (kind === "missing-receipt") r.kind = "fictional_missing_receipt";
        if (kind === "covered") {
          // A structurally valid off-branch seed exclusion is appended through the
          // real native writer; the controller must not revive the old receipt.
          await raw.moveTo(null); return;
        }
        const altered = Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n");
        interception.read = path => path === raw.metadata.path ? altered : undefined;
      }
    }); } finally { interception.read = null; }
    inferred++;
  } })).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  expect(inferred).toBe(0);
}, 60000);

const splitProgress = async raw => {
  await raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional prefix. ".repeat(4000) }], stopReason: "stop", usage: {}, timestamp: 2 });
  await raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional recent suffix. ".repeat(3000) }], stopReason: "stop", usage: {}, timestamp: 3 });
};
async function completedDestination(f, path, mutate = row => row) {
  const rows = (await readFile(path, "utf8")).trimEnd().split("\n").map(JSON.parse), record = rows.filter(r => r.kind === "compaction").at(-1);
  mutate(record);
  await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return bindE2Checkpoint({ root: f.root, state: f.state, planned: f.planned, slot: f.slot, summaries: f.slot.holds,
    reference: { journalId: rows[0].journalId, checkpointId: record.id, checkpoint: 0 }, readPrivate: f.readPrivate, readArtifact: f.readArtifact });
}
it.each(["retained", "absent", "dropped"])("binds single-response split reuse only with %s retained history", async kind => {
  let path;
  const f = await fixture("quotation", { sourceBackgroundRepeats: 100,
    onAdmission: async (_f, { raw, admission }) => raw.moveTo(admission.payload.seed.entryId), appendProgress: splitProgress,
    onSummary: async (f, { raw, context, text }) => { path = raw.metadata.path; f.slot.holds.push(await f.gate(raw, context, text)); } });
  expect(f.slot.holds).toHaveLength(1); expect(f.slot.holds[0].retainedPredecessor.assembly).toBe("split-prefix");
  const result = completedDestination(f, path, row => {
    if (kind === "retained") return;
    const value = row.payload.compaction, generated = value.summary.slice(value.summary.lastIndexOf(E2_PROTECTED_TEXT));
    value.summary = (kind === "absent" ? "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\n" : "") + generated;
    value.checkpoint.summaryMessage.summary = value.summary;
  });
  if (kind === "retained") {
    f.slot.lineages.proof = await result;
    const snapshot = await e2NativeCompactionSnapshot(f.root, f.state, f.planned, 0, f.readArtifact);
    expect(snapshot.every(s => !s.retainedAdmission)).toBe(true);
    const { JsonlSessionRepo } = await import("@mono-agent/turn/engine");
    const repo = new JsonlSessionRepo({ sessionsRoot: join(f.work, "sessions") });
    const header = JSON.parse((await readFile(path,"utf8")).split("\n")[0]);
    const raw = await repo.open(await repo.find(header.id), { repair: false });
    try {
      await raw.beginTurn("fictional-native-prefix", {}, "synthetic");
      await raw.openOperation("fictional-native-prefix-operation", { model }, "compaction", "continuity:manual");
      const ordinary = await f.gate(raw, createPrefixSummaryContext([]));
      expect(ordinary.retainedPredecessor).toBeUndefined();
      await raw.closeOperation("fictional-native-prefix-operation", "completed"); await raw.endTurn("fictional-native-prefix", "completed");
    } finally { await raw.close(); await repo.close(); }
  } else await expect(result).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
}, 60000);

it.each(["quotation", "carry"])("refuses forged fallback for a small %s predecessor before inference", async carrier => {
  let inferred = 0;
  await expect(fixture(carrier, { onSummary: async (f, { raw, context, text }) => {
    await f.gate(raw, context, text, () => f.wire(createHistorySummaryContext([], {}))); inferred++;
  } })).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  expect(inferred).toBe(0);
}, 60000);
it.each(["mismatch", "missing", "ambiguous", "missing-trigger"])("refuses %s controller policy before inference", async kind => {
  let inferred = 0;
  await expect(fixture("quotation", { onSummary: async (f, { raw, context, text }) => {
    if (kind === "missing") delete f.state.summaryPolicies;
    if (kind === "missing-trigger") delete f.state.summaryPolicies.trigger;
    if (kind === "ambiguous") f.state.summaryPolicies.models.push(f.state.summaryPolicies.models[0]);
    if (kind === "mismatch") f.state.summaryPolicies.models[0].policy.keepRecentTokens = 100000;
    await f.gate(raw, context, text); inferred++;
  } })).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" }); expect(inferred).toBe(0);
}, 60000);
it("authenticates genuine 32k destination fallback and its generated-only checkpoint", async () => {
  let path;
  const f = await fixture("quotation", { fallback: true, onSummary: async (f, { raw, context, text }) => {
    path = raw.metadata.path; const hold = await f.gate(raw, context, text); expect(hold.retainedPredecessor.assembly).toBe("legacy-fallback"); f.slot.holds.push(hold);
  } });
  await expect(completedDestination(f, path)).resolves.toMatchObject({ version: 3 });
}, 60000);

it.each(["newline", "whitespace", "reordered"])("refuses a retained split-prefix %s perturbation before inference", async mutation => {
  const done = Object.assign(Error("Fictional perturbed split checked"), { code: "FICTIONAL_SPLIT_COMPLETE" }); let inferred = 0;
  await expect(fixture("quotation", { onAdmission: async (f, { raw, active }) => {
    await raw.beginTurn("fictional-perturbed-prefix", {}, "synthetic"); await raw.openOperation("fictional-perturbed-operation", { model }, "compaction", "continuity:manual");
    const context = createPrefixSummaryContext([{ role: "user", content: "Fictional prefix.", timestamp: 1 }]);
    const part = context.messages[0].content[0];
    if (mutation === "newline") part.text += "\n";
    if (mutation === "whitespace") part.text = part.text.replace("## Original Request", "##  Original Request");
    if (mutation === "reordered") part.text = part.text.replace("## Original Request", "## Early Progress").replace("## Early Progress\n-", "## Original Request\n-");
    await expect(f.gate(raw, context)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
    expect((await raw.getEntries()).some(e => e.type === "compaction")).toBe(false);
    expect(inferred).toBe(0); throw done;
  }, onSummary: async () => { inferred++; } })).rejects.toBe(done);
});
