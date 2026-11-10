// Shared-core tests, fictional text, no transport/provider/registry. Not subprocess proofs.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { e2ExecutionPolicy as policy } from "../lib/continuity-e2-execution-policy.mjs";
import { E2_GUARD_CONTRACT, E2_SUMMARY_RESULTS_DIRECTORY } from "../lib/continuity-e2-policy.mjs";
import { e2RequestPrice, loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { SOL, LUNA } from "../lib/continuity-e2-protocol.mjs";
import { guardedModels } from "../lib/continuity-guarded-models.mjs";
import { guardedAccounting } from "../lib/continuity-guarded-accounting.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { e2SummaryResultPath, writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
const accounting = guardedAccounting("e2-validation"), core = guardedModels("e2-validation"), readPrivate = guardedState("e2-validation").readPrivate;
let root, pilot, planned;
const slotId = "b".repeat(64), operationDigest = "d".repeat(64), context = { systemPrompt: "Fictional instructions.", messages: [{ role: "user", content: "Fictional request." }], tools: [] };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "e2-ledger-"))); await mkdir(join(root, E2_SUMMARY_RESULTS_DIRECTORY), { mode: 0o700 }); vi.stubEnv("HOME", root);
  const catalogs = await loadE2Catalog();
  pilot = { descriptor: { capUnits: "900719925474099312345" }, registration: { catalog: catalogs,
    roles: ["summary", "continuation", "probe"].flatMap(role => (role === "summary" ? [SOL, LUNA] : [SOL]).map(model => ({ role, model, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 }))),
    toolPolicies: { summary: [], replay: ["ConversationHistory"], proof: ["ConversationHistory"], cancelContinuation: ["ConversationHistory", "ProofSentinel"] } } };
  planned = { kind: "proof", arm: "switch", budgets: pilot.registration.roles.map(r => ({ checkpoint: 0, paidRole: r.role, model: r.model, maxRequests: 2 })) };
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function request(paidRole = "probe", model = SOL) {
  const catalog = pilot.registration.catalog.find(c => c.model === model);
  return { requestId: "fictional-run:1", slotId, round: 1, payloadDigest: "a".repeat(64), inputTokens: 100, paidRole, model, checkpoint: 0,
    reservationUnits: e2RequestPrice(catalog, { inputTokens: 100, maxOutputTokens: 128000 }).reservationUnits };
}
it("preserves exact caps beyond Number and independently derives every model/role hold", () => {
  expect(policy.cap(pilot)).toBe(900719925474099312345n);
  for (const model of [SOL, LUNA]) {
    const p = request("summary", model), slot = { holds: [], compaction: { checkpoint: 0, operationDigest } }, result = policy.admission(pilot, planned, slot, p);
    expect(result.reserve.toString()).toBe(model === SOL ? "3920000000" : "196000000");
    expect(result.metadata).toMatchObject({ inputMax: 272000, outputMax: 128000, measuredInputTokens: 100 });
    p.reservationUnits = "1"; expect(() => policy.admission(pilot, planned, slot, p)).toThrow("e2_permit_invalid");
  }
});
it("refuses unregistered work, extra requests, excessive estimates and summary calls without lifecycle", () => {
  const p = request();
  expect(() => policy.admission(pilot, planned, { holds: [p, p] }, p)).toThrow("e2_request_limit");
  p.inputTokens = 272001; expect(() => policy.admission(pilot, planned, { holds: [] }, p)).toThrow("not_admitted_input_envelope");
  expect(() => policy.admission(pilot, planned, { holds: [] }, request("summary"))).toThrow("e2_summary_not_authorized");
  p.inputTokens = 100; expect(() => policy.admission(pilot, planned, { holds: [{ checkpoint: 1 }] }, p)).toThrow("e2_permit_invalid");
  p.checkpoint = 1; expect(() => policy.admission(pilot, planned, { holds: [] }, p)).toThrow("e2_request_limit");
});
it.each([["default", "291000"], ["priority", "582000"], [null, "582000"], ["flex", "145500"]])("settles actual usage exactly for tier %s", (tier, units) => {
  const p = request(), hold = { ...policy.admission(pilot, planned, { holds: [] }, p).metadata, consumed: true, reservedUnits: p.reservationUnits };
  const raw = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 } };
  const settled = accounting.settleHold(hold, { kind: "settled", costUnits: units }, raw, tier);
  expect(settled.settlement.knownUnits).toBe(units); expect(accounting.accountRun([{ terminal: "completed", holds: [settled] }]).totalUnits).toBe(units);
  expect(() => accounting.settleHold(hold, { kind: "settled", costUnits: "1" }, raw, tier)).toThrow("e2_hold_exceeded");
});
it("rounds sub-unit flex liability up and retains full cancellation/lost holds", () => {
  const p = request("summary", LUNA), hold = { ...policy.admission(pilot, planned, { holds: [], compaction: { checkpoint: 0, operationDigest } }, p).metadata, consumed: true, reservedUnits: p.reservationUnits };
  expect(accounting.priceUsage({ input_tokens: 1, output_tokens: 0, input_tokens_details: { cache_write_tokens: 1 } }, "flex", hold).units).toBe("63");
  for (const kind of ["lost", "own_abort_after_send"]) {
    const settled = accounting.settleHold(hold, { kind }, null, null), spend = accounting.accountRun([{ terminal: kind, holds: [settled] }]);
    expect(spend.retainedUnits).toBe("196000000"); expect(spend.totalUnits).toBe("196000000");
    expect(accounting.stopReason(spend, 196000000n, 1n)).toBe("budget_admission");
  }
});
it("refuses expensive-model body substitution and nondefault-tier/tool bypasses", () => {
  const hold = { model: LUNA, tools: [] }, body = { model: SOL.split(":")[1], store: false, stream: true };
  expect(() => policy.assertBody(Buffer.from(JSON.stringify(body)), hold)).toThrow("e2_body_mismatch");
  body.model = LUNA.split(":")[1]; body.service_tier = "priority"; expect(() => policy.assertBody(Buffer.from(JSON.stringify(body)), hold)).toThrow("e2_body_mismatch");
  delete body.service_tier; body.tools = [{ type: "function", name: "UnapprovedTool" }]; expect(() => policy.assertBody(Buffer.from(JSON.stringify(body)), hold)).toThrow("e2_tools_forbidden");
});
async function summaryResult(cacheViolation = false) {
  const p = request("summary"), bytes = Buffer.byteLength(JSON.stringify(context)), maximum = Math.ceil(bytes / 3);
  const contract = { ...E2_GUARD_CONTRACT, model: SOL.split(":")[1], effort: "high", slotId, runId: "fictional-run", ...(cacheViolation ? { promptCacheKey: "fictional-assigned-phase" } : {}), e2: {
    pilot, planned, ...p, outputRoot: root, operationDigest, size: { method: "intercepted-full-models-context", serializedBytes: bytes, serializedBytesOver3: maximum, engineFullRequest: 1, maximum, usage: "engine-estimate-not-provider-measurement" } } };
  const permit = core.createTestOnlyLookupPermitSource(); let evidence, sends = 0;
  const wrappedPermit = { ...permit, settle(...args) { evidence = args[4]; return permit.settle(...args); } };
  const raw = { input_tokens: 100, output_tokens: 10 }, message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "FICTIONAL-PRIVATE-SUMMARY-CANARY" }] };
  const target = { streamSimple(model, ctx, options) {
    const promise = (async () => {
      const final = await options.onPayload({ model: model.id, stream: true, store: false, input: [], reasoning: { effort: "high" } }, model);
      await options.fetch(`${model.baseUrl}/codex/responses`, { method: "POST", ...(cacheViolation ? { headers: { "session-id": "foreign", "x-client-request-id": "foreign" } } : {}), body: JSON.stringify(final) });
      await options.onProviderStreamEvent({ type: "response.completed", response: { usage: raw, service_tier: "default" } }, model); return message;
    })();
    return { result: () => promise, async *[Symbol.asyncIterator]() { yield { type: "done", message: await promise }; } };
  } };
  const models = core.guardedLookupModels(target, { contract, permit: wrappedPermit, send: async () => { sends++; return new Response(); } });
  const model = { provider: contract.provider, id: contract.model, api: contract.api, baseUrl: contract.baseUrl };
  if (cacheViolation) {
    await expect(models.streamSimple(model, context, { reasoning: "high", transport: "sse", maxRetries: 0 }).result()).rejects.toMatchObject({ code: "e2_prompt_cache_key_forbidden" });
    expect(permit.events.find(e => e.type === "settle").outcome).toMatchObject({ kind: "integrity_stop", code: "e2_prompt_cache_key_forbidden" });
    expect(permit.events.find(e => e.type === "stop")).toMatchObject({ code: "e2_prompt_cache_key_forbidden" }); expect(sends).toBe(0);
    return;
  }
  expect(await models.streamSimple(model, context, { reasoning: "high", transport: "sse", maxRetries: 0 }).result()).toEqual(message);
  expect(() => models.streamSimple(model, context, { reasoning: "high", transport: "sse", maxRetries: 0 })).toThrow("e2_request_limit"); expect(sends).toBe(1);
  const admission = permit.events.find(e => e.type === "admit"), event = permit.events.find(e => e.type === "settle");
  const { type: _type, ...admittedRequest } = admission;
  const slot = { holds: [], compaction: { checkpoint: 0, operationDigest } }, metadata = policy.admission(pilot, planned, slot, admittedRequest);
  return { p, admission, event, evidence, metadata, slot, models, model };
}
it("records unknown generated output only after actual consume/settlement, verifies before durable compaction and probes", async () => {
  const r = await summaryResult();
  const hold = accounting.settleHold({ ...r.metadata.metadata, round: 1, requestId: r.p.requestId, payloadDigest: r.admission.payloadDigest, reservedUnits: r.p.reservationUnits, consumed: true }, r.event.outcome, r.event.rawUsage, r.event.tier);
  r.slot.holds.push(hold); await policy.verifySettlement(root, slotId, hold, r.evidence, readPrivate);
  expect(hold.summaryReceipt).toMatchObject({ verified: true, durable: false });
  await expect(policy.beforeAdmission(root, slotId, r.slot, request(), readPrivate)).rejects.toThrow("e2_compaction_invalid");
  await policy.compaction(root, slotId, planned, r.slot, { kind: "durable", checkpoint: 0, operationDigest }, readPrivate);
  await expect(policy.beforeAdmission(root, slotId, r.slot, request(), readPrivate)).resolves.toBeUndefined();
  const path = e2SummaryResultPath(root, slotId, 1), content = JSON.parse(await readFile(path)); content.message.content[0].text = "different fictional text"; await writeFile(path, JSON.stringify(content));
  await expect(policy.beforeAdmission(root, slotId, r.slot, request(), readPrivate)).rejects.toThrow("e2_summary_receipt_invalid");
});

