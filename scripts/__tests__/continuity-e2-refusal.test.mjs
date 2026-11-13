// Fictional native journals + real shared/paid observers/accounting. The
// credential reader, assignment brand, controller transport and native SDK are
// replaced, and the runtime phase-adapter/safety assertions are stubbed (they
// are exercised by the runtime suites, not here). No credentials, registry,
// provider or network is accessed.
import { afterEach, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
const live = vi.hoisted(() => ({ root: null, state: null }));
vi.mock("@mono-agent/turn", async original => ({ ...await original(), createPiOAuthApiKeyResolver: () => ({ readCredential: async () => ({ type: "oauth", access: "fictional-credential" }) }) }));
vi.mock("../lib/continuity-e2-runtime.mjs", () => ({ assertE2PhaseAdapter() {}, assertE2Safety() {} }));
vi.mock("../lib/continuity-guarded-state.mjs", async original => {
  const module = await original();
  return { ...module, guardedState: name => {
    const core = module.guardedState(name);
    return { ...core, readPrivate: path => live.root && path === core.statePath(live.root) ? Promise.resolve(live.state) : core.readPrivate(path) };
  } };
});
import { lineageFixture } from "./fixtures/e2-lineage-fixture.mjs";
import { createE2PaidModels } from "../lib/continuity-e2-paid-models.mjs";
import { createE2Models, loadE2Estimators, shippingSoul } from "../lib/continuity-e2-models.mjs";
import { e2ExecutionPolicy as policy } from "../lib/continuity-e2-execution-policy.mjs";
import { effectiveE2Summaries, E2_RETRY_POLICY } from "../lib/continuity-e2-retry.mjs";
import { E2_PROTECTION_REFUSALS } from "../lib/continuity-e2-compaction.mjs";
import { E2_REAL_CONTROLLER, E2_GUARD_CONTRACT } from "../lib/continuity-e2-policy.mjs";
import { guardedAccounting } from "../lib/continuity-guarded-accounting.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";
import { loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
import { bindE2Checkpoint, e2PhaseWork, verifyE2NativeLineage, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX } from "../lib/continuity-e2-lineage.mjs";
import { writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
import { createObserverHub } from "../../packages/turn/dist/telemetry/observer.js";
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { compactWithRequest } from "../../packages/turn/dist/engine/compaction-kit/compaction.js";
import { reportGuardedCompactionOutcome } from "../../packages/turn/dist/execution/pi/compaction/compaction-driver.js";
const accounting = guardedAccounting("e2-validation"), readPrivate = (...args) => guardedState("e2-validation").readPrivate(...args);
const history = "## Historical events and corrections\n" + Array.from({ length: 12 }, (_, i) => `- Fictional parcel ${i}; m${i}; previously 18; corrected to 16; current 16; resolved.`).join("\n") + "\n\n## Pending items\n- None.";
const roots = [];
afterEach(async () => { live.root = live.state = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
async function setup({ retryFirst = false, length = false, replay = false, compactionLimit = 10 } = {}) {
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
  const f = await lineageFixture([history], undefined, undefined, replay ? { kind: "replay", branch: 0 } : {}); roots.push(f.root); live.root = f.root;
  const prior = await f.bind(); f.slot.lineages = { [replay ? 0 : "proof"]: prior }; f.planned.slotId = f.slot.slotId;
  f.slot.holds.forEach(h => { h.consumed = true; h.checkpoint = replay ? 3 : 0; h.summaryReceipt.durable = true; h.reservedUnits = "1"; h.settlement.knownUnits = "1"; });
  f.planned.budgets = (replay ? [0, 1, 2, 3, 4] : [0]).flatMap(checkpoint => ["summary", "probe", "continuation"].map(paidRole => ({ paidRole, model: "openai-codex:gpt-6.1-sol", checkpoint, maxRequests: 10 })));
  const model = { ...E2_GUARD_CONTRACT, id: "gpt-6.1-sol", contextWindow: 272000, maxTokens: 128000, reasoning: false };
  const protocol = replay ? { probeLookupRounds: 3, branches: [{ checkpoints: [5, 15, 25, 35].map(turn => ({ turn })) }, { checkpoints: [{ turn: 35 }] }] } : {};
  const protocolText = JSON.stringify(protocol);
  const pilot = { descriptor: { retryPolicy: E2_RETRY_POLICY }, registration: {
    protocol: { path: join(f.root, "fictional-protocol.json"), sha256: digest(protocolText) },
    roles: ["summary", "probe", "continuation"].map(role => ({ role, model: `openai-codex:${model.id}`, maxInputTokens: 272000, maxOutputTokens: 128000 })),
    catalog: await loadE2Catalog(), toolPolicies: { summary: [], proof: [], replay: [], replayFinal: [] }, ...(replay ? { probeCounts: [0, 1, 2, 3, 4].map(checkpoint => ({ checkpoint, lookupRounds: 3 })) } : {}),
  } };
  // Actor's registration read uses the real private artifact reader.
  const { writeFile } = await import("node:fs/promises"); await writeFile(pilot.registration.protocol.path, protocolText, { mode: 0o600 });
  const state = live.state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 0, stop: null, capUnits: "999999999999", pilot };
  const safety = {}, actor = await createE2PaidModels({ slot: f.planned, index: 0, slotId: f.slot.slotId, outputRoot: f.root, runId: "fictional-run", cacheKey: "fictional-cache", pilot, authorization: { credentialPath: "/fictional/unused" } }, safety);
  const dispositions = [];
  const permit = { testOnly: true,
    async compaction(p) { await policy.compaction(f.root, f.slot.slotId, f.planned, f.slot, p, readPrivate, state, pilot); dispositions.push(p); },
    async admit(p) {
      const lineage = await policy.beforeAdmission(f.root, f.slot.slotId, f.slot, p, readPrivate, state, pilot);
      const funded = policy.admission(pilot, f.planned, f.slot, p);
      const hold = { ...p, ...funded.metadata, ...lineage, reservedUnits: p.reservationUnits };
      f.slot.holds.push(hold); if (hold.retryOf) { delete f.slot.retryPending; f.slot.terminal = null; } return hold;
    },
    async consume(h) { h.consumed = true; h.summaryPresence = { native: 0, branch: 0, pack: 0, none: true }; },
    async settle(h, outcome, raw, tier, evidence) { Object.assign(h, accounting.settleHold(h, outcome, raw, tier)); await policy.verifySettlement(f.root, f.slot.slotId, h, evidence, readPrivate); },
    retry: vi.fn(async (round, ownerCanceled) => policy.retry(pilot, state, 0, { round, ownerCanceled })), stop: vi.fn(async () => {}),
  };
  actor.bind(null, { resolvedSafety: safety, permit, send: async () => new Response() });
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const route = createE2Models({ pi: {}, estimators, models: [{ model: `openai-codex:${model.id}` }], ...(replay ? { probeLookupRounds: 3 } : {}), limits: { compactions: compactionLimit, summaryRequests: 10, summaryRequestsPerCompaction: 2, sourceRequests: 10, probeRequests: 10 }, summary: "real", soul, paidAdapter: actor });
  let responseText = "Fictional lossy candidate.", calls = 0;
  const raw = { input_tokens: 10, output_tokens: 10 };
  const target = { getModel: () => model, streamSimple(selected, context, options) {
    const result = (async () => {
      const payload = await options.onPayload({ model: selected.id, stream: true, store: false, ...(options.cacheRetention === "none" ? {} : { prompt_cache_key: "fictional-cache" }), input: [{ role: "user", content: "Fictional native SDK body." }] }, selected);
      await options.fetch(`${selected.baseUrl}/codex/responses`, { method: "POST", headers: { "session-id": "fictional-cache", "x-client-request-id": "fictional-cache" }, body: JSON.stringify(payload) });
      if (retryFirst && ++calls === 1) throw Object.assign(Error("Fictional stream interruption."), { code: "ECONNRESET" });
      await options.onProviderStreamEvent({ type: "response.completed", response: { usage: raw, service_tier: "default" } }, selected);
      return { role: "assistant", stopReason: length ? "length" : "stop", content: [{ type: "text", text: responseText }] };
    })();
    return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: "done", message: await result }; } };
  } };
  const models = route.decorator(target), options = { maxTokens: 128000, transport: "sse", maxRetries: 0, reasoning: "off" };
  const event = (status, operationId = "fictional-refusal", reason = "protected_tuples_missing") => ({ type: "context_compaction", status, operationId, reason, trigger: "proactive" });
  route.setPosition({ model: `openai-codex:${model.id}`, turn: 34, message: 87, ...(replay ? { branch: 0 } : {}) });
  const request = () => models.completeSimple(model, { messages: [{ role: "user", content: "Fictional summary input." }] }, { ...options, maxTokens: 2000, cacheRetention: "none" });
  async function append(summary, changedTip = false) {
    const repo = new JsonlSessionRepo({ sessionsRoot: join(f.work, "sessions") }), session = await repo.open(f.metadata);
    const id = `fictional-${f.slot.holds.length}`;
    await session.beginTurn(id); await session.openOperation(id + "-compaction", { model });
    if (changedTip) await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional new native tip." }], stopReason: "stop" });
    if (summary !== undefined) await session.appendCompaction({ summary, retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
    await session.closeOperation(id + "-compaction", summary === undefined ? "failed" : "completed"); await session.endTurn(id, summary === undefined ? "failed" : "completed");
    await session.sync(); await session.close(); await repo.close();
  }
  return { ...f, prior, state, pilot, actor, route, models, model, options, event, request, append, permit, dispositions, setText: text => { responseText = text; },
    async next(probe = true, branch = 0) {
      route.setPosition({ model: `openai-codex:${model.id}`, turn: 35, message: 88, probe, ...(replay ? { branch } : {}), ...(!probe ? { paidRole: "continuation" } : {}) });
      const context = { systemPrompt: `## Core Guardrails\n\n${soul.text}`, messages: [{ role: "user", content: "Fictional probe." }], tools: [] };
      return models.streamSimple(model, context, options).result();
    } };
}
it("replays a protected split refusal through shipping compaction, shared + paid observers, then continues and commits a later successor", async () => {
  const f = await setup(); f.planned.budgets.find(b => b.paidRole === "summary").maxRequests = 4; f.route.observe(f.event("running"));
  const prep = { messagesToSummarize: [{ role: "user", content: "Fictional update", timestamp: 0 }], turnPrefixMessages: [{ role: "user", content: "Fictional prefix" }], retainedTail: [], isSplitTurn: true,
    previousSummary: history, tokensBefore: 10000, settings: { reserveTokens: 2000, summaryMaxTokens: 1600 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, preservation: {} };
  const result = await compactWithRequest(prep, { model: f.model }, async (context, options) => f.models.completeSimple(f.model, context, { ...options, transport: "sse", maxRetries: 0 }), {});
  expect(result).toMatchObject({ ok: false, error: { code: "summary_refused" } });
  expect(prep.preservation).toMatchObject({ protectedTupleCount: 12, missingTupleCount: 12, refusalReason: "protected_tuples_missing" });
  await f.append(); // Native operation failed, but its context tip did not change.
  reportGuardedCompactionOutcome({ decision: { kind: "summary_refused", reason: prep.preservation.refusalReason }, operationId: "fictional-refusal", trigger: "proactive", emit: (_onEvent, e) => f.route.observe({ type: "context_compaction", ...e }) });
  await f.actor.flush(); f.route.assertSettled();
  const rejected = f.slot.holds.at(-1);
  expect(rejected.summaryReceipt).toMatchObject({ verified: true, durable: false, rejected: true });
  expect(f.slot.compaction).toBeNull(); expect(f.slot.lineages.proof).toEqual(f.prior);
  expect(f.dispositions.map(p => p.kind)).toEqual(["begin", "rejected"]);
  await f.next(); await f.next(false);
  expect(f.slot.holds.slice(-2).map(h => h.paidRole)).toEqual(["probe", "continuation"]);
  expect(f.slot.holds.slice(-2).every(h => h.lineage.textSha256 === f.prior.textSha256)).toBe(true);
  f.route.observe(f.event("running", "fictional-success")); f.setText(history); await f.request(); await f.append(history);
  f.route.observe(f.event("succeeded", "fictional-success")); await f.actor.flush(); await f.next();
  expect(f.slot.holds.at(-2).summaryReceipt.durable).toBe(true);
  expect(rejected.summaryReceipt.durable).toBe(false);
  expect(effectiveE2Summaries(f.slot.holds)).not.toContain(rejected);
  const protocol = guardedProtocol("e2-validation"); f.slot.terminal = "completed"; f.slot.score = 1; f.slot.worker = {}; f.state.cursor = 1;
  const receipt = policy.slotReceipt(f.state, 0, accounting.accountRun, protocol), report = policy.aggregateRun(f.state, [receipt], accounting.accountRun, protocol);
  expect(report.compactionRefusals).toEqual({ count: 1, byReason: { protected_tuples_missing: 1 }, rejectedRequests: 1, rejectedUnits: rejected.settlement.knownUnits });
  expect(receipt.compactionRefusals).toEqual(report.compactionRefusals);
  expect(report.costs.totalUnits).toBe(accounting.accountRun([f.slot]).totalUnits);
  expect(f.route.report().compactionRefusals[0]).toMatchObject({ requests: 1, durable: false, rejected: true, reason: "protected_tuples_missing" });
  expect(f.route.report().compactions).toHaveLength(1);
  expect(f.route.report().compactions.every(c => c.durable)).toBe(true);
  expect(f.slot.holds.filter(h => h.paidRole === "summary")).toHaveLength(3); // Four funded: the second split call was not bought.
  expect(report.schedule).toMatchObject({ missing: 0, remaining: 0 });
  expect(report.stop).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(["unknown_reason", "failed", "mismatched_digest", "active", "non_summary"])("paid observer fails closed for %s", async variant => {
  const f = await setup(); f.route.observe(f.event("running"));
  if (variant === "non_summary") {
    await expect(f.next()).rejects.toThrow("E2_SOURCE_REQUEST_LIMIT");
    await expect(f.actor.stream({}, f.model, { messages: [] }, f.options, "probe").result()).rejects.toThrow("e2_compaction_invalid");
    expect(f.permit.stop).toHaveBeenCalledWith("e2_compaction_invalid"); return;
  }
  if (variant === "active") {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const admit = f.permit.admit; f.permit.admit = async p => { entered(); await wait; return admit(p); };
    const pending = f.request(); await started;
    expect(() => f.route.observe(f.event("skipped"))).toThrow("E2_COMPACTION_LIFECYCLE_INVALID"); release(); await pending; await expect(f.actor.flush()).rejects.toThrow("e2_compaction_invalid"); return;
  }
  await f.request();
  const terminal = f.event(variant === "failed" ? "failed" : "skipped", variant === "mismatched_digest" ? "other-operation" : "fictional-refusal", variant === "unknown_reason" ? "unknown" : "protected_tuples_missing");
  if (["unknown_reason", "failed", "mismatched_digest"].includes(variant)) expect(() => f.route.observe(terminal)).toThrow();
  if (variant !== "mismatched_digest") await expect(f.actor.flush()).rejects.toThrow("e2_compaction_invalid");
});
it.each(["unsettled", "lost", "unconsumed", "unverified", "durable", "changed_tip", "changed_prefix", "changed_checkpoint", "wrong_checkpoint", "wrong_digest", "non_summary", "unknown_reason"])("controller rejects refusal with %s", async variant => {
  const f = await setup(); f.route.observe(f.event("running")); await f.request();
  const hold = f.slot.holds.at(-1);
  if (variant === "unsettled") delete hold.settlement;
  if (variant === "lost") hold.settlement.kind = "lost";
  if (variant === "unconsumed") hold.consumed = false;
  if (variant === "unverified") hold.summaryReceipt.verified = false;
  if (variant === "durable") hold.summaryReceipt.durable = true;
  if (variant === "non_summary") hold.paidRole = "probe";
  if (variant === "changed_checkpoint") await f.append("Unverified fictional successor.");
  if (variant === "changed_tip") await f.append(undefined, true);
  if (variant === "changed_prefix") {
    const { writeFile } = await import("node:fs/promises");
    // A changed pre-request prefix is rejected even if it leaves the same tip.
    await writeFile(f.journalPath, (await readFile(f.journalPath, "utf8")).replace("fictional-turn", "changed-fictional-turn"));
  }
  const p = { kind: "rejected", operationDigest: digest(variant === "wrong_digest" ? "other" : "fictional-refusal"), checkpoint: variant === "wrong_checkpoint" ? 1 : 0, reason: variant === "unknown_reason" ? "unknown" : "protected_tuples_missing" };
  await expect(f.permit.compaction(p)).rejects.toThrow();
  expect(hold.summaryReceipt.rejected).toBeUndefined(); expect(f.slot.compaction).not.toBeNull();
});
it("does not let rejected candidates hide a later unverified successor or receipt corruption", async () => {
  const f = await setup(); f.route.observe(f.event("running")); await f.request(); f.route.observe(f.event("skipped")); await f.actor.flush();
  const rejected = f.slot.holds.at(-1);
  f.slot.holds.push({ ...rejected, round: 3, summaryReceipt: { ...rejected.summaryReceipt, rejected: false } });
  await expect(f.next()).rejects.toThrow("e2_summary_receipt_invalid"); f.slot.holds.pop();
  rejected.summaryReceipt.durable = true;
  await expect(policy.beforeAdmission(f.root, f.slot.slotId, f.slot, { paidRole: "probe", checkpoint: 0 }, readPrivate, f.state, f.pilot)).rejects.toThrow("e2_summary_receipt_invalid");
});
it("accounts both split candidates on a budget refusal without committing either", async () => {
  const f = await setup(); f.route.observe(f.event("running")); await f.request(); await f.request();
  f.route.observe(f.event("skipped", "fictional-refusal", "summary_budget_exceeded")); await f.actor.flush();
  const rejected = f.slot.holds.slice(1);
  expect(rejected).toHaveLength(2);
  expect(rejected.every(h => h.summaryReceipt.rejected && !h.summaryReceipt.durable)).toBe(true);
  expect(f.slot.compactionRefusals[0].rounds).toEqual([2, 3]);
  await f.next(); expect(f.slot.holds.at(-1).lineage).toEqual(f.prior);
  const protocol = guardedProtocol("e2-validation"); f.slot.terminal = "completed"; f.slot.score = 1;
  const receipt = policy.slotReceipt(f.state, 0, accounting.accountRun, protocol);
  expect(receipt.compactionRefusals.rejectedUnits).toBe(rejected.reduce((n, h) => n + BigInt(h.settlement.knownUnits), 0n).toString());
  expect(receipt.compactionRefusals.rejectedRequests).toBe(2);
});
it("never accepts a refusal without a native pre-request baseline", async () => {
  const f = await setup(); await rm(f.journalPath);
  f.route.observe(f.event("running")); await f.request();
  expect(f.slot.compaction.nativeSnapshot).toEqual([]);
  f.route.observe(f.event("skipped")); await expect(f.actor.flush()).rejects.toThrow("e2_compaction_invalid");
  expect(f.slot.holds.at(-1).summaryReceipt.rejected).toBeUndefined();
});
it.each(["duplicate", "mismatched", "active"])("keeps %s terminal failures sticky through the shipping observer hub", async variant => {
  const f = await setup(), hub = createObserverHub({ onEvent: event => f.route.observe(event) });
  hub.emit(f.event("running"));
  if (variant === "active") {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const admit = f.permit.admit; f.permit.admit = async p => { entered(); await wait; return admit(p); };
    const pending = f.request(); await started;
    expect(() => hub.emit(f.event("skipped"))).not.toThrow(); release(); await pending;
  } else {
    await f.request();
    hub.emit(f.event("skipped", variant === "mismatched" ? "fictional-wrong-operation" : "fictional-refusal"));
  }
  // A duplicate or corrected terminal cannot erase the swallowed first error.
  expect(() => hub.emit(f.event("skipped"))).not.toThrow(); await hub.flush();
  await expect(f.actor.flush()).rejects.toThrow("e2_compaction_invalid");
  expect(() => f.route.assertSettled()).toThrow("E2_COMPACTION_LIFECYCLE_INVALID");
  const count = f.slot.holds.length;
  expect(() => f.actor.stream({}, f.model, { messages: [] }, f.options, "probe")).toThrow("e2_compaction_invalid");
  await expect(f.next()).rejects.toThrow("E2_COMPACTION_LIFECYCLE_INVALID");
  expect(f.slot.holds).toHaveLength(count);
});
it("accepts an authenticated retry-v1 success followed by refusal, preserving both physical liabilities", async () => {
  const f = await setup({ retryFirst: true }); f.route.observe(f.event("running")); await f.request();
  const [failed, success] = f.slot.holds.slice(1), failedSnapshot = structuredClone(failed);
  expect(f.permit.retry).toHaveBeenCalledExactlyOnceWith(failed.round, false);
  expect(failed).toMatchObject({ retryAuthorized: true, settlement: { kind: "lost" } });
  expect(failed.summaryReceipt).toBeUndefined(); expect(success.retryOf).toBe(failed.round);
  expect(effectiveE2Summaries(f.slot.holds)).not.toContain(failed);
  f.route.observe(f.event("skipped")); await f.actor.flush(); f.route.assertSettled();
  expect(success.summaryReceipt).toMatchObject({ verified: true, durable: false, rejected: true });
  expect(failed).toEqual(failedSnapshot);
  expect(effectiveE2Summaries(f.slot.holds)).toEqual([f.slot.holds[0]]);
  await f.next(); await f.next(false);
  expect(f.slot.lineages.proof).toEqual(f.prior);
  const protocol = guardedProtocol("e2-validation"); f.slot.terminal = "completed"; f.slot.score = 1;
  const receipt = policy.slotReceipt(f.state, 0, accounting.accountRun, protocol);
  expect(receipt.compactionRefusals).toMatchObject({ count: 1, rejectedRequests: 2,
    rejectedUnits: (BigInt(failed.reservedUnits) + BigInt(success.settlement.knownUnits)).toString() });
  expect(receipt.costs.retainedUnits).toBe(failed.reservedUnits);
  expect(receipt.retries).toMatchObject({ attempted: 1, succeeded: 1 });
});
it.each(["grant", "cause", "retry_binding", "receipt"])("cannot exclude a failed attempt with unauthenticated retry %s", async variant => {
  const f = await setup({ retryFirst: true }); f.route.observe(f.event("running")); await f.request();
  const [failed, success] = f.slot.holds.slice(1);
  if (variant === "grant") delete failed.retryAuthorized;
  if (variant === "cause") failed.nativeCause.payloadDigest = "e".repeat(64);
  if (variant === "retry_binding") success.retryOf = failed.round - 1;
  if (variant === "receipt") success.summaryReceipt.sha256 = "e".repeat(64);
  await expect(f.permit.compaction({ kind: "rejected", operationDigest: digest("fictional-refusal"), checkpoint: 0, reason: "protected_tuples_missing" })).rejects.toThrow("e2_summary_receipt_invalid");
  expect(success.summaryReceipt.rejected).toBeUndefined(); expect(f.slot.compaction).not.toBeNull();
});
it("keeps SDK length results on the existing nonretryable failure path, never a refusal disposition", async () => {
  const f = await setup({ length: true }); f.route.observe(f.event("running"));
  await expect(f.request()).rejects.toThrow("e2_phase_failed");
  const hold = f.slot.holds.at(-1);
  expect(hold.nativeCause).toMatchObject({ causeClass: "sdk_length_result" });
  expect(hold.summaryReceipt).toBeUndefined();
  expect(f.slot.holds).toHaveLength(2); // Initial checkpoint + one failed summary; no retry.
  await expect(f.permit.retry.mock.results[0].value).resolves.toEqual({ allowed: false });
  expect(f.permit.stop).toHaveBeenCalledWith("e2_phase_failed");
  const hub = createObserverHub({ onEvent: event => f.route.observe(event) });
  hub.emit(f.event("skipped", "fictional-refusal", "output_truncated"));
  await expect(f.actor.flush()).rejects.toThrow(); expect(() => f.route.assertSettled()).toThrow();
  expect(f.dispositions.map(p => p.kind)).toEqual(["begin"]);
});
it("counts refused candidates toward the unchanged compaction-attempt ceiling", async () => {
  const f = await setup({ compactionLimit: 1 }); f.route.observe(f.event("running")); await f.request();
  f.route.observe(f.event("skipped")); await f.actor.flush();
  expect(f.route.report().compactions).toHaveLength(0); expect(f.route.report().compactionRefusals).toHaveLength(1);
  expect(() => f.route.observe(f.event("running", "fictional-extra-compaction"))).toThrow("E2_COMPACTION_LIMIT");
  expect(f.slot.holds).toHaveLength(2);
});
it("keeps a prefix refusal scoped to its own checkpoint and leaves the main branch lineage untouched", async () => {
  const f = await setup({ replay: true }), main = structuredClone(f.slot.lineages[0]);
  const before = await readFile(f.journalPath);
  const work = e2PhaseWork(f.root, f.planned, 1), repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") });
  const session = await repo.create({ id: "fictional-prefix-session", cwd: work });
  await session.beginTurn("fictional-prefix-turn"); await session.openOperation("fictional-prefix-compaction", { model: f.model });
  const checkpointId = await session.appendCompaction({ summary: history, retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
  await session.closeOperation("fictional-prefix-compaction", "completed"); await session.endTurn("fictional-prefix-turn", "completed"); await session.sync();
  const journalId = session.metadata.journalId; await session.close(); await repo.close();
  const round = f.slot.holds.length + 1, rawUsage = { input_tokens: 10, output_tokens: 10 }, payloadDigest = "c".repeat(64);
  const result = await writeE2SummaryResult({ runId: "fictional-run", slotId: f.slot.slotId, e2: { paidRole: "summary", model: "openai-codex:gpt-6.1-sol", round, outputRoot: f.root } },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: history }] }, rawUsage, "default", payloadDigest);
  const hold = { requestId: `fictional-run:${round}`, round, paidRole: "summary", model: "openai-codex:gpt-6.1-sol", checkpoint: 4, payloadDigest, consumed: true, reservedUnits: "1",
    summaryReceipt: { ...result.evidence, verified: true, durable: false }, settlement: { kind: "settled", rawUsage, tier: "default", knownUnits: "1" } };
  f.slot.holds.push(hold);
  f.slot.lineages[1] = await bindE2Checkpoint({ root: f.root, planned: f.planned, slot: f.slot, readPrivate, readArtifact: f.readArtifact, state: f.state, summaries: [hold], reference: { journalId, checkpointId, checkpoint: 4 } }); hold.summaryReceipt.durable = true;
  const prefix = structuredClone(f.slot.lineages[1]);
  f.route.setPosition({ model: "openai-codex:gpt-6.1-sol", branch: 1, turn: 34, message: 87 });
  f.route.observe(f.event("running")); await f.request(); f.route.observe(f.event("skipped")); await f.actor.flush();
  expect(f.slot.compactionRefusals[0].checkpoint).toBe(4);
  expect(f.slot.lineages).toEqual({ 0: main, 1: prefix });
  await f.next(true, 1); expect(f.slot.holds.at(-1).lineage).toEqual(prefix);
  const metadata = await policy.beforeAdmission(f.root, f.slot.slotId, f.slot, { paidRole: "probe", checkpoint: 3 }, readPrivate, f.state, f.pilot);
  expect(metadata).toEqual({ lineageScope: 0, lineage: main });
  const bytes = Buffer.from(JSON.stringify({ input: [{ role: "user", content: E2_SUMMARY_PREFIX + history + E2_SUMMARY_SUFFIX }] }));
  await expect(verifyE2NativeLineage(bytes, metadata, f.state, { outputRoot: f.root, index: 0 }, f.readArtifact)).resolves.toMatchObject({ native: 1 });
  expect(await readFile(f.journalPath)).toEqual(before);
});
it("pins the closed refusal reasons to the shipping summary_refused paths", async () => {
  const source = await readFile(new URL("../../packages/turn/src/engine/compaction-kit/compaction.ts", import.meta.url), "utf8");
  const reasons = [...source.matchAll(/refuse\("([a-z_]+)"\)/gu)].map(m => m[1]);
  reasons.push(...[...source.slice(source.indexOf("const validate ="), source.indexOf("let historyText =")).matchAll(/"([a-z_]+)"/gu)].map(m => m[1]));
  expect([...new Set(reasons)].sort()).toEqual([...E2_PROTECTION_REFUSALS, "output_truncated"].sort());
  expect(E2_PROTECTION_REFUSALS).not.toContain("output_truncated");
});
