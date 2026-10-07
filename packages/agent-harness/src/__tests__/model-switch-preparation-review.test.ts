import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createMonoRuntime, type RuntimeNativeDispatchSnapshot, type RuntimeSessionTurnReconciliationResult, type RuntimeHandoffProducerResult } from "@mono-agent/runtime-adapter";
import type { RunRecorder } from "@mono-agent/observability";
import { fixture, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import type { ConversationHistoryTurnInspection } from "../types.js";
import { createDurableHistoryStore } from "../durable-history.js";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import { createModelSwitchState } from "../model-switch-billing.js";
import { buildAgentContext } from "../context/index.js";
import { UncommittedTurnCollector } from "../harness/turn-continuity.js";
import { prepareHarnessRuntime } from "../harness/runtime-execution.js";
import {
  advancePreparedModelSwitch, recoverPreparedModelSwitch, createPreparedModelSwitchState,
  explicitSwitchMessageDigest, runPreparedModelSwitch,
} from "../harness/model-switch-preparation.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const summary = { intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] };
function producer(model = "B") {
  const snapshot: RuntimeNativeDispatchSnapshot = { expiresAt: Date.now() + 300000,
    model: { provider: "faux", id: model, api: "faux-api", contextWindow: 100000, maxTokens: 8000 },
    provenance: { provider: "faux", api: "faux-api", model, account: null }, authSource: "provider",
    systemPrompt: "Fictional stable instructions", tools: [], messages: [{ role: "user", content: "Fictional current input" }] };
  return { snapshot, checkHandoffSummary: vi.fn(() => ({ status: "ready" as const })),
    produceHandoffSummary: vi.fn(async (): Promise<RuntimeHandoffProducerResult> => ({ status: "ready", summary })), close: vi.fn(async () => {}) };
}
async function setup() {
  const base = await mkdtemp(join(tmpdir(), "mono-switch-review-")); roots.push(base);
  const f = await fixture(base);
  const store = createDurableHistoryStore({ root: join(base, "history"), nativeJournalStorage: f.native,
    retireProviderSession: async () => { throw new Error("Preserve switch evidence"); } });
  const prep = await store.beginProviderSessionPreparation(bucket, "review-run");
  const captured = await prep.captureNativeEvidence({ provider: "faux", api: "faux-api", model: "A", account: null });
  const source = (await prep.read()).source; if (source.status !== "supported") throw new Error("Expected bound source");
  const incoming = producer(), outgoing = producer("A");
  const state = createPreparedModelSwitchState({ source, sources: captured.sources, incoming: incoming.snapshot, native: f.native,
    targetEpoch: "5".repeat(64), reservation: f.state.reservation, timestamp: 17, messageId: "channel:conversation:delivery:001", outputReserve: 2000 });
  const input = { preparation: prep, native: f.native, incoming, outgoing: async () => outgoing, state, view: captured.view,
    messageId: "channel:conversation:delivery:001", exclusiveWriters: true as const };
  return { ...f, store, prep, captured, source, incoming, outgoing, state, input };
}
async function events(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.kind === "model_change");
}