it("preserves independently priced partial spend even beyond a violated catalog envelope", () => {
  const p = request(), hold = { ...policy.admission(pilot, planned, { holds: [] }, p).metadata, consumed: true, reservedUnits: p.reservationUnits };
  const settled = accounting.settleHold(hold, { kind: "integrity_stop", code: "e2_input_envelope_violated" }, { input_tokens: 300000, output_tokens: 128000 }, "priority");
  expect(settled.settlement.knownUnits).toBe("6240000000");
  expect(accounting.accountRun([{ terminal: "integrity_stop", holds: [settled] }]).retainedUnits).toBe("6240000000");
});

it("blocks direct completion/deferred APIs and alternate native routes on E2 guards", async () => {
  const { models, model } = await summaryResult();
  for (const method of ["stream", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "setProvider"]) expect(() => models[method]()).toThrow("e2_method_forbidden");
  expect(() => models.streamSimple({ ...model, api: "alternate" }, context, { reasoning: "high", transport: "sse", maxRetries: 0 })).toThrow("e2_route_mismatch");
  expect(() => models.streamSimple(model, context, { reasoning: "high", transport: "sse", maxRetries: 0, fetch: () => {} })).toThrow("e2_external_fetch_forbidden");
});

it("bounds generated private summary results before writing a receipt", async () => {
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "s".repeat(1048576) }] };
  await expect(writeE2SummaryResult({ runId: "fictional-run", slotId, e2: { paidRole: "summary", model: SOL, round: 1, outputRoot: root } }, message,
    { input_tokens: 100, output_tokens: 128000 }, "default", "a".repeat(64))).rejects.toThrow("e2_summary_receipt_invalid");
});

