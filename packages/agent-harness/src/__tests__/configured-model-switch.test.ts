import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createManagedNativeJournalStorage, createMonoRuntime, type MonoRuntimeLike, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { MonoAgentHarness } from "../harness.js";
import { createDurableHistoryStore, NativeHistoryAuthorityBusyError } from "../durable-history.js";
import { switchConversationKey } from "../durable-model-switch-contract.js";
import type { AgentHarnessOptions, AgentHarnessRequest } from "../types.js";

const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const summary = JSON.stringify({ intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: ["Fictional progress"], failures: [], openWork: [], nextActions: [], references: [] });
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);
async function fixture(limits: Record<string, unknown> = {}, targetWindow = 100000) {
  const base = await mkdtemp(join(tmpdir(), "configured-native-switch-")); closes.push(() => rm(base, { recursive: true, force: true }));
  const identityPath = join(base, "IDENTITY.md"), nativeRoot = join(base, "native"), historyRoot = join(base, "history");
  await writeFile(identityPath, "Fictional stable instructions");
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 1000000, maxTokens: 4096 }, { id: "B", contextWindow: targetWindow, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), native = createManagedNativeJournalStorage({ sessionsRoot: nativeRoot });
  const inspector = createMonoRuntime({ workspace: base }); closes.push(() => inspector.disposeAllSessions!());
  const inspect = vi.fn(async (request) => await inspector.reconcileSessionTurn!({ sessionsRoot: nativeRoot, descriptor: request.descriptor,
    purpose: request.purpose, expectedInputs: request.expectedInputs, expectedModel: { provider: "faux", id: request.modelKey.split(":").at(-1) } }));
  const retire = vi.fn(async (id: string) => { await inspector.retireDurableSession!(id, nativeRoot); });
  const makeStore = () => createDurableHistoryStore({ root: historyRoot, nativeJournalStorage: native, reconcileProviderSessionTurn: inspect, retireProviderSession: retire, ...limits });
  const store = makeStore(), runtimes: MonoRuntimeLike[] = [];
  const runtimeFor = (id: string) => {
    const runtime = createMonoRuntime({ workspace: base }), run = runtime.run.bind(runtime), prepare = runtime.prepareNativeDispatch!.bind(runtime);
    // Fixture catalog injection only; real preparation, native storage, P2 and
    // execution remain untouched. No completion/inspector stubs.
    runtime.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    runtime.prepareNativeDispatch = (prompt, options) => prepare(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    runtimes.push(runtime); return runtime;
  };
  const makeHarness = (model = "A", enabled = false, options: Partial<AgentHarnessOptions> = {}) => {
    const primary = runtimeFor(model);
    const harness = new MonoAgentHarness({ runtime: primary, identityPath, cwd: base, piSessionsRoot: nativeRoot, historyStore: store, session: { mode: "continuous", idleTimeoutMs: 600000 },
      model: { provider: "faux", model, reference: `faux:${model}` }, runtimeForModel: (ref) => runtimeFor(ref.model), runtimeOptionsForRequest: async ({ request }) => ({ runtimeOptions: typeof (request.metadata?.web as {model?: string})?.model === "string" ? { model: parseMonoRuntimeModelReference((request.metadata!.web as {model: string}).model) } : {} }), runtimeOptions: { piResolvedModels: models, allowedTools: [], compaction: { enabled: false } }, ...options },
    { ...(enabled ? { nativeModelSwitch: { exclusiveWriters: true as const, native, sessionsRoot: nativeRoot,
        deliveryId: (request: AgentHarnessRequest) => request.metadata?.delivery as string | undefined } } : {}) });
    closes.push(() => harness.dispose()); return harness;
  };
  const request = (delivery: string, message = "Fictional current input", extra: Partial<AgentHarnessRequest> = {}) => ({ conversationId: "fictional", userMessage: message,
    abortSignal: new AbortController().signal, ...extra, metadata: { delivery, ...extra.metadata } });
  const canonicalBytes = async (id = "fictional") => await readFile(join(historyRoot, `${switchConversationKey(id)}.history.json`));
  const canonical = async (id = "fictional") => JSON.parse(await readFile(join(historyRoot, `${switchConversationKey(id)}.history.json`), "utf8"));
  const journals = async () => await readdir(nativeRoot, { recursive: true }).then((entries) => entries.filter((entry) => entry.endsWith(".jsonl")));
  const changes = async () => (await Promise.all((await journals()).map(async (entry) => (await readFile(join(nativeRoot, entry), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat().filter((record) => record.kind === "model_change");
  const seed = async (message = "Fictional source fact", delivery = "seed") => { const h = makeHarness(); faux.setResponses([text("Fictional A reply")]); const response = await h.run(request(delivery, message)); expect(response.failure).toBeUndefined(); await h.dispose(); return response; };
  return { base, identityPath, nativeRoot, historyRoot, faux, models, native, transport, store, makeStore, makeHarness, request, canonical, changes, journals, seed, inspect, retire, runtimes, runtimeFor, canonicalBytes };
}

it("default OFF leaves legacy bytes/root format alone and keeps today's cold override", async () => {
  const f = await fixture(); await f.seed();
  const beforeBytes = await f.canonicalBytes(), before = JSON.parse(beforeBytes.toString()); expect(before.version).toBe(3);
  const isolated = f.makeHarness("B", false, { session: { mode: "continuous", idleTimeoutMs: 600000, isolateProactive: true } });
  const controller = new AbortController(); controller.abort("Fictional isolated cancellation");
  expect((await isolated.run(f.request("isolated-off", "Fictional isolated input", { abortSignal: controller.signal, metadata: { source: "subagent", cron: { jobId: "fictional" } } }))).failure?.kind).toBe("cancelled");
  expect(await f.canonicalBytes()).toEqual(beforeBytes);
  expect(f.transport).toHaveBeenCalledTimes(1);
  f.faux.setResponses([text("Fictional ordinary B reply")]); const result = await f.makeHarness().run(f.request("off", "Fictional override", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional ordinary B reply");
  const afterBytes = await f.canonicalBytes(), after = JSON.parse(afterBytes.toString());
  // Pin complete legacy wire bytes (dynamic epoch/receipt/time values only are
  // observed), not merely the version or a projection hiding extra fields.
  expect(afterBytes).toEqual(Buffer.from(`${JSON.stringify({ version: 3, conversationId: "fictional", messages: after.messages,
    lastCommit: after.lastCommit, providerSession: after.providerSession })}\n`));
  expect(afterBytes.equals(beforeBytes)).toBe(false); expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(await f.changes()).toHaveLength(0); expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await readdir(f.historyRoot)).some((name) => name.includes("native-root"))).toBe(false);
});

it("private configured override prepares extensions once, emits one switch, and commits actual incoming native P2 without replay", async () => {
  const f = await fixture(); await f.seed();
  const cleanup = vi.fn(async () => {}), settleCleanup = vi.fn(async () => {});
  const extension = vi.fn(async () => ({ runtimeOptions: { model: parseMonoRuntimeModelReference("faux:B") }, decorateUserMessage: (value: string) => `Fictional decorated: ${value}`, cleanup, settleCleanup }));
  f.faux.setResponses([text(summary), text("Fictional B reply")]);
  const result = await f.makeHarness("A", true, { runtimeOptionsForRequest: extension }).run(f.request("delivery-001", "Fictional override", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional B reply"); expect(f.transport).toHaveBeenCalledTimes(3);
  expect(extension).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce(); expect(settleCleanup).toHaveBeenCalledOnce();
  const record = await f.canonical(); expect(record.version).toBe(4); expect(record.providerSession).toMatchObject({ modelKey: "faux:B", revision: 1 });
  expect(record.native.chain).toHaveLength(2); expect(record.lastCommit.turnId).toBe(result.metadata.runId); expect(record.native.projection).toEqual(record.lastSwitch.artifact);
  const rows = (await Promise.all((await f.journals()).map(async (path) => (await readFile(join(f.nativeRoot, path), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  const operation = rows.find((row) => row.kind === "operation_start" && row.payload.config?.model?.id === "B");
  // Actual prepared credential is unsupported for the fictional transport, so
  // pin explicit unknown rather than trusting switch-time metadata or options.
  expect(operation.payload.config.nativeProvenance).toMatchObject({ provider: "faux", model: "B", account: null });
  expect(operation.payload.config.nativeProvenance.api).toBe(operation.payload.config.model.api);
  expect(await f.changes()).toHaveLength(1); expect(f.retire).not.toHaveBeenCalled(); expect(f.inspect).toHaveBeenCalled();
  expect(await f.store.recoverProviderSessionTurn("fictional")).toEqual({ status: "clean" });
  expect((await f.store.load("fictional")).at(-2)?.content).toBe("Fictional override");
  const actual = f.transport.mock.calls.at(-1)!; expect(JSON.stringify(actual)).toContain("Fictional decorated: Fictional override");
});

it("new configured harness resumes inherited content through ordinary account-ungated same-model execution", async () => {
  const f = await fixture(); await f.seed(); f.faux.setResponses([text(summary), text("Fictional B reply")]);
  const first = await f.makeHarness("B", true).run(f.request("first-B")); expect(first.failure).toBeUndefined();
  for (const runtime of f.runtimes) await runtime.disposeAllSessions!();
  f.faux.setResponses([text("Fictional B resumed reply")]); const second = await f.makeHarness("B", true).run(f.request("second-B"));
  expect(second.failure).toBeUndefined(); expect(second.text).toBe("Fictional B resumed reply"); expect(f.transport).toHaveBeenCalledTimes(4);
  expect(await f.changes()).toHaveLength(1); expect((await f.canonical()).providerSession.revision).toBe(2);
  expect(JSON.stringify(f.transport.mock.calls.at(-1))).toContain("Fictional current input");
});

it("pending explicit message is neither appended nor admitted/queued; same delivery and background delivery spend nothing", async () => {
  const f = await fixture(); for (let i = 0; i < 6; i++) await f.seed("Fictional older detail ".repeat(2600), `seed-${i}`); await f.seed("Fictional recent completed turn", "seed-recent");
  const before = await f.canonical(); f.faux.setResponses([text("Not a valid structured summary")]);
  const harness = f.makeHarness("B", true), request = f.request("durable-delivery");
  const result = await harness.run(request); expect(result.failure?.kind).toBe("handoff_pending");
  expect((await f.store.load("fictional"))).toEqual(before.messages); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A");
  const pendingOwner = await f.store.beginProviderSessionPreparation("fictional", "pending-inspection"); const pending = (await pendingOwner.read()).pending!; await pendingOwner.abort();
  expect(pending.phase).toBe("pending"); expect(pending.attempts).toHaveLength(1); expect(f.transport).toHaveBeenCalledTimes(8); expect(await f.changes()).toHaveLength(0);
  expect((await harness.run(request)).failure?.kind).toBe("handoff_pending");
  // No persisted delivery identity selects ordinary admission before native
  // preparation. Its typed storage-pending refusal cannot become failed-turn
  // continuity work that blocks this same harness's next explicit message.
  const background = await harness.run({ ...request, metadata: {} });
  expect(background.failure?.kind).toBe("handoff_pending");
  expect(background.failure?.message).toContain("not admitted or queued");
  expect(f.transport).toHaveBeenCalledTimes(8); expect((await f.store.load("fictional"))).toEqual(before.messages);
  f.faux.setResponses([text(summary), text("Fictional explicitly authorized reply")]);
  const resumed = await harness.run(f.request("new-explicit-delivery")); expect(resumed.failure).toBeUndefined();
  expect(f.transport).toHaveBeenCalledTimes(10); expect(await f.changes()).toHaveLength(1); expect((await f.store.load("fictional"))).toHaveLength(before.messages.length + 2);
});

it("pre-intent aggregate reservation refusal falls back without a paid summary", async () => {
  const f = await fixture({ maxStoreBytes: 200000, maxStagedBytes: 200000 }); await f.seed();
  f.faux.setResponses([text("Fictional capacity fallback")]); const result = await f.makeHarness("B", true).run(f.request("capacity"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional capacity fallback"); expect(f.transport).toHaveBeenCalledTimes(2);
  expect(await f.changes()).toHaveLength(0); expect((await f.canonical()).version).toBe(3);
});

it("owned native evidence corruption surfaces; it is never disguised as cold replay", async () => {
  const f = await fixture(); await f.seed();
  const path = join(f.nativeRoot, (await f.journals())[0]!); await writeFile(path, "{fictional-corrupt-record}\n");
  f.faux.setResponses([text("Must not execute")]); const result = await f.makeHarness("B", true).run(f.request("corrupt"));
  expect(result.failure?.kind).toBe("SyntaxError"); expect(f.transport).toHaveBeenCalledTimes(1); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A");
});

it("inherited-prefix check captures real compaction prompt/output, refuses oversized prefix without dispatch or intent", async () => {
  const f = await fixture(); await f.seed();
  const fit = await f.native.checkInheritedPrefix([{ role: "user", content: [{ type: "text", text: "Fictional inherited text ".repeat(20000) }] }],
    { provider: "faux", id: "B", api: "faux-api", contextWindow: 100000, maxTokens: 4096 }, { summaryMaxTokens: 64000 });
  expect(fit).toEqual({ status: "budget_failure", reason: "inherited_prefix" }); expect(f.transport).toHaveBeenCalledTimes(1);
  const check = vi.spyOn(f.native, "checkInheritedPrefix").mockResolvedValue({ status: "budget_failure", reason: "inherited_prefix" });
  const result = await f.makeHarness("B", true).run(f.request("prefix-refused")); expect(result.failure?.kind).toBe("handoff_budget_exceeded");
  expect(check).toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(1); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A");
  const owner = await f.store.beginProviderSessionPreparation("fictional", "prefix-inspection"); expect((await owner.read()).pending).toBeUndefined(); await owner.abort();
});


it("unsupported native-preparation runtime uses today's cold P2 path without authority or summary work", async () => {
  const f = await fixture(); await f.seed();
  const real = f.runtimeFor("B"), opaque = new Proxy(real, { get: (target, key) => key === "nativePreparedDispatch" || key === "prepareNativeDispatch" ? undefined : Reflect.get(target, key) });
  f.faux.setResponses([text("Fictional opaque runtime reply")]);
  const result = await f.makeHarness("B", true, { runtime: opaque }).run(f.request("opaque"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional opaque runtime reply"); expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await f.canonical()).version).toBe(3); expect(await f.changes()).toHaveLength(0);
});

it("post-P2 refresh refusal accounts admitted failure, never dispatches or retries it, and permits a later explicit B turn", async () => {
  const f = await fixture(); await f.seed(); const h = f.makeHarness("B", true), incoming = f.runtimes.at(-1)!;
  const originalRefresh = incoming.refreshSession!.bind(incoming), refresh = vi.fn(async (id: string) => { await originalRefresh(id); });
  incoming.refreshSession = refresh; refresh.mockRejectedValueOnce(new Error("Fictional admitted refresh interruption"));
  f.faux.setResponses([text(summary), text("Must not dispatch the failed input")]);
  const failed = await h.run(f.request("failed-admitted", "Fictional failed input")); expect(failed.failure).toBeDefined();
  expect(f.transport).toHaveBeenCalledTimes(2); expect(await f.changes()).toHaveLength(1);
  expect(await f.store.recoverProviderSessionTurn("fictional")).toEqual({ status: "clean" });
  f.faux.setResponses([text("Fictional later explicit reply")]);
  const next = await f.makeHarness("B", true).run(f.request("later-explicit", "Fictional later explicit input"));
  expect(next.failure).toBeUndefined(); expect(f.transport).toHaveBeenCalledTimes(3); expect(await f.changes()).toHaveLength(1);
  expect((await f.store.load("fictional")).at(-2)?.content).toBe("Fictional later explicit input");
});

it.each(["reset", "retention"])("upgraded private-switch fixture %s destroys the owned whole chain, not merely a guarded-denial success", async (kind) => {
  const f = await fixture(kind === "retention" ? { maxConversations: 1 } : {}); await f.seed();
  const h = f.makeHarness("B", true); f.faux.setResponses([text(summary), text("Fictional guarded reply")]);
  expect((await h.run(f.request("upgraded"))).failure).toBeUndefined(); expect((await f.journals())).toHaveLength(2); await h.dispose();
  if (kind === "reset") { await f.store.reset("fictional"); expect(await f.journals()).toHaveLength(0); }
  else {
    f.faux.setResponses([text("Fictional retention successor")]); const successor = f.makeHarness("B");
    expect((await successor.run(f.request("successor", "Fictional new conversation", { conversationId: "other-fictional" }))).failure).toBeUndefined(); await successor.dispose();
    expect(await f.journals()).toHaveLength(1);
  }
  expect(await f.store.load("fictional")).toEqual([]); expect(await f.changes()).toHaveLength(0);
});


it("flag-on unbound claim-wait cancellation reclaims ordinary continuity just like OFF", async () => {
  const outcomes = [];
  for (const enabled of [false, true]) {
    const f = await fixture(), held = await f.store.beginProviderSessionPreparation("fictional", "fictional-holder"), controller = new AbortController();
    const waiting = vi.spyOn(f.store, enabled ? "beginProviderSessionPreparation" : "beginProviderSessionTurn");
    const running = f.makeHarness("A", enabled).run(f.request("cancelled-wait", "Fictional cancelled input", { abortSignal: controller.signal }));
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce()); controller.abort("Fictional claim-wait cancellation"); await held.abort();
    const result = await running; expect(result.failure?.kind).toBe("cancelled"); expect(f.transport).not.toHaveBeenCalled();
    const record = await f.canonical(); expect(record.lastCommit.turnId).toBe(result.metadata.runId);
    outcomes.push({ outcome: record.lastCommit.outcome, messages: record.messages.map(({ role, content }: {role:string;content:string}) => ({role, content: content.replace(result.metadata.runId, "fictional-run").replace(/"cancelledAt":"[^"]+"/gu, '"cancelledAt":"fictional-time"')})) });
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
});

it.each(["typed", "spoofed", "old-spoofed"])("%s capture-capacity errors cannot be confused with generic custom failures", async (kind) => {
  const f = await fixture(); await f.seed();
  const capture = f.native.captureEvidence.bind(f.native);
  vi.spyOn(f.native, "captureEvidence").mockImplementationOnce(async (sources, context) => {
    if (kind !== "typed") throw Object.assign(new Error("Fictional custom failure"), { code: kind === "old-spoofed" ? "ERR_NATIVE_EVIDENCE_CAPACITY" : "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT" });
    // The actual native capture, not a mocked exception, enforces its chain cap.
    return await capture(Array.from({ length: 33 }, () => sources[0]!), context);
  });
  f.faux.setResponses([text("Fictional capacity cold reply")]);
  const result = await f.makeHarness("B", true).run(f.request("capture-limit"));
  if (kind === "typed") { expect(result.failure).toBeUndefined(); expect(f.transport).toHaveBeenCalledTimes(2); }
  else { expect(result.failure?.kind).toBe("Error"); expect(f.transport).toHaveBeenCalledTimes(1); }
  expect((await f.canonical()).version).toBe(3); expect(await f.changes()).toHaveLength(0);
});

it("real oversized inherited completed prefix is refused on the host path before intent or paid work", async () => {
  const f = await fixture({}, 32000); await f.seed("Fictional oversized inherited detail ".repeat(1600));
  const before = await f.canonicalBytes();
  const result = await f.makeHarness("B", true).run(f.request("real-prefix"));
  expect(result.failure).toMatchObject({ kind: "handoff_budget_exceeded", message: expect.stringContaining("mandatory_history") });
  expect(f.transport).toHaveBeenCalledTimes(1); expect(await f.canonicalBytes()).toEqual(before); expect(await f.changes()).toHaveLength(0);
  const owner = await f.store.beginProviderSessionPreparation("fictional", "prefix-read"); expect((await owner.read()).pending).toBeUndefined(); await owner.abort();
});

it.each(["checkpoint", "incoming", "pending"])("unavailable outgoing auth advances unbilled to %s", async (step) => {
  const f = await fixture();
  if (step !== "checkpoint") for (let i = 0; i < (step === "pending" ? 6 : 4); i++) await f.seed("Fictional older detail ".repeat(2600), `older-${i}`);
  await f.seed("Fictional recent completed turn", "recent");
  const beforeCalls = f.transport.mock.calls.length, old = f.runtimeFor("A");
  const unavailable = vi.fn(async () => { throw new Error("Fictional unavailable old provider/auth"); }); old.prepareNativeDispatch = unavailable;
  f.faux.setResponses(step === "incoming" ? [text(summary), text("Fictional incoming fallback reply")] : [text("Fictional checkpoint fallback reply")]);
  const result = await f.makeHarness("B", true, { runtimeForModel: () => old }).run(f.request(`unavailable-${step}`));
  expect(unavailable).toHaveBeenCalledOnce();
  if (step === "pending") {
    expect(result.failure?.kind).toBe("handoff_pending"); expect(f.transport).toHaveBeenCalledTimes(beforeCalls);
    const owner = await f.store.beginProviderSessionPreparation("fictional", "unavailable-read"); const state = (await owner.read()).pending!;
    expect(state.phase).toBe("pending"); expect(state.attempts).toHaveLength(0); await owner.abort();
  } else {
    expect(result.failure).toBeUndefined(); expect(f.transport).toHaveBeenCalledTimes(beforeCalls + (step === "incoming" ? 2 : 1));
    const owner = await f.store.beginProviderSessionPreparation("fictional", "producer-read"), record = await owner.read();
    const cached = await owner.readHandoff(record.lastSwitch!.switchId, record.native!.projection!); expect(cached.artifact.producer).toBe(step); await owner.abort();
    expect(await f.changes()).toHaveLength(1);
  }
});

it("root authority contention is typed/retryable, preserves evidence and publishes no intent; explicit retry after drain succeeds", async () => {
  const f = await fixture(); await f.seed(); const before = await f.canonicalBytes();
  const other = await f.store.beginProviderSessionPreparation("other-fictional", "other-owner");
  const owner = await f.store.beginProviderSessionPreparation("fictional", "authority-check");
  await expect(owner.acquireNativeHistoryAuthority({ exclusiveWriters: true })).rejects.toMatchObject({ code: "ERR_NATIVE_HISTORY_AUTHORITY_BUSY", retryable: true });
  await expect(owner.acquireNativeHistoryAuthority({ exclusiveWriters: true })).rejects.toBeInstanceOf(NativeHistoryAuthorityBusyError); await owner.abort();
  const result = await f.makeHarness("B", true).run(f.request("busy-delivery"));
  expect(result.failure).toMatchObject({ kind: "native_switch_busy", details: { retryable: true } });
  expect(f.transport).toHaveBeenCalledTimes(1); expect(await f.canonicalBytes()).toEqual(before); expect(await f.changes()).toHaveLength(0);
  await other.abort(); f.faux.setResponses([text(summary), text("Fictional serialized retry")]);
  expect((await f.makeHarness("B", true).run(f.request("busy-delivery"))).failure).toBeUndefined(); expect(f.transport).toHaveBeenCalledTimes(3);
});

it("unguarded default and unguarded prepared turns emit no nativeProvenance; prepare-time flags/values are ignored", async () => {
  const f = await fixture(); await f.seed();
  const runtime = f.runtimeFor("A");
  // Only the host's run-time binding may request recording; a caller's
  // prepare-time flag or forged provenance value is never honoured or copied.
  const lease = await runtime.prepareNativeDispatch!("Fictional unguarded rules", { model: parseMonoRuntimeModelReference("faux:A"),
    abortSignal: new AbortController().signal, messages: [{ role: "user", content: "Fictional unguarded prepared input" }], allowedTools: [],
    piSessionsRoot: f.nativeRoot, sessionId: "fictional-unguarded-prepare", sessionKeepAlive: true, compaction: { enabled: false },
    nativeProvenanceRecording: true, ...{ nativeProvenance: { provider: "faux", api: "forged", model: "A", account: "forged" } } });
  try { f.faux.setResponses([text("Fictional unguarded reply")]); expect((await lease.run()).error).toBeFalsy(); }
  finally { await lease.close(); }
  const records = (await Promise.all((await f.journals()).map(async (path) => (await readFile(join(f.nativeRoot, path), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  const starts = records.filter((record) => ["turn_start", "operation_start"].includes(record.kind));
  expect(starts.some((record) => record.payload.config?.model?.id === "A")).toBe(true);
  expect(starts.every((record) => !Object.hasOwn(record.payload.config, "nativeProvenance"))).toBe(true);
  expect(JSON.stringify(records)).not.toContain("forged");
});