it.each(["recover", "advance"])("%s rolls forward first after switch_canonical_renamed and stops at the first ready", async (entry) => {
  const f = await setup(), original = f.prep.rollForwardModelSwitch.bind(f.prep);
  const fault = vi.spyOn(f.prep, "rollForwardModelSwitch").mockImplementation(async (id, options) => await original(id, { ...options,
    onPhase: async (phase) => { if (phase === "switch_canonical_renamed") throw new Error("Fictional rename interruption"); } }));
  await expect(advancePreparedModelSwitch(f.input)).rejects.toThrow("rename interruption"); fault.mockRestore();
  const snapshot = await f.prep.read(); expect(snapshot.pending?.phase).toBe("ready"); expect(snapshot.source).toMatchObject({ fromModelKey: "faux:B" });
  const begin = vi.spyOn(f.prep, "beginModelSwitchStorage").mockRejectedValue(new Error("Must not re-begin old source"));
  const otherIncoming = producer("C"), outgoing = vi.fn(async () => producer("B"));
  const result = entry === "recover" ? await recoverPreparedModelSwitch(f.prep, { exclusiveWriters: true })
    : await advancePreparedModelSwitch({ ...f.input, incoming: otherIncoming, outgoing, messageId: "next-message-asks-for-C", view: { ...f.captured.view, segments: [] } });
  expect(result).toMatchObject({ status: "ready", modelKey: "faux:B", switchId: f.state.identity.switchId });
  expect(begin).not.toHaveBeenCalled(); expect(outgoing).not.toHaveBeenCalled(); expect(otherIncoming.produceHandoffSummary).not.toHaveBeenCalled();
  expect((await f.prep.read()).pending).toBeUndefined(); expect(await events(f.nativePath)).toHaveLength(1);
  expect(await recoverPreparedModelSwitch(f.prep, { exclusiveWriters: true })).toEqual(result);
  await f.prep.abort();
});

it("outgoing close and diagnostic failures cannot mask a committed result; lastSwitch reconstructs ready", async () => {
  const f = await setup(), error = new Error("Fictional cleanup failure");
  f.outgoing.close.mockRejectedValue(error);
  const onCleanupError = vi.fn(() => { throw new Error("Fictional diagnostic failure"); });
  const result = await advancePreparedModelSwitch({ ...f.input, onCleanupError }); expect(result.status).toBe("ready");
  expect(onCleanupError).toHaveBeenCalledWith(error); expect((await f.prep.read()).pending).toBeUndefined();
  expect(await recoverPreparedModelSwitch(f.prep, { exclusiveWriters: true })).toEqual(result);
  expect(await advancePreparedModelSwitch(f.input)).toEqual(result);
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(await events(f.nativePath)).toHaveLength(1);
  await f.prep.abort();
  const reopened = createDurableHistoryStore({ root: join(f.base, "history"), nativeJournalStorage: f.native,
    retireProviderSession: async () => { throw new Error("Preserve committed chain"); } });
  const restarted = await reopened.beginProviderSessionPreparation(bucket, "receipt-recovery");
  try { expect(await recoverPreparedModelSwitch(restarted, { exclusiveWriters: true })).toEqual(result); }
  finally { await restarted.abort(); }
});

it("outgoing close rejection cannot replace the original producer exception", async () => {
  const f = await setup(), producerError = new Error("Fictional original producer failure"), cleanupError = new Error("Fictional close failure");
  f.outgoing.produceHandoffSummary.mockRejectedValue(producerError); f.outgoing.close.mockRejectedValue(cleanupError);
  const onCleanupError = vi.fn();
  await expect(advancePreparedModelSwitch({ ...f.input, onCleanupError })).rejects.toBe(producerError);
  expect(onCleanupError).toHaveBeenCalledWith(cleanupError); expect((await f.prep.read()).pending?.attempts[0]?.outcome).toBe("started");
  await f.prep.abort();
});

it("begin rejects a different initiating delivery digest for otherwise identical intent coordinates", async () => {
  const f = await setup(), lease = await f.prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected storage lease"); await lease.release();
  const { switchId: _id, ...identity } = f.state.identity;
  const changed = createModelSwitchState(identity, f.state.reservation, f.state.frozenBudget, explicitSwitchMessageDigest("different-durable-delivery"));
  expect(changed.identity.switchId).toBe(f.state.identity.switchId);
  await expect(f.prep.beginModelSwitchStorage(changed)).rejects.toThrow("initiating message identity conflicts");
  expect((await f.prep.read()).pending).toEqual(f.state); await f.prep.abort();
});

it("checks the bounded delivery-ID shape without pretending it proves host durability", () => {
  for (const id of ["", " ", " delivery", "delivery\n", "delivery\0id", "x".repeat(513)]) expect(() => explicitSwitchMessageDigest(id)).toThrow();
  expect(explicitSwitchMessageDigest("channel:conversation:delivery:001")).toMatch(/^[a-f0-9]{64}$/u);
});

