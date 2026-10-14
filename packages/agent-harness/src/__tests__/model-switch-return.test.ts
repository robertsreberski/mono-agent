// A -> B -> A returns are ordinary structured transfers: outgoing summary, then
// the exact prior validated structured summary plus the complete current suffix,
// then incoming, then handoff pending. Native envelopes are never reused across
// a model change, even with matching provenance. One current journal remains.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { createMonoRuntime, type RuntimeNativePreparationStorage } from "@mono-agent/runtime-adapter";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fixture, ready, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import { createDurableHistoryStore } from "../durable-history.js";
import { advancePreparedModelSwitch, createPreparedModelSwitchState, recoverPreparedModelSwitch, runPreparedModelSwitch } from "../harness/model-switch-preparation.js";
import type { PreparedHarnessRuntime, HarnessPreparedBinding } from "../harness/runtime-execution.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const provenance = { provider: "faux", api: "faux-api", model: "A", account: "fictional-account" };
const summary = { intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] };
const firstSummary = { intent: ["Fictional source fact summarized at A -> B"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] };
async function setup(api = provenance.api) {
  const dispatchProvenance = { ...provenance, api };
  const root = await mkdtemp(join(tmpdir(), "model-switch-return-")); roots.push(root);
  const f = await fixture(root, bucket, dispatchProvenance);
  // Bootstrap the A -> B boundary, then one intervening B turn. No real
  // credentials/provider calls: later evidence uses exact journals.
  await ready(f, { summary: firstSummary }); await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { });
  const store = createDurableHistoryStore({ root: join(root, "history"), nativeJournalStorage: f.native,
    reconcileProviderSessionTurn: async () => ({ status: "absent" }),
    retireProviderSession: async () => { throw new Error("Predecessors must not be deleted"); } });
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-B-turn", { modelKey: "faux:B" });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(root, "native") });
  const session = await repo.open((await repo.listOwned()).find((row: { id: string }) => row.id === turn.providerSessionId)!);
  await session.beginTurn("intervening-B", {}, "synthetic", undefined);
  await session.write("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
  await session.write("handle_binding", { handleId: turn.providerSessionId, baseRevision: 0, authoritative: true, model: { provider: "faux", api, id: "B" } });
  await session.openOperation("intervening-B-op", { model: { provider: "faux", api, id: "B" }, nativeProvenance: { ...dispatchProvenance, model: "B" } });
  await session.appendMessage({ role: "user", content: "Intervening fictional B fact", timestamp: 17 });
  await session.appendMessage({ role: "assistant", provider: "faux", api, model: "B", stopReason: "stop", timestamp: 17,
    content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "fixture-signature" }, { type: "text", text: "Intervening B reply" }] });
  await session.closeOperation("intervening-B-op", "completed"); await session.endTurn("intervening-B", "completed"); await session.sync();
  await session.close(); await repo.close();
  await (await turn.prepareCommit([{ role: "user", content: "Intervening fictional B fact" }, { role: "assistant", content: "Intervening B reply" }], { providerSessionSynced: true })).commit();
  const prep = await store.beginProviderSessionPreparation(bucket, "switch-return");
  const native = f.native as RuntimeNativePreparationStorage, captured = await prep.captureNativeEvidence();
  const source = (await prep.read()).source; if (source.status !== "supported") throw new Error("Expected source");
  const incoming = { snapshot: {  model: { provider: "faux", api, id: "A", contextWindow: 100000, maxTokens: 8000 },
    provenance: dispatchProvenance, systemPrompt: "Fictional current instructions", tools: [], messages: [{ role: "user", content: "Fictional return request" }] },
    checkHandoffSummary: vi.fn(() => ({ status: "ready" as const })), produceHandoffSummary: vi.fn(async () => ({ status: "ready" as const, summary })), close: vi.fn(async () => {}) };
  const state = createPreparedModelSwitchState({ source, historyBucket: bucket, journal: captured.source, incoming: incoming.snapshot, native, targetEpoch: "6".repeat(64),
    reservation: { canonicalBytes: 65536, artifactBytes: 131072, nativeBytes: 8192, pendingBytes: 131072 },
    timestamp: 17, messageId: "persisted-return-delivery", outputReserve: 2000 });
  const outgoing = { ...incoming, snapshot: { ...incoming.snapshot, model: { ...incoming.snapshot.model, id: "B" }, provenance: { ...dispatchProvenance, model: "B" } },
    produceHandoffSummary: vi.fn(async () => ({ status: "ready" as const, summary })) };
  const advance = () => advancePreparedModelSwitch({ preparation: prep, native, incoming, state, view: captured.view,
    messageId: "persisted-return-delivery", outgoing: async () => outgoing });
  return { ...f, store, prep, native, captured, incoming, outgoing, state, advance };
}
const switchStates = async (base: string, switchId: string) => {
  const dir = join(base, "history", ".model-switches");
  return await Promise.all((await readdir(dir)).filter((name) => name.includes(switchId) && name.endsWith(".state.json"))
    .map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
};

it("B -> A takes the outgoing structured summary with intervening B work, never a native projection", async () => {
  const f = await setup();
  const result = await f.advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected ready");
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  const cached = await f.prep.readHandoff(result.switchId, result.artifact);
  expect(cached.artifact).toMatchObject({ producer: "outgoing", summary });
  expect(cached.artifact).not.toHaveProperty("nativeProjection");
  expect(JSON.stringify(cached.artifact)).toContain("Intervening fictional B fact");
  expect(JSON.stringify(cached.artifact)).not.toContain("fixture-signature"); // opaque reasoning is referenced by digest only
  // The producer saw the inherited prior handoff; the new artifact does not nest it.
  expect(JSON.stringify((f.outgoing.produceHandoffSummary.mock.calls as unknown[][])[0]![0])).toContain("Fictional source fact summarized at A -> B");
  expect(JSON.stringify(cached.artifact)).not.toContain("Fictional source fact summarized");
  const record = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(record.version).toBe(3);
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(1);
  expect(record.providerSession.modelKey).toBe("faux:A"); expect(record.lastSwitch.artifact).toEqual(result.artifact);
  expect(await recoverPreparedModelSwitch(f.prep)).toEqual(result);
  let binding: HarnessPreparedBinding | undefined;
  const incoming = { ...f.incoming, run: async (resolve: () => Promise<HarnessPreparedBinding>) => { binding = await resolve(); return { text: "Fictional incoming reply" }; } } as unknown as PreparedHarnessRuntime;
  let admitted: any;
  expect((await runPreparedModelSwitch({ preparation: f.prep, incoming, ready: result, sessionsRoot: join(f.base, "native"),
    binding: { modelKey: "faux:A", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional return request", timestamp: "2000-01-01T00:00:00.000Z" } } },
    onAdmitted: (turn) => { admitted = turn; } })).text).toBe("Fictional incoming reply");
  const inherited = JSON.stringify(binding!.nativeSessionProjection!.inherited.messages);
  expect(binding!.nativeSessionProjection!.inherited.messages).toHaveLength(1);
  expect(inherited).toContain("Historical handoff"); expect(inherited).toContain("Intervening fictional B fact"); expect(inherited).not.toContain("fixture-signature");
  await admitted.abort();
});

it("an outcome-unknown outgoing attempt stays charged; the same delivery continues free and is never rebilled", async () => {
  const f = await setup();
  f.outgoing.produceHandoffSummary.mockRejectedValueOnce(new Error("Fictional summary interruption"));
  await expect(f.advance()).rejects.toThrow("Fictional summary interruption");
  const pending = (await f.prep.read()).pending;
  expect(pending?.phase).toBe("outgoing"); expect(pending?.attempts).toEqual([expect.objectContaining({ producer: "outgoing", outcome: "started", generation: 0 })]);
  // Redelivery of the same persisted message: the unknown attempt finishes
  // storage-only, then the free route (exact prior validated summary + complete
  // current suffix) is accepted without another billed call.
  const result = await f.advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected ready");
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  const cached = await f.prep.readHandoff(result.switchId, result.artifact);
  expect(cached.artifact).toMatchObject({ producer: "checkpoint", summary: null, checkpoint: { summary: firstSummary } });
  expect(JSON.stringify((cached.artifact.checkpoint as { suffix: unknown[] }).suffix)).toContain("Intervening fictional B fact");
  expect((await switchStates(f.base, result.switchId)).map((state) => state.attempts)).toEqual([[expect.objectContaining({ producer: "outgoing", outcome: "started" })]]);
  expect(await f.advance()).toEqual(result); expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce();
  await f.prep.abort();
});

it("recovers accepted structured bytes after a lost ready pointer without any further summary call", async () => {
  const f = await setup(), proto = ModelSwitchPayloadStore.prototype as any, publish = proto.publishState;
  let interrupted = false;
  vi.spyOn(proto, "publishState").mockImplementation(async function (this: unknown, state: any, owner: unknown) {
    if (state.phase === "ready" && !interrupted) { interrupted = true; throw new Error("Fictional ready interruption"); }
    return await publish.call(this, state, owner);
  });
  await expect(f.advance()).rejects.toThrow("ready interruption");
  expect((await f.prep.read()).pending?.phase).toBe("outgoing"); await f.prep.abort();
  const prep = await f.store.beginProviderSessionPreparation(bucket, "fictional-return-recovery");
  const result = await recoverPreparedModelSwitch(prep); expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected ready");
  expect((await prep.readHandoff(result.switchId, result.artifact)).artifact).toMatchObject({ producer: "outgoing", summary });
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled();
  expect(await recoverPreparedModelSwitch(prep)).toEqual(result); await prep.abort();
});

it("actually dispatches and reconciles the inherited structured handoff on same-model reopening", async () => {
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 100000, maxTokens: 8000 }], tokensPerSecond: 1000000 });
  const f = await setup(faux.getModel().api), readyResult = await f.advance(); if (readyResult.status !== "ready") throw new Error("Expected ready");
  await f.prep.abort();
  const runtime = createMonoRuntime({ workspace: f.base }), nativeRoot = join(f.base, "native");
  const models = createModels(); models.setProvider(faux.provider); const transport = vi.spyOn(faux.provider, "streamSimple");
  const inspect = vi.fn(async (request) => await runtime.reconcileSessionTurn!({ sessionsRoot: nativeRoot,
    descriptor: request.descriptor, purpose: request.purpose, expectedInputs: request.expectedInputs, expectedModel: { provider: "faux", id: "A" } }));
  const store = createDurableHistoryStore({ root: join(f.base, "history"), nativeJournalStorage: f.native,
    reconcileProviderSessionTurn: inspect, retireProviderSession: async () => { throw new Error("Retain native chain"); } });
  const prep = await store.beginProviderSessionPreparation(bucket, "actual-reopen");
  const input = "Fictional explicit reopened input";
  const lease = await runtime.prepareNativeDispatch!("Fictional current rules", { model: { provider: "faux", model: "A", reference: "faux:A" },
    piResolvedModel: faux.getModel(), piResolvedModels: models, messages: [{ role: "user", content: input }],
    abortSignal: new AbortController().signal, allowedTools: [], piSessionsRoot: nativeRoot, compaction: { enabled: false } });
  const incoming = { snapshot: lease.snapshot, run: async (resolve: () => Promise<HarnessPreparedBinding>) => {
    const bound = await resolve();
    return await lease.run({ sessionId: bound.sessionId, providerSessionId: bound.providerSessionId, providerAttributionSessionId: bound.providerAttributionSessionId!,
      sessionKeepAlive: bound.sessionKeepAlive, sessionTurn: bound.sessionTurn!, nativeSessionAuthority: bound.nativeSessionAuthority!, nativeSessionProjection: bound.nativeSessionProjection! });
  } } as unknown as PreparedHarnessRuntime;
  let turn: Awaited<ReturnType<typeof prep.admit>> | undefined;
  try {
    faux.setResponses([fauxAssistantMessage([fauxText("Fictional reopened reply")])]);
    const result = await runPreparedModelSwitch({ preparation: prep, incoming, ready: readyResult, sessionsRoot: nativeRoot, switching: false,
      binding: { modelKey: "faux:A", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: input, timestamp: "2000-01-01T00:00:00.000Z" } } },
      onAdmitted: (value) => { turn = value; } });
    expect(result.error).toBeFalsy(); expect(result.text).toBe("Fictional reopened reply"); expect(transport).toHaveBeenCalledOnce();
    const dispatched = JSON.stringify(transport.mock.calls[0]); expect(dispatched).toContain("Historical handoff");
    expect(dispatched).toContain("Intervening fictional B fact"); expect(dispatched).not.toContain("fixture-signature");
    await (await turn!.prepareCommit([{ role: "user", content: input, runId: "actual-reopen", timestamp: "2000-01-01T00:00:00.000Z" },
      { role: "assistant", content: result.text!, runId: "actual-reopen", timestamp: "2000-01-01T00:00:01.000Z" }], { providerSessionSynced: true })).commit();
    await expect(inspect.mock.results.at(-1)?.value).resolves.toMatchObject({ status: "matched", outcome: "completed" });
    expect(await store.recoverProviderSessionTurn(bucket)).toEqual({ status: "clean" });
  } finally { await lease.close(); await turn?.abort(); await prep.abort(); await runtime.disposeAllSessions!(); }
});
