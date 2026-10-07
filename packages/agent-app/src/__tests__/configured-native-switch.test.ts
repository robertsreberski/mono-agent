import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { AgentHarnessFailureError, type AgentHarness, type AgentHarnessRequest, type ConversationHistoryStore } from "@mono-agent/agent-harness";
import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createManagedNativeJournalStorage, createMonoRuntime, type MonoRuntimeLike, type RuntimeNativePreparedDispatch } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentResponderForApp, wrapOwnedConfiguredRuntime } from "../configured-agent.js";
import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";
import { createSlackPostedReplyHistory } from "../posted-reply-history.js";
import { persistedWebDeliveryId, serializeNativeSwitchHarness } from "../configured-native-switch.js";
import { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } from "../agent-root-coordinator.js";
import { completionOnlyRuntime } from "../configured-runtime-capabilities.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const reply = (value: string) => fauxAssistantMessage([fauxText(value)]);
const summary = JSON.stringify({ intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: ["Fictional progress"], failures: [], openWork: [], nextActions: [], references: [] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "app-native-switch-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identityPath = join(root, "IDENTITY.md"), nativeRoot = join(root, "native"); await writeFile(identityPath, "Fictional stable instructions");
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 1000000, maxTokens: 4096 }, { id: "B", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), native = createManagedNativeJournalStorage({ sessionsRoot: nativeRoot });
  const config: MonoAgentConfig = {
    runtime: { model: { provider: "faux", model: "A", reference: "faux:A" }, workspace: root, maxTurns: 4, session: { mode: "continuous", idleTimeoutMs: 600000, rollover: "none" } },
    providers: { piNative: { piSessionsRoot: nativeRoot } }, context: { identityPath, selectedSkills: [] }, tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts"), retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false }, memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false } },
    traceability: { registryDir: join(root, "trace") },
  };
  const runtimeFor = (id: string) => {
    const raw = createMonoRuntime({ workspace: root }), run = raw.run.bind(raw), prepare = raw.prepareNativeDispatch!.bind(raw);
    raw.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    raw.prepareNativeDispatch = (prompt, options) => prepare(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    const owned = wrapOwnedConfiguredRuntime(raw, config, root, undefined); cleanup.push(() => owned.disposeAllSessions!()); return owned;
  };
  let store: ConversationHistoryStore | undefined;
  let preparation = vi.fn(), draining = vi.fn();
  const make = async (enabled: boolean) => {
    const posted = createSlackPostedReplyHistory({ maxMessages: 64 });
    const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime: runtimeFor("A"), runtimeForModel: (ref) => runtimeFor(ref.model), runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: config.runtime.model }), runtimeOptions: { piResolvedModels: models, compaction: { enabled: false } } }, {
      sessionRollover: "none", wrapHistoryStore: (base) => { store = base; draining = vi.fn(base.drainPendingProviderSessionTurns!.bind(base)); base.drainPendingProviderSessionTurns = draining; preparation = vi.fn(base.beginProviderSessionPreparation!.bind(base)); base.beginProviderSessionPreparation = preparation; return posted.wrapHistoryStore(base); },
      ...(enabled ? { nativeModelSwitch: { exclusiveWriters: true as const, native } } : {}),
    });
    const wrapped = posted.wrapResponder(responder); cleanup.push(() => (wrapped as AgentResponder & { dispose(): Promise<void> }).dispose()); return wrapped;
  };
  const request = (id: string | undefined, model = "faux:A"): AgentRequestBase => ({ conversationId: "web:fictional-thread", text: "Fictional current input", abortSignal: new AbortController().signal,
    metadata: { web: { threadId: "fictional-thread", model, ...(id === undefined ? {} : { userMessageId: id }) }, tui: { requestId: randomUUID() } } });
  const record = async () => {
    for (const name of (await readdir(join(root, "history"))).filter((name) => name.endsWith(".history.json"))) {
      const record = JSON.parse(await readFile(join(root, "history", name), "utf8"));
      if (record.conversationId === "web:fictional-thread") return record;
    }
    throw new Error("Fictional conversation record missing");
  };
  const dispose = async (responder: AgentResponder) => await (responder as AgentResponder & { dispose(): Promise<void> }).dispose();
  const seed = async () => { const h = await make(false); faux.setResponses([reply("Fictional A reply")]); await h.respond(request(undefined), { append: async () => {} }); await dispose(h); };
  return { root, config, native, nativeRoot, faux, transport, request, record, make, seed, dispose, runtimeFor, getStore: () => store!, getPreparation: () => preparation, getDraining: () => draining };
}

