import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { AgentHarnessFailureError, type AgentHarness, type AgentHarnessRequest, type ConversationHistoryStore } from "@mono-agent/agent-harness";
import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createManagedNativeJournalStorage, createMonoRuntime, type MonoRuntimeLike, type RuntimeNativePreparedDispatch } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentResponder, createConfiguredAgentResponderForApp, wrapOwnedConfiguredRuntime } from "../configured-agent.js";
import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";
import { createSlackPostedReplyHistory } from "../posted-reply-history.js";
import { persistedWebDeliveryId, serializeNativeSwitchHarness } from "../configured-native-switch.js";
import { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } from "../agent-root-coordinator.js";
import { completionOnlyRuntime } from "../configured-runtime-capabilities.js";
import { loadAppCoreConfig } from "../app-config.js";
// White-box fixture uses Web's existing persisted inbound identity, not an APP ledger.
import { WebStore } from "../../../web/dist/store.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const reply = (value: string) => fauxAssistantMessage([fauxText(value)]);
const summary = JSON.stringify({ intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: ["Fictional progress"], failures: [], openWork: [], nextActions: [], references: [] });
async function fixture(publicConfig = false) {
  const root = await mkdtemp(join(tmpdir(), "app-native-switch-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identityPath = join(root, "IDENTITY.md"), nativeRoot = join(root, "native"); await writeFile(identityPath, "Fictional stable instructions");
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 1000000, maxTokens: 4096 }, { id: "B", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  const originalTransport = faux.provider.streamSimple.bind(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), native = createManagedNativeJournalStorage({ sessionsRoot: nativeRoot });
  const config: MonoAgentConfig = {
    runtime: { model: { provider: "faux", model: "A", reference: "faux:A" }, workspace: root, maxTurns: 4, session: { mode: "continuous", idleTimeoutMs: 600000, rollover: "none" } },
    providers: { piNative: { piSessionsRoot: nativeRoot } }, context: { identityPath, selectedSkills: [] }, tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts"), retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false }, memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false } },
    traceability: { registryDir: join(root, "trace") },
  };
  const runtimes: MonoRuntimeLike[] = [];
  const runtimeFor = (id: string) => {
    const raw = createMonoRuntime({ workspace: root }), run = raw.run.bind(raw), prepare = raw.prepareNativeDispatch!.bind(raw);
    raw.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    raw.prepareNativeDispatch = (prompt, options) => prepare(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    const owned = wrapOwnedConfiguredRuntime(raw, config, root, undefined); runtimes.push(owned); cleanup.push(() => owned.disposeAllSessions!()); return owned;
  };
  let store: ConversationHistoryStore | undefined;
  let activeNative = native;
  let preparation = vi.fn(), draining = vi.fn(), bindingRead = vi.fn();
  const make = async (enabled: boolean, unsupported?: "non-native" | "routed") => {
    let resolved = config;
    if (publicConfig) {
      const configPath = join(root, "mono-agent.config.json");
      await writeFile(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, model: "pi:openai-codex:gpt-5.5", session: {
        ...config.runtime.session, modelSwitch: { enabled, ...(enabled ? { olderWritersStopped: true } : {}) },
      } } }));
      // A real validated public config; the local faux transport is the only
      // provider replacement. No private native-switch capability is injected.
      resolved = await loadAppCoreConfig({ cwd: root, configPath, env: {} });
      resolved = { ...resolved, runtime: { ...resolved.runtime, model: config.runtime.model } };
    }
    const incoming = (id: string): MonoRuntimeLike => {
      const runtime = runtimeFor(id);
      if (id !== "A" || unsupported === undefined) return runtime;
      const { nativePreparedDispatch: _native, prepareNativeDispatch: _prepare, ...base } = runtime;
      if (unsupported === "routed") return base;
      const { sessionTurnReconciliation: _reconciliation, reconcileSessionTurn: _reconcile, ...nonNative } = base;
      return nonNative;
    };
    const posted = createSlackPostedReplyHistory({ maxMessages: 64 });
    const responder = await createConfiguredAgentResponderForApp({ config: resolved, cwd: root, runtime: incoming("A"), runtimeForModel: (ref) => incoming(ref.model), runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: config.runtime.model }), runtimeOptions: { piResolvedModels: models, compaction: { enabled: false } } }, {
      sessionRollover: "none", wrapHistoryStore: (base) => { store = base; bindingRead = vi.fn(base.readProviderSessionBinding!.bind(base)); base.readProviderSessionBinding = bindingRead; if (publicConfig && enabled) activeNative = (base as unknown as { nativeJournalStorage: typeof native }).nativeJournalStorage; draining = vi.fn(base.drainPendingProviderSessionTurns!.bind(base)); base.drainPendingProviderSessionTurns = draining; preparation = vi.fn(base.beginProviderSessionPreparation!.bind(base)); base.beginProviderSessionPreparation = preparation; return posted.wrapHistoryStore(base); },
      ...(enabled && !publicConfig ? { nativeModelSwitch: { exclusiveWriters: true as const, native } } : {}),
    });
    const wrapped = posted.wrapResponder(responder); cleanup.push(() => (wrapped as AgentResponder & { dispose(): Promise<void> }).dispose()); return wrapped;
  };
  const request = (id: string | undefined, model = "faux:A"): AgentRequestBase => ({ conversationId: "web:fictional-thread", text: "Fictional current input", abortSignal: new AbortController().signal,
    metadata: { source: "web", web: { threadId: "fictional-thread", model, ...(id === undefined ? {} : { userMessageId: id }) }, tui: { requestId: randomUUID() } } });
  const record = async () => {
    for (const name of (await readdir(join(root, "history"))).filter((name) => name.endsWith(".history.json"))) {
      const record = JSON.parse(await readFile(join(root, "history", name), "utf8"));
      if (record.conversationId === "web:fictional-thread") return record;
    }
    throw new Error("Fictional conversation record missing");
  };
  const dispose = async (responder: AgentResponder) => await (responder as AgentResponder & { dispose(): Promise<void> }).dispose();
  const seed = async () => { const h = await make(false); faux.setResponses([reply("Fictional A reply")]); await h.respond(request(undefined), { append: async () => {} }); await dispose(h); };
  const makePublic = async () => {
    const configPath = join(root, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ ...config, runtime: { ...config.runtime, model: "pi:openai-codex:gpt-5.5", session: {
      ...config.runtime.session, modelSwitch: { enabled: true, olderWritersStopped: true },
    } } }));
    const loaded = await loadAppCoreConfig({ cwd: root, configPath, env: {} });
    const resolved = { ...loaded, runtime: { ...loaded.runtime, model: config.runtime.model } };
    const h = await createConfiguredAgentResponder({ config: resolved, cwd: root, runtime: runtimeFor("A"), runtimeForModel: (ref) => runtimeFor(ref.model),
      runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: config.runtime.model }), runtimeOptions: { piResolvedModels: models, compaction: { enabled: false } } });
    cleanup.push(() => dispose(h)); return h;
  };
  return { root, config, runtimes, get native() { return activeNative; }, nativeRoot, faux, transport, originalTransport, request, record, make, makePublic, seed, dispose, runtimeFor, getStore: () => store!, getPreparation: () => preparation, getBindingRead: () => bindingRead, getDraining: () => draining };
}