it("leaves live hold-count enforcement to the controller, not a fabricated child snapshot", () => {
  const p = request(), bytes = Buffer.byteLength(JSON.stringify(context)), size = { method: "intercepted-full-models-context", serializedBytes: bytes,
    serializedBytesOver3: Math.ceil(bytes / 3), engineFullRequest: 100, maximum: 100, usage: "engine-estimate-not-provider-measurement" };
  const contract = { ...E2_GUARD_CONTRACT, runId: "fictional-run", slotId, model: SOL.split(":")[1], effort: "high",
    e2: { pilot, planned, size, round: 3, model: SOL, checkpoint: 0, paidRole: "probe", reservationUnits: p.reservationUnits } };
  expect(policy.guardRequest(contract, context).request.round).toBe(3);
  expect(() => policy.admission(pilot, planned, { holds: [p, p] }, { ...p, round: 3, requestId: "fictional-run:3" })).toThrow("e2_request_limit");
});

it("classifies delegated E2 cache-header failures as integrity stops and stops the permit", async () => { await summaryResult(true); });

it.each([1, 3, 4])("derives per-probe admission ordinal and final wire tool policy from durable holds: R=%s", rounds => {
  planned.kind = "replay"; planned.budgets.forEach(b => b.maxRequests = 20);
  pilot.registration.probeCounts = [{ checkpoint: 0, questions: 2, lookupRounds: rounds }];
  pilot.registration.toolPolicies.replayFinal = [];
  const slot = { holds: [] };
  for (let i = 1; i <= rounds + 1; i++) {
    const p = request(i === 1 ? "probe" : "continuation");
    const admitted = policy.admission(pilot, planned, slot, p);
    expect(admitted.metadata.probeRequest).toBe(i);
    expect(admitted.metadata.tools).toEqual(i === rounds + 1 ? [] : ["ConversationHistory"]);
    const body = { model: SOL.split(":")[1], store: false, stream: true, input: [], tools: i === rounds + 1 ? [] : [{ type: "function", name: "ConversationHistory" }] };
    expect(() => policy.assertBody(Buffer.from(JSON.stringify(body)), admitted.metadata)).not.toThrow();
    body.tools = i === rounds + 1 ? [{ type: "function", name: "ConversationHistory" }] : [];
    expect(() => policy.assertBody(Buffer.from(JSON.stringify(body)), admitted.metadata)).toThrow("e2_tools_forbidden");
    slot.holds.push({ ...admitted.metadata, settlement: { kind: "settled" } });
  }
  // Checkpoint-level funds remain, but this probe's R+1 cannot be exceeded.
  expect(() => policy.admission(pilot, planned, slot, request("continuation"))).toThrow("e2_request_limit");
  // An early answer ends its probe; the next question/repeat starts at one.
  slot.holds = slot.holds.slice(0, 1);
  expect(policy.admission(pilot, planned, slot, request("probe")).metadata.probeRequest).toBe(1);
});
