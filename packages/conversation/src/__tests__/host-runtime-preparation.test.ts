import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecorder } from "@mono-agent/observability";
import type { MonoRuntimeLike, RuntimePreparedHandoff } from "@mono-agent/turn/host/types";
// @ts-expect-error Fake transport fixture, real native orchestration.
import { preparedHostFixture } from "../../../turn/src/__tests__/fixtures/prepared-host-runtime.mjs";
import { prepareHarnessRuntime, type HarnessRuntimePreparationInput } from "../harness/runtime-execution.js";
import { UncommittedTurnCollector } from "../harness/turn-continuity.js";
import { buildAgentContext } from "../context/context-builder.js";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { createSemaphore } from "../semaphore.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-preparation-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const f = preparedHostFixture(root), runtime = f.runtime as MonoRuntimeLike, nativeRoot = join(root, "native"), limiter = createSemaphore(1), controller = new AbortController();
  const store = createDurableHistoryStore({ root: join(root, "history"), retireProviderSession: async (id) => { await runtime.retireDurableSession!(id, nativeRoot); },
    reconcileProviderSessionTurn: async (request) => await runtime.reconcileSessionTurn!({ descriptor: request.descriptor, purpose: request.purpose,
      expectedInputs: request.expectedInputs, sessionsRoot: nativeRoot, expectedModel: { provider: "faux", id: "fixture" } }) });
  const owner = await store.beginProviderSessionPreparation("fictional", "prepared"); cleanup.push(() => owner.abort());
  const extensionClose = vi.fn(async () => {}), settleClose = vi.fn(async () => {}), metadata = { source: "fictional" };
  const context = vi.fn(async (request) => ({ context: buildAgentContext({ identity: "Fictional stable rules", userMessage: request.userMessage }),
    memory: "Fictional memory", skillDisclosureEntries: [], history: [], historyOmitted: false, historyAsMessages: true, toolHistoryProjection: undefined }));
  const extension = vi.fn(async ({ request }) => { expect(request.metadata).toBe(metadata); return {
    runtimeOptions: f.options, decorateUserMessage: (text: string) => `Fictional decoration: ${text}`, cleanup: extensionClose, settleCleanup: settleClose }; });
  const input: HarnessRuntimePreparationInput = { options: { identityPath: "/fictional/identity.md", model: f.model, runtime, runtimeOptionsForRequest: extension },
    request: { conversationId: "fictional", userMessage: "Original fictional input", abortSignal: controller.signal, metadata }, recorder: { onEvent: vi.fn() } as unknown as RunRecorder,
    sessionsEnabled: true, runLimiter: limiter, runId: "prepared", durableSessionsRoot: nativeRoot,
    routing: { modelKey: "faux:fixture", runtimeForSession: () => runtime, onRuntimeSelected: vi.fn() },
    attachmentContext: { root: "", allowedPaths: [], allowedIdentities: [] }, continuationCapabilities: [], turnContinuityCollector: new UncommittedTurnCollector(),
    assertOwned: () => owner.assertOwned(), prepareContext: context };
  return { root, nativeRoot, f, runtime, store, owner, input, limiter, controller, context, extension, extensionClose, settleClose };
}
const producer = { prepared: { status: "prepared", checkpoints: [], recent: [], older: [], ledger: [], prior: null, coverage: [] } as RuntimePreparedHandoff, outputReserve: 256 };
const summary = JSON.stringify({ intent: ["Fictional goal"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] });