it("APP wrappers prepare a persisted Web delivery, dispatch once, then refuse no-id guarded admission without cold rotation", async () => {
  const f = await fixture(); await f.seed(); const h = await f.make(true);
  const prepare = f.getPreparation();
  f.faux.setResponses([reply(summary), reply("Fictional B reply")]);
  expect((await h.respond(f.request("fictional-web-message", "faux:B"), { append: async () => {} })).text).toBe("Fictional B reply");
  expect(prepare).toHaveBeenCalledOnce();
  const before = await f.record(); expect(before.version).toBe(4); expect(before.native.chain).toHaveLength(2);
  expect(before.providerSession.modelKey).toBe("faux:B");
  const calls = f.transport.mock.calls.length;
  for (const model of ["faux:A", "faux:B"]) {
    await expect(h.respond(f.request(undefined, model), { append: async () => {} })).rejects.toMatchObject({ failure: { kind: "native_cold_model_change_unavailable" } });
  }
  expect(prepare).toHaveBeenCalledOnce(); expect(await f.record()).toEqual(before); expect(f.transport).toHaveBeenCalledTimes(calls);
});

it("operator per-attempt UUIDs select the original cold path before native preparation, authority or intent", async () => {
  const f = await fixture(); await f.seed(); const h = await f.make(true);
  const prepare = f.getPreparation(), authority = vi.spyOn(f.native, "measureSwitch");
  f.faux.setResponses([reply("Fictional ordinary B reply"), reply("Fictional ordinary B follow-up")]);
  for (let i = 0; i < 2; i++) await h.respond(f.request(undefined, "faux:B"), { append: async () => {} });
  expect(prepare).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled(); expect((await f.record()).version).toBe(3);
  expect((await readdir(join(f.root, "history"))).some((name) => name.includes("model-switch") || name.includes("native-history-root"))).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(3);
});

it("Web retry and responder restart reuse the persisted message id without a new billed generation", async () => {
  const f = await fixture(); await f.seed();
  // Force the paid producer boundary without an expensive large-history setup.
  // Real evidence capture, producer dispatch, billing and durable state remain real.
  vi.spyOn(f.native, "buildHandoff").mockReturnValue({ status: "budget_failure", reason: "fixture-forced-summary" });
  const h = await f.make(true), request = f.request("fictional-persisted-user-message", "faux:B");
  f.faux.setResponses([reply("Fictional invalid structured summary")]);
  await expect(h.respond(request, { append: async () => {} })).rejects.toBeInstanceOf(AgentHarnessFailureError);
  const inspect = async () => { const owner = await f.getStore().beginProviderSessionPreparation!(request.conversationId, "fictional-inspection"); try { return (await owner.read()).pending!; } finally { await owner.abort(); } };
  const first = await inspect(); expect(first.phase).toBe("pending"); expect(first.authorizationGeneration).toBe(0); expect(first.attempts).toHaveLength(2);
  const calls = f.transport.mock.calls.length;
  await expect(h.respond({ ...request, metadata: { ...request.metadata, tui: { requestId: randomUUID() } } }, { append: async () => {} })).rejects.toMatchObject({ failure: { kind: "handoff_pending" } });
  await f.dispose(h); const restarted = await f.make(true);
  await expect(restarted.respond(f.request("fictional-persisted-user-message", "faux:B"), { append: async () => {} })).rejects.toMatchObject({ failure: { kind: "handoff_pending" } });
  const redelivered = await inspect(); expect(redelivered.authorizationGeneration).toBe(0); expect(redelivered.authorizations).toEqual(first.authorizations); expect(redelivered.attempts).toEqual(first.attempts); expect(f.transport).toHaveBeenCalledTimes(calls);
});