it.each(["host", "input"])("new-generation %s overflow refuses before billing or authorizing another generation", async (part) => {
  const f = await setup(), lease = await f.prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected storage lease");
  await lease.advanceUnfit(); await lease.advanceUnfit(); await lease.advanceUnfit(); await lease.release();
  const before = (await f.prep.read()).pending;
  const incoming = producer();
  if (part === "host") incoming.snapshot = { ...incoming.snapshot, systemPrompt: "x".repeat(70000) };
  else incoming.snapshot = { ...incoming.snapshot, messages: [{ role: "user", content: "x".repeat(20000) }] };
  const result = await advancePreparedModelSwitch({ ...f.input, incoming, messageId: "new-explicit-delivery" });
  expect(result).toEqual({ status: "budget_failure", reason: part === "host" ? "host_cap" : "input_allowance" });
  expect((await f.prep.read()).pending).toEqual(before); expect(incoming.produceHandoffSummary).not.toHaveBeenCalled();
  expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled(); await f.prep.abort();
});

it("incoming prepared execution commits through the real native P2 inspector, retaining one switch and one admitted turn", async () => {
  const f = await setup(); await f.prep.abort();
  const nativeRoot = join(f.base, "native"), runtime = createMonoRuntime({ workspace: f.base });
  const faux = fauxProvider({ models: [{ id: "B", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  const transport = vi.spyOn(faux.provider, "streamSimple");
  const models = createModels(); models.setProvider(faux.provider);
  const observations: RuntimeSessionTurnReconciliationResult[] = [];
  const inspect = vi.fn(async (request: ConversationHistoryTurnInspection) => {
    const result = await runtime.reconcileSessionTurn!({ descriptor: request.descriptor, purpose: request.purpose, expectedInputs: request.expectedInputs,
      sessionsRoot: nativeRoot, expectedModel: { provider: "faux", id: "B" } }); observations.push(result); return result;
  });
  const store = createDurableHistoryStore({ root: join(f.base, "history"), nativeJournalStorage: f.native, reconcileProviderSessionTurn: inspect,
    retireProviderSession: async () => { throw new Error("Real incoming must retain its native chain"); } });
  const prep = await store.beginProviderSessionPreparation(bucket, "real-incoming-turn");
  const message = "Fictional real incoming input", controller = new AbortController();
  const incoming = await prepareHarnessRuntime({ options: { identityPath: "/fictional/identity.md", model: { provider: "faux", model: "B", reference: "faux:B" },
    runtime, runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, allowedTools: [], compaction: { enabled: false } } },
    request: { conversationId: bucket, userMessage: message, abortSignal: controller.signal }, recorder: { onEvent: vi.fn() } as unknown as RunRecorder,
    sessionsEnabled: true, runId: "real-incoming-turn", durablePiSessionsRoot: nativeRoot,
    routing: { modelKey: "faux:B", runtimeForSession: () => runtime, onRuntimeSelected: vi.fn() },
    attachmentContext: { root: "", allowedPaths: [], allowedIdentities: [] }, continuationCapabilities: [], turnContinuityCollector: new UncommittedTurnCollector(),
    assertOwned: () => prep.assertOwned(), prepareContext: async () => ({ context: buildAgentContext({ identity: "Fictional stable rules", userMessage: message }),
      memory: undefined, skillDisclosureEntries: [], history: [], historyOmitted: false, historyAsMessages: false, toolHistoryProjection: undefined }) });
  let turn: Awaited<ReturnType<typeof prep.admit>> | undefined;
  try {
    const captured = await prep.captureNativeEvidence({ provider: "faux", api: "faux-api", model: "A", account: null });
    const source = (await prep.read()).source; if (source.status !== "supported") throw new Error("Expected source");
    const state = createPreparedModelSwitchState({ source, sources: captured.sources, incoming: incoming.snapshot, native: f.native,
      targetEpoch: "5".repeat(64), reservation: f.state.reservation, timestamp: 17, messageId: "channel:conversation:delivery:real", outputReserve: 2000 });
    const ready = await advancePreparedModelSwitch({ preparation: prep, native: f.native, incoming, state, view: captured.view,
      messageId: "channel:conversation:delivery:real", exclusiveWriters: true });
    if (ready.status !== "ready") throw new Error("Expected ready switch");
    faux.setResponses([fauxAssistantMessage([fauxText("Fictional inspected reply")])]);
    const result = await runPreparedModelSwitch({ preparation: prep, incoming, ready, sessionsRoot: nativeRoot,
      binding: { modelKey: "faux:B", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: message, timestamp: "2000-01-01T00:00:00.000Z" } } },
      onAdmitted: (value) => { turn = value; } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fictional inspected reply"); expect(result.error).toBeFalsy(); expect(result.cancelled).not.toBe(true);
    await (await turn!.prepareCommit([{ role: "user", content: message, runId: "real-incoming-turn", timestamp: "2000-01-01T00:00:00.000Z" },
      { role: "assistant", content: result.text!, runId: "real-incoming-turn", timestamp: "2000-01-01T00:00:01.000Z" }], { providerSessionSynced: true })).commit();
    expect(inspect).toHaveBeenCalled(); expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({ status: "matched", outcome: "completed" })]));
    const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8"));
    expect(canonical.lastCommit.turnId).toBe("real-incoming-turn"); expect(canonical.providerSession.revision).toBe(1); expect(canonical.native.chain).toHaveLength(2);
    expect(await events(f.nativePath)).toHaveLength(1); expect(await store.recoverProviderSessionTurn(bucket)).toEqual({ status: "clean" });
    expect(transport).toHaveBeenCalledTimes(1);
  } finally { await incoming.close(); await turn?.abort(); await prep.abort(); }
});