it("prepares context/extensions once under the permit and claim, without incoming P2; then transfers and runs the frozen input once", async () => {
  const f = await fixture(), native = vi.spyOn(f.runtime, "run");
  f.context.mockImplementationOnce(async (request) => { expect(f.limiter.inUse()).toBe(1); await f.owner.assertOwned();
    return { context: buildAgentContext({ identity: "Fictional stable rules", userMessage: request.userMessage }), memory: "Fictional memory",
      skillDisclosureEntries: [], history: [], historyOmitted: false, historyAsMessages: true, toolHistoryProjection: undefined }; });
  const pending = prepareHarnessRuntime(f.input); (f.input.request as { userMessage: string }).userMessage = "Caller mutation";
  const lease = await pending; cleanup.push(() => lease.close());
  lease.assertReady(); expect(() => { (lease.context.context as { systemPrompt: string }).systemPrompt = "Caller mutation"; }).toThrow();
  expect(f.limiter.inUse()).toBe(1); expect(f.context).toHaveBeenCalledOnce(); expect(f.extension).toHaveBeenCalledOnce();
  expect((await readdir(join(f.root, "history", ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
  expect(lease.snapshot.messages.at(-1)?.content).toContain("Fictional decoration: Original fictional input");
  expect(lease.snapshot.messages.at(-1)?.content).toContain("Fictional memory"); expect(f.extensionClose).not.toHaveBeenCalled();
  await expect(lease.run({ model: f.f.model } as never)).rejects.toThrow("owned P2/session binding");
  f.f.faux.setResponses([f.f.response(summary), f.f.response("Incoming result")]);
  expect((await lease.produceHandoffSummary(producer)).status).toBe("ready");
  const turn = await f.owner.admit({ modelKey: "faux:fixture", reconciliation: { purpose: "execution", ownerKey: "fictional",
    initial: { persistText: "Original fictional input", timestamp: new Date().toISOString() } } });
  const result = await lease.run({ reconciliation: turn.reconciliation!, assertOwned: () => turn.assertOwned(), turnRevision: turn.providerSessionRevision,
    sessionId: turn.providerSessionId, providerSessionId: turn.providerSessionId, sessionKeepAlive: true });
  expect(result.text).toBe("Incoming result"); expect(native).not.toHaveBeenCalled();
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  await lease.close(); expect(f.limiter.inUse()).toBe(0); expect(f.extensionClose).toHaveBeenCalledOnce(); expect(f.settleClose).toHaveBeenCalledOnce();
  expect(f.extension).toHaveBeenCalledOnce(); await expect(lease.run({} as never)).rejects.toThrow("no longer available");
});

it("queued preparation allocates neither context nor request resources; idle close releases them once and preserves the claim", async () => {
  const f = await fixture(); await f.limiter.acquire(); const pending = prepareHarnessRuntime(f.input);
  await Promise.resolve(); expect(f.context).not.toHaveBeenCalled(); expect(f.extension).not.toHaveBeenCalled();
  f.limiter.release(); const lease = await pending; await lease.close(); await lease.close();
  expect(f.limiter.inUse()).toBe(0); expect(f.extensionClose).toHaveBeenCalledOnce(); await f.owner.assertOwned();
  expect((await readdir(join(f.root, "history", ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
});

it("abort during an active producer keeps the permit/resources until provider settlement, with no incoming P2", async () => {
  const f = await fixture(), lease = await prepareHarnessRuntime(f.input);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { finish = resolve; });
  f.f.faux.setResponses([async () => { enter(); await gate; return f.f.response(summary); }]);
  const production = lease.produceHandoffSummary(producer); await entered; f.controller.abort();
  const closing = lease.close(); await Promise.resolve(); expect(f.limiter.inUse()).toBe(1); expect(f.extensionClose).not.toHaveBeenCalled();
  finish(); await production; await closing; expect(f.limiter.inUse()).toBe(0); expect(f.extensionClose).toHaveBeenCalledOnce();
});

it.each(["context", "native", "claim"])("failed %s preparation closes acquired resources and permit without P2", async (failure) => {
  const f = await fixture();
  if (failure === "context") f.context.mockRejectedValueOnce(new Error("Fictional context failure"));
  if (failure === "native") f.f.models.setProvider({ ...f.f.faux.provider, auth: { apiKey: { resolve: async () => { throw new Error("Fictional auth failure"); } } } });
  if (failure === "claim") await f.owner.abort();
  await expect(prepareHarnessRuntime(f.input)).rejects.toThrow(); expect(f.limiter.inUse()).toBe(0);
  expect(f.extensionClose).toHaveBeenCalledTimes(failure === "native" ? 1 : 0);
});


it("idle preparations retain the permit until explicit close, even after a long delay", async () => {
  const f = await fixture(), lease = await prepareHarnessRuntime(f.input);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
  lease.assertReady(); expect(f.limiter.inUse()).toBe(1); await f.owner.assertOwned();
  await lease.close(); await lease.close(); expect(f.limiter.inUse()).toBe(0);
  expect(f.extensionClose).toHaveBeenCalledOnce(); expect(f.settleClose).toHaveBeenCalledOnce();
  await expect(lease.run({} as never)).rejects.toThrow("no longer available");
});

it("run admits P2 once after a long delay under the same ownership claim", async () => {
  const f = await fixture(), lease = await prepareHarnessRuntime(f.input); cleanup.push(() => lease.close());
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
  const admission = vi.fn(async () => {
    const turn = await f.owner.admit({ modelKey: "faux:fixture", reconciliation: { purpose: "execution", ownerKey: "fictional",
      initial: { persistText: "Original fictional input", timestamp: new Date().toISOString() } } });
    cleanup.push(() => turn.abort());
    return { reconciliation: turn.reconciliation!, assertOwned: () => turn.assertOwned(), turnRevision: turn.providerSessionRevision,
      sessionId: turn.providerSessionId, providerSessionId: turn.providerSessionId, sessionKeepAlive: true };
  });
  lease.assertReady(); await f.owner.assertOwned();
  f.f.faux.setResponses([f.f.response("Delayed admission accepted")]);
  expect((await lease.run(admission)).text).toBe("Delayed admission accepted"); expect(admission).toHaveBeenCalledOnce();
});

it("prepared running abort intentionally holds resources/permit until the provider settles unlike ordinary R10", async () => {
  const f = await fixture(), lease = await prepareHarnessRuntime(f.input); cleanup.push(() => lease.close());
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { finish = resolve; });
  f.f.faux.setResponses([async () => { enter(); await gate; return f.f.response("Late completion"); }]);
  const running = lease.run(async () => {
    const turn = await f.owner.admit({ modelKey: "faux:fixture", reconciliation: { purpose: "execution", ownerKey: "fictional",
      initial: { persistText: "Original fictional input", timestamp: new Date().toISOString() } } });
    cleanup.push(() => turn.abort());
    return { reconciliation: turn.reconciliation!, assertOwned: () => turn.assertOwned(), turnRevision: turn.providerSessionRevision,
      sessionId: turn.providerSessionId, providerSessionId: turn.providerSessionId, sessionKeepAlive: true };
  });
  await entered; f.controller.abort(); await Promise.resolve(); expect(f.limiter.inUse()).toBe(1); expect(f.extensionClose).not.toHaveBeenCalled();
  finish(); await running; expect(f.limiter.inUse()).toBe(0); expect(f.extensionClose).toHaveBeenCalledOnce();
});


it("close during active production waits for settlement before releasing semaphore(1)", async () => {
  const f = await fixture(), lease = await prepareHarnessRuntime(f.input);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { finish = resolve; });
  f.f.faux.setResponses([async () => { enter(); await gate; return f.f.response(summary); }]);
  const production = lease.produceHandoffSummary(producer); await entered;
  const closing = lease.close();
  expect(f.limiter.inUse()).toBe(1); expect(f.extensionClose).not.toHaveBeenCalled();
  finish(); await production; await closing;
  expect(f.limiter.inUse()).toBe(0); expect(f.extensionClose).toHaveBeenCalledOnce(); await f.owner.assertOwned();
});


it.each(["admission", "normalization"])("allows slow %s while the signal and transferred owner remain valid", async (phase) => {
  const f = await fixture(), transport = vi.spyOn(f.f.faux.provider, "streamSimple"), lease = await prepareHarnessRuntime(f.input);
  cleanup.push(() => lease.close()); const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  f.f.faux.setResponses([f.f.response("Slow admission accepted")]);
  let turn: Awaited<ReturnType<typeof f.owner.admit>> | undefined;
  const running = lease.run(async () => {
    turn = await f.owner.admit({ modelKey: "faux:fixture", reconciliation: { purpose: "execution", ownerKey: "fictional",
      initial: { persistText: "Original fictional input", timestamp: new Date().toISOString() } } });
    cleanup.push(() => turn!.abort());
    if (phase === "admission") clock.mockReturnValue(now + 10 * 60_000);
    else {
      const admit = turn.reconciliation!.admit.bind(turn.reconciliation);
      vi.spyOn(turn.reconciliation!, "admit").mockImplementation(async (input) => { await admit(input); clock.mockReturnValue(now + 10 * 60_000); });
    }
    return { reconciliation: turn.reconciliation!, assertOwned: () => turn!.assertOwned(), turnRevision: turn.providerSessionRevision,
      sessionId: turn.providerSessionId, providerSessionId: turn.providerSessionId, sessionKeepAlive: true };
  });
  expect((await running).text).toBe("Slow admission accepted"); expect(transport).toHaveBeenCalledOnce(); await turn!.assertOwned();
  expect((await readdir(join(f.root, "history", ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toHaveLength(1);
  await lease.close(); expect(f.limiter.inUse()).toBe(0); await turn!.abort();
});