it("real typed root contention drains without waiting on a pinned foreign claim or replaying the Web message", async () => {
  const f = await fixture(); await f.seed(); const h = await f.make(true);
  const foreign = await f.getStore().beginProviderSessionTurn!("fictional-other-owner", "fictional-pinned-run", { modelKey: "faux:A" });
  const before = await f.record();
  try {
    await expect(h.respond(f.request("fictional-busy-web-message", "faux:B"), { append: async () => {} }))
      .rejects.toMatchObject({ failure: { kind: "native_switch_busy", details: { retryable: true } } });
    expect(f.getDraining()).toHaveBeenCalledExactlyOnceWith({ limit: 32 });
    expect(await f.record()).toEqual(before); expect(f.transport).toHaveBeenCalledTimes(1);
    // The failed preparation's claim is gone while the unrelated claim is still
    // pinned. Inspection does not retry or admit the failed incoming message.
    const released = await f.getStore().beginProviderSessionPreparation!("web:fictional-thread", "fictional-post-busy-inspection");
    try { expect((await released.read()).pending).toBeUndefined(); } finally { await released.abort(); }
  } finally { await foreign.abort(); }
});

it("prepared configured runtime retains protection through summary/close, strips it from completion-only runtimes", async () => {
  const f = await fixture(), runtime = f.runtimeFor("A"), owner = await acquireAgentRootOwnership(f.root); cleanup.push(() => releaseAgentRootOwnershipWhenIdle(owner));
  const prepared = await runtime.prepareNativeDispatch!("Fictional prepared instructions", { model: { provider: "faux", model: "A", reference: "faux:A" }, messages: [{ role: "user", content: "Fictional input" }], abortSignal: new AbortController().signal, allowedTools: [], piSessionsRoot: f.nativeRoot });
  const settled = vi.fn(); const waiting = owner.coordinator.waitForSettlement().then(settled); await Promise.resolve(); await Promise.resolve();
  expect(settled).not.toHaveBeenCalled(); expect(prepared.assertReady).toBeTypeOf("function"); expect(prepared.checkHandoffSummary).toBeTypeOf("function"); expect(prepared.produceHandoffSummary).toBeTypeOf("function");
  expect(completionOnlyRuntime(runtime).prepareNativeDispatch).toBeUndefined(); expect(completionOnlyRuntime(runtime).nativePreparedDispatch).toBeUndefined();
  await prepared.close(); await prepared.close(); await waiting; expect(settled).toHaveBeenCalledOnce();
});

it("failed preparation releases protection, but duplicate dispatch cannot release a running lease", async () => {
  const f = await fixture(), owner = await acquireAgentRootOwnership(f.root); cleanup.push(() => releaseAgentRootOwnershipWhenIdle(owner));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const run = vi.fn(async () => { entered(); await gate; return { text: "Fictional reply" }; });
  const lease: RuntimeNativePreparedDispatch = { snapshot: {} as RuntimeNativePreparedDispatch["snapshot"], run, close: async () => {} };
  const prepare = vi.fn(async () => lease).mockRejectedValueOnce(new Error("Fictional preparation failure"));
  const raw: MonoRuntimeLike = { run: async () => ({ text: "unused" }), nativePreparedDispatch: "v1", prepareNativeDispatch: prepare };
  const runtime = wrapOwnedConfiguredRuntime(raw, f.config, f.root, undefined); cleanup.push(() => runtime.disposeAllSessions!());
  const options = { messages: [], model: f.config.runtime.model, abortSignal: new AbortController().signal };
  await expect(runtime.prepareNativeDispatch!("Fictional instructions", options)).rejects.toThrow("Fictional preparation failure");
  await owner.coordinator.waitForSettlement();
  const prepared = await runtime.prepareNativeDispatch!("Fictional instructions", options);
  const running = prepared.run(); await started;
  await expect(prepared.run()).rejects.toThrow("already been consumed"); expect(run).toHaveBeenCalledOnce();
  const settled = vi.fn(), waiting = owner.coordinator.waitForSettlement().then(settled); await Promise.resolve(); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
  release(); await running; await waiting; expect(settled).toHaveBeenCalledOnce(); await prepared.close();
});

