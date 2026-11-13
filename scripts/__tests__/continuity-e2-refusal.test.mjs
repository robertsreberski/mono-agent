// Fictional native journals + real shared/paid observers/accounting. Only the
// credential reader, assignment brand, controller transport and native SDK are
// replaced; no credentials, registry, provider or network is accessed.
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
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { compactWithRequest } from "../../packages/turn/dist/engine/compaction-kit/compaction.js";
import { reportGuardedCompactionOutcome } from "../../packages/turn/dist/execution/pi/compaction/compaction-driver.js";
const accounting = guardedAccounting("e2-validation"), readPrivate = (...args) => guardedState("e2-validation").readPrivate(...args);
const history = "## Historical events and corrections\n" + Array.from({ length: 12 }, (_, i) => `- Fictional parcel ${i}; m${i}; previously 18; corrected to 16; current 16; resolved.`).join("\n") + "\n\n## Pending items\n- None.";
const roots = [];
afterEach(async () => { live.root = live.state = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
async function setup() {
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
  const f = await lineageFixture([history]); roots.push(f.root); live.root = f.root;
  const prior = await f.bind(); f.slot.lineages = { proof: prior }; f.planned.slotId = f.slot.slotId;
  f.slot.holds.forEach(h => { h.consumed = true; h.checkpoint = 0; h.summaryReceipt.durable = true; h.reservedUnits = "1"; h.settlement.knownUnits = "1"; });
  f.planned.budgets = ["summary", "probe", "continuation"].map(paidRole => ({ paidRole, model: "openai-codex:gpt-6.1-sol", checkpoint: 0, maxRequests: 10 }));
  const model = { ...E2_GUARD_CONTRACT, id: "gpt-6.1-sol", contextWindow: 272000, maxTokens: 128000, reasoning: false };
  const pilot = { descriptor: { retryPolicy: E2_RETRY_POLICY }, registration: {
    protocol: { path: join(f.root, "fictional-protocol.json"), sha256: digest("{}") },
    roles: ["summary", "probe", "continuation"].map(role => ({ role, model: `openai-codex:${model.id}`, maxInputTokens: 272000, maxOutputTokens: 128000 })),
    catalog: await loadE2Catalog(), toolPolicies: { summary: [], proof: [] },
  } };
  // Actor's registration read uses the real private artifact reader.
  const { writeFile } = await import("node:fs/promises"); await writeFile(pilot.registration.protocol.path, "{}", { mode: 0o600 });
  const state = live.state = { ...f.state, schema: E2_REAL_CONTROLLER, cursor: 0, stop: null, capUnits: "999999999999", pilot };
  const safety = {}, actor = await createE2PaidModels({ slot: f.planned, index: 0, slotId: f.slot.slotId, outputRoot: f.root, runId: "fictional-run", cacheKey: "fictional-cache", pilot, authorization: { credentialPath: "/fictional/unused" } }, safety);
  const dispositions = [];
  const permit = { testOnly: true,
    async compaction(p) { await policy.compaction(f.root, f.slot.slotId, f.planned, f.slot, p, readPrivate, state, pilot); dispositions.push(p); },
    async admit(p) {
      const lineage = await policy.beforeAdmission(f.root, f.slot.slotId, f.slot, p, readPrivate, state, pilot);
      const funded = policy.admission(pilot, f.planned, f.slot, p);
      const hold = { ...p, ...funded.metadata, ...lineage, reservedUnits: p.reservationUnits };
      f.slot.holds.push(hold); return hold;
    },
    async consume(h) { h.consumed = true; },
    async settle(h, outcome, raw, tier, evidence) { Object.assign(h, accounting.settleHold(h, outcome, raw, tier)); await policy.verifySettlement(f.root, f.slot.slotId, h, evidence, readPrivate); },
    retry: async () => ({ allowed: false }), stop: vi.fn(async () => {}),
  };
  actor.bind(null, { resolvedSafety: safety, permit, send: async () => new Response() });
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const route = createE2Models({ pi: {}, estimators, models: [{ model: `openai-codex:${model.id}` }], limits: { compactions: 10, summaryRequests: 10, summaryRequestsPerCompaction: 2, sourceRequests: 10, probeRequests: 10 }, summary: "real", soul, paidAdapter: actor });
  let responseText = "Fictional lossy candidate.";
  const raw = { input_tokens: 10, output_tokens: 10 };
  const target = { getModel: () => model, streamSimple(selected, context, options) {
    const result = (async () => {
      const payload = await options.onPayload({ model: selected.id, stream: true, store: false, ...(options.cacheRetention === "none" ? {} : { prompt_cache_key: "fictional-cache" }), input: [{ role: "user", content: "Fictional native SDK body." }] }, selected);
      await options.fetch(`${selected.baseUrl}/codex/responses`, { method: "POST", headers: { "session-id": "fictional-cache", "x-client-request-id": "fictional-cache" }, body: JSON.stringify(payload) });
      await options.onProviderStreamEvent({ type: "response.completed", response: { usage: raw, service_tier: "default" } }, selected);
      return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: responseText }] };
    })();
    return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: "done", message: await result }; } };
  } };
  const models = route.decorator(target), options = { maxTokens: 128000, transport: "sse", maxRetries: 0, reasoning: "off" };
  const event = (status, operationId = "fictional-refusal", reason = "protected_tuples_missing") => ({ type: "context_compaction", status, operationId, reason, trigger: "proactive" });
  route.setPosition({ model: `openai-codex:${model.id}`, turn: 34, message: 87 });
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
    async next(probe = true) {
      route.setPosition({ model: `openai-codex:${model.id}`, turn: 35, message: 88, probe, ...(!probe ? { paidRole: "continuation" } : {}) });
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
    expect(() => f.route.observe(f.event("skipped"))).toThrow("e2_compaction_invalid"); release(); await pending; await expect(f.actor.flush()).rejects.toThrow("e2_compaction_invalid"); return;
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
it("pins the closed refusal reasons to the shipping summary_refused paths", async () => {
  const source = await readFile(new URL("../../packages/turn/src/engine/compaction-kit/compaction.ts", import.meta.url), "utf8");
  const reasons = [...source.matchAll(/refuse\("([a-z_]+)"\)/gu)].map(m => m[1]);
  reasons.push(...[...source.slice(source.indexOf("const validate ="), source.indexOf("let historyText =")).matchAll(/"([a-z_]+)"/gu)].map(m => m[1]));
  expect([...new Set(reasons)].sort()).toEqual([...E2_PROTECTION_REFUSALS].sort());
});
