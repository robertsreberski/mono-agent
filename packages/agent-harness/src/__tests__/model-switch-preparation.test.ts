import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import type { RuntimeNativePreparationStorage, RuntimeHandoffSummary } from "@mono-agent/runtime-adapter";
import { fixture, openStore, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { createDurableHistoryStore } from "../durable-history.js";
import { createModelSwitchState } from "../model-switch-billing.js";
import { switchDigest } from "../durable-model-switch-contract.js";
import {
  advancePreparedModelSwitch, recoverPreparedModelSwitch, createPreparedModelSwitchState,
  explicitSwitchMessageDigest, runPreparedModelSwitch,
} from "../harness/model-switch-preparation.js";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import type { PreparedHarnessRuntime, HarnessPreparedBinding } from "../harness/runtime-execution.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const summary: RuntimeHandoffSummary = { intent: ["Retain fictional source facts"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] };
function producer(model = "B", outcome: "ready" | "unknown" | "rejected" = "ready") {
  const snapshot = { expiresAt: Date.now() + 300000, model: { provider: "faux", id: model, api: "faux-api", contextWindow: 100000, maxTokens: 8000 },
    provenance: { provider: "faux", api: "faux-api", model, account: null }, authSource: "provider", systemPrompt: "Fictional host instructions",
    tools: [{ name: "FictionalLookup", description: "Read fictional data", parameters: { type: "object", properties: { query: { type: "string" } } } }],
    messages: [{ role: "user", content: "Decorated fictional current input" }] };
  return { snapshot, checkHandoffSummary: vi.fn(() => ({ status: "ready" as const })),
    produceHandoffSummary: vi.fn(async () => outcome === "ready" ? { status: "ready" as const, summary }
      : { status: "summary_rejected" as const, reason: outcome === "unknown" ? "request_outcome_unknown" : "malformed_summary" }), close: vi.fn(async () => {}) };
}
async function setup(long = false, checkpoint = false) {
  const base = await mkdtemp(join(tmpdir(), "mono-switch-producer-")); roots.push(base);
  const f = await fixture(base);
  // Fixture bootstrap uses built administrative storage; exercise the source
  // orchestration/store here so fault injection targets its actual prototypes.
  f.store = createDurableHistoryStore({ root: join(base, "history"), nativeJournalStorage: f.native,
    retireProviderSession: async () => { throw new Error("Switch must preserve native evidence"); } });
  if (long) {
    const repo = new JsonlSessionRepo({ sessionsRoot: join(base, "native") });
    const session = await repo.open((await repo.listOwned()).find((row: { id: string }) => row.id === f.state.identity.sources[0]!.handleId)!);
    try {
      if (checkpoint) await session.appendCompaction({ summary: "Exact fictional checkpoint", tokensBefore: 100, retainedTail: [] });
      for (let i = 0; i < 4; i++) {
        await session.appendMessage({ role: "user", content: `Fictional older question ${i}`, timestamp: 17 + i });
        await session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Fictional answer ${i}` }], timestamp: 17 + i });
      }
      await session.sync();
    } finally { await session.close(); await repo.close(); }
  }
  const prep = await f.store.beginProviderSessionPreparation(bucket, "prepared-message");
  const native = f.native as RuntimeNativePreparationStorage;
  const captured = await prep.captureNativeEvidence({ provider: "faux", api: "faux-api", model: "A", account: null });
  const source = (await prep.read()).source; if (source.status !== "supported") throw new Error("Expected bound source");
  const incoming = producer(), outgoing = producer("A"), state = createPreparedModelSwitchState({ source, sources: captured.sources, incoming: incoming.snapshot,
    native, targetEpoch: "5".repeat(64), reservation: { ...f.state.reservation, retainedNativeBytes: 131072, headerCopyBytes: 131072 }, timestamp: 17, messageId: "initial-message", outputReserve: 2000 });
  const advance = (extra: Partial<Parameters<typeof advancePreparedModelSwitch>[0]> = {}) => advancePreparedModelSwitch({ preparation: prep, native,
    incoming, state, view: captured.view, messageId: "initial-message", exclusiveWriters: true, outgoing: async () => outgoing, ...extra });
  return { ...f, prep, native, captured, source, incoming, outgoing, state, advance };
}
async function nativeRecords(f: Awaited<ReturnType<typeof setup>>) {
  return (await readFile(f.nativePath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
}

it("measures the actual frozen host/declarations/input and records generation-zero delivery identity", async () => {
  const f = await setup();
  expect(f.state.frozenBudget?.hostContextDigest).toBe(createHash("sha256").update(JSON.stringify({ systemPrompt: f.incoming.snapshot.systemPrompt, tools: f.incoming.snapshot.tools })).digest("hex"));
  expect(f.state.initialMessageDigest).toBe(explicitSwitchMessageDigest("initial-message"));
  expect(f.state.frozenBudget?.inputTokens).toBeGreaterThan(4096);
  const create = (snapshot = f.incoming.snapshot, outputReserve = 2000) => createPreparedModelSwitchState({ source: f.source, sources: f.captured.sources,
    incoming: snapshot, native: f.native, targetEpoch: "5".repeat(64), reservation: f.state.reservation, timestamp: 17, messageId: "initial-message", outputReserve });
  expect(() => create({ ...f.incoming.snapshot, messages: [] })).toThrow("decorated current input");
  expect(() => create(undefined, 9000)).toThrow("model limit");
  expect(() => explicitSwitchMessageDigest("")).toThrow();
  await f.prep.abort();
});

it("persists admission before the outgoing call, runs outside root transactions, then rolls forward one accepted artifact", async () => {
  const f = await setup(true), internal = f.store as any, acquire = internal.acquireRootTransaction.bind(f.store);
  let rootHeld = 0;
  vi.spyOn(internal, "acquireRootTransaction").mockImplementation(async (...args: unknown[]) => {
    const release = await acquire(...args); rootHeld++;
    return async () => { try { await release(); } finally { rootHeld--; } };
  });
  f.outgoing.produceHandoffSummary.mockImplementation(async () => {
    expect(rootHeld).toBe(0); await f.prep.assertOwned();
    const pending = (await f.prep.read()).pending!;
    expect(pending.attempts).toHaveLength(1); expect(pending.attempts[0]).toMatchObject({ producer: "outgoing", outcome: "started" });
    await createDurableHistoryStore({ root: join(f.base, "history") }).append("fictional-unrelated", [{ role: "user", content: "Unrelated writer proceeds" }]);
    return { status: "ready", summary };
  });
  const result = await f.advance(); expect(result.status).toBe("ready");
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(f.outgoing.close).toHaveBeenCalledTimes(1);
  expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled(); expect(f.incoming.close).not.toHaveBeenCalled();
  const snapshot = await f.prep.read(); expect(snapshot.pending).toBeUndefined(); expect(snapshot.native?.chain).toHaveLength(2);
  expect(snapshot.source).toMatchObject({ fromModelKey: "faux:B" });
  expect((await nativeRecords(f)).filter((record: any) => record.kind === "model_change")).toHaveLength(1);
  await f.prep.abort();
});

it("uses the free exact checkpoint/no-older-history fallback before incoming billing", async () => {
  const f = await setup();
  const result = await f.advance({ outgoing: undefined }); expect(result.status).toBe("ready");
  expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  if (result.status !== "ready") throw new Error("Expected ready");
  const stored = await f.prep.readHandoff(result.switchId, result.artifact);
  expect(stored.artifact.producer).toBe("checkpoint"); expect(stored.artifact.recent).toHaveLength(1);
  await f.prep.abort();
});

it("continues outgoing unknown -> free fallback -> incoming without rebilling the outgoing attempt", async () => {
  const f = await setup(true), outgoing = producer("A", "unknown");
  const result = await f.advance({ outgoing: async () => outgoing }); expect(result.status).toBe("ready");
  expect(outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(f.incoming.produceHandoffSummary).toHaveBeenCalledTimes(1);
  if (result.status !== "ready") throw new Error("Expected ready");
  expect((await f.prep.readHandoff(result.switchId, result.artifact)).artifact.producer).toBe("incoming");
  await f.prep.abort();
});

it("reports pending after two calls, restart never rebills, and a new explicit delivery authorizes exactly one attempt per producer", async () => {
  const f = await setup(true), outgoing = producer("A", "unknown"), incoming = producer("B", "rejected");
  expect(await f.advance({ outgoing: async () => outgoing, incoming })).toEqual({ status: "pending", switchId: f.state.identity.switchId });
  const state0 = (await f.prep.read()).pending!; expect(state0.attempts).toHaveLength(2); expect(state0.authorizationGeneration).toBe(0);
  expect(state0.attempts.map((attempt) => attempt.outcome)).toEqual(["started", "rejected"]);
  expect((await nativeRecords(f)).some((record: any) => record.kind === "model_change")).toBe(false);
  expect((await f.prep.read()).source).toMatchObject({ fromModelKey: "faux:A" });
  await f.prep.abort();
  const reopened = openStore(f.base).store, prep = await reopened.beginProviderSessionPreparation(bucket, "restarted-message");
  expect(await recoverPreparedModelSwitch(prep, { exclusiveWriters: true })).toEqual({ status: "pending", switchId: f.state.identity.switchId });
  const request = { preparation: prep, native: f.native, incoming, state: f.state, view: f.captured.view,
    messageId: "initial-message", exclusiveWriters: true as const, outgoing: async () => outgoing };
  expect((await advancePreparedModelSwitch(request)).status).toBe("pending");
  expect(outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(incoming.produceHandoffSummary).toHaveBeenCalledTimes(1);
  expect((await advancePreparedModelSwitch({ ...request, messageId: "next-explicit-message" })).status).toBe("pending");
  const state1 = (await prep.read()).pending!; expect(state1.authorizationGeneration).toBe(1); expect(state1.attempts).toHaveLength(4);
  expect(state1.attempts.filter((attempt) => attempt.generation === 1).map((attempt) => attempt.producer)).toEqual(["outgoing", "incoming"]);
  expect((await advancePreparedModelSwitch({ ...request, messageId: "next-explicit-message" })).status).toBe("pending");
  expect(outgoing.produceHandoffSummary).toHaveBeenCalledTimes(2); expect(incoming.produceHandoffSummary).toHaveBeenCalledTimes(2);
  await prep.abort();
});

it("an exception after durable outgoing admission stays unknown on restart, without automatically repeating it", async () => {
  const f = await setup(true);
  f.outgoing.produceHandoffSummary.mockRejectedValue(new Error("Fictional lost response"));
  await expect(f.advance()).rejects.toThrow("lost response");
  expect(f.outgoing.close).toHaveBeenCalledTimes(1); expect((await f.prep.read()).pending!.attempts[0]!.outcome).toBe("started");
  await f.prep.abort();
  const prep = await openStore(f.base).store.beginProviderSessionPreparation(bucket, "after-loss");
  const outgoing = vi.fn(async () => producer("A"));
  const result = await advancePreparedModelSwitch({ preparation: prep, native: f.native, incoming: f.incoming, state: f.state,
    view: f.captured.view, messageId: "initial-message", exclusiveWriters: true, outgoing });
  expect(result.status).toBe("ready"); expect(outgoing).not.toHaveBeenCalled(); expect(f.incoming.produceHandoffSummary).toHaveBeenCalledTimes(1);
  await prep.abort();
});

it("rejects unfit mandatory history before intent or billing; unsupported ownership is not hidden", async () => {
  const f = await setup(), budget = { ...f.state.frozenBudget!, contextWindow: 24000, safety: 4096, historyAllowance: -279 };
  budget.historyAllowance = budget.contextWindow - budget.hostCap - budget.outputReserve - budget.inputTokens - budget.safety;
  const { switchId: _id, ...coordinates } = f.state.identity;
  const state = createModelSwitchState({ ...coordinates, frozenBudgetDigest: switchDigest(budget) }, f.state.reservation, budget, f.state.initialMessageDigest);
  expect((await f.advance({ state })).status).toBe("budget_failure");
  expect((await f.prep.read()).pending).toBeUndefined(); expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled();
  expect(await readdir(join(f.base, "history"))).not.toContain(".model-switches");
  await expect(f.advance({ exclusiveWriters: false as never })).rejects.toThrow("acknowledged");
  await expect(f.advance({ view: { ...f.captured.view, segments: [] } })).rejects.toThrow("coverage");
  const wrong = producer("C"); await expect(f.advance({ incoming: wrong })).rejects.toThrow("recorded target");
  await f.prep.abort();
});

it("skips unfit producer input without a billed attempt and refuses storage failures before calls", async () => {
  const f = await setup(true);
  f.outgoing.checkHandoffSummary.mockReturnValue({ status: "budget_failure", reason: "producer_input" } as any);
  const result = await f.advance(); expect(result.status).toBe("ready");
  expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled(); expect(f.outgoing.close).toHaveBeenCalledTimes(1);
  expect(f.incoming.produceHandoffSummary).toHaveBeenCalledTimes(1); await f.prep.abort();
  const second = await setup(true);
  vi.spyOn(second.prep, "beginModelSwitchStorage").mockRejectedValue(new Error("Fictional capacity refusal"));
  await expect(second.advance()).rejects.toThrow("capacity refusal"); expect(second.outgoing.produceHandoffSummary).not.toHaveBeenCalled(); await second.prep.abort();
});

it("storage-only recovery rolls forward an artifact lost after acceptance, with no provider and exactly one native event", async () => {
  const f = await setup(true), roll = vi.spyOn(f.prep, "rollForwardModelSwitch").mockRejectedValue(new Error("Fictional publication interruption"));
  await expect(f.advance()).rejects.toThrow("publication interruption"); roll.mockRestore();
  expect((await f.prep.read()).pending!.phase).toBe("ready"); await f.prep.abort();
  const prep = await openStore(f.base).store.beginProviderSessionPreparation(bucket, "recovery-request-for-A");
  const result = await recoverPreparedModelSwitch(prep, { exclusiveWriters: true }); expect(result.status).toBe("ready");
  expect((await prep.read()).source).toMatchObject({ fromModelKey: "faux:B" });
  expect(await recoverPreparedModelSwitch(prep, { exclusiveWriters: true })).toEqual(result);
  expect((await nativeRecords(f)).filter((record: any) => record.kind === "model_change")).toHaveLength(1);
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  await prep.abort();
});

it("ready incoming admission transfers the owner once and forwards the sole immutable artifact, budget and narrow current authority", async () => {
  const f = await setup(), ready = await f.advance({ outgoing: undefined }); if (ready.status !== "ready") throw new Error("Expected ready");
  // This fixture tests the real durable transfer. The native prepared execution
  // boundary and normalized-budget checks have their own real-runtime suites.
  const store = openStore(f.base).store as any; store.inspectProviderTurn = async () => ({ status: "absent" });
  await f.prep.abort();
  const prep = await store.beginProviderSessionPreparation(bucket, "incoming-turn");
  let bound!: HarnessPreparedBinding, admitted: any;
  const incoming = { ...f.incoming, run: vi.fn(async (getBinding: () => Promise<HarnessPreparedBinding>) => { bound = await getBinding(); return { success: true, text: "Fictional reply" }; }) } as unknown as PreparedHarnessRuntime;
  const input = { preparation: prep, incoming, ready, sessionsRoot: join(f.base, "native"), binding: { modelKey: "faux:B", reconciliation: { ownerKey: bucket,
    purpose: "execution" as const, initial: { persistText: "Fictional input", timestamp: "2000-01-01T00:00:00.000Z" } } }, onAdmitted: (turn: unknown) => { admitted = turn; } };
  const result = await runPreparedModelSwitch(input); expect(result.success).toBe(true); await admitted.assertOwned();
  expect(bound.nativeSessionProjection?.artifact).toEqual(ready.artifact); expect(bound.nativeSessionProjection?.inherited.coverage.sources).toHaveLength(1);
  expect(bound.nativeSessionProjection?.dispatchBudget).toEqual(f.state.frozenBudget);
  expect(bound.nativeSessionProjection?.inherited.coverage.sources[0]?.sourceDigest).toBe(f.state.identity.sources[0]!.sourceDigest);
  expect(bound.nativeSessionProjection?.inherited.messages[0]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Fictional source fact") })]));
  const access = bound.nativeSessionAuthority!;
  await access.assertCurrent({ handleId: admitted.providerSessionId, action: "open", sessionsRoot: join(f.base, "native") });
  await expect(access.assertCurrent({ handleId: f.state.identity.sources[0]!.handleId, action: "create", sessionsRoot: join(f.base, "native") })).rejects.toThrow("current handle");
  await expect(access.assertCurrent({ handleId: admitted.providerSessionId, action: "open", sessionsRoot: join(f.base, "other") })).rejects.toThrow("current handle");
  await expect(runPreparedModelSwitch(input)).rejects.toThrow("no longer owned");
  await prep.abort(); await admitted.assertOwned(); await admitted.abort();
});

it("post-P2 refusal surfaces as an admitted failure, preserving the owned fence for explicit abort/recovery", async () => {
  const f = await setup(), ready = await f.advance({ outgoing: undefined }); if (ready.status !== "ready") throw new Error("Expected ready");
  await f.prep.abort(); const store = openStore(f.base).store as any; store.inspectProviderTurn = async () => ({ status: "absent" });
  const prep = await store.beginProviderSessionPreparation(bucket, "incoming-refusal"); let admitted: any;
  const incoming = { ...f.incoming, run: vi.fn(async (getBinding: () => Promise<HarnessPreparedBinding>) => { await getBinding(); throw new Error("Fictional post-admission expiry"); }) } as unknown as PreparedHarnessRuntime;
  await expect(runPreparedModelSwitch({ preparation: prep, incoming, ready, sessionsRoot: join(f.base, "native"), binding: { modelKey: "faux:B", reconciliation: {
    ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional input", timestamp: "2000-01-01T00:00:00.000Z" } } }, onAdmitted: (turn) => { admitted = turn; } })).rejects.toThrow("post-admission expiry");
  expect(incoming.run).toHaveBeenCalledTimes(1); await prep.abort(); await admitted.assertOwned();
  expect((await readdir(join(f.base, "history", ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toHaveLength(1);
  await admitted.abort();
});


it("free checkpoint fallback preserves the exact envelope and complete suffix before incoming reduction", async () => {
  const f = await setup(true, true), outgoing = producer("A", "rejected");
  const result = await f.advance({ outgoing: async () => outgoing }); if (result.status !== "ready") throw new Error("Expected ready");
  const cached = await f.prep.readHandoff(result.switchId, result.artifact);
  const checkpoint = cached.artifact.checkpoint as { envelope: unknown; suffix: unknown[] };
  expect(checkpoint.suffix).toHaveLength(8);
  expect(checkpoint.envelope).toEqual(f.captured.view.segments[0]!.entries.find((entry) => entry.type === "compaction")!.checkpoint);
  expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  expect(cached.artifact.producer).toBe("checkpoint"); await f.prep.abort();
});

it("recovers exact accepted content when artifact fsync preceded a lost ready-state publication", async () => {
  const f = await setup(true), proto = ModelSwitchPayloadStore.prototype as any, publish = proto.publishState;
  let interrupted = false;
  vi.spyOn(proto, "publishState").mockImplementation(async function (this: unknown, state: any, owner: unknown) {
    if (state.phase === "ready" && !interrupted) { interrupted = true; throw new Error("Fictional lost ready pointer"); }
    return await publish.call(this, state, owner);
  });
  await expect(f.advance()).rejects.toThrow("lost ready pointer");
  expect((await f.prep.read()).pending!.phase).toBe("outgoing");
  const files = await readdir(join(f.base, "history", ".model-switches"));
  const name = files.find((entry) => entry.endsWith(".handoff.json"))!;
  const bytes = await readFile(join(f.base, "history", ".model-switches", name));
  await f.prep.abort();
  const prep = await openStore(f.base).store.beginProviderSessionPreparation(bucket, "cache-recovery");
  const recovered = await recoverPreparedModelSwitch(prep, { exclusiveWriters: true }); expect(recovered.status).toBe("ready");
  expect(await readFile(join(f.base, "history", ".model-switches", name))).toEqual(bytes);
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  await prep.abort();
});

it("oversized accepted prose is rejected without clipping and advances to the next producer", async () => {
  const f = await setup(true);
  f.outgoing.produceHandoffSummary.mockResolvedValue({ status: "ready", summary: { ...summary, intent: ["x".repeat(300000)] } });
  const result = await f.advance(); expect(result.status).toBe("ready");
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(f.incoming.produceHandoffSummary).toHaveBeenCalledTimes(1);
  if (result.status !== "ready") throw new Error("Expected ready");
  expect((await f.prep.readHandoff(result.switchId, result.artifact)).artifact.producer).toBe("incoming");
  await f.prep.abort();
});


it("a new explicit message after a crashed producer gets its own generation before paid work, and redelivery cannot rebill", async () => {
  const f = await setup(true), lease = await f.prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch lease"); await lease.admit("outgoing"); await lease.release(); await f.prep.abort();
  const prep = await openStore(f.base).store.beginProviderSessionPreparation(bucket, "new-generation");
  const outgoing = producer("A", "rejected"), incoming = producer("B", "unknown");
  outgoing.produceHandoffSummary.mockImplementation(async () => {
    const active = (await prep.read()).pending!;
    expect(active.authorizationGeneration).toBe(1); expect(active.authorizations[0]!.messageDigest).toBe(explicitSwitchMessageDigest("new-explicit"));
    return { status: "summary_rejected", reason: "malformed_summary" };
  });
  const request = { preparation: prep, native: f.native, incoming, state: f.state, view: f.captured.view,
    messageId: "new-explicit", exclusiveWriters: true as const, outgoing: async () => outgoing };
  expect((await advancePreparedModelSwitch(request)).status).toBe("pending");
  const active = (await prep.read()).pending!;
  expect(active.attempts).toHaveLength(3); expect(active.attempts[0]).toMatchObject({ generation: 0, outcome: "started" });
  expect(active.attempts.filter((attempt) => attempt.generation === 1)).toHaveLength(2);
  expect((await advancePreparedModelSwitch(request)).status).toBe("pending");
  expect(outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(incoming.produceHandoffSummary).toHaveBeenCalledTimes(1); await prep.abort();
});


it("redelivery of an older generation cannot spend a newer generation's unused producer slot", async () => {
  const f = await setup(true), lease = await f.prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch lease");
  await lease.advanceUnfit(); await lease.advanceUnfit(); await lease.advanceUnfit();
  await lease.authorizeMessage(explicitSwitchMessageDigest("newer-message")); await lease.release();
  const before = (await f.prep.read()).pending;
  expect((await f.advance()).status).toBe("pending");
  expect((await f.prep.read()).pending).toEqual(before);
  expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled(); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  await expect(recoverPreparedModelSwitch(f.prep, { exclusiveWriters: false } as never)).rejects.toThrow("acknowledged");
  await f.prep.abort();
});