it("root gate serializes siblings and mutations before claims, drains typed busy after release, never replays", async () => {
  let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  const firstRun = vi.fn(async () => { held = true; entered(); await gate; held = false; return { metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] }, failure: { kind: "native_switch_busy", message: "Fictional busy", details: { retryable: true } } }; });
  const response = { text: "Fictional reply", metadata: { runId: "fictional-next", conversationId: "fictional", contextSources: [], contextSectionIds: [] } };
  const nextRun = vi.fn(async () => { expect(held).toBe(false); return response; });
  const drain = vi.fn(async () => { expect(held).toBe(false); return { settled: 0, busy: 1, unresolved: 0, remaining: false }; });
  const reset = vi.fn(async () => { expect(held).toBe(false); });
  const store: ConversationHistoryStore = { load: async () => [], append: async () => {}, drainPendingProviderSessionTurns: drain };
  const a = serializeNativeSwitchHarness({ run: firstRun }, "fictional-canonical-root", store);
  const b = serializeNativeSwitchHarness({ run: nextRun, resetConversation: reset }, "fictional-canonical-root", store);
  const request: AgentHarnessRequest = { conversationId: "fictional", userMessage: "Fictional input", abortSignal: new AbortController().signal };
  const first = a.run(request); await started; const next = b.run(request), mutation = b.resetConversation!("fictional"); await Promise.resolve();
  expect(nextRun).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled(); release();
  expect((await first).failure?.kind).toBe("native_switch_busy"); await next; await mutation;
  expect(firstRun).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledExactlyOnceWith({ limit: 32 }); expect(nextRun).toHaveBeenCalledOnce();
});

it("queued cancellation/disposal never enters harness claims; a subsequent root owner is not poisoned", async () => {
  let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const result = { metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] } };
  const store: ConversationHistoryStore = { load: async () => [], append: async () => {} };
  const active = serializeNativeSwitchHarness({ run: async () => { entered(); await gate; return result; } }, "fictional-queue-root", store);
  const run = vi.fn(async () => result), queued = serializeNativeSwitchHarness({ run }, "fictional-queue-root", store);
  const request: AgentHarnessRequest = { conversationId: "fictional", userMessage: "Fictional input", abortSignal: new AbortController().signal };
  const first = active.run(request); await started; const next = queued.run(request); const rejected = expect(next).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
  queued.cancel!("fictional", "Fictional cancellation"); const disposed = queued.dispose!(); release(); await first; await rejected; await disposed; expect(run).not.toHaveBeenCalled();
  const fresh = serializeNativeSwitchHarness({ run }, "fictional-queue-root", store); await fresh.run(request); expect(run).toHaveBeenCalledOnce();
});

it("identity seam excludes background/subagent messages and ignores run/request IDs", () => {
  const request: AgentHarnessRequest = { conversationId: "web:fictional-thread", userMessage: "Fictional input", abortSignal: new AbortController().signal, metadata: { web: { turnId: "fictional-turn", userMessageId: "fictional-message" }, tui: { requestId: randomUUID() } } };
  expect(persistedWebDeliveryId(request)).toBe("fictional-message");
  expect(persistedWebDeliveryId({ ...request, metadata: { web: { turnId: "fictional-turn" }, tui: { requestId: randomUUID() } } })).toBeUndefined();
  for (const metadata of [{ cron: {} }, { webhook: {} }, { processJob: {} }, { source: "subagent" }]) expect(persistedWebDeliveryId({ ...request, metadata: { ...request.metadata, ...metadata } })).toBeUndefined();
});