it("an already-authorized generation one rechecks fit before spending its producer slots", async () => {
  const f = await setup(), lease = await f.prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected lease");
  await lease.advanceUnfit(); await lease.advanceUnfit(); await lease.advanceUnfit();
  const messageId = "authorized-generation-one";
  await lease.authorizeMessage(explicitSwitchMessageDigest(messageId)); await lease.release();
  const before = (await f.prep.read()).pending!; expect(before.authorizationGeneration).toBe(1); expect(before.attempts).toHaveLength(0);
  const incoming = producer(); incoming.snapshot = { ...incoming.snapshot, messages: [{ role: "user", content: "x".repeat(20000) }] };
  expect(await advancePreparedModelSwitch({ ...f.input, incoming, messageId })).toEqual({ status: "budget_failure", reason: "input_allowance" });
  expect((await f.prep.read()).pending).toEqual(before); expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled();
  expect(incoming.produceHandoffSummary).not.toHaveBeenCalled(); await f.prep.abort();
});


it("accepted cached bytes roll forward before a later message's budget refusal", async () => {
  const f = await setup(), proto = ModelSwitchPayloadStore.prototype as any, publish = proto.publishState;
  let interrupted = false;
  vi.spyOn(proto, "publishState").mockImplementation(async function (this: unknown, state: any, owner: unknown) {
    if (state.phase === "ready" && !interrupted) { interrupted = true; throw new Error("Fictional ready pointer interruption"); }
    return await publish.call(this, state, owner);
  });
  await expect(advancePreparedModelSwitch(f.input)).rejects.toThrow("ready pointer interruption");
  expect((await f.prep.read()).pending?.phase).toBe("outgoing");
  const incoming = producer(); incoming.snapshot = { ...incoming.snapshot, systemPrompt: "x".repeat(70000) };
  const result = await advancePreparedModelSwitch({ ...f.input, incoming, messageId: "oversized-new-message" });
  expect(result.status).toBe("ready"); expect((await f.prep.read()).pending).toBeUndefined();
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledTimes(1); expect(incoming.produceHandoffSummary).not.toHaveBeenCalled();
  expect(await events(f.nativePath)).toHaveLength(1); await f.prep.abort();
});