it.each([false, true])("same-model no-ID wakes inherit the chain; explicit no-ID changes refuse (public=%s)", async (publicConfig) => {
  const f = await fixture(publicConfig); await f.seed(); const h = await f.make(true);
  f.faux.setResponses([reply(summary), reply("Fictional B reply")]);
  await h.respond(f.request("fictional-web-message", "faux:B"), { append: async () => {} });
  const before = await f.record(); expect(before.version).toBe(4); expect(before.native.chain).toHaveLength(2);
  const measure = vi.spyOn(f.native, "measureSwitch"), handoff = vi.spyOn(f.native, "prepareHandoff");
  const calls = f.transport.mock.calls.length;
  for (const wake of [{ source: "web", web: { trigger: "job" } }, { cron: { jobId: "fictional-scheduled", model: "faux:B" } }]) {
    f.faux.setResponses([reply("Fictional ordinary wake reply")]);
    const request = f.request(undefined, "faux:B");
    expect((await h.respond({ ...request, metadata: { ...request.metadata, ...wake } }, { append: async () => {} })).text).toBe("Fictional ordinary wake reply");
  }
  const after = await f.record(); expect(after.providerSession.modelKey).toBe("faux:B");
  expect(after.providerSession.epoch).toBe(before.providerSession.epoch); expect(after.providerSession.revision).toBe(before.providerSession.revision + 2);
  expect(after.native.chain).toHaveLength(2); expect(after.lastSwitch).toEqual(before.lastSwitch);
  expect(f.transport).toHaveBeenCalledTimes(calls + 2); expect(measure).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
  const inspect = await f.getStore().beginProviderSessionPreparation!("web:fictional-thread", "fictional-wake-inspection");
  try { expect((await inspect.read()).pending).toBeUndefined(); } finally { await inspect.abort(); }
  for (const source of ["web", "tui", "acp"]) {
    const refused = f.request(source === "web" ? undefined : "fictional-spoofed-web-id", "faux:A");
    await expect(h.respond({ ...refused, metadata: { ...refused.metadata, source } }, { append: async () => {} }))
      .rejects.toMatchObject({ failure: { kind: "native_cold_model_change_unavailable" } });
  }
  expect(await f.record()).toEqual(after); expect(f.transport).toHaveBeenCalledTimes(calls + 2);
});

