import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createManagedNativeJournalStorage, NativeEvidenceCapacityError } from "@mono-agent/turn/ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { type MonoRuntimeLike } from "@mono-agent/turn/host/types";
import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import { MonoAgentHarness } from "../harness.js";
import { createDurableHistoryStore } from "../durable-history.js";
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
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 1000000, maxTokens: 4096 }, { id: "B", contextWindow: targetWindow, maxTokens: 4096 }, { id: "C", contextWindow: targetWindow, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), native = createManagedNativeJournalStorage({ sessionsRoot: nativeRoot });
  const inspector = createMonoRuntime({ workspace: base }); closes.push(() => inspector.disposeAllSessions!());
  const inspect = vi.fn(async (request) => await inspector.reconcileSessionTurn!({ sessionsRoot: nativeRoot, descriptor: request.descriptor,
    purpose: request.purpose, expectedInputs: request.expectedInputs, expectedModel: { provider: "faux", id: request.modelKey.split(":").at(-1) } }));
  const retire = vi.fn(async (id: string) => { await inspector.retireDurableSession!(id, nativeRoot); });
  const makeStore = () => createDurableHistoryStore({ root: historyRoot, nativeJournalStorage: native, reconcileProviderSessionTurn: inspect, retireProviderSession: retire, ...limits });
  const store = makeStore(), runtimes: MonoRuntimeLike[] = [];
  const prepareCalls: Array<{ id: string; options: import("@mono-agent/turn/host/types").RuntimeRunOptions }> = [];
  const runtimeFor = (id: string) => {
    const runtime = createMonoRuntime({ workspace: base }), run = runtime.run.bind(runtime), prepare = runtime.prepareNativeDispatch!.bind(runtime);
    // Fixture catalog injection only; real preparation, native storage, P2 and
    // execution remain untouched. No completion/inspector stubs.
    runtime.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    runtime.prepareNativeDispatch = (prompt, options) => { prepareCalls.push({ id, options }); return prepare(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models }); };
    runtimes.push(runtime); return runtime;
  };
  const makeHarness = (model = "A", enabled = false, options: Partial<AgentHarnessOptions> = {}, inheritModel = false) => {
    const primary = runtimeFor(model);
    const harness = new MonoAgentHarness({ runtime: primary, identityPath, cwd: base, sessionsRoot: nativeRoot, historyStore: store, session: { mode: "continuous", idleTimeoutMs: 600000 },
      model: { provider: "faux", model, reference: `faux:${model}` }, runtimeForModel: (ref) => runtimeFor(ref.model), runtimeOptionsForRequest: async ({ request }) => ({ runtimeOptions: typeof (request.metadata?.web as {model?: string})?.model === "string" ? { model: parseMonoRuntimeModelReference((request.metadata!.web as {model: string}).model) } : {} }), runtimeOptions: { piResolvedModels: models, allowedTools: [], compaction: { enabled: false } }, ...options },
    { ...(enabled ? { nativeModelSwitch: { native, sessionsRoot: nativeRoot,
        deliveryId: (request: AgentHarnessRequest) => request.metadata?.delivery as string | undefined,
        ...(inheritModel ? { implicitModel: async (_request: AgentHarnessRequest, key: string) => ({ model: parseMonoRuntimeModelReference(key), runtimeOptions: {} }) } : {}) } } : {}) });
    closes.push(() => harness.dispose()); return harness;
  };
  const request = (delivery: string, message = "Fictional current input", extra: Partial<AgentHarnessRequest> = {}) => ({ conversationId: "fictional", userMessage: message,
    abortSignal: new AbortController().signal, ...extra, metadata: { delivery, ...extra.metadata } });
  const canonicalBytes = async (id = "fictional") => await readFile(join(historyRoot, `${switchConversationKey(id)}.history.json`));
  const canonical = async (id = "fictional") => JSON.parse(await readFile(join(historyRoot, `${switchConversationKey(id)}.history.json`), "utf8"));
  const journals = async () => await readdir(nativeRoot, { recursive: true }).then((entries) => entries.filter((entry) => entry.endsWith(".jsonl")));
  // Completed switches are recorded only by the canonical receipt (no native model_change frames).
  const changes = async () => { try { const record = await canonical(); return record.native !== undefined && record.lastSwitch ? [record.lastSwitch] : []; } catch { return []; } };
  const seed = async (message = "Fictional source fact", delivery = "seed") => { const h = makeHarness(); faux.setResponses([text("Fictional A reply")]); const response = await h.run(request(delivery, message)); expect(response.failure).toBeUndefined(); await h.dispose(); return response; };
  return { base, identityPath, nativeRoot, historyRoot, faux, models, native, transport, store, makeStore, makeHarness, request, canonical, changes, journals, seed, inspect, retire, runtimes, runtimeFor, canonicalBytes, prepareCalls };
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
  const record = await f.canonical(); expect(record.version).toBe(3); expect(record.providerSession).toMatchObject({ modelKey: "faux:B", revision: 1 });
  expect(await f.journals()).toHaveLength(1); expect(record.lastCommit.turnId).toBe(result.metadata.runId); expect(record.native.projection).toEqual(record.lastSwitch.artifact);
  const rows = (await Promise.all((await f.journals()).map(async (path) => (await readFile(join(f.nativeRoot, path), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  const operation = rows.find((row) => row.kind === "operation_start" && row.payload.config?.model?.id === "B");
  // Actual prepared credential is unsupported for the fictional transport, so
  // pin explicit unknown rather than trusting switch-time metadata or options.
  expect(Object.hasOwn(operation.payload.config, "nativeProvenance")).toBe(false);
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

it("pre-intent aggregate reservation refusal is a typed refusal, never a summary-less model change", async () => {
  const f = await fixture({ maxStoreBytes: 200000, maxStagedBytes: 200000 }); await f.seed(); const before = await f.canonicalBytes();
  f.faux.setResponses([text("Must not execute")]); const result = await f.makeHarness("B", true).run(f.request("capacity"));
  expect(result.failure).toMatchObject({ kind: "handoff_budget_exceeded", message: expect.stringContaining("capacity") }); expect(f.transport).toHaveBeenCalledTimes(1);
  expect(await f.changes()).toHaveLength(0); expect(await f.canonicalBytes()).toEqual(before);
});
it("owned native evidence corruption surfaces; it is never disguised as cold replay", async () => {
  const f = await fixture(); await f.seed();
  const path = join(f.nativeRoot, (await f.journals())[0]!); await writeFile(path, "{fictional-corrupt-record}\n");
  f.faux.setResponses([text("Must not execute")]); const result = await f.makeHarness("B", true).run(f.request("corrupt"));
  // The pre-admission probe types corruption; it is never classified as missing.
  expect(result.failure?.kind).toBe("native_journal_unreadable"); expect(f.transport).toHaveBeenCalledTimes(1); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A");
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
  expect((await h.run(f.request("upgraded"))).failure).toBeUndefined(); expect((await f.journals())).toHaveLength(1); await h.dispose();
  if (kind === "reset") { await f.store.reset("fictional"); expect(await f.journals()).toHaveLength(0); }
  else {
    f.faux.setResponses([text("Fictional retention successor")]); const successor = f.makeHarness("B");
    expect((await successor.run(f.request("successor", "Fictional new conversation", { conversationId: "other-fictional" }))).failure).toBeUndefined(); await successor.dispose();
    expect(await f.journals()).toHaveLength(1);
  }
  expect(await f.store.load("fictional")).toEqual([]); expect(await f.changes()).toHaveLength(0);
});


it.each([false, true])("unbound claim-wait cancellation with switching %s publishes no unadmitted input", async (enabled) => {
  const f = await fixture(), held = await f.store.beginProviderSessionPreparation("fictional", "fictional-holder"), controller = new AbortController();
  const waiting = vi.spyOn(f.store, enabled ? "beginProviderSessionPreparation" : "beginProviderSessionTurn");
  const running = f.makeHarness("A", enabled).run(f.request("cancelled-wait", "Fictional cancelled input", { abortSignal: controller.signal }));
  try {
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce()); controller.abort("Fictional claim-wait cancellation");
    expect((await running).failure?.kind).toBe("cancelled"); expect(f.transport).not.toHaveBeenCalled();
    expect(await f.store.load("fictional")).toEqual([]);
    await expect(f.canonical()).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await held.abort(); }
});

it.each(["typed", "spoofed", "old-spoofed"])("%s capture-capacity errors cannot be confused with generic custom failures", async (kind) => {
  const f = await fixture(); await f.seed(); const before = await f.canonicalBytes();
  vi.spyOn(f.native, "captureEvidence").mockImplementationOnce(async () => {
    if (kind !== "typed") throw Object.assign(new Error("Fictional custom failure"), { code: kind === "old-spoofed" ? "ERR_NATIVE_EVIDENCE_CAPACITY" : "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT" });
    throw new NativeEvidenceCapacityError();
  });
  f.faux.setResponses([text("Must not execute")]);
  const result = await f.makeHarness("B", true).run(f.request("capture-limit"));
  // Typed capacity is a handoff refusal; never a cold model change or a disguised success.
  expect(result.failure?.kind).toBe(kind === "typed" ? "handoff_budget_exceeded" : "Error"); expect(f.transport).toHaveBeenCalledTimes(1);
  expect(await f.canonicalBytes()).toEqual(before); expect(await f.changes()).toHaveLength(0);
});
it("real oversized inherited completed prefix is refused on the host path before intent or paid work", async () => {
  const f = await fixture({}, 32000); await f.seed("Fictional oversized inherited detail ".repeat(1600));
  const before = await f.canonicalBytes();
  const result = await f.makeHarness("B", true).run(f.request("real-prefix"));
  expect(result.failure).toMatchObject({ kind: "handoff_budget_exceeded", message: expect.stringContaining("mandatory_history") });
  expect(f.transport).toHaveBeenCalledTimes(1); expect(await f.canonicalBytes()).toEqual(before); expect(await f.changes()).toHaveLength(0);
  const owner = await f.store.beginProviderSessionPreparation("fictional", "prefix-read"); expect((await owner.read()).pending).toBeUndefined(); await owner.abort();
});

it.each(["incoming", "pending"])("unavailable outgoing auth advances unbilled to %s", async (step) => {
  const f = await fixture();
  if (step === "pending") for (let i = 0; i < 6; i++) await f.seed("Fictional older detail ".repeat(2600), `older-${i}`);
  await f.seed("Fictional recent completed turn", "recent");
  const beforeCalls = f.transport.mock.calls.length, old = f.runtimeFor("A");
  const unavailable = vi.fn(async () => { throw new Error("Fictional unavailable old provider/auth"); }); old.prepareNativeDispatch = unavailable;
  f.faux.setResponses([text(summary), text("Fictional incoming fallback reply")]);
  const result = await f.makeHarness("B", true, { runtimeForModel: () => old }).run(f.request(`unavailable-${step}`));
  expect(unavailable).toHaveBeenCalledOnce();
  if (step === "pending") {
    expect(result.failure?.kind).toBe("handoff_pending"); expect(f.transport).toHaveBeenCalledTimes(beforeCalls);
    const owner = await f.store.beginProviderSessionPreparation("fictional", "unavailable-read"); const state = (await owner.read()).pending!;
    expect(state.phase).toBe("pending"); expect(state.attempts).toHaveLength(0); await owner.abort();
  } else {
    // No prior structured summary: the free route is refused and incoming summarizes.
    expect(result.failure).toBeUndefined(); expect(f.transport).toHaveBeenCalledTimes(beforeCalls + 2);
    const owner = await f.store.beginProviderSessionPreparation("fictional", "producer-read"), record = await owner.read();
    const cached = await owner.readHandoff(record.lastSwitch!.switchId, record.native!.projection!); expect(cached.artifact.producer).toBe("incoming"); await owner.abort();
    expect(await f.changes()).toHaveLength(1);
  }
});
it("the first switch succeeds while an unrelated preparation still owns its conversation", async () => {
  const f = await fixture(); await f.seed();
  const other = await f.store.beginProviderSessionPreparation("other-fictional", "other-owner");
  const owner = await f.store.beginProviderSessionPreparation("fictional", "authority-check");
  const lease = await owner.acquireNativeHistoryAuthority();
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release(); await owner.abort();
  f.faux.setResponses([text(summary), text("Fictional switched answer")]);
  const result = await f.makeHarness("B", true).run(f.request("active-sibling-delivery"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional switched answer");
  expect(f.transport).toHaveBeenCalledTimes(3); expect(await f.changes()).toHaveLength(1);
  await other.assertOwned(); await other.abort();
});

it("an interrupted turn on a legacy-only handle settles as interrupted without rerun, and the next turn runs", async () => {
  const f = await fixture(); await f.seed();
  const [journal] = await f.journals(), current = join(f.nativeRoot, journal!), id = JSON.parse((await readFile(current, "utf8")).split("\n")[0]!).id;
  // The handle exists only as a not-yet-imported legacy Pi source (the shared harness fixture).
  const legacy = (await readFile(new URL("../../../turn/src/engine/__tests__/fixtures/legacy-v3.jsonl", import.meta.url), "utf8")).replace('"id":"fixture-session"', `"id":"${id}"`);
  await rm(current); await mkdir(join(f.nativeRoot, "legacy"), { mode: 0o700 }); await writeFile(join(f.nativeRoot, "legacy", `1700000000000_${id}.jsonl`), legacy, { mode: 0o600 });
  const abandoned = await f.store.beginProviderSessionTurn!("fictional", "fictional-killed-run", { modelKey: "faux:A",
    reconciliation: { purpose: "execution", ownerKey: "fictional", initial: { persistText: "Fictional killed input", timestamp: "2000-01-01T00:00:00.000Z" } } });
  expect(abandoned.providerSessionId).toBe(id); await abandoned.abort(); // Fence written; killed before the import.
  const calls = f.transport.mock.calls.length; f.faux.setResponses([text("Fictional next answer")]);
  const result = await f.makeHarness().run(f.request("next-delivery", "Fictional next input"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional next answer"); expect(f.transport).toHaveBeenCalledTimes(calls + 1);
  const settled = f.inspect.mock.calls.findIndex(([request]) => request.descriptor.turnId === "fictional-killed-run");
  expect(await f.inspect.mock.results[settled]!.value).toEqual({ status: "absent" });
  const messages: { content: string }[] = (await f.canonical()).messages;
  expect(messages.some((message) => message.content.includes("Fictional killed input"))).toBe(true);
  expect(messages.some((message) => message.content.includes("interrupted"))).toBe(true);
});

it("an unreadable sibling canonical record on an unmarked root does not block the first switch", async () => {
  const f = await fixture(); await f.seed();
  const sibling = join(f.historyRoot, `${switchConversationKey("other-fictional")}.history.json`); await writeFile(sibling, "{", { mode: 0o600 });
  f.faux.setResponses([text(summary), text("Fictional B answer")]);
  const result = await f.makeHarness("B", true).run(f.request("first-switch-delivery"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional B answer"); expect(await f.changes()).toHaveLength(1);
  expect(await readFile(sibling, "utf8")).toBe("{");
});

it("the first switch preserves another conversation's damaged recovery data without refusing", async () => {
  const f = await fixture(); await f.seed();
  const other = await f.store.beginProviderSessionTurn!("other-fictional", "other-damaged-run", { modelKey: "faux:A",
    reconciliation: { purpose: "execution", ownerKey: "other-fictional", initial: { persistText: "Fictional other input", timestamp: "2000-01-01T00:00:00.000Z" } } });
  await other.abort(); await rm(join(f.historyRoot, ".locks", `${switchConversationKey("other-fictional")}.dirty.json`));
  const [name] = await readdir(join(f.historyRoot, ".pending-turns")); await writeFile(join(f.historyRoot, ".pending-turns", name!), '{"version":', { mode: 0o600 });
  f.faux.setResponses([text(summary), text("Fictional switched answer")]);
  const result = await f.makeHarness("B", true).run(f.request("damaged-delivery"));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional switched answer");
  expect(f.transport).toHaveBeenCalledTimes(3); expect(await f.changes()).toHaveLength(1);
  expect(await readFile(join(f.historyRoot, ".pending-turns", name!), "utf8")).toBe('{"version":');
});

it("unguarded default and unguarded prepared turns emit no nativeProvenance; prepare-time flags/values are ignored", async () => {
  const f = await fixture(); await f.seed();
  const runtime = f.runtimeFor("A");
  // Only the host's run-time binding may request recording; a caller's
  // prepare-time flag or forged provenance value is never honoured or copied.
  const lease = await runtime.prepareNativeDispatch!("Fictional unguarded rules", { model: parseMonoRuntimeModelReference("faux:A"),
    abortSignal: new AbortController().signal, messages: [{ role: "user", content: "Fictional unguarded prepared input" }], allowedTools: [],
    sessionsRoot: f.nativeRoot, sessionId: "fictional-unguarded-prepare", sessionKeepAlive: true, compaction: { enabled: false },
    nativeProvenanceRecording: true, ...{ nativeProvenance: { provider: "faux", api: "forged", model: "A", account: "forged" } } });
  try { f.faux.setResponses([text("Fictional unguarded reply")]); expect((await lease.run()).error).toBeFalsy(); }
  finally { await lease.close(); }
  const records = (await Promise.all((await f.journals()).map(async (path) => (await readFile(join(f.nativeRoot, path), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  const starts = records.filter((record) => ["turn_start", "operation_start"].includes(record.kind));
  expect(starts.some((record) => record.payload.config?.model?.id === "A")).toBe(true);
  expect(starts.every((record) => !Object.hasOwn(record.payload.config, "nativeProvenance"))).toBe(true);
  expect(JSON.stringify(records)).not.toContain("forged");
});

it("strips static detached replay from outgoing handoff and incoming preparation", async () => {
  const f = await fixture(); await f.seed(); const detachedContext = vi.fn(async () => []);
  f.faux.setResponses([text(summary), text("Fictional B reply")]);
  const result = await f.makeHarness("A", true, { runtimeOptions: { piResolvedModels: f.models, allowedTools: [], compaction: { enabled: false }, detachedContext } }).run(f.request("fictional-switch", "Fictional override", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure).toBeUndefined(); expect(f.prepareCalls.map((call) => call.id)).toContain("A"); expect(f.prepareCalls.map((call) => call.id)).toContain("B");
  for (const call of f.prepareCalls) expect(call.options).not.toHaveProperty("detachedContext");
  expect(detachedContext).not.toHaveBeenCalled();
});

/** Both producers reject: no prior summary makes the free checkpoint unfit, so the intent ends pending. */
async function pendingSwitch(f: Awaited<ReturnType<typeof fixture>>, delivery = "switch-to-B") {
  f.faux.setResponses([text("Fictional malformed summary"), text("Fictional malformed summary")]);
  const result = await f.makeHarness("B", true).run(f.request(delivery, "Fictional switch request", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure?.kind).toBe("handoff_pending");
  const owner = await f.store.beginProviderSessionPreparation("fictional", `inspect-${delivery}`); const pending = (await owner.read()).pending; await owner.abort();
  return pending!;
}
const switchFiles = async (f: Awaited<ReturnType<typeof fixture>>) => (await readdir(join(f.historyRoot, ".model-switches"))).sort();

it("an explicit message back to the source model abandons a pending switch storage-only, then a later switch is a new id", async () => {
  const f = await fixture(); await f.seed();
  const sourceJournals = await f.journals(), pending = await pendingSwitch(f);
  expect(pending).toMatchObject({ phase: "pending", identity: { fromModelKey: "faux:A", toModelKey: "faux:B" } });
  expect(pending.attempts.map(({ producer, outcome }) => ({ producer, outcome }))).toEqual([{ producer: "outgoing", outcome: "rejected" }, { producer: "incoming", outcome: "rejected" }]);
  const billed = f.transport.mock.calls.length; expect(billed).toBe(3);
  f.faux.setResponses([text("Fictional A reply after cancelling")]);
  const back = await f.makeHarness("A", true).run(f.request("back-to-A", "Fictional return to the source model", { metadata: { web: { model: "faux:A" } } }));
  expect(back.failure).toBeUndefined(); expect(back.text).toBe("Fictional A reply after cancelling");
  // One ordinary turn on the current source journal; no summary producer ran.
  expect(f.transport).toHaveBeenCalledTimes(billed + 1); expect(f.transport.mock.calls.at(-1)![0].id).toBe("A");
  expect(await f.journals()).toEqual(sourceJournals); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A"); expect(await f.changes()).toHaveLength(0);
  // Only the intent fence is gone: the billing state with both charged attempts is retained.
  const files = await switchFiles(f); expect(files.filter((name) => name.endsWith(".fence.json"))).toEqual([]);
  const retained = await Promise.all(files.filter((name) => name.endsWith(".state.json")).map(async (name) => JSON.parse(await readFile(join(f.historyRoot, ".model-switches", name), "utf8"))));
  expect(retained.at(-1)).toMatchObject({ identity: { switchId: pending.identity.switchId }, attempts: pending.attempts });
  expect((await f.store.stats()).reservedBytes).toBe(0);
  // Redelivery of the abandoning message stays an ordinary source-model turn.
  f.faux.setResponses([text("Fictional second A reply")]);
  expect((await f.makeHarness("A", true).run(f.request("back-to-A", "Fictional return to the source model", { metadata: { web: { model: "faux:A" } } }))).failure).toBeUndefined();
  expect(f.transport).toHaveBeenCalledTimes(billed + 2);
  // Requesting the target again is a new explicit message and a new switch id.
  f.faux.setResponses([text(summary), text("Fictional B reply")]);
  const again = await f.makeHarness("B", true).run(f.request("switch-to-B-again", "Fictional second switch", { metadata: { web: { model: "faux:B" } } }));
  expect(again.failure).toBeUndefined(); expect(again.text).toBe("Fictional B reply"); expect(f.transport).toHaveBeenCalledTimes(billed + 4);
  const switched = await f.canonical(); expect(switched.providerSession.modelKey).toBe("faux:B");
  expect(switched.lastSwitch.switchId).not.toBe(pending.identity.switchId);
});

it("a pending switch keeps accepting explicit messages beyond 32 authorizations", async () => {
  const f = await fixture(); await f.seed(); await pendingSwitch(f, "authorization-0");
  for (let index = 1; index <= 32; index++) await pendingSwitch(f, `authorization-${index}`);
  f.faux.setResponses([text(summary), text("Fictional B reply after many messages")]);
  const result = await f.makeHarness("B", true).run(f.request("authorization-33", "Fictional switch request", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional B reply after many messages");
  // Two billed producers per explicit message, never more; 67 durable attempts.
  expect(f.transport).toHaveBeenCalledTimes(1 + 33 * 2 + 2);
  const state = JSON.parse(await readFile(join(f.historyRoot, ".model-switches", (await switchFiles(f)).find((name) => name.endsWith(".state.json"))!), "utf8"));
  expect(state).toMatchObject({ phase: "ready", authorizationGeneration: 33 }); expect(state.attempts).toHaveLength(67);
}, 60_000);

it("a third model requested while a switch is pending is a typed pending refusal that bills nothing", async () => {
  const f = await fixture(); await f.seed(); const pending = await pendingSwitch(f), billed = f.transport.mock.calls.length;
  const result = await f.makeHarness("C", true).run(f.request("third-model", "Fictional third model request", { metadata: { web: { model: "faux:C" } } }));
  expect(result.failure).toMatchObject({ kind: "handoff_pending", message: expect.stringContaining("faux:A to cancel") });
  expect(f.transport).toHaveBeenCalledTimes(billed);
  const owner = await f.store.beginProviderSessionPreparation("fictional", "inspect-third"); expect((await owner.read()).pending).toEqual(pending); await owner.abort();
});

it("a native journal well over 16 MiB with a small effective tail switches, keeping a far-back outcome-unknown call in the ledger", async () => {
  const f = await fixture(); await f.seed();
  // Grow the source journal directly: an early crashed Write (outcome unknown),
  // then many large completed turns, a compaction checkpoint and a small tail.
  const { JsonlSessionRepo } = await import("@mono-agent/turn/engine"), repo = new JsonlSessionRepo({ sessionsRoot: f.nativeRoot });
  const [metadata] = await repo.list(), store = await repo.open(metadata!), model = { provider: "faux", api: "faux-api", id: "A" };
  await store.beginTurn("fictional-far-turn", {}, "host", undefined); await store.openOperation("fictional-far-op", { model });
  await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fictional-far-write", name: "Write", arguments: { file_path: "/fictional/far" } }], stopReason: "toolUse", timestamp: 1 } as never, "fictional-far-message");
  for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId: "fictional-far-write", name: "Write", messageId: "fictional-far-message", admission }, { operationId: "fictional-far-op" });
  await store.write("interruption", { cause: "crashed", operationIds: ["fictional-far-op"], tipId: store.tip, calls: [] });
  await store.closeOperation("fictional-far-op", "interrupted"); await store.endTurn("fictional-far-turn", "interrupted");
  for (let index = 0; index < 24; index++) {
    await store.beginTurn(`fictional-large-${index}`, {}, "host", undefined); await store.openOperation(`fictional-large-op-${index}`, { model });
    await store.appendMessage({ role: "user", content: `Fictional large turn ${index} `.repeat(40000), timestamp: 1 } as never, `fictional-large-message-${index}`);
    await store.closeOperation(`fictional-large-op-${index}`, "completed"); await store.endTurn(`fictional-large-${index}`, "completed");
  }
  await store.appendCompaction({ summary: "Fictional checkpoint of the large turns", tokensBefore: 10, retainedTail: [] });
  await store.beginTurn("fictional-tail", {}, "host", undefined); await store.openOperation("fictional-tail-op", { model });
  await store.appendMessage({ role: "user", content: "Fictional small tail fact", timestamp: 1 } as never, "fictional-tail-message");
  await store.closeOperation("fictional-tail-op", "completed"); await store.endTurn("fictional-tail", "completed"); await store.sync(); await store.close(); await repo.close();
  const [journal] = await f.journals(); expect((await stat(join(f.nativeRoot, journal!))).size).toBeGreaterThan(20 * 1024 * 1024);
  f.faux.setResponses([text(summary), text("Fictional B reply after a long conversation")]);
  const result = await f.makeHarness("B", true).run(f.request("long-switch", "Fictional switch request", { metadata: { web: { model: "faux:B" } } }));
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional B reply after a long conversation");
  expect((await f.canonical()).providerSession.modelKey).toBe("faux:B"); expect(f.transport).toHaveBeenCalledTimes(3);
  // The producer saw the checkpoint and tail, not the 24 large turns.
  expect(JSON.stringify(f.transport.mock.calls[1]![1])).toContain("Fictional checkpoint of the large turns");
  expect(JSON.stringify(f.transport.mock.calls[1]![1])).not.toContain("Fictional large turn 0");
  const name = (await switchFiles(f)).find((entry) => entry.endsWith(".handoff.json"))!;
  const artifact = JSON.parse(await readFile(join(f.historyRoot, ".model-switches", name), "utf8")).artifact;
  expect(artifact.ledger.filter((entry: { callId?: string }) => entry.callId === "fictional-far-write")).toEqual([expect.objectContaining({ outcome: "unknown", admission: "started", arguments: { file_path: "/fictional/far" } })]);
}, 60_000);

it("a redelivered message whose abandoned switch already billed it makes no paid call; a new message starts a fresh switch", async () => {
  const f = await fixture(); await f.seed();
  const abandoned = await pendingSwitch(f, "fictional-m1"); const billed = f.transport.mock.calls.length;
  f.faux.setResponses([text("Fictional A reply after cancelling")]);
  expect((await f.makeHarness("A", true).run(f.request("fictional-m2", "Fictional back to A", { metadata: { web: { model: "faux:A" } } }))).failure).toBeUndefined();
  expect(f.transport).toHaveBeenCalledTimes(billed + 1);
  // M1 redelivered for B: its retained billing state already consumed it.
  f.faux.setResponses([text(summary), text("Fictional must not run")]);
  const redelivered = await f.makeHarness("B", true).run(f.request("fictional-m1", "Fictional switch request", { metadata: { web: { model: "faux:B" } } }));
  expect(redelivered.failure).toMatchObject({ kind: "handoff_pending", message: expect.stringContaining("send a new message") });
  expect(f.transport).toHaveBeenCalledTimes(billed + 1); expect((await f.canonical()).providerSession.modelKey).toBe("faux:A");
  expect((await switchFiles(f)).filter((name) => name.endsWith(".fence.json"))).toEqual([]);
  // A genuinely new explicit message starts a fresh switch.
  f.faux.setResponses([text(summary), text("Fictional B reply")]);
  const fresh = await f.makeHarness("B", true).run(f.request("fictional-m3", "Fictional new switch request", { metadata: { web: { model: "faux:B" } } }));
  expect(fresh.failure).toBeUndefined(); expect(fresh.text).toBe("Fictional B reply");
  expect(f.transport).toHaveBeenCalledTimes(billed + 3); expect((await f.canonical()).lastSwitch.switchId).not.toBe(abandoned.identity.switchId);
});


it("unreadable capture during a pending switch is typed and bills nothing", async () => {
  const f = await fixture(); await f.seed(); await pendingSwitch(f); const billed = f.transport.mock.calls.length;
  const inspect = vi.spyOn(f.native as Required<Pick<import("@mono-agent/turn/host/types").RuntimeNativePreparationStorage, "inspectCurrentJournal">>, "inspectCurrentJournal").mockResolvedValue({ status: "unreadable", reason: "fictional-damage" });
  const result = await f.makeHarness("B", true).run(f.request("fictional-retry"));
  expect(result.failure?.kind).toBe("native_journal_unreadable"); expect(f.transport).toHaveBeenCalledTimes(billed); inspect.mockRestore();
});

it("a recovered ready handoff reports its completed model before refusing a different selection", async () => {
  const f = await fixture(); await f.seed();
  const roll = vi.spyOn(f.store, "beginProviderSessionPreparation"), original = f.store.beginProviderSessionPreparation.bind(f.store);
  roll.mockImplementationOnce(async (...args) => {
    const prep = await original(...args); prep.rollForwardModelSwitch = async () => { throw new Error("Fictional roll-forward interruption"); }; return prep;
  });
  f.faux.setResponses([text(summary)]); await f.makeHarness("B", true).run(f.request("fictional-ready")); roll.mockRestore();
  const billed = f.transport.mock.calls.length;
  const result = await f.makeHarness("A", true).run(f.request("fictional-back"));
  expect(result.failure).toMatchObject({ kind: "handoff_pending", message: expect.stringContaining("handoff to faux:B completed") });
  expect(f.transport).toHaveBeenCalledTimes(billed); expect((await f.canonical()).providerSession.modelKey).toBe("faux:B");
});

it("switches while an unrelated conversation is active after root bootstrap", async () => {
  const f = await fixture(); await f.seed();
  const root = await f.store.acquireNativeHistoryAuthority("fictional"); if (root.status !== "owned") throw new Error("fixture"); await root.release();
  const active = await f.store.beginProviderSessionTurn("fictional-other", "fictional-active", { modelKey: "faux:A" });
  f.faux.setResponses([text(summary), text("Fictional B reply")]);
  try { expect((await f.makeHarness("B", true).run(f.request("fictional-concurrent-switch"))).failure).toBeUndefined(); }
  finally { await active.abort(); }
  expect((await f.canonical()).providerSession.modelKey).toBe("faux:B");
});


it("keyless native inheritance overrides a late sticky extension without copying metadata identity, its effort or its 1M flag", async () => {
  const f = await fixture(); await f.seed();
  f.faux.setResponses([text(summary), text("Fictional switched B answer")]);
  await f.makeHarness("B", true).run(f.request("fictional-switch-id"));
  const before = await f.canonical(), cleanup = vi.fn(async () => {});
  const extension = vi.fn(async (_input: Parameters<NonNullable<AgentHarnessOptions["runtimeOptionsForRequest"]>>[0]) => ({ runtimeOptions: { model: parseMonoRuntimeModelReference("faux:A"), effort: "xhigh", context1MModels: { "faux:A": true } }, cleanup }));
  const wake = { ...f.request("not-a-host-delivery"), metadata: { source: "web", web: { model: "faux:A", context1M: true } } };
  f.faux.setResponses([text("Fictional inherited B answer")]);
  const result = await f.makeHarness("A", true, { runtimeOptionsForRequest: extension }, true).run(wake);
  expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional inherited B answer");
  expect(extension).toHaveBeenCalledOnce(); expect(extension.mock.calls[0]![0].request.metadata).toBe(wake.metadata); expect(cleanup).toHaveBeenCalledOnce();
  const prepared = f.prepareCalls.at(-1)!;
  expect(prepared.id).toBe("B"); expect(prepared.options.model).toMatchObject({ provider: "faux", model: "B" });
  expect(prepared.options.context1MModels?.["faux:A"]).toBeUndefined(); expect(prepared.options.effort).toBeUndefined();
  const after = await f.canonical(); expect(after.providerSession.modelKey).toBe("faux:B");
  expect(after.providerSession.epoch).toBe(before.providerSession.epoch); expect(after.native).toEqual(before.native); expect(after.lastSwitch).toEqual(before.lastSwitch);
});

it("configured preparation cancels a contended claim before admission or any summary/provider call", async () => {
  const f = await fixture(); await f.seed(); const before = await f.canonicalBytes();
  const holder = await f.store.beginProviderSessionPreparation("fictional", "fictional-holder");
  const begin = vi.spyOn(f.store, "beginProviderSessionPreparation"), harness = f.makeHarness("B", true), controller = new AbortController();
  try {
    const waiting = harness.run(f.request("fictional-cancelled", "Fictional cancelled input", { abortSignal: controller.signal }));
    await vi.waitFor(() => expect(begin).toHaveBeenCalled()); controller.abort();
    expect((await waiting).failure?.kind).toBe("cancelled");
    expect(f.transport).toHaveBeenCalledTimes(1); expect(await f.canonicalBytes()).toEqual(before);
    expect(f.prepareCalls).toHaveLength(0); expect(await f.changes()).toHaveLength(0);
  } finally { await holder.abort(); }
  f.faux.setResponses([text(summary), text("Fictional successor reply")]);
  expect((await harness.run(f.request("fictional-successor"))).failure).toBeUndefined();
  expect(f.transport).toHaveBeenCalledTimes(3);
});

it("cancellation during the binding preflight leaves no account and never waits for the held conversation", async () => {
  const f = await fixture(); await f.seed(); const before = await f.canonicalBytes();
  const holder = await f.store.beginProviderSessionPreparation("fictional", "fictional-holder"), controller = new AbortController();
  const read = f.store.readProviderSessionBinding.bind(f.store);
  vi.spyOn(f.store, "readProviderSessionBinding").mockImplementationOnce(async (...args) => { controller.abort(); return await read(...args); });
  const append = vi.spyOn(f.store, "prepareAppend"), begin = vi.spyOn(f.store, "beginProviderSessionTurn"), harness = f.makeHarness("A", true);
  let settled = false;
  const pending = harness.run({ conversationId: "fictional", userMessage: "Fictional cancelled input", abortSignal: controller.signal }).then((result) => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
    expect((await pending).failure?.kind).toBe("cancelled"); expect(append).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
    expect(f.transport).toHaveBeenCalledTimes(1); expect(await f.canonicalBytes()).toEqual(before); await holder.assertOwned();
  } finally { await holder.abort(); await pending; }
});