it.each(["non-native", "routed"] as const)("ID-carrying %s fallback cannot cold-rotate a v4 native source", async (unsupported) => {
  const f = await fixture(); await f.seed(); const h = await f.make(true);
  f.faux.setResponses([reply(summary), reply("Fictional B reply")]);
  await h.respond(f.request("fictional-first-web-message", "faux:B"), { append: async () => {} }); await f.dispose(h);
  const before = await f.record(), calls = f.transport.mock.calls.length;
  const fallback = await f.make(true, unsupported);
  await expect(fallback.respond(f.request("fictional-next-web-message", "faux:A"), { append: async () => {} }))
    .rejects.toMatchObject({ failure: { kind: "native_cold_model_change_unavailable" } });
  expect(await f.record()).toEqual(before); expect(f.transport).toHaveBeenCalledTimes(calls); expect(f.getPreparation()).not.toHaveBeenCalled();
});

it("operator per-attempt UUIDs select the original cold path before native preparation, authority or intent", async () => {
  const f = await fixture(); await f.seed(); const h = await f.make(true);
  const prepare = f.getPreparation(), authority = vi.spyOn(f.native, "measureSwitch");
  f.faux.setResponses([reply("Fictional ordinary B reply"), reply("Fictional ordinary B follow-up")]);
  for (let i = 0; i < 2; i++) {
    const request = f.request(undefined, "faux:B");
    await h.respond({ ...request, metadata: { ...request.metadata, source: "tui" } }, { append: async () => {} });
  }
  expect(prepare).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled(); expect((await f.record()).version).toBe(3);
  expect((await readdir(join(f.root, "history"))).some((name) => name.includes("model-switch") || name.includes("native-history-root"))).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(3);
});

it.each([false, true])("Web retry/reopen never authorize a new billed generation (public=%s)", async (publicConfig) => {
  const f = await fixture(publicConfig); await f.seed();
  // Force the paid producer boundary without an expensive large-history setup.
  // Real evidence capture, producer dispatch, billing and durable state remain real.
  const h = await f.make(true);
  vi.spyOn(f.native, "buildHandoff").mockReturnValue({ status: "budget_failure", reason: "fixture-forced-summary" });
  const request = { ...f.request("fictional-persisted-user-message", "faux:B"), text: "Fictional blocked input must never replay" };
  f.faux.setResponses([reply("Fictional invalid structured summary")]);
  await expect(h.respond(request, { append: async () => {} })).rejects.toBeInstanceOf(AgentHarnessFailureError);
  const inspect = async () => { const owner = await f.getStore().beginProviderSessionPreparation!(request.conversationId, "fictional-inspection"); try { return (await owner.read()).pending!; } finally { await owner.abort(); } };
  const first = await inspect(); expect(first.phase).toBe("pending"); expect(first.authorizationGeneration).toBe(0); expect(first.attempts).toHaveLength(2);
  const calls = f.transport.mock.calls.length;
  await expect(h.respond({ ...request, metadata: { ...request.metadata, tui: { requestId: randomUUID() } } }, { append: async () => {} })).rejects.toMatchObject({ failure: { kind: "handoff_pending" } });
  await f.dispose(h); const restarted = await f.make(true);
  await expect(restarted.respond(f.request("fictional-persisted-user-message", "faux:B"), { append: async () => {} })).rejects.toMatchObject({ failure: { kind: "handoff_pending" } });
  const redelivered = await inspect(); expect(redelivered.authorizationGeneration).toBe(0); expect(redelivered.authorizations).toEqual(first.authorizations); expect(redelivered.attempts).toEqual(first.attempts); expect(f.transport).toHaveBeenCalledTimes(calls);
  if (publicConfig) {
    // A pending legacy-source switch is still non-v4: no-ID input takes the
    // original admission path, whose pending-storage guard refuses without replay.
    const preparationCalls = f.getPreparation().mock.calls.length;
    await expect(restarted.respond({ ...request, metadata: { source: "web", web: { trigger: "job" } } }, { append: async () => {} }))
      .rejects.toMatchObject({ failure: { kind: "handoff_pending" } });
    expect(f.getPreparation()).toHaveBeenCalledTimes(preparationCalls);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    const build = f.native.buildHandoff.bind(f.native);
    vi.spyOn(f.native, "buildHandoff").mockImplementation((view, options) => options.summary
      ? build(view, options) : { status: "budget_failure", reason: "fixture-forced-summary" });
    f.faux.setResponses([reply(summary), reply("Fictional newly authorized answer")]);
    await restarted.respond({ ...f.request("fictional-next-persisted-id", "faux:B"), text: "Fictional next explicit input" }, { append: async () => {} });
    expect(f.transport).toHaveBeenCalledTimes(calls + 2); // One paid producer + ordinary incoming turn.
    expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
    const messages = await f.getStore().load(request.conversationId);
    expect(messages.some((message) => message.content === request.text)).toBe(false);
    expect(messages.at(-2)?.content).toBe("Fictional next explicit input");
  }
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
  expect(runtime.salvageDurableSession).toBeUndefined();
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

it("configured queued responder disposal does not wait for a foreign gate or protection lease", async () => {
  const f = await fixture(), local = await f.make(true), owner = await acquireAgentRootOwnership(f.root); cleanup.push(() => releaseAgentRootOwnershipWhenIdle(owner));
  const runtime = f.runtimeFor("A"), prepared = await runtime.prepareNativeDispatch!("Fictional foreign instructions", {
    model: f.config.runtime.model, messages: [], abortSignal: new AbortController().signal,
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const foreign = serializeNativeSwitchHarness({ run: async () => {
    entered(); try { await gate; return { metadata: { runId: "fictional-foreign", conversationId: "web:fictional-thread", contextSources: [], contextSectionIds: [] } }; }
    finally { await prepared.close(); }
  } }, owner.agentRoot, f.getStore());
  const active = foreign.run({ conversationId: "web:fictional-thread", userMessage: "Fictional foreign input", abortSignal: new AbortController().signal }); await started;
  const globalSettled = vi.fn(), allSettled = owner.coordinator.waitForSettlement().then(globalSettled);
  try {
    const queued = local.respond(f.request(undefined), { append: async () => {} });
    const cancelled = expect(queued).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
    // Let responder admission reach its conversation queue; never release foreign.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await f.dispose(local); await cancelled;
    expect(globalSettled).not.toHaveBeenCalled(); expect(f.getPreparation()).not.toHaveBeenCalled();
  } finally { release(); await active; await allSettled; }
});

it("bounded runtime disposal preserves own and foreign protection leases until true settlement", async () => {
  const f = await fixture(), first = f.runtimeFor("A"), foreign = f.runtimeFor("B");
  const options = { model: f.config.runtime.model, messages: [], abortSignal: new AbortController().signal };
  const own = await first.prepareNativeDispatch!("Fictional own instructions", options); cleanup.push(() => own.close());
  const other = await foreign.prepareNativeDispatch!("Fictional foreign instructions", { ...options, model: { provider: "faux", model: "B", reference: "faux:B" } }); cleanup.push(() => other.close());
  const owner = await acquireAgentRootOwnership(f.root); cleanup.push(() => releaseAgentRootOwnershipWhenIdle(owner));
  const settled = vi.fn(), waiting = owner.coordinator.waitForSettlement().then(settled);
  await first.disposeAllSessions!(); expect(settled).not.toHaveBeenCalled();
  try { await own.close(); await Promise.resolve(); expect(settled).not.toHaveBeenCalled(); other.assertReady?.(); }
  finally { await other.close(); await waiting; }
});

it("conversation gate serializes siblings and mutations before claims, drains typed busy after release, never replays", async () => {
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

it("queued cancellation/disposal settles while a foreign conversation gate remains held", async () => {
  let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const result = { metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] } };
  const store: ConversationHistoryStore = { load: async () => [], append: async () => {} };
  const active = serializeNativeSwitchHarness({ run: async () => { entered(); await gate; return result; } }, "fictional-queue-root", store);
  const run = vi.fn(async () => result), queued = serializeNativeSwitchHarness({ run }, "fictional-queue-root", store);
  const request: AgentHarnessRequest = { conversationId: "fictional", userMessage: "Fictional input", abortSignal: new AbortController().signal };
  const first = active.run(request); await started; const next = queued.run(request); const rejected = expect(next).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
  queued.cancel!("fictional", "Fictional cancellation"); await rejected; await queued.dispose!(); expect(run).not.toHaveBeenCalled();
  release(); await first;
  const fresh = serializeNativeSwitchHarness({ run }, "fictional-queue-root", store); await fresh.run(request); expect(run).toHaveBeenCalledOnce();
});

it("identity seam requires a host-stamped Web source and excludes background authorization", () => {
  const request: AgentHarnessRequest = { conversationId: "web:fictional-thread", userMessage: "Fictional input", abortSignal: new AbortController().signal, metadata: { source: "web", web: { turnId: "fictional-turn", userMessageId: "fictional-message" }, tui: { requestId: randomUUID() } } };
  expect(persistedWebDeliveryId(request)).toBe("fictional-message");
  expect(persistedWebDeliveryId({ ...request, metadata: { web: { turnId: "fictional-turn" }, tui: { requestId: randomUUID() } } })).toBeUndefined();
  for (const metadata of [{ cron: {} }, { webhook: {} }, { processJob: {} }, { source: "tui" }, { source: "acp" }, { source: undefined }]) expect(persistedWebDeliveryId({ ...request, metadata: { ...request.metadata, ...metadata } })).toBeUndefined();
});

async function nativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) files.push(...await nativeFiles(join(root, entry.name)));
    else if (entry.name.endsWith(".jsonl")) files.push(join(root, entry.name));
  }
  return files;
}
async function modelChanges(root: string) {
  return (await Promise.all((await nativeFiles(root)).map((file) => readFile(file, "utf8"))))
    .flatMap((text) => text.trim().split("\n").map((line) => JSON.parse(line)))
    .filter((record) => record.kind === "model_change");
}
it.each([false, true])("public config switches once before incoming dispatch, including different-model reopen (fresh=%s)", async (fresh) => {
  const f = await fixture(true);
  if (!fresh) await f.seed();
  const stateDir = join(await realpath(f.root), "web-state");
  let web = await WebStore.open({ stateDir, clock: () => new Date("2000-01-01T00:00:00Z") });
  cleanup.push(async () => web.close());
  web.replaceAgents([{ sourceId: "fictional-agent", label: "Fictional Agent", status: "online", health: "running", supportsAttachments: false,
    models: [], efforts: [], modelOptions: {}, runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: "2000-01-01T00:00:00Z" }]);
  const thread = web.createThread("fictional-agent");
  const started = web.beginTurn({ threadId: thread.id, text: "Fictional current input", attachmentIds: [] });
  const persistedId = started.userMessageId;
  expect(web.getMessage(persistedId)?.id).toBe(persistedId);
  web.close(); web = await WebStore.open({ stateDir });
  expect(web.getMessage(persistedId)?.id).toBe(persistedId);
  const h = await f.makePublic();
  if (fresh) {
    f.faux.setResponses([reply("Fictional initial A answer")]);
    await h.respond(f.request("fictional-first-id"), { append: async () => {} });
  }
  const before = await f.record(); expect(before.version).toBe(3);
  const canonicalPath = join(f.root, "history", (await readdir(join(f.root, "history"))).find((name) => name.endsWith(".history.json"))!);
  const sourcePath = (await nativeFiles(f.nativeRoot))[0]!;
  let incomingDispatches = 0;
  f.transport.mockImplementation((...args) => {
    if (args[0].id === "B") {
      incomingDispatches++;
      const record = JSON.parse(readFileSync(canonicalPath, "utf8"));
      expect(record.version).toBe(4); expect(record.providerSession.modelKey).toBe("faux:B");
      expect(readFileSync(sourcePath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "model_change")).toHaveLength(1);
    }
    return f.originalTransport(...args);
  });
  f.faux.setResponses([reply(summary), reply("Fictional incoming B answer")]);
  const seen: unknown[] = [];
  await h.respond(f.request(persistedId, "faux:B"), { append: async () => {
    seen.push(await f.record()); expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
  } });
  const switched = await f.record(); expect(switched.version).toBe(4); expect(switched.native.chain).toHaveLength(2);
  expect(switched.providerSession.modelKey).toBe("faux:B"); expect(seen.length).toBeGreaterThan(0); expect(incomingDispatches).toBe(1);
  expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
  const calls = f.transport.mock.calls.length;
  await f.dispose(h); const reopened = await f.makePublic();
  f.faux.setResponses([reply("Fictional retry B answer")]);
  await reopened.respond(f.request(persistedId, "faux:B"), { append: async () => {} });
  expect(f.transport).toHaveBeenCalledTimes(calls + 1); // Ordinary dispatch, no summary.
  expect((await f.record()).lastSwitch).toEqual(switched.lastSwitch);
  expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
});
it.each([false, true])("Slack no-ID other-model turn keeps the original cold replay on never-upgraded history (enabled=%s)", async (enabled) => {
  const f = await fixture(true); await f.seed(); const before = await f.record(), h = await f.make(enabled);
  const binding = f.getBindingRead();
  const measure = vi.spyOn(f.native, "measureSwitch");
  f.faux.setResponses([reply("Fictional cold B answer")]);
  const request = { ...f.request(undefined), metadata: { source: "slack", slack: { channelId: "fictional-channel", threadTs: "fictional-thread", model: "faux:B" } } };
  expect((await h.respond(request, { append: async () => {} })).text).toBe("Fictional cold B answer");
  const after = await f.record(); expect(after.version).toBe(3); expect(after.providerSession.modelKey).toBe("faux:B");
  expect(after.providerSession.epoch).not.toBe(before.providerSession.epoch);
  expect(f.transport).toHaveBeenCalledTimes(2); expect(f.getPreparation()).not.toHaveBeenCalled(); expect(measure).not.toHaveBeenCalled();
  expect(binding).toHaveBeenCalledTimes(enabled ? 1 : 0);
  expect(JSON.stringify(f.transport.mock.calls.at(-1))).toContain("Fictional A reply"); // Canonical cold replay.
  expect((await readdir(join(f.root, "history"))).some((name) => name.includes("native-history-root") || name.includes("model-switch"))).toBe(false);
});
it("Slack no-ID other-model turn refuses only after native upgrade; keyword prose never escalates a wake", async () => {
  const f = await fixture(true); await f.seed(); const h = await f.make(true);
  f.faux.setResponses([reply(summary), reply("Fictional B answer")]);
  await h.respond(f.request("fictional-upgrade-id", "faux:B"), { append: async () => {} });
  const before = await f.record(), calls = f.transport.mock.calls.length;
  const binding = f.getBindingRead();
  await expect(h.respond({ ...f.request(undefined), metadata: { source: "slack", slack: { channelId: "fictional-channel", threadTs: "fictional-thread", model: "faux:A" } } }, { append: async () => {} }))
    .rejects.toMatchObject({ failure: { kind: "native_cold_model_change_unavailable" } });
  expect(await f.record()).toEqual(before); expect(f.transport).toHaveBeenCalledTimes(calls); expect(binding).toHaveBeenCalledTimes(1);
  binding.mockClear(); f.faux.setResponses([reply("Fictional inherited B answer")]);
  const wake = { ...f.request(undefined), text: "please think hard, ultra think, ultrathink", metadata: { source: "web", web: { trigger: "job" } } };
  expect((await h.respond(wake, { append: async () => {} })).text).toBe("Fictional inherited B answer");
  expect(binding).toHaveBeenCalledTimes(1); expect((await f.record()).providerSession.modelKey).toBe("faux:B");
  expect((await f.record()).lastSwitch).toEqual(before.lastSwitch); expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
});
it.each(["reset", "retention"])("public activation %s deletes the whole upgraded native chain", async (kind) => {
  const f = await fixture(true); await f.seed(); const h = await f.make(true);
  f.faux.setResponses([reply(summary), reply("Fictional B answer")]);
  await h.respond(f.request("fictional-upgrade-id", "faux:B"), { append: async () => {} });
  expect(await nativeFiles(f.nativeRoot)).toHaveLength(2); await f.dispose(h);
  if (kind === "reset") await f.getStore().reset!("web:fictional-thread");
  else {
    // Retention uses file age; age only this fictional canonical fixture.
    const old = new Date("2000-01-01T00:00:00Z");
    for (const name of (await readdir(join(f.root, "history"))).filter((name) => name.endsWith(".history.json"))) await utimes(join(f.root, "history", name), old, old);
    const successor = await f.makePublic(); f.faux.setResponses([reply("Fictional successor answer")]);
    await successor.respond({ ...f.request("fictional-successor-id"), conversationId: "web:fictional-successor" }, { append: async () => {} });
    await f.dispose(successor);
  }
  expect(await f.getStore().load("web:fictional-thread")).toEqual([]);
  expect(await modelChanges(f.nativeRoot)).toHaveLength(0);
  expect(await nativeFiles(f.nativeRoot)).toHaveLength(kind === "reset" ? 0 : 1);
});

it("public constructor rejects missing acknowledgement before acquiring or upgrading roots", async () => {
  const f = await fixture();
  await expect(createConfiguredAgentResponder({ cwd: f.root, config: { ...f.config, runtime: { ...f.config.runtime, session: {
    ...f.config.runtime.session, modelSwitch: { enabled: true },
  } } } })).rejects.toThrow("older writers are stopped");
  expect(await readdir(f.root)).toEqual(["IDENTITY.md"]);
  await expect(lstat(f.nativeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("public upgrade reconciles a legacy pending turn, refusing missing evidence without replay", async () => {
  const f = await fixture(true); await f.seed();
  const abandoned = await f.getStore().beginProviderSessionTurn!("web:fictional-thread", "fictional-abandoned-run", {
    modelKey: "faux:A", reconciliation: { purpose: "execution", ownerKey: "web:fictional-thread",
      initial: { persistText: "Fictional abandoned input", timestamp: "2000-01-01T00:00:00.000Z" } },
  });
  // Fixture simulates storage left after abandoned admission, not a process-kill
  // drill. No provider/tool call belongs to this abandoned turn.
  await abandoned.abort();
  const calls = f.transport.mock.calls.length, h = await f.makePublic();
  await expect(h.respond(f.request("fictional-post-interruption-id", "faux:B"), { append: async () => {} }))
    .rejects.toThrow("native journal evidence");
  expect(f.transport).toHaveBeenCalledTimes(calls); // Storage-only settlement.
  const settled = await f.record(); expect(settled.version).toBe(3);
  expect(settled.messages.some((message: { content: string }) => message.content.includes("interrupted"))).toBe(true);
  // Absent native evidence cannot be invented. A new explicit current-model
  // turn seeds its fresh epoch; a later explicit switch can then upgrade it.
  f.faux.setResponses([reply("Fictional new A answer")]);
  await h.respond(f.request("fictional-new-current-id"), { append: async () => {} });
  f.faux.setResponses([reply(summary), reply("Fictional new explicit B answer")]);
  await h.respond({ ...f.request("fictional-later-switch-id", "faux:B"), text: "Fictional new explicit input" }, { append: async () => {} });
  const record = await f.record(); expect(record.version).toBe(4); expect(record.native.chain).toHaveLength(2);
  expect(record.messages.some((message: { content: string }) => message.content.includes("Fictional abandoned input"))).toBe(true);
  expect(record.messages.some((message: { content: string }) => message.content.includes("interrupted"))).toBe(true);
  expect(record.messages.at(-2).content).toBe("Fictional new explicit input");
  expect(f.transport.mock.calls.length - calls).toBeLessThanOrEqual(3); // Current turn + summary + new turn, never replay.
  expect(await modelChanges(f.nativeRoot)).toHaveLength(1);
});

it.each(["acknowledgement", "continuous", "piSessionsRoot"])("programmatic switch validation names the missing %s condition", async (missing) => {
  const f = await fixture();
  const config = { ...f.config, runtime: { ...f.config.runtime, session: { ...f.config.runtime.session,
    ...(missing === "continuous" ? { mode: "per-message" as const } : {}),
    modelSwitch: { enabled: true, ...(missing === "acknowledgement" ? {} : { olderWritersStopped: true as const }) },
  } }, ...(missing === "piSessionsRoot" ? { providers: {} } : {}) };
  await expect(createConfiguredAgentResponder({ cwd: f.root, config })).rejects.toThrow(missing);
  await expect(lstat(f.nativeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("long-ID Web requests bypass native switching without weakening the existing host contract (enabled=%s)", async (enabled) => {
  const f = await fixture(true), h = await f.make(enabled);
  const request = { ...f.request("fictional-persisted-long-id", "faux:B"), conversationId: "web:" + "x".repeat(513) };
  const measure = vi.spyOn(f.native, "measureSwitch"), begin = vi.spyOn(f.getStore(), "beginProviderSessionPreparation");
  f.faux.setResponses([reply("Fictional cold answer")]);
  await expect(h.respond(request, { append: async () => {} })).rejects.toThrow("Invalid protected sessionTurn host contract");
  expect(begin).not.toHaveBeenCalled(); // Entry seam exits before claiming/reading.
  expect(measure).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  expect((await readdir(join(f.root, "history"))).some((name) => name.includes("native-history-root") || name.includes("model-switch"))).toBe(false);
});

it("post-switch host publication failure preserves predecessor bytes and never delegates native deletion through a stale model runtime", async () => {
  const f = await fixture(true); await f.seed(); const h = await f.make(true);
  f.faux.setResponses([reply(summary), reply("Fictional switched answer")]);
  await h.respond(f.request("fictional-switch-publication", "faux:B"), { append: async () => {} });
  const before = await f.record(), predecessor = join(f.nativeRoot, "mono-v2", "journals", `${before.native.chain[0].journalId}.jsonl`);
  const bytes = await readFile(predecessor), calls = f.transport.mock.calls.length;
  const destructive = f.runtimes.flatMap((runtime) => [vi.spyOn(runtime, "invalidateSession"), vi.spyOn(runtime, "retireDurableSession")]);
  const original = f.getPreparation().getMockImplementation() as NonNullable<ConversationHistoryStore["beginProviderSessionPreparation"]>;
  f.getPreparation().mockImplementation(async (...args: Parameters<typeof original>) => {
    const preparation = await original(...args), admit = preparation.admit.bind(preparation);
    preparation.admit = async (...bindings) => {
      const turn = await admit(...bindings), prepareCommit = turn.prepareCommit.bind(turn);
      turn.prepareCommit = async (...commitArgs) => {
        const prepared = await prepareCommit(...commitArgs);
        return { ...prepared, commit: async () => { throw new Error("Fictional host publication failure"); } };
      };
      return turn;
    };
    return preparation;
  });
  f.faux.setResponses([reply("Fictional uncommitted answer")]);
  await expect(h.respond(f.request("fictional-publication-failure", "faux:B"), { append: async () => {} })).rejects.toBeInstanceOf(AgentHarnessFailureError);
  expect(f.transport).toHaveBeenCalledTimes(calls + 1);
  for (const callback of destructive) expect(callback).not.toHaveBeenCalled();
  expect(await readFile(predecessor)).toEqual(bytes);
});

it("a 512-character Web conversation remains eligible for the bounded native switch contract", async () => {
  const f = await fixture(true), h = await f.make(true), conversationId = "web:" + "x".repeat(508);
  const request = (id: string, model: string) => ({ ...f.request(id, model), conversationId });
  f.faux.setResponses([reply("Fictional boundary A answer")]);
  await h.respond(request("fictional-boundary-A", "faux:A"), { append: async () => {} });
  const measure = vi.spyOn(f.native, "measureSwitch"); f.faux.setResponses([reply(summary), reply("Fictional boundary B answer")]);
  expect((await h.respond(request("fictional-boundary-B", "faux:B"), { append: async () => {} })).text).toBe("Fictional boundary B answer");
  expect(measure).toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(3);
});
