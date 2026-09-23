import { createSubagentRecoveryAccess } from "../subagent-recovery-access.js";
import { formatHostCapabilities } from "@mono-agent/agent-harness";
// @ts-expect-error Real direct kernel execution seam.
import { execToolRun } from "../../../agent-runtime/src/agent/tools/exec.js";
import { parseProcessJobProjection, type ProcessJobProjection } from "@mono-agent/agent-contracts";
import { fileURLToPath } from "node:url";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime, createSandboxPolicy } from "@mono-agent/runtime-adapter";
import { buildSubagentsOptions } from "../configured-agent.js";
// @ts-expect-error Real Pi test seam; transport only is fake.
import { generatePiNativeResponse } from "../../../agent-runtime/src/ai/providers/pi-native.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../continuation-store-fs.js";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import { openProcessJobsService, type ProcessJobsServiceHandle } from "../process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../process-jobs-config.js";
import { openProcessJobStore, PROCESS_JOB_TRANSACTION_FILE } from "../process-jobs-store.js";
import { launchInternalProcessJob } from "../process-jobs-internal.js";
// @ts-expect-error Private kernel test seam.
import { createAgentTool, subagentUsageForRun } from "../../../agent-runtime/src/agent/tools/agent-tool.js";
// @ts-expect-error Private kernel test seam.
import { createAgentManageTool } from "../../../agent-runtime/src/agent/tools/agent-manage-tool.js";

const origin = { conversationId: "slack:C1:1.1#bucket", baseConversationId: "slack:C1:1.1", bucket: "bucket",
  replyToConversationId: "slack:C1:1.1", normalizedReplyTarget: "slack:C1:1.1", runId: "parent", historyBoundary: "parent", channel: "slack" };
const spec = { id: "helper", name: "helper", systemPrompt: "Review", definition: { name: "helper", description: "Review", systemPrompt: "Review" } };
const roots: string[] = [];
const services: ProcessJobsServiceHandle[] = [];
// Full-package runs overlap this file with physical crash, compiler, and app
// fixtures. Durable publication plus wake settlement has repeatedly taken
// 7-9s under that load, while the same path completes quickly in isolation.
// Timeout-fence cases also wait 1500ms + 5100ms of deadline and grace before
// delivery, so a 9s budget leaves too little headroom under contention.
const DURABLE_DELIVERY_TIMEOUT_MS = 15_000;
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(overrides = {}, retireSession: (id: string, root: string) => Promise<unknown> = async () => undefined, surfaceUpdate?: (job: ProcessJobProjection) => Promise<void>, realOwner = false) {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.background-subagents-")); roots.push(root);
  const wake = vi.fn(async (_input: unknown) => ({ delivered: true as const }));
  const signalProcess = vi.fn();
  const store = await openProcessJobStore(root, resolve(root, "jobs"));
  const options = { cwd: root, workspace: root, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir: resolve(root, "jobs"), ...overrides },
    ...(surfaceUpdate ? { surfaceUpdate } : {}),
    registration: {} as never, attestRegistration: async () => ({} as never), wake, signalProcess,
    ...(realOwner ? {} : { acquireLock: async () => ({ release: async () => undefined }) as never }) };
  const service = await openProcessJobsService(options); services.push(service); await service.activateWakes();
  const registry = createSubagentInstanceRegistry({ root: resolve(root, "children"), retireSession });
  const instances = await registry.open(origin.conversationId);
  return { root, service, instances, registry, wake, signalProcess, options, store };
}
function tools(f: Awaited<ReturnType<typeof fixture>>, run: (request: any) => Promise<any>, extra = {}) {
  const options = { instances: f.instances, run, backgroundSubagentController: f.service.internalController(origin, 0), ...extra };
  const context = { recoveryAccess: { workspace: f.root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root: f.root }) } };
  return { options, agent: createAgentTool(options, context), send: createAgentManageTool(options, context) };
}
const done = async (service: ProcessJobsServiceHandle, id: string) => {
  await vi.waitFor(async () => expect((await service.get(id))?.wake.state).toBe("delivered"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  const job = (await service.get(id))!;
  if (job.kind !== "internal") throw new Error("Expected an internal subagent job");
  return job;
};

function processJobSettlement(service: ProcessJobsServiceHandle, jobId: string): Promise<void> {
  const settlement = (service as unknown as { readonly settlements: ReadonlyMap<string, Promise<void>> })
    .settlements.get(jobId);
  if (settlement === undefined) throw new Error(`Expected active settlement for process job ${jobId}.`);
  return settlement;
}

async function managedFixture(retireSession: (id: string, root: string) => Promise<unknown> = async () => {}, overrides = {}, realOwner = false, writeRegistry?: typeof writeJsonAtomic) {
  const f = await fixture({ maxConcurrent: 1, maxQueued: 0, ...overrides }, retireSession, undefined, realOwner);
  const registry = createSubagentInstanceRegistry({ root: resolve(f.root, "children"), retireSession, ...(writeRegistry ? { writeRegistry } : {}),
    ...createSubagentRecoveryAccess({ service: f.service, privateRoots: async () => [resolve(f.root, "jobs"), resolve(f.root, "children")],
      hostAccess: () => ({ workspace: f.root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root: f.root }) }) }),
    ownerForReservation: (jobId) => ({ jobId, storeRoot: f.service.settings.stateDir }),
    resolveOwner: (identity) => f.service.resolveSubagentOwner!(identity),
  });
  f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
    verify: async (identity) => await (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) =>
    await (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication) });
  return { ...f, registry, instances: await registry.open(origin.conversationId) };
}

describe("parent stop", () => {
  it("parent stop cancels queued reservation without a provider call", async () => {
    const f = await managedFixture(undefined, { maxQueued: 1 }); const gate = deferred<any>();
    const run = vi.fn(() => gate.promise); const { agent, send } = tools(f, run);
    const first = await agent.execute("hold", { id: "holder", persist: true, background: true, prompt: "hold" });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      const queued = await agent.execute("queue", { id: "helper", persist: true, background: true, prompt: "queue" });
      const stopped = await send.execute("stop", { id: "helper", stop: true });
      expect(stopped.details.stop).toMatchObject({ status: "stopped", turns: 0, resumable: true, jobId: queued.details.jobId });
      expect(run).toHaveBeenCalledOnce();
      expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 0 });
      expect((await f.instances.get("helper"))?.recovery).toBeUndefined();
      await send.execute("close", { id: "helper", close: true });
    } finally { gate.resolve({ text: "done" }); await done(f.service, first.details.jobId); }
  }, 30_000);
  it("cooperative stop permits ordinary resume and close", async () => {
    const f = await managedFixture(); const entered = deferred<void>(); const sessions: string[] = [];
    const run = vi.fn(async (request: any) => {
      sessions.push(request.instance.sessionId);
      if (sessions.length === 1) { entered.resolve(); await new Promise<void>((resolve) => request.abortSignal.addEventListener("abort", () => resolve(), { once: true })); }
      return { text: "retained", subagentContinuity: { turnToken: request.turnToken, state: "retained" } };
    });
    const { agent, send } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    const results = await Promise.all([send.execute("stop", { id: "helper", stop: true }), send.execute("repeat", { id: "helper", stop: true })]);
    // Under package-wide compiler/crash-test contention, durable fsync can
    // exceed the public six-second limit. That must stay an honest incomplete
    // receipt, never a test-only expansion of the product deadline.
    for (const result of results) {
      if (result.details.stop.status === "stopped") expect(result.details.stop).toMatchObject({ resumable: true, childStillBusy: false, turns: 1 });
      else if (result.details.stop.status === "stop_requested") expect(result.details.stop).toMatchObject({ resumable: false, childStillBusy: true, stopRequested: true });
      else expect(result.details.stop).toMatchObject({ code: "subagent_stop_unavailable", stopRequested: expect.toBeOneOf([true, "unknown"]) });
    }
    await done(f.service, first.details.jobId);
    expect((await send.execute("idle", { id: "helper", stop: true })).details.stop.status).toBe("already_idle");
    const next = await send.execute("resume", { id: "helper", background: true, message: "next" }); await done(f.service, next.details.jobId);
    expect(sessions).toEqual([sessions[0], sessions[0]]);
    await send.execute("close", { id: "helper", close: true });
    expect(f.wake).toHaveBeenCalledTimes(2);
  }, 40_000);
  it("uncooperative stop retains capacity and returns childStillBusy; late settlement cannot finish a successor", async () => {
    const f = await managedFixture(); const gate = deferred<any>(); let request: any;
    const run = vi.fn(async (input: any) => { request = input; return gate.promise; }); const { agent, send } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    try {
      const stopped = await send.execute("stop", { id: "helper", stop: true });
      expect(stopped.details.stop).toMatchObject({ status: "stop_requested", childStillBusy: true, resumable: false });
      expect(await f.instances.get("helper")).toMatchObject({ status: "running", turns: 0 });
      expect((await f.store.get(first.details.jobId))?.subagentOwnership?.owner.settlement).toBe("running");
      await expect(send.execute("busy", { id: "helper", message: "next" })).rejects.toThrow("busy");
      await expect(send.execute("close", { id: "helper", close: true })).rejects.toThrow("busy");
      await expect(agent.execute("capacity", { id: "other", persist: true, background: true, prompt: "no" })).rejects.toThrow();
      gate.resolve({ text: "late", subagentContinuity: { turnToken: request.turnToken, state: "retained" } });
      await vi.waitFor(async () => { const record = await f.instances.get("helper"); expect(record).toMatchObject({ status: "idle", turns: 1 }); expect(record?.recoveryBlocked).not.toBe(true); }, { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      const successorGate = deferred<any>(); const successorTools = tools(f, async () => successorGate.promise);
      const successor = await successorTools.send.execute("resume", { id: "helper", background: true, message: "next" });
      await vi.waitFor(async () => expect(await f.instances.get("helper")).toMatchObject({ status: "running" }), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      await f.service.refreshSubagentOwner!({ storeRoot: f.service.settings.stateDir, jobId: first.details.jobId, conversationId: origin.conversationId, instanceId: "helper", instanceIncarnation: (await f.instances.get("helper"))!.incarnation!, turnToken: first.details.jobId });
      expect(await f.instances.get("helper")).toMatchObject({ status: "running", turns: 1, activeTurn: { token: successor.details.jobId } });
      successorGate.resolve({ text: "next" }); await done(f.service, successor.details.jobId);
    } finally { gate.resolve({ text: "cleanup" }); }
  }, 40_000);
  it("rearms a newer terminal publication when cancellation grace completes under an older publication", async () => {
    const f = await managedFixture(undefined, { maxRuntimeMs: 60_000 });
    const releaseUnknownConfirm = deferred<void>();
    const unknownConfirmHeld = deferred<void>();
    const releaseRetainedConfirm = deferred<void>();
    const retainedConfirmHeld = deferred<number>();
    let heldUnknown = false;
    let heldRetained = false;
    f.service.bindManagedSubagents!({
      root: resolve(f.root, "children"),
      verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (phase === "confirm" && !publication.released && publication.disposition.status === "cancelled") {
          if (!heldUnknown && publication.disposition.continuity === "unknown") {
            heldUnknown = true;
            unknownConfirmHeld.resolve();
            await releaseUnknownConfirm.promise;
          } else if (!heldRetained && publication.disposition.continuity === "retained") {
            heldRetained = true;
            retainedConfirmHeld.resolve(publication.sequence);
            await releaseRetainedConfirm.promise;
          }
        }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    const providerGate = deferred<any>();
    const providerEntered = deferred<void>();
    const providerAborted = deferred<void>();
    let request: any;
    const { agent, send } = tools(f, async (input: any) => {
      request = input;
      providerEntered.resolve();
      if (input.abortSignal.aborted) providerAborted.resolve();
      else input.abortSignal.addEventListener("abort", () => providerAborted.resolve(), { once: true });
      return await providerGate.promise;
    });

    vi.useFakeTimers();
    try {
      const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" });
      await providerEntered.promise;
      const stopping = send.execute("stop", { id: "helper", stop: true });
      await providerAborted.promise;
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await stopping).details.stop).toMatchObject({
        status: "stop_requested",
        childStillBusy: true,
        resumable: false,
      });
      await vi.advanceTimersByTimeAsync(1_100);
      await unknownConfirmHeld.promise;
      vi.useRealTimers();

      providerGate.resolve({ text: "late", subagentContinuity: { turnToken: request.turnToken, state: "retained" } });
      releaseUnknownConfirm.resolve();
      const retainedSequence = await retainedConfirmHeld.promise;
      await vi.waitFor(async () => {
        const record = await f.store.get(first.details.jobId);
        expect(record).toMatchObject({
          state: "cancelled",
          childStillBusy: true,
          subagentOwnership: {
            owner: { settlement: "settled" },
            disposition: { status: "cancelled", continuity: "retained", resumeAfterStop: true },
            publication: { state: "pending" },
          },
        });
        expect(record!.subagentOwnership!.publication.sequence).toBeGreaterThan(retainedSequence);
      }, { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      expect(await f.instances.get("helper")).toMatchObject({ status: "running", turns: 0 });
      expect(f.wake).not.toHaveBeenCalled();
      await expect(send.execute("busy", { id: "helper", message: "next" })).rejects.toThrow("busy");
      await expect(agent.execute("capacity", { id: "other", persist: true, background: true, prompt: "no" })).rejects.toThrow();

      releaseRetainedConfirm.resolve();
      await vi.waitFor(async () => expect((await f.store.get(first.details.jobId))?.subagentOwnership?.publication)
        .toMatchObject({ state: "confirmed", receiptPending: false }), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      expect(await done(f.service, first.details.jobId)).toMatchObject({ state: "cancelled", childStillBusy: false });
      const settledInstance = await f.instances.get("helper");
      expect(settledInstance).toMatchObject({ status: "idle", turns: 1 });
      expect(settledInstance?.recoveryBlocked).not.toBe(true);
      expect(f.wake).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      releaseUnknownConfirm.resolve();
      releaseRetainedConfirm.resolve();
      providerGate.resolve({ text: "cleanup" });
    }
  }, 40_000);
  it.each([false, true])("stop races completion and AskParent without fabricating cancellation (question=%s)", async (question) => {
    const f = await managedFixture(); const gate = deferred<any>(); const reached = deferred<void>(); const proceed = deferred<void>();
    const controllerDrained = deferred<void>(); const secondReadDrained = deferred<void>();
    const { agent, options } = tools(f, async () => gate.promise);
    const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" });
    const controller = options.backgroundSubagentController;
    // The public six-second race does not cancel its underlying operation. Track
    // the proof and final registry read so fixture removal never races late I/O.
    const originalGet = options.instances.get.bind(options.instances);
    let readCalls = 0;
    const instances = { ...options.instances, get: async (id: string) => {
      const call = ++readCalls;
      try { return await originalGet(id); }
      finally { if (call === 2) secondReadDrained.resolve(); }
    } };
    let observedProof: Awaited<ReturnType<NonNullable<typeof controller.stop>>> | undefined;
    let completionOrder = 0; let proofObservedAt = 0;
    const send = createAgentManageTool({ ...options, instances, backgroundSubagentController: { ...controller,
      stop: async (identity: any) => {
        reached.resolve();
        try {
          await proceed.promise;
          observedProof = await controller.stop!(identity);
          proofObservedAt = ++completionOrder;
          return observedProof;
        } finally { controllerDrained.resolve(); }
      } } });
    let stopping: ReturnType<typeof send.execute> | undefined;
    try {
      stopping = send.execute("stop", { id: "helper", stop: true }); await reached.promise;
      gate.resolve({ text: "completed first", ...(question ? { subagentQuestion: { question: "Choose scope?" } } : {}) });
      await done(f.service, started.details.jobId); proceed.resolve();
      const result = await stopping;
      const receiptObservedAt = ++completionOrder;
      await controllerDrained.promise;
      expect(observedProof).toMatchObject({ jobId: started.details.jobId, disposition: question ? "awaiting_reply" : "ok",
        stopRequested: false, childStillBusy: false, resumable: true });
      await secondReadDrained.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (result.details.stop.status === "stopped") {
        expect(result.details.stop).toMatchObject({ disposition: question ? "awaiting_reply" : "ok", stopRequested: false, resumable: true });
        expect(proofObservedAt).toBeLessThan(receiptObservedAt);
      } else {
        expect(result.details.stop).toMatchObject({ code: "subagent_stop_unavailable", stopRequested: expect.toBeOneOf(["unknown", false]) });
        if (result.details.stop.stopRequested === "unknown") expect(receiptObservedAt).toBeLessThan(proofObservedAt);
        else expect(proofObservedAt).toBeLessThan(receiptObservedAt);
      }
      expect((await send.execute("idle", { id: "helper", stop: true })).details.stop).toMatchObject({ status: "already_idle", disposition: question ? "awaiting_reply" : "ok", resumable: true });
      expect(await f.instances.get("helper")).toMatchObject({ turns: 1, status: question ? "awaiting_reply" : "idle" });
      expect(f.wake).toHaveBeenCalledOnce();
    } finally {
      gate.resolve({ text: "cleanup" });
      proceed.resolve();
      if (stopping) await Promise.allSettled([stopping, controllerDrained.promise]);
      if (observedProof) await secondReadDrained.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }, 30_000);
  it("publication failure and restart remain fenced until the exact stop certificate is acknowledged", async () => {
    const f = await managedFixture(); const entered = deferred<void>(); const root = resolve(f.root, "children");
    f.service.bindManagedSubagents!({ root,
      verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (phase === "confirm" && publication.released) throw new Error("injected publication failure");
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      } });
    const { agent, send } = tools(f, async (request: any) => { entered.resolve(); await new Promise<void>((resolve) => request.abortSignal.addEventListener("abort", () => resolve(), { once: true })); return { text: "partial", subagentContinuity: { turnToken: request.turnToken, state: "retained" } }; });
    const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    expect((await send.execute("stop", { id: "helper", stop: true })).details.stop).toMatchObject({ status: "stop_requested", resumable: false, childStillBusy: true });
    await expect(send.execute("resume", { id: "helper", message: "no" })).rejects.toThrow("busy");
    expect(f.wake).not.toHaveBeenCalled();
    await f.service.stop();
    const reopened = await openProcessJobsService(f.options); services.push(reopened);
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {},
      ownerForReservation: (jobId) => ({ jobId, storeRoot: reopened.settings.stateDir }),
      resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity),
      checkOwnerIndex: (conversationId, known) => reopened.checkSubagentOwnerIndex!(conversationId, known) });
    reopened.bindManagedSubagents!({ root,
      verify: async (identity) => await (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => await (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication) });
    await reopened.activateWakes(); await done(reopened, started.details.jobId);
    const instances = await registry.open(origin.conversationId);
    const record = await instances.get("helper"); expect(record).toMatchObject({ status: "idle", turns: 1 });
    expect(record?.recoveryBlocked).not.toBe(true); expect(record?.recovery).toBeUndefined();
    await instances.close("helper"); expect(f.wake).toHaveBeenCalledOnce();
  }, 20_000);
  it("parent stop cannot retroactively authorize an operator cancellation", async () => {
    const f = await managedFixture(); const gate = deferred<any>(); let request: any;
    const { agent, send } = tools(f, async (input: any) => { request = input; return gate.promise; });
    const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" });
    await vi.waitFor(() => expect(request).toBeDefined(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    await f.service.cancel(started.details.jobId);
    const stopping = send.execute("stop", { id: "helper", stop: true });
    gate.resolve({ text: "partial", subagentContinuity: { turnToken: request.turnToken, state: "retained" } });
    expect((await stopping).details.stop).toMatchObject({ code: "subagent_stop_recovery_required", stopRequested: false });
    expect((await f.store.get(started.details.jobId))?.subagentOwnership?.parentStopRequested).not.toBe(true);
    await expect(send.execute("resume", { id: "helper", message: "no" })).rejects.toThrow("subagent_recovery_required");
  }, 30_000);
  it("stop cannot cross conversation/incarnation", async () => {
    const f = await managedFixture(); const gate = deferred<any>(); const run = vi.fn(() => gate.promise); const { agent } = tools(f, run);
    const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" });
    const record = (await f.instances.get("helper"))!;
    try {
      const identity = { instanceId: record.id, instanceIncarnation: record.incarnation!, turnToken: started.details.jobId };
      await expect(f.service.internalController({ ...origin, conversationId: "other" }, 0).stop!(identity)).rejects.toMatchObject({ code: "subagent_stale_turn" });
      await expect(f.service.internalController(origin, 0).stop!({ ...identity, instanceIncarnation: randomUUID() })).rejects.toMatchObject({ code: "subagent_stale_turn" });
      expect((await f.store.get(started.details.jobId))?.cancelRequested).not.toBe(true);
    } finally { gate.resolve({ text: "done" }); await done(f.service, started.details.jobId); }
  }, 30_000);
  it.each([undefined, { turnToken: "wrong", state: "retained" }])("missing/mismatched recovery evidence never authorizes resume: %j", async (continuity) => {
    const f = await managedFixture(); const entered = deferred<void>();
    const { agent, send } = tools(f, async (request: any) => { entered.resolve(); await new Promise<void>((resolve) => request.abortSignal.addEventListener("abort", () => resolve(), { once: true })); return { cancelled: true, subagentContinuity: continuity }; });
    await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    expect((await send.execute("stop", { id: "helper", stop: true })).details.stop).toMatchObject({ code: "subagent_stop_recovery_required", stopRequested: true });
    await expect(send.execute("resume", { id: "helper", message: "next" })).rejects.toThrow("subagent_recovery_required");
  }, 15_000);
});

describe("parent steer", () => {
  const liveMailbox = (f: Awaited<ReturnType<typeof managedFixture>>): ReadonlyMap<string, unknown> =>
    (f.service as unknown as { readonly subagentLiveInput: ReadonlyMap<string, unknown> }).subagentLiveInput;

  it("steers a running detached turn and proves the text reached the child's turn", async () => {
    const f = await managedFixture(); const entered = deferred<void>(); const steered: string[] = [];
    const run = vi.fn(async (request: any) => {
      entered.resolve();
      const iterator = request.liveInput[Symbol.asyncIterator]();
      const next = await iterator.next();
      steered.push(next.value.body);
      expect(next.value.acknowledge()).toBe("recorded");
      return { text: `acted on: ${next.value.body}`, subagentContinuity: { turnToken: request.turnToken, state: "retained" } };
    });
    const { agent, send } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    const result = await send.execute("steer", { id: "helper", steer: "prefer the smaller diff" });
    expect(result.isError).toBeUndefined();
    expect(result.details.steer).toMatchObject({ instanceId: "helper", jobId: first.details.jobId, status: "applied", applied: true, delivery: "consumed" });
    const job = await done(f.service, first.details.jobId);
    expect(steered).toEqual(["prefer the smaller diff"]);
    expect(job.output.preview).toContain("acted on: prefer the smaller diff");
    // Every termination path must remove the mailbox, not merely close it.
    await vi.waitFor(() => expect(liveMailbox(f).size).toBe(0), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    const late = await f.service.internalController!(origin, 0).steer!(
      { instanceId: "helper", instanceIncarnation: (await f.instances.get("helper"))!.incarnation!, turnToken: first.details.jobId }, "too late");
    expect(late).toMatchObject({ jobId: first.details.jobId, delivery: "rejected", reason: "inactive" });
    expect((await send.execute("late", { id: "helper", steer: "too late" })).details.steer)
      .toMatchObject({ code: "subagent_steer_not_running", status: "not_applied", applied: false });
    await send.execute("close", { id: "helper", close: true });
  }, 20_000);

  it("reports pending when the child cannot read its mailbox within the bounded wait", async () => {
    const f = await managedFixture(); const entered = deferred<void>();
    const run = vi.fn(async (request: any) => { entered.resolve(); await new Promise<void>((resolve) => request.abortSignal.addEventListener("abort", () => resolve(), { once: true })); return { text: "cancelled" }; });
    const { agent, send } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    const result = await send.execute("steer", { id: "helper", steer: "look at the tests too" });
    expect(result.details.steer).toMatchObject({ status: "pending", applied: false, delivery: "offered", reason: "not_settled" });
    await send.execute("stop", { id: "helper", stop: true });
    await done(f.service, first.details.jobId);
    await vi.waitFor(() => expect(liveMailbox(f).size).toBe(0), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  }, 25_000);

  it.each([false, true])("reports unsupported whichever side of the offer observed it (offerFirst=%s)", async (offerFirst) => {
    const f = await managedFixture(); const entered = deferred<void>(); const gate = deferred<any>(); const offered = deferred<void>();
    const run = vi.fn(async (request: any) => {
      entered.resolve();
      // An accepted offer that is only later told the route cannot take live
      // input is the same fact as an upfront refusal, and must read the same.
      if (offerFirst) await offered.promise;
      request.liveInput.markUnsupported();
      return await gate.promise;
    });
    const { agent, send } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    try {
      const steering = send.execute("steer", { id: "helper", steer: "go" });
      offered.resolve();
      const result = await steering;
      expect(result.isError).toBeUndefined();
      expect(result.details.steer).toMatchObject({ status: "unsupported", applied: false, delivery: "unsupported", reason: "unsupported" });
    } finally { gate.resolve({ text: "done" }); await done(f.service, first.details.jobId); }
  }, 20_000);

  it("calls a settled turn inactive, not retryable, before its terminal state is persisted", async () => {
    const f = await managedFixture(); const entered = deferred<void>(); const gate = deferred<any>();
    const run = vi.fn(async () => { entered.resolve(); return await gate.promise; });
    const { agent } = tools(f, run);
    const first = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "first" }); await entered.promise;
    const identity = { instanceId: "helper", instanceIncarnation: (await f.instances.get("helper"))!.incarnation!, turnToken: first.details.jobId };
    const controller = f.service.internalController!(origin, 0);
    // Reproduce the window between the child's last breath and the durable
    // terminal record exactly: the mailbox is closed while the job record is
    // still running, which is where a missing entry would have lied.
    (f.service as unknown as { closeSubagentLiveInput(jobId: string): void }).closeSubagentLiveInput(first.details.jobId);
    expect(liveMailbox(f).has(first.details.jobId)).toBe(true);
    expect((await f.service.get(first.details.jobId))?.state).toBe("running");
    expect(await controller.steer!(identity, "too late")).toMatchObject({ jobId: first.details.jobId, delivery: "rejected", reason: "inactive" });
    gate.resolve({ text: "done" });
    await done(f.service, first.details.jobId);
    await vi.waitFor(() => expect(liveMailbox(f).size).toBe(0), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    // Once the entry is gone the started job still reads inactive, never not_started.
    expect(await controller.steer!(identity, "too late")).toMatchObject({ delivery: "rejected", reason: "inactive" });
  }, 20_000);

  it("refuses a queued turn that has no provider loop yet, and a foreground turn", async () => {
    const f = await managedFixture(undefined, { maxQueued: 1 }); const gate = deferred<any>();
    const run = vi.fn(() => gate.promise); const { agent, send } = tools(f, run);
    const first = await agent.execute("hold", { id: "holder", persist: true, background: true, prompt: "hold" });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      await agent.execute("queue", { id: "helper", persist: true, background: true, prompt: "queue" });
      expect((await send.execute("steer", { id: "helper", steer: "go" })).details.steer)
        .toMatchObject({ status: "not_applied", applied: false, delivery: "rejected", reason: "not_started" });
      await send.execute("drop", { id: "helper", stop: true });
    } finally { gate.resolve({ text: "done" }); await done(f.service, first.details.jobId); }
  }, 20_000);

  it("cannot reach a foreground child and admits steering in the envelope only with a controller", async () => {
    const f = await managedFixture(); const entered = deferred<void>(); const gate = deferred<any>();
    const run = vi.fn(async () => { entered.resolve(); return await gate.promise; });
    const { options, agent, send } = tools(f, run);
    const foreground = agent.execute("start", { id: "helper", persist: true, prompt: "first" }); await entered.promise;
    try {
      expect((await send.execute("steer", { id: "helper", steer: "go" })).details.steer)
        .toMatchObject({ code: "subagent_steer_foreground_unsupported", status: "not_applied", applied: false });
      expect(formatHostCapabilities({ subagents: options } as never)).toContain('"AgentManage.steer":{"available":true}');
      expect(formatHostCapabilities({ subagents: { instances: f.instances } } as never))
        .toContain('"AgentManage.steer":{"available":false,"reason":"controller_unavailable"}');
    } finally { gate.resolve({ text: "done" }); await foreground; }
  }, 20_000);
});

describe("managed detached production execution", () => {
  it("G05: failed admission after active intent remains fenced without starting the provider", async () => {
    const f = await managedFixture(); const run = vi.fn(async () => ({ text: "must not run" }));
    failMutationOnce(f, (records) => [...records.values()].some((record) => record.kind === "internal" && record.state === "queued"));
    const { agent, send } = tools(f, run);
    await expect(agent.execute("admission-write-fault", { persist: true, background: true, id: "helper", prompt: "work" }))
      .rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    expect(run).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
    expect(await f.instances.get("helper")).toMatchObject({ status: "queued" });
    await expect(send.execute("blocked-send", { id: "helper", message: "must not run", background: true })).rejects.toThrow();
    await expect(f.instances.close("helper")).rejects.toThrow(/busy/u);
    expect(run).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
  });

  it.each([
    { fault: "registry-reason-intent", ordering: "settled-before-stop" },
    { fault: "registry-reason-intent", ordering: "during-stop" },
    { fault: "job-reason-write", ordering: "settled-before-stop" },
  ] as const)("G05: $fault failure never exposes resumable idle or wakes before a durable reason ($ordering)", async ({ fault, ordering }) => {
    const f = await managedFixture(); const run = vi.fn(async () => { throw new Error("provider failed once"); });
    const reasonIntentEntered = deferred<void>(); const releaseReasonIntent = deferred<void>();
    const registryFailure = new Error("injected registry reason-intent failure");
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (phase === "intent" && publication.disposition.reason) {
          reasonIntentEntered.resolve();
          await releaseReasonIntent.promise;
          if (fault === "registry-reason-intent") throw registryFailure;
        }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    if (fault === "job-reason-write") {
      failMutationOnce(f, (records) => [...records.values()].some((record) => record.subagentOwnership?.disposition?.reason));
    }
    const { agent, send } = tools(f, run);
    let settlement: Promise<void> | undefined; let stopping: Promise<void> | undefined;
    try {
      const receipt = await agent.execute(`reason-write-${fault}`, { persist: true, background: true, id: "helper", prompt: "fail once" });
      await reasonIntentEntered.promise;
      settlement = processJobSettlement(f.service, receipt.details.jobId);
      expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
      const instance = await f.instances.get("helper");
      expect(instance).toMatchObject({ status: "running" });
      await expect(send.execute("blocked-after-reason-fault", { id: "helper", message: "must not rerun", background: true })).rejects.toThrow();
      await expect(f.instances.close("helper")).rejects.toThrow();
      expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
      const stored = await f.store.get(receipt.details.jobId).catch(() => undefined);
      if (stored) expect(stored.state).not.toBe("succeeded");

      if (ordering === "settled-before-stop") {
        releaseReasonIntent.resolve();
        await settlement;
        // Check the failure outcome, not only the deliberately held publication.
        expect(await f.instances.get("helper")).toMatchObject({ status: "running" });
        await expect(send.execute("blocked-after-settlement", { id: "helper", message: "must not rerun", background: true })).rejects.toThrow();
        await expect(f.instances.close("helper")).rejects.toThrow();
        expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
        const failed = await f.store.get(receipt.details.jobId).catch(() => undefined);
        if (failed) expect(failed.state).not.toBe("succeeded");
        stopping = f.service.stop();
        await expect(stopping).resolves.toBeUndefined();
      } else {
        stopping = f.service.stop();
        releaseReasonIntent.resolve();
        const stopError = await stopping.then(() => undefined, (error: unknown) => error);
        expect(stopError).toBeInstanceOf(AggregateError);
        expect((stopError as AggregateError).message).toBe("Process-job shutdown encountered failures.");
        expect((stopError as AggregateError).errors).toHaveLength(1);
        expect((stopError as AggregateError).errors[0]).toBe(registryFailure);
      }
      expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
    } finally {
      releaseReasonIntent.resolve();
      if (settlement) await Promise.allSettled([settlement]);
      if (stopping) {
        await Promise.allSettled([stopping]);
        const serviceIndex = services.indexOf(f.service);
        if (serviceIndex >= 0) services.splice(serviceIndex, 1);
      }
    }
  });

  it("G05: a late observation persistence failure degrades storage without changing the settled result or waking twice", async () => {
    const f = await managedFixture(); const run = vi.fn(async () => ({ text: "settled result" }));
    const receipt = await tools(f, run).agent.execute("observation-write-fault", { persist: true, background: true, id: "helper", prompt: "work" });
    await done(f.service, receipt.details.jobId);
    const privateJob = (await f.store.get(receipt.details.jobId))!; const owner = privateJob.subagentOwnership!;
    const identity = { storeRoot: f.store.stateDir, jobId: privateJob.jobId, conversationId: origin.conversationId,
      instanceId: "helper", instanceIncarnation: owner.instanceIncarnation, turnToken: owner.turnToken };
    const privatePath = "PRIVATE-LATE-OBSERVATION";
    failMutationOnce(f, (records) => records.get(privateJob.jobId)?.subagentObservation?.paths[0]?.path === privatePath);
    await expect(f.service.recordSubagentObservation!(identity, { schemaVersion: 1, capturedAt: Date.now(), policyRevision: "ab".repeat(32),
      status: "observed", workdir: f.root, headBefore: "a".repeat(40), headAfter: "a".repeat(40),
      paths: [{ path: privatePath, status: "untracked" }], omitted: 0 })).rejects.toThrow("injected persistence failure");
    expect(f.service.health.state).toBe("degraded");
    expect((await f.store.get(privateJob.jobId))?.subagentObservation).toBeUndefined();
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 1 });
    expect(run).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce();
    await f.service.stop().catch(() => undefined); services.splice(services.indexOf(f.service), 1);
  });

  it.each(["ok", "failed"])("G11: actual managed %s job and delivered wake omit private command/observation canaries", async (mode) => {
    const f = await managedFixture(); const release = deferred<void>(); const entered = deferred<void>();
    const privatePath = "PRIVATE-OBSERVATION-CANARY"; const body = "PRIVATE-REPORT-BODY-CANARY"; const pid = 991827364;
    await writeFile(resolve(f.root, "report.txt"), body);
    const run = vi.fn(async () => { entered.resolve(); await release.promise; return mode === "ok" ? { text: "public answer" } : { error: "public failure" }; });
    try {
      const receipt = await tools(f, run).agent.execute("privacy", { id: "helper", persist: true, background: true, prompt: "public task" });
      await entered.promise;
      // Valid synthetic private facts on a real admitted job, not a process proof.
      // Released command metadata cannot create a live PID/signalling obligation.
      await f.store.mutate((records) => {
        const owner = records.get(receipt.details.jobId)!.subagentOwnership!;
        owner.command = { id: randomUUID(), callKey: "private-canary-call", tool: "Exec", state: "released", cwd: f.root,
          sandboxSettingsPath: resolve(f.root, "mono-agent-srt-settings-PRIVATE-SANDBOX-CANARY", "settings.json"), pid, pgid: pid,
          incarnation: { schema: "mono-agent.process-incarnation.v1", bootSessionId: "synthetic-boot", processStartId: "synthetic-birth" }, deadlineAt: Date.now() };
        owner.seenCalls.push(owner.command.callKey);
        records.get(receipt.details.jobId)!.subagentObservation = { schemaVersion: 1, capturedAt: Date.now(), policyRevision: "ab".repeat(32), status: "observed",
          workdir: f.root, headBefore: "a".repeat(40), headAfter: "a".repeat(40), paths: [{ path: privatePath, status: "untracked" }], omitted: 0,
          report: { path: "report.txt", present: true } };
      });
      release.resolve(); const job = await done(f.service, receipt.details.jobId);
      expect(job.state).toBe(mode === "ok" ? "succeeded" : "failed");
      const privateJob = await f.store.get(receipt.details.jobId);
      expect(privateJob?.subagentOwnership?.command?.pid).toBe(pid);
      expect(privateJob?.subagentObservation?.paths?.[0]?.path).toBe(privatePath);
      expect(f.wake).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
      for (const projection of [receipt, job, f.wake.mock.calls[0]]) {
        const encoded = JSON.stringify(projection);
        for (const canary of [f.root, privatePath, body, String(pid), "PRIVATE-SANDBOX-CANARY", "synthetic-birth"])
          expect(encoded).not.toContain(canary);
      }
    } finally { release.resolve(); }
  });

  it("G01: drains an entered registry transaction before transferring the owner lock", async () => {
    const provider = deferred<any>(); const entered = deferred<void>(); const release = deferred<void>();
    let armed = false; let blocked = false; let stopped = false; let writesAfterStop = 0;
    const f = await managedFixture(undefined, {}, true, async (...args) => {
      if (armed && !blocked) { blocked = true; entered.resolve(); await release.promise; }
      if (stopped) writesAfterStop++;
      await writeJsonAtomic(...args);
    });
    const ownerLock = (f.service as unknown as { lock: { release(): Promise<void> } }).lock;
    const releaseOwner = vi.spyOn(ownerLock, "release");
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (publication.released && phase === "intent") armed = true;
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    const run = vi.fn(() => provider.promise);
    let shutdown: Promise<void> | undefined;
    try {
      const receipt = await tools(f, run, { timeoutMs: 1500 }).agent.execute("entered-publication", { persist: true, background: true, id: "helper", prompt: "work" });
      await vi.waitFor(async () => expect((await f.service.get(receipt.details.jobId))?.wake.state).toBe("delivered"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      provider.resolve({ text: "late settlement starts publication" });
      await entered.promise; // Real registry transaction owns its lock and is at its actual write boundary.
      shutdown = f.service.stop().then(() => { stopped = true; });
      await vi.waitFor(() => expect((f.service as unknown as { managedWritesClosed: boolean }).managedWritesClosed).toBe(true), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      expect((f.service as unknown as { managedPublicationRearmPending: Set<string> }).managedPublicationRearmPending.size).toBe(0);
      expect(releaseOwner, "entered registry I/O must finish before owner-lock release").not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      await expect(openProcessJobsService(f.options)).rejects.toMatchObject({ code: "process_job_controller_unavailable" });
      release.resolve(); await shutdown;
      expect(releaseOwner).toHaveBeenCalledOnce(); expect(writesAfterStop).toBe(0);
      expect(run).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce();
      // The incomplete publication stays recoverable; do not drop P to make shutdown pass.
      expect((await f.store.get(receipt.details.jobId))?.subagentOwnership).toMatchObject({ owner: { settlement: "settled" }, publication: { state: "pending" } });
    } finally { release.resolve(); provider.resolve({ text: "cleanup" }); await shutdown; }
  }, 25_000);

  it.each(["retained", "job-removed", "registry-removed", "degraded"])("G01/G04/G06: live managed provider cannot regain write authority after same-process reopen (%s)", async (mode) => {
    let oldServiceStopped = false; let writesAfterStop = 0;
    // Count only the original service-bound registry writer. The reopened registry
    // and test observations below use separate capabilities, not this callback.
    const f = await managedFixture(undefined, {}, true, async (...args) => { if (oldServiceStopped) writesAfterStop++; await writeJsonAtomic(...args); });
    const provider = deferred<any>(); const observed = deferred<void>(); const reported = deferred<void>();
    const controller = f.service.internalController(origin, 0);
    let settlementError: unknown;
    const backgroundSubagentController = { ...controller,
      startInternal: (request: Parameters<typeof controller.startInternal>[0]) => controller.startInternal({ ...request,
        run: async (signal, output, progress, execution) => {
          if (!execution?.managed) throw new Error("Expected actual managed execution");
          const managed = execution.managed;
          try { return await request.run(signal, output, progress, { ...execution, managed: { ...managed,
            settled: async (outcome) => {
              try { await managed.settled(outcome); } catch (error) { settlementError = error; throw error; }
              finally { observed.resolve(); }
            },
          } }); } finally { reported.resolve(); }
        },
      }),
    };
    let providerSignal: AbortSignal | undefined; let providerReturned = false;
    const run = vi.fn(async (request: { abortSignal?: AbortSignal }) => { providerSignal = request.abortSignal; const result = await provider.promise; providerReturned = true; return result; });
    const { agent } = tools(f, run, { backgroundSubagentController });
    try {
      const receipt = await agent.execute("live-owner", { persist: true, background: true, id: "helper", prompt: "ignore abort until explicitly released" });
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      // Default real owner-private lifetime lock, not fixture's no-op lock.
      await expect(openProcessJobsService(f.options)).rejects.toMatchObject({ code: "process_job_controller_unavailable" });
      if (mode === "degraded") {
        // Cross the real store serialization boundary before replacing its
        // transaction-file path with the fault-injection directory. Waiting
        // only for provider entry races admission's final durable mutations.
        await f.store.mutate(() => undefined);
        const journal = resolve(f.store.stateDir, PROCESS_JOB_TRANSACTION_FILE); await mkdir(journal);
        await expect(f.store.mutate((records) => { records.get(receipt.details.jobId)!.cancelRequested = true; })).rejects.toThrow();
        await expect(f.service.stop()).rejects.toThrow("Process-job shutdown encountered failures");
        services.splice(services.indexOf(f.service), 1); await rm(journal, { recursive: true });
      } else await f.service.stop();
      await reported.promise; // Reporting frame is separate from the still-live provider.
      expect(providerSignal?.aborted).toBe(true); expect(providerReturned).toBe(false);
      oldServiceStopped = true;
      const registryRoot = resolve(f.root, "children");
      const registryFile = resolve(subagentConversationRoot(registryRoot, origin.conversationId), "instances.json");
      const store = await openProcessJobStore(f.root, f.store.stateDir);
      if (mode === "job-removed") await store.mutate((records) => { records.delete(receipt.details.jobId); });
      if (mode === "registry-removed") await rm(registryFile);
      const reopened = await openProcessJobsService({ ...f.options, store }); services.push(reopened);
      const registry = createSubagentInstanceRegistry({ root: registryRoot, retireSession: async () => {},
        resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity),
        checkOwnerIndex: (conversationId, known) => reopened.checkSubagentOwnerIndex!(conversationId, known),
      });
      reopened.bindManagedSubagents!({ root: registryRoot,
        verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
        publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
      });
      const instances = await registry.open(origin.conversationId);
      if (mode === "registry-removed") {
        expect(writesAfterStop, "old registry writer invoked after service stop and reporting settlement").toBe(0);
        expect(await instances.list()).toEqual([]);
        expect(await reopened.checkSubagentOwnerIndex!(origin.conversationId, [])).toBe("held");
        const deniedRun = vi.fn(); const fresh = tools({ ...f, service: reopened, instances }, deniedRun);
        for (const id of ["helper", "replacement"]) await expect(fresh.agent.execute(`reset-${id}`, { persist: true, background: true, id, prompt: "must not run" })).rejects.toThrow("subagent_ownership_held");
        expect(deniedRun).not.toHaveBeenCalled(); expect(await instances.list()).toEqual([]);
        expect(await reopened.checkSubagentOwnerIndex!(origin.conversationId, [])).toBe("held");
      } else if (mode !== "job-removed") {
        await reopened.activateWakes(); await done(reopened, receipt.details.jobId);
        await expect(reopened.internalController(origin, 0).startInternal({ kind: "internal", tool: "Agent", jobId: randomUUID(), instanceId: "blocked", run: async () => ({ status: "ok", output: "must not run" }), cleanup: async () => {} })).rejects.toThrow();
      }
      if (mode !== "job-removed") expect((await store.get(receipt.details.jobId))?.subagentOwnership?.owner.settlement).toBe("unknown");
      const before = await store.get(receipt.details.jobId); const registryBefore = await readFile(registryFile, "utf8"); const wakes = f.wake.mock.calls.length;
      const artifactFiles = ["stdout.log", "stderr.log"].map((name) => resolve(store.artifactsDir, receipt.details.jobId, name));
      const artifactsBefore = await Promise.all(artifactFiles.map((path) => readFile(path, "utf8")));
      const oldWrites = vi.spyOn(f.store, "mutate"); oldWrites.mockClear();
      provider.resolve({ text: "late success must never release or recreate", usage: { input_tokens: 99 } });
      await observed.promise; // Actual old managed.settled callback has returned/rejected.
      expect(settlementError).toBeInstanceOf(Error); expect(String(settlementError)).toContain("ownership ended");
      expect(oldWrites).not.toHaveBeenCalled();
      expect(writesAfterStop, "closed original registry writer must remain idle after late settlement").toBe(0);
      expect(await store.get(receipt.details.jobId)).toEqual(before);
      expect(await readFile(registryFile, "utf8")).toBe(registryBefore);
      expect(await Promise.all(artifactFiles.map((path) => readFile(path, "utf8")))).toEqual(artifactsBefore);
      expect(f.wake).toHaveBeenCalledTimes(wakes); expect(run).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
      if (mode !== "job-removed") {
        await store.applyRetention({ ...reopened.settings, retention: { ...reopened.settings.retention, maxAgeMs: 1 } }, new Date(Date.now() + 3 * 86_400_000));
        expect(await store.get(receipt.details.jobId)).toBeDefined();
      }
    } finally {
      await f.service.stop().catch(() => {});
      if (services.includes(f.service)) services.splice(services.indexOf(f.service), 1);
      provider.resolve({ text: "fixture cleanup" });
      if (run.mock.calls.length) await Promise.all([observed.promise, reported.promise]);
    }
  }, 18_000);

  it.each(["changed-root", "missing-job", "registry-reset"])("G03/G04: actual managed certificate remains fenced after %s without recreating historical state", async (mode) => {
    const f = await managedFixture(undefined, {}, true); const root = resolve(f.root, "children"); let held = false;
    let identity: import("../subagent-registry-ownership.js").SubagentOwnerIdentity | undefined;
    f.service.bindManagedSubagents!({ root,
      verify: async (owner) => (await f.registry.open(owner.conversationId, { existingOnly: true })).verifyOwner(owner),
      publish: async (phase, publication) => {
        identity = publication.identity;
        if (phase === "finalize") { held = true; throw new Error("hold settled certificate before durable finalization"); }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    const run = vi.fn(async () => ({ text: "settled once, not an authority bypass" }));
    const receipt = await tools(f, run).agent.execute("old-store", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 });
    expect((await f.store.get(receipt.details.jobId))?.subagentOwnership).toMatchObject({ owner: { settlement: "settled" }, publication: { receiptPending: true } });
    await f.service.stop();
    const stateDir = mode === "changed-root" ? resolve(f.root, "new-jobs") : f.store.stateDir;
    if (mode === "changed-root") await rename(f.store.stateDir, resolve(f.root, "historical-jobs"));
    const store = await openProcessJobStore(f.root, stateDir);
    if (mode === "missing-job") await store.mutate((records) => { records.delete(receipt.details.jobId); });
    if (mode === "registry-reset") await rm(resolve(subagentConversationRoot(root, origin.conversationId), "instances.json"));
    const reopened = await openProcessJobsService({ ...f.options, store, settings: { ...f.options.settings, stateDir } }); services.push(reopened);
    const resolveOwner = vi.fn((owner: import("../subagent-registry-ownership.js").SubagentOwnerIdentity) => reopened.resolveSubagentOwner!(owner));
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {}, now: () => Date.now() + 3 * 86_400_000,
      resolveOwner, checkOwnerIndex: (conversationId, known) => reopened.checkSubagentOwnerIndex!(conversationId, known),
    });
    reopened.bindManagedSubagents!({ root,
      verify: async (owner) => (await registry.open(owner.conversationId, { existingOnly: true })).verifyOwner(owner),
      publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
    if (mode === "registry-reset") {
      expect(await reopened.resolveSubagentOwner!(identity!)).toMatchObject({ state: "released", receiptPending: true });
      const instances = await registry.open(origin.conversationId);
      const denied = vi.fn(); const next = tools({ ...f, instances, service: reopened }, denied);
      for (const id of ["helper", "replacement"]) await expect(next.agent.execute(`reset-${id}`, { id, persist: true, background: true, prompt: "must not run" })).rejects.toThrow("subagent_ownership_held");
      expect(await instances.list()).toEqual([]); expect(denied).not.toHaveBeenCalled();
      expect((await store.get(receipt.details.jobId))?.subagentOwnership).toMatchObject({ owner: { settlement: "settled" }, publication: { receiptPending: true } });
      expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
      return;
    }
    expect(await reopened.resolveSubagentOwner!(identity!)).toEqual({ state: "unavailable" });
    const instances = await registry.open(origin.conversationId, { existingOnly: true });
    const denied = vi.fn(); const next = tools({ ...f, instances, service: reopened }, denied);
    await expect(instances.begin("helper")).rejects.toThrow("subagent_owner_unavailable");
    await expect(instances.reserve("helper", randomUUID())).rejects.toThrow("subagent_owner_unavailable");
    await expect(next.send.execute("close", { id: "helper", close: true })).rejects.toThrow("subagent_owner_unavailable");
    await expect(next.send.execute("continue", { id: "helper", message: "must not run", background: true })).rejects.toThrow("subagent_owner_unavailable");
    await expect(next.agent.execute("replace", { id: "replacement", persist: true, background: true, prompt: "must not run" })).rejects.toThrow("subagent_owner_unavailable");
    expect(resolveOwner).toHaveBeenCalledWith(identity);
    expect(await instances.get("helper")).toMatchObject({ status: "idle", incarnation: identity!.instanceIncarnation });
    expect(await store.list()).toEqual([]); expect(denied).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
    if (mode === "changed-root") await expect(stat(f.store.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("G03: a corrupt matching job keeps the retained registry certificate fenced without opening a fallback root", async () => {
    const f = await managedFixture(undefined, {}, true); const root = resolve(f.root, "children"); let held = false;
    f.service.bindManagedSubagents!({ root,
      verify: async (owner) => (await f.registry.open(owner.conversationId, { existingOnly: true })).verifyOwner(owner),
      publish: async (phase, publication) => {
        if (phase === "finalize") { held = true; throw new Error("retain unacknowledged certificate"); }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    const run = vi.fn(async () => ({ text: "settled once" }));
    const receipt = await tools(f, run).agent.execute("corrupt-owner", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 }); await f.service.stop();
    services.splice(services.indexOf(f.service), 1);
    const recordPath = resolve(f.store.recordsDir, `${receipt.details.jobId}.json`);
    await writeFile(recordPath, "{\"schemaVersion\":1,\"corrupt\":true}\n", { mode: 0o600 });
    await expect(openProcessJobStore(f.root, f.store.stateDir)).rejects.toThrow();
    const fallbackRoot = resolve(f.root, "fallback-jobs"); const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {},
      resolveOwner: async () => ({ state: "unavailable" }), checkOwnerIndex: async () => "unavailable" });
    const instances = await registry.open(origin.conversationId, { existingOnly: true });
    await expect(instances.begin("helper")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(instances.reserve("helper", randomUUID())).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(instances.close("helper")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(instances.create({ ...spec, id: "replacement" })).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    expect(await instances.get("helper")).toMatchObject({ status: "idle", recoveryBlocked: true });
    expect(run).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled(); await expect(stat(fallbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it.each(["ordinary", "late-provider"])("F1: drains queued managed work after %s publication releases capacity", async (mode) => {
    const f = await managedFixture(undefined, { maxQueued: 1, maxActivePerConversation: 3, maxQueueAgeMs: 10_000 });
    const gate = deferred<any>(); const firstRun = vi.fn(() => gate.promise);
    const first = tools(f, firstRun, { timeoutMs: mode === "ordinary" ? 20_000 : 1500 });
    const nextRun = vi.fn(async () => ({ text: "queued child actually ran" }));
    const next = tools(f, nextRun, { timeoutMs: 20_000 });
    // A reported failure correctly blocks creating arbitrary replacement instances;
    // this independently existing idle child still has its own admission authority.
    if (mode === "late-provider") await f.instances.create({ ...spec, id: "second" });
    try {
      const a = await first.agent.execute("A", { persist: true, background: true, id: "first", prompt: "hold" });
      await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      if (mode === "late-provider") {
        // The reporting boundary includes its existing bounded abandonment grace.
        await vi.waitFor(async () => expect((await f.service.get(a.details.jobId))?.wake.state).toBe("delivered"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
        expect((await f.service.get(a.details.jobId))?.state).toBe("timed_out");
        expect((await f.store.get(a.details.jobId))?.subagentOwnership?.owner.settlement).toBe("running");
      }
      const b = mode === "late-provider"
        ? await next.send.execute("B", { background: true, id: "second", message: "queued" })
        : await next.agent.execute("B", { persist: true, background: true, id: "second", prompt: "queued" });
      expect((await f.service.get(b.details.jobId))?.state).toBe("queued"); expect(nextRun).not.toHaveBeenCalled();
      gate.resolve({ text: "first finished" });
      await vi.waitFor(async () => {
        const owner = (await f.store.get(a.details.jobId))?.subagentOwnership;
        expect(owner).toMatchObject({ owner: { settlement: "settled" }, publication: { state: "confirmed" } });
      }, { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
      const completed = await done(f.service, b.details.jobId);
      expect(completed.state).toBe("succeeded"); expect(nextRun).toHaveBeenCalledOnce();
      expect((await f.service.get(a.details.jobId))?.state).toBe(mode === "ordinary" ? "succeeded" : "timed_out");
      expect(f.wake).toHaveBeenCalledTimes(2); // Late release adds no second wake for A.
    } finally { gate.resolve({ text: "cleanup" }); }
  }, 55_000);

  it.each(["before-write", "after-write-lost-ack"])("F2 crash boundary %s pins delivered jobs through reopen-before-bind retention", async (fault) => {
    const f = await managedFixture(); const provider = deferred<any>(); let intercepted = false;
    let lastPublication: import("../subagent-managed-turn.js").SubagentRegistryPublication | undefined;
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        const instances = await f.registry.open(publication.identity.conversationId, { existingOnly: true });
        if (phase === "finalize") {
          lastPublication = publication;
          if (fault === "after-write-lost-ack") await instances.publishOwned(phase, publication);
          intercepted = true; throw new Error("injected certificate acknowledgement crash boundary");
        }
        await instances.publishOwned(phase, publication);
      },
    });
    const run = vi.fn(() => provider.promise);
    const { agent } = tools(f, run, { timeoutMs: 1500 });
    const receipt = await agent.execute("certificate-fault", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    await vi.waitFor(async () => expect((await f.service.get(receipt.details.jobId))?.wake.state).toBe("delivered"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    provider.resolve({ text: "late completion" });
    await vi.waitFor(() => expect(intercepted).toBe(true), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    const registryFile = resolve(subagentConversationRoot(resolve(f.root, "children"), origin.conversationId), "instances.json");
    expect(JSON.parse(await readFile(registryFile, "utf8"))[0].ownerReceipt.finalized).toBe(fault === "after-write-lost-ack");
    expect(await f.store.get(receipt.details.jobId)).toMatchObject({ wake: { state: "delivered" },
      subagentOwnership: { publication: { state: "confirmed", receiptPending: true } } });
    if (fault === "after-write-lost-ack") {
      // A durable certificate cannot be overwritten while its exact job ack is held.
      await expect(f.instances.begin("helper")).rejects.toThrow("subagent_owner_unavailable");
      await expect(f.instances.create({ ...spec, id: "bypass" })).rejects.toThrow("subagent_owner_unavailable");
    }
    await f.service.stop();
    const reopened = await openProcessJobsService({ ...f.options, now: () => new Date(Date.now() + 10_000),
      settings: { ...f.options.settings, retention: { ...PROCESS_JOBS_DEFAULTS.retention, maxAgeMs: 1 } },
    }); services.push(reopened);
    expect(await f.store.get(receipt.details.jobId)).toMatchObject({ subagentOwnership: { publication: { receiptPending: true } } });
    const registry = createSubagentInstanceRegistry({ root: resolve(f.root, "children"), retireSession: async () => {},
      resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity),
    });
    reopened.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
    await vi.waitFor(async () => expect((await f.store.get(receipt.details.jobId))?.subagentOwnership?.publication.receiptPending).toBe(false), { timeout: 5000 });
    expect(JSON.parse(await readFile(registryFile, "utf8"))[0].ownerReceipt.finalized).toBe(true);
    const instances = await registry.open(origin.conversationId, { existingOnly: true });
    for (const invalid of [
      { ...lastPublication!, sequence: lastPublication!.sequence + 1 },
      { ...lastPublication!, identity: { ...lastPublication!.identity, storeRoot: resolve(f.root, "wrong-store") } },
      { ...lastPublication!, identity: { ...lastPublication!.identity, turnToken: randomUUID() } },
    ]) await expect(instances.publishOwned("finalize", invalid)).rejects.toThrow("subagent_stale_turn");
    await f.store.applyRetention(reopened.settings, new Date(Date.now() + 10_000)); expect(await f.store.get(receipt.details.jobId)).toBeUndefined();
    await instances.close("helper");
    const replacement = await instances.create(spec);
    expect(replacement.incarnation).not.toBe(lastPublication!.identity.instanceIncarnation);
    await expect(instances.publishOwned("finalize", lastPublication!)).rejects.toThrow("subagent_stale_turn");
    expect((await instances.get("helper"))?.incarnation).toBe(replacement.incarnation);
    expect(f.wake).toHaveBeenCalledOnce();
  }, 40_000);

  it.each(["absent", "stopped"])("F3: lost certificate acknowledgement survives %s service close and registry retention", async (resolver) => {
    const f = await managedFixture(); let intercepted = false;
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
        if (phase === "finalize") { intercepted = true; throw new Error("lost certificate acknowledgement"); }
      },
    });
    const run = vi.fn(async () => ({ text: "settled once" }));
    const { agent } = tools(f, run);
    const receipt = await agent.execute("F3", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(intercepted).toBe(true), { timeout: 5000 });
    await f.service.stop();
    const root = resolve(f.root, "children"); let clock = Date.now();
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {}, now: () => clock,
      ...(resolver === "stopped" ? { resolveOwner: (identity: import("../subagent-registry-ownership.js").SubagentOwnerIdentity) => f.service.resolveSubagentOwner!(identity) } : {}),
    });
    const unavailable = await registry.open(origin.conversationId, { existingOnly: true });
    await expect(unavailable.close("helper")).rejects.toThrow("subagent_owner_unavailable");
    clock += 3 * 86_400_000;
    expect(await unavailable.get("helper")).toBeDefined();
    const reopened = await openProcessJobsService(f.options); services.push(reopened);
    const recoveredRegistry = createSubagentInstanceRegistry({ root, retireSession: async () => {}, resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity) });
    reopened.bindManagedSubagents!({ root,
      verify: async (identity) => (await recoveredRegistry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => (await recoveredRegistry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
    await vi.waitFor(async () => expect((await f.store.get(receipt.details.jobId))?.subagentOwnership?.publication.receiptPending).toBe(false), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    await reopened.activateWakes(); await done(reopened, receipt.details.jobId);
    await f.store.applyRetention({ ...reopened.settings, retention: { ...reopened.settings.retention, maxAgeMs: 1 } }, new Date(Date.now() + 10_000));
    expect(await f.store.get(receipt.details.jobId)).toBeUndefined();
    await reopened.stop();
    // A positively acknowledged certificate remains usable without the job/service.
    const offline = await createSubagentInstanceRegistry({ root, retireSession: async () => {} }).open(origin.conversationId);
    await expect(offline.close("helper")).resolves.toMatchObject({ status: "closed" });
    expect(run).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce();
  }, 40_000);

  it.each(["finalize", "acknowledge"] as const)("F3: actual %s-following journal write failure degrades service without losing release evidence", async (faultPhase) => {
    const f = await managedFixture(); const root = resolve(f.root, "children");
    const journal = resolve(f.store.stateDir, PROCESS_JOB_TRANSACTION_FILE); let injected = false;
    f.service.bindManagedSubagents!({ root,
      verify: async (identity) => (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
        if (phase === faultPhase && !injected) {
          // A real filesystem type collision rejects the next atomic journal write;
          // no mocked store rejection or registry exception establishes degradation.
          await mkdir(journal); injected = true;
        }
      },
    });
    const run = vi.fn(async () => ({ text: "one settled result" }));
    const receipt = await tools(f, run).agent.execute("disk-fault", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(f.service.health.state).toBe("degraded"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    expect(injected).toBe(true);
    await expect(f.service.stop()).rejects.toThrow("Process-job shutdown encountered failures");
    services.splice(services.indexOf(f.service), 1); // The stopped service retains its rejected shutdown promise.
    await rm(journal, { recursive: true });
    let clock = Date.now();
    const offline = await createSubagentInstanceRegistry({ root, retireSession: async () => {}, now: () => clock }).open(origin.conversationId);
    if (faultPhase === "finalize") await expect(offline.close("helper")).rejects.toThrow("subagent_owner_unavailable");
    else await expect(offline.close("helper")).resolves.toMatchObject({ status: "closed" });
    clock += 3 * 86_400_000;
    expect(await offline.get("helper")).toEqual(faultPhase === "acknowledge" ? undefined : expect.any(Object));
    const store = await openProcessJobStore(f.root, f.store.stateDir);
    expect(await store.get(receipt.details.jobId)).toMatchObject({ subagentOwnership: { publication: { receiptPending: true } } });
    const reopened = await openProcessJobsService({ ...f.options, store }); services.push(reopened);
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {}, resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity) });
    if (faultPhase === "acknowledge") {
      const held = (await store.get(receipt.details.jobId))!; const owner = held.subagentOwnership!;
      expect(owner.publication.receiptRecorded).toBe(owner.publication.sequence);
      const publication = { identity: { storeRoot: f.store.stateDir, jobId: held.jobId, conversationId: origin.conversationId,
        instanceId: "helper", instanceIncarnation: owner.instanceIncarnation, turnToken: owner.turnToken },
        sequence: owner.publication.sequence, disposition: owner.disposition!, released: true };
      const empty = await registry.open(origin.conversationId, { existingOnly: true });
      for (const invalid of [
        { ...publication, sequence: publication.sequence + 1 },
        { ...publication, identity: { ...publication.identity, storeRoot: resolve(f.root, "wrong") } },
        { ...publication, identity: { ...publication.identity, turnToken: randomUUID() } },
        { ...publication, identity: { ...publication.identity, instanceIncarnation: randomUUID() } },
      ]) await expect(empty.publishOwned("acknowledge", invalid)).rejects.toThrow("subagent_owner_unavailable");
      expect((await store.get(held.jobId))?.subagentOwnership?.publication.receiptPending).toBe(true);
    }
    reopened.bindManagedSubagents!({ root,
      verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
    await vi.waitFor(async () => expect((await store.get(receipt.details.jobId))?.subagentOwnership?.publication.receiptPending).toBe(false), { timeout: 5000 });
    await reopened.activateWakes(); expect((await done(reopened, receipt.details.jobId)).state).toBe("succeeded");
    expect(run).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledOnce();
  }, 45_000);

  it("F2: retains a durable release certificate through startup retention without an intervening registry read", async () => {
    const f = await managedFixture();
    const { agent } = tools(f, async () => ({ text: "done without a registry-reading wake" }));
    const receipt = await agent.execute("retention", { persist: true, background: true, id: "helper", prompt: "work" });
    await done(f.service, receipt.details.jobId);
    // done() reads only the service projection. The wake callback never reads
    // instances; do not let get/list opportunistically repair this certificate.
    const registryFile = resolve(subagentConversationRoot(resolve(f.root, "children"), origin.conversationId), "instances.json");
    const before = JSON.parse(await readFile(registryFile, "utf8"));
    expect(before[0].ownerReceipt).toMatchObject({ jobId: receipt.details.jobId });
    await f.service.stop();
    const reopened = await openProcessJobsService({ ...f.options,
      now: () => new Date(Date.now() + 10_000),
      settings: { ...f.options.settings, retention: { ...PROCESS_JOBS_DEFAULTS.retention, maxAgeMs: 1 } },
    }); services.push(reopened);
    expect(await f.store.get(receipt.details.jobId)).toBeUndefined(); // Startup retained no U/P obligation.
    const registry = createSubagentInstanceRegistry({ root: resolve(f.root, "children"), retireSession: async () => {},
      resolveOwner: (identity) => reopened.resolveSubagentOwner!(identity),
    });
    const instances = await registry.open(origin.conversationId, { existingOnly: true });
    await expect(instances.create({ ...spec, id: "after-retention" })).resolves.toMatchObject({ id: "after-retention" });
  }, 30_000);

  it.each([false, true])("inspects retained failure and consumes acknowledgement exactly once (admissionRejected=%s)", async (admissionRejected) => {
    const f = await managedFixture(); const release = deferred<void>(); let delayed = false;
    const sessions: string[] = [];
    const run = vi.fn(async (request: any) => { sessions.push(request.instance.sessionId); return { text: "clean durable result" }; });
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (!delayed && phase === "confirm" && !publication.released && publication.disposition.status === "ok") { delayed = true; await release.promise; }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    const { agent, send } = tools(f, run, { timeoutMs: 3000 });
    try {
      const original = await agent.execute("retained", { persist: true, background: true, id: "helper", prompt: "first" });
      await vi.waitFor(async () => expect((await f.store.get(original.details.jobId))?.subagentOwnership?.disposition).toMatchObject({ reason: "timeout", continuity: "retained" }), { timeout: 12_000 });
      release.resolve(); await done(f.service, original.details.jobId);
      await expect(send.execute("unacknowledged", { id: "helper", message: "next", background: true })).rejects.toThrow("subagent_recovery_required");
      const inspected = await send.execute("inspect", { id: "helper", inspect: true });
      expect(inspected.details).toMatchObject({ executed: false, recovery: { status: "ready", recovery: { continuity: "retained" } } });
      expect(run).toHaveBeenCalledOnce();
      let request = { id: "helper", ack: inspected.details.recovery.ack, background: true, message: "Independently verified; continue." };
      if (admissionRejected) {
        const busy = deferred<void>();
        const other = tools(f, async () => { await busy.promise; return { text: "holder done" }; }, { timeoutMs: 30_000 });
        const holder = await other.agent.execute("occupier", { persist: true, background: true, id: "occupier", prompt: "hold" });
        try {
          await expect(send.execute("denied-ack", request)).rejects.toMatchObject({ code: "process_job_queue_full" });
          expect((await f.instances.get("helper"))?.recovery).toMatchObject({ reason: "continuation_not_started", continuity: "retained" });
          expect((await send.execute("denied-duplicate", request)).details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_already_consumed" } });
          expect(run).toHaveBeenCalledOnce();
          const fresh = await send.execute("fresh-inspection", { id: "helper", inspect: true });
          expect(fresh.details.recovery.ack).not.toBe(request.ack);
          request = { ...request, ack: fresh.details.recovery.ack };
        } finally { busy.resolve(); await done(f.service, holder.details.jobId); }
      }
      const continuation = await send.execute("ack", request);
      expect((await send.execute("duplicate", request)).details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_already_consumed" } });
      expect((await send.execute("conflict", { ...request, message: "different" })).details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_ack_conflict" } });
      await done(f.service, continuation.details.jobId);
      expect(run).toHaveBeenCalledTimes(2); expect(sessions).toEqual([sessions[0], sessions[0]]);
      expect((await f.service.get(original.details.jobId))?.state).toBe("timed_out"); expect(f.wake).toHaveBeenCalledTimes(admissionRejected ? 3 : 2);
    } finally { release.resolve(); }
  }, 30_000);
  it("serializes rejected admission with a durable not-started proof and excludes delayed duplicate verifiers", async () => {
    const f = await managedFixture(); const held = deferred<void>(); const verified = deferred<void>(); const proceed = deferred<void>();
    const { agent } = tools(f, async () => { await held.promise; return { text: "done" }; });
    const holder = await agent.execute("holder", { persist: true, background: true, id: "holder", prompt: "hold" });
    const instance = await f.instances.create({ ...spec, id: "rejected" });
    const jobId = randomUUID(); const reserved = await f.instances.reserve(instance.id, jobId);
    let verifierCalls = 0;
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => {
        await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity);
        if (identity.jobId === jobId) { verifierCalls++; verified.resolve(); await proceed.promise; }
      },
      publish: async (phase, publication) => await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
    const run = vi.fn(async () => ({ output: "must not execute", status: "ok" }));
    const request = { kind: "internal", tool: "Agent", jobId, instanceId: instance.id,
      managed: { instanceIncarnation: reserved.incarnation!, turnToken: reserved.activeTurn!.token }, run, cleanup: async () => {} } as const;
    const controller = f.service.internalController(origin, 0);
    try {
      const original = controller.startInternal(request).catch((error: unknown) => error);
      await verified.promise;
      await expect(controller.startInternal(request)).rejects.toMatchObject({ code: "process_job_conflict" });
      expect(verifierCalls).toBe(1);
      proceed.resolve();
      expect(await original).toMatchObject({ code: "process_job_queue_full" });
      expect(run).not.toHaveBeenCalled();
      expect(await f.store.get(jobId)).toMatchObject({ state: "failed", wakeOnCompletion: false,
        subagentOwnership: { owner: { settlement: "not_started" }, publication: { state: "confirmed" }, disposition: { reason: "continuation_not_started" } } });
      expect(await f.instances.get(instance.id)).toMatchObject({ status: "idle", turns: 0, recovery: { reason: "continuation_not_started" } });
      expect(f.wake).not.toHaveBeenCalled();
      await f.store.mutate((records) => { records.delete(jobId); }); // Simulate later retention after confirmation.
      await expect(controller.startInternal(request)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled(); expect(verifierCalls).toBe(1);
    } finally { proceed.resolve(); held.resolve(); await done(f.service, holder.details.jobId); }
  }, 30_000);
  it("awaits a real gated command on its original slot and permits a clean retained continuation", async () => {
    const f = await managedFixture();
    const sessions: string[] = [];
    const run = async (request: any) => {
      sessions.push(request.instance.sessionId);
      const result = await execToolRun({ executable: process.execPath, args: ["-e", "process.stdout.write('verified')"], workdir: f.root }, {
        ctx: { workspace: f.root }, toolCallId: "owned-call", ownedForegroundProcessController: request.ownedForegroundProcesses.forAttempt(),
      });
      expect(result.error).not.toBe(true);
      expect(result.text).toContain("verified");
      const turn = sessions.length;
      return { text: "done", usage: { input_tokens: 3 }, cost: { total: turn === 1 ? 0.25 : 0.1 } };
    };
    const { agent, send } = tools(f, run);
    const first = await agent.execute("managed", { persist: true, background: true, id: "helper", prompt: "work" });
    const firstJob = await done(f.service, first.details.jobId);
    expect(firstJob).toMatchObject({ state: "succeeded", childStillBusy: false, subagentProgress: { costUsd: 0.25 } });
    const stored = (await f.store.get(first.details.jobId))!;
    expect(stored.subagentProgress).toMatchObject({ costUsd: 0.25 });
    const reopened = await openProcessJobStore(f.root, f.options.settings.stateDir);
    expect((await reopened.get(first.details.jobId))?.subagentProgress).toMatchObject({ costUsd: 0.25 });
    expect(stored.subagentOwnership).toMatchObject({ owner: { settlement: "settled" }, publication: { state: "confirmed" }, command: { state: "released" }, seenCalls: ["1:owned-call"] });
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 1, usage: { input: 3 } });
    expect(await f.instances.get("helper")).not.toHaveProperty("ownerReceipt");
    const second = await send.execute("managed-send", { id: "helper", background: true, message: "next" });
    expect(await done(f.service, second.details.jobId)).toMatchObject({ state: "succeeded", subagentProgress: { costUsd: 0.1 } });
    expect(sessions).toEqual([sessions[0], sessions[0]]);
    expect(await f.instances.get("helper")).toMatchObject({ turns: 2, usage: { input: 6, costUsd: 0.35 } });
    expect(f.wake).toHaveBeenCalledTimes(2);
  }, 30_000);
  it.each(["delay-confirm", "fail-after-confirm"])("keeps admission and wakes fenced through %s", async (fault) => {
    const f = await managedFixture(); const gate = deferred<void>();
    let intercepted = false; let releasedConfirmAttempts = 0;
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        const handle = await f.registry.open(publication.identity.conversationId, { existingOnly: true });
        if (phase === "confirm" && publication.released) {
          intercepted = true;
          releasedConfirmAttempts++;
          if (fault === "delay-confirm") await gate.promise;
          else { await handle.publishOwned(phase, publication); throw new Error("injected confirmation receipt failure"); }
        }
        await handle.publishOwned(phase, publication);
      },
    });
    try {
      const { agent, send } = tools(f, async () => ({ text: "clean result" }));
      const receipt = await agent.execute("publication", { persist: true, background: true, id: "helper", prompt: "work" });
      await vi.waitFor(() => expect(intercepted).toBe(true), { timeout: 5000 });
      expect((await f.store.get(receipt.details.jobId))?.subagentOwnership?.publication.state).toBe("pending");
      expect(f.wake).not.toHaveBeenCalled();
      await expect(send.execute("blocked-publication", { id: "helper", message: "next" })).rejects.toThrow();
      if (fault === "fail-after-confirm") {
        await expect(f.instances.close("helper")).rejects.toThrow("subagent_owner_unavailable");
        await expect(f.instances.create({ ...spec, id: "bypass" })).rejects.toThrow("subagent_owner_unavailable");
        expect((await f.instances.get("helper"))?.status).toBe("idle");
      } else {
        expect((await f.instances.get("helper"))?.status).toBe("running");
        gate.resolve(); await done(f.service, receipt.details.jobId);
        expect((await f.instances.get("helper"))?.turns).toBe(1);
        expect(f.wake).toHaveBeenCalledOnce();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releasedConfirmAttempts).toBe(1);
    } finally { gate.resolve(); }
  }, 30_000);

  it("reports a timeout fence once and releases only after the true late provider settles", async () => {
    const f = await managedFixture(); const gate = deferred<any>();
    const run = vi.fn(() => gate.promise);
    const { agent, send } = tools(f, run, { timeoutMs: 1500 });
    const receipt = await agent.execute("managed-late", { persist: true, background: true, id: "helper", prompt: "work" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    await vi.waitFor(async () => expect((await f.service.get(receipt.details.jobId))?.wake.state).toBe("delivered"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    const beforeLate = await f.service.get(receipt.details.jobId);
    expect(beforeLate).toMatchObject({ kind: "internal" });
    expect(beforeLate?.kind === "internal" ? beforeLate.subagentProgress : undefined).not.toHaveProperty("costUsd");
    expect(await f.instances.get("helper")).toMatchObject({ status: "running", recovery: { reason: "timeout", continuity: "unknown" } });
    expect((await f.store.get(receipt.details.jobId))?.subagentOwnership).toMatchObject({ owner: { settlement: "running" }, publication: { state: "confirmed" } });
    await expect(send.execute("blocked", { id: "helper", message: "next" })).rejects.toThrow();
    gate.resolve({ text: "late", usage: { input_tokens: 7 }, cost: { total: 0.08 } });
    await vi.waitFor(async () => expect((await f.instances.get("helper"))?.status).toBe("idle"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    expect(await f.instances.get("helper")).toMatchObject({ turns: 1, usage: { input: 7, costUsd: 0.08 }, recovery: { continuity: "unknown" } });
    expect(await f.service.get(receipt.details.jobId)).toMatchObject({ state: "timed_out", childStillBusy: false,
      subagentProgress: { costUsd: 0.08 } });
    expect(f.wake).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect((await f.store.get(receipt.details.jobId))?.subagentOwnership?.publication.receiptPending).toBe(false), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    await expect(send.execute("not-retained", { id: "helper", message: "next" })).rejects.toThrow("subagent_recovery_required");
  }, 30_000);
});

describe("detached persistent subagents", () => {
  it("returns before completion, keeps metadata prompt-free, and wakes the exact origin once", async () => {
    const f = await fixture(); const gate = deferred<any>();
    const { agent, send } = tools(f, () => gate.promise);
    const receipt = await agent.execute("a", { persist: true, background: true, id: "helper", prompt: "PRIVATE_PROMPT_MARKER" });
    const id = receipt.details.jobId;
    expect(receipt.details.state).toBe("running");
    expect(receipt.details.outcome).toMatchObject({ code: "background_started", job_id: id });
    expect(f.wake).not.toHaveBeenCalled();
    await expect(send.execute("b", { id: "helper", message: "racing", background: true })).rejects.toThrow(/busy/);
    const store = await openProcessJobStore(f.root, f.options.settings.stateDir);
    expect(JSON.stringify(await store.list())).not.toContain("PRIVATE_PROMPT_MARKER");
    gate.resolve({ text: "answer" });
    expect(await done(f.service, id)).toMatchObject({ kind: "internal", tool: "Agent", state: "succeeded", childStillBusy: false });
    expect(f.wake).toHaveBeenCalledOnce();
    expect(f.wake.mock.calls[0]![0]).toMatchObject({ conversationId: origin.replyToConversationId, chainDepth: 1, projection: { instanceId: "helper", origin: { conversationId: origin.conversationId } } });
    expect((await f.instances.get("helper"))?.status).toBe("idle");
    expect(f.signalProcess).not.toHaveBeenCalled();
  });

  it("names the job after the model-authored description, never the prompt, and falls back to the instance", async () => {
    const f = await fixture(); const gate = deferred<any>();
    const { agent, send } = tools(f, () => gate.promise);
    const receipt = await agent.execute("a", { persist: true, background: true, id: "helper", prompt: "PRIVATE_PROMPT_MARKER", description: "Plan then implement issue-885" });
    expect((await f.service.get(receipt.details.jobId))?.summary).toBe("Plan then implement issue-885");
    gate.resolve({ text: "answer" });
    await done(f.service, receipt.details.jobId);
    const second = await send.execute("b", { id: "helper", message: "PRIVATE_PROMPT_MARKER", background: true });
    expect((await f.service.get(second.details.jobId))?.summary).toBe("Persistent subagent helper");
    expect((await f.service.get(second.details.jobId))?.summary).not.toContain("PRIVATE_PROMPT_MARKER");
    gate.resolve({ text: "answer" });
    await done(f.service, second.details.jobId);
  });

  it("reserves queued sends, cancels without executing or charging turns, and rolls back rejected admission", async () => {
    const f = await fixture({ maxConcurrent: 1, maxQueued: 1, maxActivePerConversation: 3 });
    const gate = deferred<any>(); const run = vi.fn(() => gate.promise); const { agent, send } = tools(f, run);
    const first = await agent.execute("a", { persist: true, background: true, id: "first", prompt: "first" });
    await f.instances.create(spec);
    const queued = await send.execute("b", { id: "helper", message: "queued", background: true });
    expect(queued.details.state).toBe("queued");
    expect(await f.instances.get("helper")).toMatchObject({ status: "queued", turns: 0, reservation: { token: queued.details.jobId } });
    await expect(send.execute("c", { id: "helper", message: "duplicate", background: true })).rejects.toThrow(/busy/);
    const denied = tools(f, run, { backgroundSubagentController: { startInternal: async () => { throw new Error("admission rejected"); } } });
    await expect(denied.agent.execute("d", { persist: true, background: true, id: "denied", prompt: "reject" })).rejects.toThrow("admission rejected");
    expect(await f.instances.get("denied")).toMatchObject({ status: "idle", turns: 0 });
    await f.service.cancel(queued.details.jobId); await done(f.service, queued.details.jobId);
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 0 });
    expect(run).toHaveBeenCalledOnce();
    gate.resolve({ text: "done" }); await done(f.service, first.details.jobId);
  });

  it.each(["timeout", "cancel"])("reports unresolved %s once, retains the lock/question, and keeps an unknown-continuity fence after late settlement", async (mode) => {
    const f = await fixture(); const gate = deferred<any>();
    const { agent, send, options } = tools(f, async (request) => { await f.instances.markAwaiting(request.instance.id, { question: "Scope?" }); return gate.promise; },
      { timeoutMs: mode === "timeout" ? 30 : 60_000 });
    const receipt = await agent.execute("a", { persist: true, background: true, id: "helper", prompt: "work" });
    if (mode === "cancel") await f.service.cancel(receipt.details.jobId);
    await vi.waitFor(async () => expect((await f.service.get(receipt.details.jobId))?.wake.state).toBe("delivered"), { timeout: 8000 });
    const job = await f.service.get(receipt.details.jobId);
    expect(job).toMatchObject({ state: mode === "timeout" ? "timed_out" : "cancelled", childStillBusy: true });
    expect(JSON.stringify(f.wake.mock.calls[0])).toContain('childStillBusy');
    expect(await f.instances.get("helper")).toMatchObject({ status: "running", pendingQuestion: { question: "Scope?" } });
    await expect(send.execute("busy", { id: "helper", message: "reply" })).rejects.toThrow(/busy/);
    await f.service.stop(); // Already abandoned children do not hold the service open.
    gate.resolve({ text: "late", usage: { input_tokens: 7, output_tokens: 2 }, cost: { total: 0.1 } });
    await vi.waitFor(async () => expect((await f.instances.get("helper"))?.status).toBe("awaiting_reply"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    expect((await f.instances.get("helper"))?.lastStatus).toBe(mode === "timeout" ? "timeout" : "cancelled");
    expect(await f.service.get(receipt.details.jobId)).toEqual(job);
    expect(f.wake).toHaveBeenCalledOnce();
    expect((await f.instances.get("helper"))?.usage).toMatchObject({ input: 7, output: 2, costUsd: 0.1 });
    expect(subagentUsageForRun(options)).toMatchObject({ input: 0, output: 0, costUsd: 0 });
    const next = tools(f, async () => ({ text: "replied" }));
    await expect(next.send.execute("reply", { id: "helper", message: "Small", close: true })).rejects.toThrow("subagent_recovery_required");
    expect((await f.instances.get("helper"))?.recovery).toMatchObject({ continuity: "unknown" });
    await f.instances.close("helper");
  }, 30_000);

  it("carries typed native session loss through the actual Agent finish seam", async () => {
    const f = await fixture();
    const { agent, send } = tools(f, async () => ({ text: "unretained answer", failureKind: "session_continuity_lost" }));
    const receipt = await agent.execute("lost", { persist: true, background: true, id: "helper", prompt: "work" });
    expect(await done(f.service, receipt.details.jobId)).toMatchObject({ state: "failed" });
    expect((await f.instances.get("helper"))?.recovery).toMatchObject({ reason: "session_continuity_lost", continuity: "lost" });
    await expect(send.execute("no-replay", { id: "helper", message: "continue" })).rejects.toThrow("subagent_recovery_required");
  });

  it("stop aborts active work, bounds waiting, and restart delivers the retained interruption once", async () => {
    const f = await fixture(); const gate = deferred<any>();
    const { agent } = tools(f, () => gate.promise);
    const receipt = await agent.execute("a", { persist: true, background: true, id: "helper", prompt: "work" });
    await f.service.stop();
    expect(await f.service.get(receipt.details.jobId)).toMatchObject({ state: "interrupted", childStillBusy: true, wake: { state: "pending" } });
    expect((await f.instances.get("helper"))?.status).toBe("running");
    gate.resolve({ text: "late" });
    await vi.waitFor(async () => expect((await f.instances.get("helper"))?.status).toBe("idle"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
    const restarted = await openProcessJobsService(f.options); services.push(restarted); await restarted.activateWakes();
    await done(restarted, receipt.details.jobId);
    expect(f.wake).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
  }, 30_000);

  it("recovers persisted internal running work without process signals or replay", async () => {
    const f = await fixture(); await f.service.stop();
    // Produce a valid record through admission, then simulate its crash snapshot.
    const live = await openProcessJobsService(f.options); services.push(live);
    const id = randomUUID();
    await live.internalController(origin, 0).startInternal({ kind: "internal", jobId: id, instanceId: "helper", tool: "Agent", run: async () => ({ status: "ok", output: "done" }), cleanup: async () => {} });
    await vi.waitFor(async () => expect((await live.get(id))?.state).toBe("succeeded"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS }); await live.stop();
    const store = await openProcessJobStore(f.root, f.options.settings.stateDir);
    await store.mutate((records) => { const r = records.get(id)!; r.state = "running"; r.completedAt = null; r.exitCode = null; r.durationMs = null; r.wake.state = "pending"; });
    const restarted = await openProcessJobsService({ ...f.options, store }); services.push(restarted); await restarted.activateWakes();
    expect(await done(restarted, id)).toMatchObject({ state: "interrupted", childStillBusy: true, lastError: { code: "process_job_agent_restarted" } });
    expect(f.wake).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
  });

  it("validates background schemas, close-only and persist requirements before admission", async () => {
    const f = await fixture(); const run = vi.fn(); const { agent, send } = tools(f, run);
    expect(agent.parameters.properties.background).toBeDefined(); expect(send.parameters.properties.background).toBeDefined();
    await expect(agent.execute("a", { prompt: "x", background: true })).rejects.toThrow(/persist/);
    await expect(send.execute("b", { id: "helper", close: true, background: true })).rejects.toThrow(/message/);
    const bare = createAgentTool({ instances: f.instances, run });
    expect(bare.parameters.properties.background).toBeDefined();
    await expect(bare.execute("c", { prompt: "x", persist: true, background: true })).rejects.toThrow(/unavailable/);
    expect(run).not.toHaveBeenCalled(); expect(await f.service.list()).toEqual([]);
  });

  it("keeps reservation ownership through failed stale-token finish and recovers orphan reservations", async () => {
    const f = await fixture(); await f.instances.create(spec); const token = randomUUID();
    await f.instances.reserve("helper", token); await f.instances.begin("helper", token);
    await expect(f.instances.finish("helper", { status: "ok" }, randomUUID())).rejects.toThrow(/ownership/);
    await expect(f.instances.begin("helper")).rejects.toThrow(/busy/);
    await f.instances.finish("helper", { status: "ok" }, token);
    const file = resolve(subagentConversationRoot(resolve(f.root, "children"), origin.conversationId), "instances.json");
    const records = JSON.parse(await readFile(file, "utf8")); records[0].status = "queued"; records[0].reservation = { token: randomUUID() };
    await writeFile(file, JSON.stringify(records));
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", lastStatus: "interrupted" });
    expect((await f.instances.get("helper"))?.reservation).toBeUndefined();
    expect(await (await f.registry.open("slack:other:1")).get("helper")).toBeUndefined();
  });

  it("keeps cancellation authoritative when its grace crosses the original timeout", async () => {
    vi.useFakeTimers();
    const gate = deferred<any>();
    const launched = launchInternalProcessJob({ kind: "internal", tool: "AgentManage", jobId: randomUUID(), instanceId: "helper",
      run: () => gate.promise, cleanup: async () => {} }, 10, 64, 20);
    await vi.advanceTimersByTimeAsync(5);
    launched.cancel();
    await vi.advanceTimersByTimeAsync(20);
    expect(await launched.completion).toMatchObject({ aborted: true, timedOut: false, childStillBusy: true });
    gate.resolve({ status: "ok", output: "late" });
    expect(await launched.completion).toMatchObject({ aborted: true, timedOut: false, childStillBusy: true });
  });

  it("bounds output, rejects exhausted lineage, and uses one terminal result for a late runner", async () => {
    const f = await fixture({ maxOutputBytes: 64 });
    const request = { kind: "internal" as const, jobId: randomUUID(), instanceId: "helper", tool: "Agent" as const,
      run: async () => ({ status: "ok", output: "x".repeat(1000) }), cleanup: async () => {} };
    await expect(f.service.internalController(origin, f.service.settings.maxChainDepth).startInternal(request)).rejects.toMatchObject({ code: "process_job_chain_depth_exceeded" });
    await f.service.internalController(origin, 0).startInternal(request);
    const job = await done(f.service, request.jobId);
    expect(job.output.stdoutBytes).toBeLessThanOrEqual(64); expect(job.output.truncated).toBe(true);
    const gate = deferred<any>(); vi.useFakeTimers();
    const launched = launchInternalProcessJob({ ...request, run: () => gate.promise }, 10, 64, 5);
    await vi.advanceTimersByTimeAsync(15);
    expect(await launched.completion).toMatchObject({ timedOut: true, childStillBusy: true });
    gate.resolve({ status: "ok", output: "late" });
    expect(await launched.completion).toMatchObject({ timedOut: true, childStillBusy: true });
  });
});


it.each(["missing", "run", "revision", "session", "model", "tip", "false", "throw"])("missing/mismatched recovery receipt never authorizes resume: %s", async (fault) => {
  const f = await managedFixture();
  const config = resolveJsonMonoAgentConfig({ cwd: f.root, json: {
    runtime: { model: "openai-codex:gpt-5.5" },
    context: { identityPath: resolve(f.root, "IDENTITY.md") },
    tools: { allowedTools: ["Agent", "AgentManage"] },
    subagents: { enabled: true, instances: { root: resolve(f.root, "children") } },
  } });
  const instance = await f.instances.create(spec); const turnToken = randomUUID();
  const receipt = { runId: fault === "run" ? "wrong" : turnToken, revision: fault === "revision" ? 1 : 0,
    providerSessionId: fault === "session" ? "wrong" : instance.sessionId,
    modelKey: fault === "model" ? "wrong:model" : config.runtime.model.reference, tipId: fault === "tip" ? "" : "tip" };
  const recoverSession = vi.fn(async () => { if (fault === "throw") throw new Error("recovery failed"); return false; });
  const runtime = { recoverSession, run: vi.fn(async (_prompt: string, _options: any) => ({ cancelled: true, providerSessionId: instance.sessionId,
    ...(fault === "missing" ? {} : { providerSessionRecovery: receipt }) })) };
  const options: any = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
    { conversationId: origin.conversationId, runId: "parent", instances: f.instances });
  const result = await options.subagents.run({ instance, turnToken, detached: true, definition: spec.definition, prompt: "first", systemPrompt: "stable", maxTurns: 2, depth: 1, abortSignal: new AbortController().signal });
  expect(result.subagentContinuity).toEqual({ turnToken, state: "unknown" });
  expect(runtime.run.mock.calls[0]?.[1]).toMatchObject({ sessionRecovery: { runId: turnToken, revision: 0 } });
  expect(recoverSession).toHaveBeenCalledTimes(["false", "throw"].includes(fault) ? 1 : 0);
});

it("stop seals first and resumed tool-bearing turns on the same native session", async () => {
  const owner = createMonoRuntime();
  const f = await managedFixture(async (id, root) => owner.retireDurableSession!(id, root));
  try {
    await writeFile(resolve(f.root, "evidence.txt"), "prior tool evidence");
    const config = resolveJsonMonoAgentConfig({ cwd: f.root, json: {
      runtime: { model: "openai-codex:gpt-5.5" },
      context: { identityPath: resolve(f.root, "IDENTITY.md") },
      tools: { allowedTools: ["Agent", "AgentManage"] },
      subagents: { enabled: true, instances: { root: resolve(f.root, "children") } },
    } });
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(piPath);
    const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
    const models = createModels(); models.setProvider(faux.provider); const calls: any[] = []; const contexts: any[] = [];
    const runtime = { recoverSession: owner.recoverSession!.bind(owner), run: async (prompt: string, options: any) => {
      calls.push(options);
      return generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    } };
    const subagents: any = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
      { conversationId: origin.conversationId, runId: "parent", instances: f.instances })!.subagents;
    subagents.backgroundSubagentController = f.service.internalController(origin, 0);
    const agent = createAgentTool(subagents, { model: config.runtime.model, cwd: f.root });
    const send = createAgentManageTool(subagents, { model: config.runtime.model, cwd: f.root });
    for (let turn = 0; turn < 2; turn++) {
      const entered = deferred<void>();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Read", { file_path: "evidence.txt" }, { id: `read-${turn}` })]),
        async (context: any, options: any) => {
          contexts.push(structuredClone(context.messages)); entered.resolve();
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          return fauxAssistantMessage([fauxText("interrupted")], { stopReason: "aborted" });
        },
      ]);
      const started = turn === 0
        ? await agent.execute("start", { persist: true, background: true, id: "helper", prompt: "remember original context" })
        : await send.execute("continue", { id: "helper", background: true, message: "second tool-bearing turn" });
      await entered.promise;
      const result = await send.execute("stop", { id: "helper", stop: true });
      expect(result.details.stop).toMatchObject({ status: "stopped", resumable: true, childStillBusy: false, disposition: "cancelled", turns: turn + 1 });
      await done(f.service, started.details.jobId);
    }
    const record = (await f.instances.get("helper"))!;
    await owner.disposeSession!(record.sessionId);
    let resumed: any;
    faux.setResponses([(context: any) => { resumed = context; return fauxAssistantMessage([fauxText("resumed with evidence")]); }]);
    const next = await send.execute("resume", { id: "helper", message: "resume after disposal", background: true });
    expect((await done(f.service, next.details.jobId)).state).toBe("succeeded");
    expect(calls.every((call) => call.sessionId === record.sessionId)).toBe(true);
    expect(JSON.stringify(resumed.messages)).toContain("remember original context");
    expect(JSON.stringify(resumed.messages)).toContain("second tool-bearing turn");
    expect(JSON.stringify(resumed.messages)).toContain("prior tool evidence");
    expect(resumed.messages.filter((message: any) => message.role === "toolResult")).toHaveLength(2);
    expect(contexts[1].slice(0, contexts[0].length)).toEqual(contexts[0]);
    await send.execute("close", { id: "helper", close: true });
    expect((await f.instances.get("helper"))?.status).toBe("closed");
  } finally { await owner.disposeAllSessions?.(); }
}, 25_000);

it("G08: retained failure acknowledgement resumes the exact Pi JSONL after warm-session disposal", async () => {
  const owner = createMonoRuntime(); const releaseConfirmation = deferred<void>(); let delayed = false;
  const f = await managedFixture(async (id, root) => owner.retireDurableSession!(id, root));
  try {
    const config = resolveJsonMonoAgentConfig({ cwd: f.root, json: {
      runtime: { model: "openai-codex:gpt-5.5" },
      context: { identityPath: resolve(f.root, "IDENTITY.md") },
      tools: { allowedTools: ["Agent", "AgentManage"] },
      subagents: { enabled: true, timeoutMs: 3000, instances: { root: resolve(f.root, "children") } },
    } });
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText } = await import(piPath);
    const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
    const models = createModels(); models.setProvider(faux.provider); const calls: any[] = [];
    const runtime = { run: async (prompt: string, options: any) => {
      calls.push(options);
      return generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    } };
    const subagents: any = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
      { conversationId: origin.conversationId, runId: "parent", instances: f.instances })!.subagents;
    subagents.backgroundSubagentController = f.service.internalController(origin, 0);
    const context = { model: config.runtime.model, recoveryAccess: { workspace: f.root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root: f.root }) } };
    const agent = createAgentTool(subagents, context); const send = createAgentManageTool(subagents, context);
    f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
      verify: async (identity) => (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => {
        if (!delayed && phase === "confirm" && !publication.released && publication.disposition.status === "ok") {
          delayed = true; await releaseConfirmation.promise;
        }
        await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
      },
    });
    faux.setResponses([fauxAssistantMessage([fauxText("native first answer retained before publication timeout")])]);
    const first = await agent.execute("retained-failure", { id: "helper", persist: true, background: true, prompt: "first task in failed epoch" });
    await vi.waitFor(async () => expect((await f.store.get(first.details.jobId))?.subagentOwnership?.disposition).toMatchObject({ reason: "timeout", continuity: "retained" }), { timeout: 12_000 });
    releaseConfirmation.resolve(); expect((await done(f.service, first.details.jobId)).state).toBe("timed_out");
    const record = (await f.instances.get("helper"))!;
    const files = (await readdir(record.sessionsRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl")); expect(files).toHaveLength(1);
    const transcriptPath = resolve(record.sessionsRoot, files[0]!); const before = await readFile(transcriptPath, "utf8");
    expect(before).toContain("first task in failed epoch"); expect(before).toContain("native first answer retained before publication timeout");
    await owner.disposeSession!(record.sessionId);
    await expect(send.execute("no-ack", { id: "helper", message: "must not replay", background: true })).rejects.toThrow("subagent_recovery_required");
    const inspected = await send.execute("inspect", { id: "helper", inspect: true });
    expect(inspected.details.recovery).toMatchObject({ status: "ready", recovery: { continuity: "retained" } }); expect(calls).toHaveLength(1);
    expect(await readFile(transcriptPath, "utf8")).toBe(before);
    let input: any;
    faux.setResponses([(value: any) => { input = value; return fauxAssistantMessage([fauxText("acknowledged continuation retained")]); }]);
    const request = { id: "helper", ack: inspected.details.recovery.ack, message: "explicit parent acknowledgement and new instructions", background: true };
    const resumed = await send.execute("ack", request); expect((await done(f.service, resumed.details.jobId)).state).toBe("succeeded");
    expect(calls).toHaveLength(2); expect(calls[1].sessionId).toBe(calls[0].sessionId); expect(calls[1].piSessionsRoot).toBe(record.sessionsRoot);
    expect((await readdir(record.sessionsRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"))).toEqual(files);
    const after = await readFile(transcriptPath, "utf8"); expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(request.message); expect(after).toContain("acknowledged continuation retained");
    expect(JSON.stringify(input.messages)).toContain("first task in failed epoch");
    expect(JSON.stringify(input.messages)).toContain("native first answer retained before publication timeout");
    const duplicate = await send.execute("duplicate", request);
    expect(duplicate.details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_already_consumed" } });
    expect(calls).toHaveLength(2); expect(await readFile(transcriptPath, "utf8")).toBe(after); expect(f.wake).toHaveBeenCalledTimes(2);
    await send.execute("close", { id: "helper", close: true });
  } finally { releaseConfirmation.resolve(); await f.service.stop(); await owner.disposeAllSessions?.(); }
}, 20_000);

it.each([false, true])("real Pi fake transport: detached AskParent and background reply resume one JSONL, then close (managed=%s)", async (managed) => {
  const owner = createMonoRuntime();
  const retire = async (id: string, root: string) => owner.retireDurableSession!(id, root);
  const f = managed ? await managedFixture(retire) : await fixture({}, retire);
  try {
    const config = resolveJsonMonoAgentConfig({ cwd: f.root, json: {
      runtime: { model: "openai-codex:gpt-5.5" },
      context: { identityPath: resolve(f.root, "IDENTITY.md") },
      tools: { allowedTools: ["Agent", "AgentManage"] },
      subagents: { enabled: true, instances: { root: resolve(f.root, "children") } },
    } });
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(piPath);
    const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
    const models = createModels(); models.setProvider(faux.provider);
    const gate = deferred<void>();
    const runtime = { run: async (prompt: string, options: any) => {
      await gate.promise;
      return generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    } };
    const subagents: any = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
      { conversationId: origin.conversationId, runId: "parent", instances: f.instances })!.subagents;
    subagents.backgroundSubagentController = f.service.internalController(origin, 0);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("AskParent", { question: "Which scope?", options: ["Small", "Large"] })])]);
    const first = await createAgentTool(subagents, { model: config.runtime.model }).execute("first", { persist: true, background: true, id: "helper", prompt: "first task" });
    expect(f.wake).not.toHaveBeenCalled(); gate.resolve();
    const questionJob = await done(f.service, first.details.jobId);
    expect(questionJob.state).toBe("succeeded");
    expect(questionJob.subagentQuestion).toEqual({ question: "Which scope?", options: ["Small", "Large"] }); expect(questionJob.output.preview).toContain("Which scope?");
    expect(await f.instances.get("helper")).toMatchObject({ status: "awaiting_reply", turns: 1 });
    const record = (await f.instances.get("helper"))!;
    const transcripts = async () => (await readdir(record.sessionsRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
    const files = await transcripts(); expect(files).toHaveLength(1);
    expect(await readFile(resolve(record.sessionsRoot, files[0]!), "utf8")).toContain("first task");
    await owner.disposeSession!(record.sessionId);
    let input: any;
    faux.setResponses([(context: any) => { input = context; return fauxAssistantMessage([fauxText("Small scope answer")]); }]);
    const second = await createAgentManageTool(subagents).execute("second", { id: "helper", message: "Small", background: true });
    expect((await done(f.service, second.details.jobId)).state).toBe("succeeded");
    expect(JSON.stringify(input.messages)).toContain("first task"); expect(JSON.stringify(input.messages)).toContain("Which scope?");
    expect(await transcripts()).toEqual(files);
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 2 });
    faux.setResponses([fauxAssistantMessage([fauxText("Closed successfully")])]);
    const third = await createAgentManageTool(subagents).execute("third", { id: "helper", message: "Finish", background: true, close: true });
    await done(f.service, third.details.jobId);
    expect((await f.instances.get("helper"))?.status).toBe("closed");
    expect(await transcripts()).toEqual([]); expect(f.wake).toHaveBeenCalledTimes(3);
  } finally { await owner.disposeAllSessions?.(); }
}, 30000);

it("failed child preserves a pending question and bounded question wakes survive preview truncation", async () => {
  const f = await fixture({ previewChars: 80 });
  const question = { question: "Which scope? ".repeat(100), options: ["Small", "Large"] };
  const id = randomUUID();
  await f.service.internalController(origin, 0).startInternal({ kind: "internal", jobId: id, instanceId: "helper", tool: "Agent",
    run: async () => ({ status: "awaiting_reply", output: "output ".repeat(100), question }), cleanup: async () => {} });
  const job = await done(f.service, id);
  expect(job.output.preview.length).toBeLessThanOrEqual(80);
  expect(job.subagentQuestion).toEqual(question);
  expect((f.wake.mock.calls[0]![0] as any).prompt).toContain(question.question);
  await f.instances.create(spec); await f.instances.begin("helper");
  await f.instances.markAwaiting("helper", { question: "Pending?" });
  await f.instances.finish("helper", { status: "awaiting_reply", question: { question: "Pending?" } });
  const { send } = tools(f, async () => { throw new Error("provider unavailable"); });
  const failed = await send.execute("failed", { id: "helper", message: "Try", background: true, close: true });
  expect((await done(f.service, failed.details.jobId)).state).toBe("failed");
  expect(await f.instances.get("helper")).toMatchObject({ status: "awaiting_reply", pendingQuestion: { question: "Pending?" } });
});

it("G10: failed close after retained acknowledgement preserves the pending question and instance", async () => {
  const f = await managedFixture(undefined, { maxRuntimeMs: 5_000 });
  const timedSpec = { ...spec, definition: { ...spec.definition, timeoutMs: 1_500 } };
  await f.instances.create(timedSpec); await f.instances.begin("helper");
  await f.instances.markAwaiting("helper", { question: "Pending scope?", options: ["Small", "Large"] });
  await f.instances.finish("helper", { status: "awaiting_reply", question: { question: "Pending scope?", options: ["Small", "Large"] } });
  expect(await f.instances.get("helper")).toMatchObject({ status: "awaiting_reply", pendingQuestion: { question: "Pending scope?" } });

  // Ordered phases, not a timing margin. The production deadlines stay at their
  // real values; only the clock is held still so host latency cannot expire the
  // 1500ms deadline before the provider settles. Two source facts make the
  // ordering deterministic (process-jobs-service reportManaged/publishManaged):
  //  * reportManaged writes the retained ok disposition durably BEFORE calling
  //    publishManaged, so entering an unreleased ok confirm hook proves
  //    settlement=settled and disposition={ok,retained} are already on disk.
  //  * reportManaged publishes its own "intent" directly, outside the per-job
  //    managedPublications chain, so the timeout intent — carrying the
  //    continuity the product actually computed — is observable while the ok
  //    confirm is still held. Only the timeout's later publishManaged run
  //    queues behind that held confirm. Releasing it finishes publication;
  //    retained continuity comes from the durable ok report, not from when
  //    the held confirm resumes.
  const releaseConfirmation = deferred<void>();
  const confirmHeld = deferred<void>();
  const timeoutIntent = deferred<{ status: string; continuity?: string; reason?: string }>();
  let delayNextSuccess = true;
  f.service.bindManagedSubagents!({ root: resolve(f.root, "children"),
    verify: async (identity) => await (await f.registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) => {
      if (phase === "intent" && publication.disposition.reason === "timeout") timeoutIntent.resolve(publication.disposition);
      if (delayNextSuccess && phase === "confirm" && !publication.released && publication.disposition.status === "ok") {
        delayNextSuccess = false;
        confirmHeld.resolve();
        await releaseConfirmation.promise;
      }
      await (await f.registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication);
    },
  });
  // Fake timers freeze Date as well as setTimeout, which the service needs:
  // admission and managedExecution compare this.now() against deadlineAt, so a
  // Date.now-only spy would leave `new Date()` running ahead of the timers.
  vi.useFakeTimers();
  try {
    const timeoutTools = tools(f, async () => ({ text: "This answer settled before reporting timed out" }));
    const timedOut = await timeoutTools.send.execute("retained-timeout", { id: "helper", message: "Small", background: true });

    // Phase 1 — durable settlement proof, with zero clock advance. Never
    // vi.waitFor inside this window: it auto-advances fake timers and would
    // expire the production deadline early.
    await confirmHeld.promise;
    expect((await f.store.get(timedOut.details.jobId))?.subagentOwnership).toMatchObject({
      owner: { settlement: "settled" },
      disposition: { status: "ok", continuity: "retained" },
    });

    // Phase 2 — fire the genuine production deadlines (1500ms job timer, then
    // the 5100ms launch grace) while the ok confirm is still held. Both are
    // real product timers; nothing here shortens or extends them.
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(5_100);
    // Both production timers have now fired, so restoring the real clock can no
    // longer expire anything early. Doing it before the release keeps a single
    // stable clock across the held hook's resumption, and leaves no pending fake
    // timer to discard on the wake path (scheduleWake runs on promises).
    vi.useRealTimers();
    // Deferred evidence resolved by the actual publish hook — not an assumption
    // that advancing timers settled the I/O. This is the product's own timeout
    // disposition, computed from the phase-1 durable ok proof and published
    // while the confirm is still held.
    expect(await timeoutIntent.promise).toMatchObject({ status: "timeout", reason: "timeout", continuity: "retained" });

    // Phase 3 — release the held confirm so the timeout's queued publication
    // can complete, then await the durable record under real timers.
    releaseConfirmation.resolve();
    await vi.waitFor(async () => expect((await f.store.get(timedOut.details.jobId))?.subagentOwnership?.disposition)
      .toMatchObject({ reason: "timeout", continuity: "retained" }), { timeout: 8_000 });
    expect((await done(f.service, timedOut.details.jobId)).state).toBe("timed_out");
    expect(await f.instances.get("helper")).toMatchObject({ status: "awaiting_reply", pendingQuestion: { question: "Pending scope?" } });

    const inspected = await f.instances.inspect("helper", { workspace: f.root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root: f.root }) });
    expect(inspected).toMatchObject({ status: "ready", recovery: { continuity: "retained" } });
    const failedRun = vi.fn(async () => { throw new Error("provider unavailable"); });
    const failedTools = tools(f, failedRun);
    const request = { id: "helper", ack: inspected.ack!, message: "Verified; finish with Small scope", background: true, close: true };
    const failed = await failedTools.send.execute("failed-close", request);
    expect((await done(f.service, failed.details.jobId)).state).toBe("failed");
    expect(await f.instances.get("helper")).toMatchObject({ status: "awaiting_reply", pendingQuestion: { question: "Pending scope?" } });
    const duplicate = await failedTools.send.execute("failed-close-duplicate", request);
    expect(duplicate.details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_already_consumed" } });
    expect(failedRun).toHaveBeenCalledOnce();
  } finally {
    // Restore the clock before ungating so a failure path never resumes the held
    // hook under fake timers, and never leaves the gate closed for teardown.
    vi.useRealTimers(); releaseConfirmation.resolve();
  }
}, 30_000);

it("queue expiry releases the reservation without invoking the child", async () => {
  const f = await fixture({ maxConcurrent: 1, maxQueueAgeMs: 1500 });
  const gate = deferred<any>(); const run = vi.fn(() => gate.promise); const { agent } = tools(f, run);
  const first = await agent.execute("a", { persist: true, id: "first", prompt: "hold", background: true });
  const queued = await agent.execute("b", { persist: true, id: "second", prompt: "expire", background: true });
  expect((await done(f.service, queued.details.jobId)).state).toBe("queue_expired");
  expect(await f.instances.get("second")).toMatchObject({ status: "idle", turns: 0 });
  expect(run).toHaveBeenCalledOnce();
  gate.resolve({ text: "done" }); await done(f.service, first.details.jobId);
});

function failMutationOnce(f: Awaited<ReturnType<typeof fixture>>, predicate: (records: Map<string, any>) => boolean) {
  const mutate = f.store.mutate.bind(f.store);
  let armed = true;
  vi.spyOn(f.store, "mutate").mockImplementation((fn) => mutate(async (records) => {
    const result = await fn(records);
    if (armed && predicate(records)) { armed = false; throw new Error("injected persistence failure"); }
    return result;
  }));
}

it.each(["cancel", "expiry"])("retains queued reservation and closure if %s persistence fails", async (mode) => {
  const f = await fixture({ maxConcurrent: 1 }); const gate = deferred<any>();
  const { agent, send } = tools(f, () => gate.promise);
  await agent.execute("first", { persist: true, background: true, id: "first", prompt: "hold" });
  const receipt = await agent.execute("second", { persist: true, background: true, id: "helper", prompt: "queued" });
  const id = receipt.details.jobId;
  failMutationOnce(f, (records) => records.get(id)?.state === (mode === "cancel" ? "cancelled" : "queue_expired"));
  await expect(mode === "cancel" ? f.service.cancel(id) : (f.service as any).withLock(() => (f.service as any).expireJob(id))).rejects.toThrow();
  expect((await f.store.get(id))?.state).toBe("queued");
  expect((f.service as any).pending.has(id)).toBe(true);
  expect((await f.instances.get("helper"))?.status).toBe("queued");
  await expect(send.execute("reuse", { id: "helper", message: "unsafe" })).rejects.toThrow(/busy/);
  gate.resolve({ text: "settled" });
});

it("rolls failed internal running publication back and drains the next queued child", async () => {
  const f = await fixture({ maxConcurrent: 1, maxActivePerConversation: 8 }); const gate = deferred<any>();
  const run = vi.fn((r) => r.instance.id === "first" ? gate.promise : Promise.resolve({ text: "done" }));
  const { agent } = tools(f, run);
  await agent.execute("first", { persist: true, background: true, id: "first", prompt: "hold" });
  const failed = await agent.execute("fail", { persist: true, background: true, id: "helper", prompt: "no drive" });
  const next = await agent.execute("next", { persist: true, background: true, id: "next", prompt: "drive" });
  failMutationOnce(f, (records) => records.get(failed.details.jobId)?.state === "running");
  gate.resolve({ text: "release" });
  expect(await done(f.service, failed.details.jobId)).toMatchObject({ state: "spawn_failed" });
  expect(await done(f.service, next.details.jobId)).toMatchObject({ state: "succeeded" });
  expect(run.mock.calls.map(([r]) => r.instance.id)).toEqual(["first", "next"]);
  expect((await f.instances.get("helper"))?.status).toBe("idle");
  expect((f.service as any).pending.has(failed.details.jobId)).toBe(false);
  expect(f.wake.mock.calls.filter(([w]: any) => w.projection.jobId === failed.details.jobId)).toHaveLength(1);
});

it.each([false, true])("keeps detached parent usage deterministic with delayed=%s", async (delayed) => {
  const f = await fixture(); const gate = deferred<any>();
  const result = { text: "answer", usage: { input_tokens: 12, output_tokens: 3 }, cost: { total: 0.25 } };
  const { agent, options } = tools(f, async (r) => {
    if (delayed) await gate.promise;
    r.onEvent({ type: "cost_accumulated", tokens: { input: 12, output: 3 }, cumulativeUsd: 0.25 });
    return result;
  });
  const before = subagentUsageForRun(options);
  const receipt = await agent.execute("usage", { persist: true, background: true, id: "helper", prompt: "work" });
  expect(subagentUsageForRun(options)).toEqual(before);
  gate.resolve(result);
  const job = await done(f.service, receipt.details.jobId);
  expect(subagentUsageForRun(options)).toEqual(before);
  expect((await f.instances.get("helper"))?.usage).toMatchObject({ input: 12, output: 3, costUsd: 0.25 });
  expect(job.output.preview).toContain('"usage":{"input":12');
});

it("normalizes oversized and duplicate AskParent options before strict projection round-trip", async () => {
  const f = await fixture(); const id = randomUUID();
  await f.service.internalController(origin, 0).startInternal({ kind: "internal", tool: "Agent", jobId: id, instanceId: "helper", cleanup: async () => {},
    run: async () => ({ status: "awaiting_reply", output: "question", question: { question: "Choose", options: [" a ", "a", "b", "c", "d", "e", "f"] } }) });
  const job = await done(f.service, id);
  expect(job.subagentQuestion?.options).toEqual(["a", "b", "c", "d", "e"]);
  expect(parseProcessJobProjection(JSON.parse(JSON.stringify(job)))).toEqual(job);
});

it.each(["timeout", "cancel"])("records cooperative process-job %s in both job and instance", async (mode) => {
  const f = await fixture({ maxRuntimeMs: mode === "timeout" ? 50 : 60_000 });
  const { agent } = tools(f, (r) => new Promise((resolve) => {
    const settle = () => resolve({ text: "partial", usage: { input_tokens: 2 } });
    if (r.abortSignal.aborted) settle(); else r.abortSignal.addEventListener("abort", settle, { once: true });
  }), { timeoutMs: 60_000 });
  const receipt = await agent.execute("cooperative", { persist: true, background: true, id: "helper", prompt: "work" });
  if (mode === "cancel") await f.service.cancel(receipt.details.jobId);
  expect(await done(f.service, receipt.details.jobId)).toMatchObject({ state: mode === "timeout" ? "timed_out" : "cancelled", childStillBusy: false });
  expect(await f.instances.get("helper")).toMatchObject({ status: "idle", lastStatus: mode === "timeout" ? "timeout" : "cancelled" });
});

it("retains observed detached spend when the child throws without a result", async () => {
  const f = await fixture();
  const { agent, options } = tools(f, async (r) => {
    r.onEvent({ type: "cost_accumulated", tokens: { input: 9, output: 4 }, cumulativeUsd: 0.2 });
    throw new Error("child failed after provider spend");
  });
  const receipt = await agent.execute("spent", { persist: true, background: true, id: "helper", prompt: "work" });
  const job = await done(f.service, receipt.details.jobId);
  expect(job.state).toBe("failed");
  expect(job.output.preview).toContain('"usage":{"input":9');
  expect((await f.instances.get("helper"))?.usage).toMatchObject({ input: 9, output: 4, costUsd: 0.2 });
  expect(subagentUsageForRun(options)).toMatchObject({ input: 0, output: 0, costUsd: 0 });
});


it("keeps detached live progress out of the parent stream and persists it separately from wake output", async () => {
  const f = await fixture();
  const gate = deferred<any>();
  const parentEvents = vi.fn();
  let emit!: (event: any) => void;
  const { agent } = tools(f, async (request) => {
    emit = request.onEvent;
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "src/file.ts", prompt: "PRIVATE_PROMPT" } }] } });
    return await gate.promise;
  }, { onEvent: parentEvents });
  const receipt = await agent.execute("parent-call", { persist: true, background: true, id: "helper", prompt: "PRIVATE_PROMPT" });
  const id = receipt.details.jobId;
  await vi.waitFor(async () => expect((await f.service.get(id) as any).subagentProgress?.toolCalls).toBe(1), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  expect(parentEvents.mock.calls.flat().some((event: any) => event.type === "subagent_activity")).toBe(false);
  await vi.waitFor(async () => expect((await f.store.get(id))?.subagentProgress?.toolCalls).toBe(1), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  expect(JSON.stringify((await f.store.get(id))?.subagentProgress)).not.toContain("PRIVATE_PROMPT");
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "PRIVATE_TOOL_RESULT" }] } });
  gate.resolve({ text: "Child final report" });
  const job = await done(f.service, id);
  expect(job.subagentProgress).toMatchObject({ toolCalls: 1, failedCalls: 0, answerHead: "Child final report", recent: [{ status: "complete", toolName: "Read" }] });
  expect(JSON.stringify(job.subagentProgress)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_TOOL_RESULT/u);
  const reopened = await openProcessJobStore(f.root, f.options.settings.stateDir);
  expect((await reopened.get(id))?.subagentProgress).toEqual(job.subagentProgress);
  const output = await readFile(resolve(f.options.settings.stateDir, job.output.stdoutRef!), "utf8");
  // Ambient secret redaction can replace even JSON literals; do not parse an output artifact.
  expect(output).toContain('"instanceId":"helper"');
  expect(output).toContain("Child final report");
  expect(output).not.toContain("subagentProgress");
  expect((f.wake.mock.calls[0]![0] as any).prompt).not.toContain("subagentProgress");
}, 45_000);

it("projects the requested detached route while running and the executed fallback after settlement", async () => {
  const f = await fixture();
  const gate = deferred<any>();
  const definitions = [{ name: "routed", description: "Route fixture", systemPrompt: "Work", allowedTools: ["Read"],
    model: { provider: "provider", model: "primary", reference: "provider:primary" }, effort: "high" }];
  const { agent } = tools(f, async (request) => {
    request.onEvent({ type: "provider_execution_config", model: "provider:primary", effort: "high", effectiveEffort: "high" });
    request.onEvent({ type: "provider_failover_started", from: "provider:primary", to: "provider:fallback", attemptIndex: 1, reason: "overloaded" });
    request.onEvent({ type: "provider_execution_config", model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" });
    await gate.promise;
    return { text: "done", model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" };
  }, { definitions });
  const receipt = await agent.execute("route", { name: "routed", persist: true, background: true, id: "helper", prompt: "work" });
  const id = receipt.details.jobId;
  await vi.waitFor(async () => expect((await f.service.get(id) as any).subagentProgress?.route).toEqual({
    requested: { model: "provider:primary", effort: "high" },
  }), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  gate.resolve(undefined);
  const job = await done(f.service, id);
  expect(job.subagentProgress?.route).toEqual({
    requested: { model: "provider:primary", effort: "high" },
    executed: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
    disposition: "fallback",
  });
  expect(JSON.stringify(job.subagentProgress?.route)).not.toMatch(/reason|overloaded/u);
  const reopened = await openProcessJobStore(f.root, f.options.settings.stateDir);
  expect((await reopened.get(id))?.subagentProgress?.route).toEqual(job.subagentProgress?.route);
});

it.each([
  ["successful", { text: "done" }],
  ["awaiting-reply", { subagentQuestion: { question: "Which scope?" } }],
])("preserves a pinned requested route when a %s result reports no executed route", async (_case, result) => {
  const f = await fixture();
  const definitions = [{ name: "pinned", description: "Pinned route fixture", systemPrompt: "Work", allowedTools: ["Read"],
    model: { provider: "provider", model: "primary", reference: "provider:primary" }, effort: "high" }];
  const { agent } = tools(f, async () => result, { definitions });
  const receipt = await agent.execute(`pinned-${_case}`, { name: "pinned", persist: true, background: true, id: "helper", prompt: "work" });
  const job = await done(f.service, receipt.details.jobId);
  expect(job.subagentProgress?.route).toEqual({
    requested: { model: "provider:primary", effort: "high" },
    disposition: "requested",
  });
  expect(job.subagentProgress?.route).not.toHaveProperty("executed");
});

it("omits detached route progress when the profile requests no route", async () => {
  const f = await fixture();
  const definitions = [{ name: "unrouted", description: "No route fixture", systemPrompt: "Work", allowedTools: ["Read"] }];
  const { agent } = tools(f, async () => ({ text: "done" }), { definitions });
  const receipt = await agent.execute("no-route", { name: "unrouted", persist: true, background: true, id: "helper", prompt: "work" });
  const job = await done(f.service, receipt.details.jobId);
  expect(job.subagentProgress).not.toHaveProperty("route");
});

it("ignores private progress emitted after internal cancellation grace expires", async () => {
  const gate = deferred<any>();
  let emit!: (event: any) => void;
  const progress = vi.fn();
  const launched = launchInternalProcessJob({ kind: "internal", tool: "Agent", jobId: randomUUID(), instanceId: "helper", cleanup: async () => {},
    run: async (_signal, _write, report) => { emit = report; return gate.promise; } }, 10, 64, 5, undefined, progress);
  await launched.completion;
  emit({ type: "started", profile: "too late" });
  gate.resolve({ status: "ok", output: "late" });
  expect(progress).not.toHaveBeenCalled();
});


it("coalesces a burst of private progress and terminally persists the latest bounded snapshot", async () => {
  const surface = vi.fn(async (_job: ProcessJobProjection) => {});
  const f = await fixture({}, undefined, surface);
  const gate = deferred<any>();
  let emit!: (event: any) => void;
  const id = randomUUID();
  await f.service.internalController(origin, 0).startInternal({ kind: "internal", tool: "AgentManage", jobId: id, instanceId: "helper", cleanup: async () => {},
    run: async (_signal, _write, report) => { emit = report; return gate.promise; } });
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  surface.mockClear();
  for (let i = 0; i < 100; i++) {
    emit({ type: "tool_started", id: String(i), toolName: "Read", argsSummary: "src/file.ts" });
    emit({ type: "tool_completed", id: String(i), failed: i % 2 === 0 });
  }
  expect((await f.service.get(id) as any).subagentProgress).toMatchObject({ toolCalls: 100, failedCalls: 50 });
  await vi.waitFor(async () => expect((await f.store.get(id))?.subagentProgress?.toolCalls).toBe(100), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  await vi.waitFor(() => expect(surface).toHaveBeenCalled(), { timeout: DURABLE_DELIVERY_TIMEOUT_MS });
  expect(surface.mock.calls.length).toBeLessThanOrEqual(2);
  gate.resolve({ status: "ok", output: '{"answer":"original output"}', answer: "Separate report" });
  const job = await done(f.service, id);
  expect(job.subagentProgress?.recent).toHaveLength(50);
  expect(job.subagentProgress?.answerHead).toBe("Separate report");
  expect((await f.store.get(id))?.subagentProgress).toEqual(job.subagentProgress);
  expect((f.wake.mock.calls[0]![0] as any).prompt).not.toContain("Separate report");
}, 45_000);

it("does not append private progress or the UI answer to the internal stdout lane", async () => {
  const output = JSON.stringify({ instanceId: "helper", answer: "Original wake report", artifacts: [] });
  const launched = launchInternalProcessJob({ kind: "internal", tool: "Agent", jobId: randomUUID(), instanceId: "helper", cleanup: async () => {},
    run: async (_signal, _write, report) => {
      report({ type: "started", profile: "helper" });
      return { status: "ok", output, answer: "Separate UI report" };
    } }, 1_000, 8_000);
  expect(await launched.completion).toMatchObject({ stdout: output, answer: "Separate UI report" });
});

it("propagates only detached Agent/AgentManage admitted deadlines, not foreground ones", async () => {
  const f = await fixture({ maxRuntimeMs: 900_000 });
  const run = vi.fn(async (_r: any) => ({ text: "done" }));
  const { agent, send } = tools(f, run, { timeoutMs: 1_800_000 });
  const first = await agent.execute("start", { persist: true, background: true, id: "helper", prompt: "work" });
  await done(f.service, first.details.jobId);
  const firstJob = (await f.store.get(first.details.jobId))!;
  expect(run.mock.calls[0]![0]).toMatchObject({ detached: true, deadlineAt: Date.parse(firstJob.runtimeDeadlineAt!) });
  expect(firstJob.maxRuntimeMs).toBe(900_000);
  const second = await send.execute("resume", { id: "helper", background: true, message: "more" });
  await done(f.service, second.details.jobId);
  const secondJob = (await f.store.get(second.details.jobId))!;
  expect(run.mock.calls[1]![0]).toMatchObject({ detached: true, deadlineAt: Date.parse(secondJob.runtimeDeadlineAt!) });
  await send.execute("foreground", { id: "helper", message: "more" });
  expect(run.mock.calls[2]![0]).not.toHaveProperty("detached");
  expect(run.mock.calls[2]![0]).not.toHaveProperty("deadlineAt");
  await agent.execute("foreground-agent", { prompt: "work" });
  expect(run.mock.calls[3]![0]).not.toHaveProperty("deadlineAt");
});

it.each([
  [undefined, 3_600_000, true, 1_800_000],
  [900_000, 3_600_000, true, 900_000],
  [900_000, 30_000, true, 30_000],
  [undefined, 30_000, true, 30_000],
  [undefined, -1, true, 1],
  [undefined, undefined, true, undefined],
  [undefined, NaN, true, undefined],
  [900_000, 3_600_000, false, undefined],
] as const)("derives child command ceiling config=%s remaining=%s detached=%s", async (commandTimeoutMs, remaining, detached, expected) => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const config = resolveJsonMonoAgentConfig({ cwd: process.cwd(), json: {
    runtime: { model: "openai-codex:gpt-5.5" },
    context: { identityPath: resolve(process.cwd(), "IDENTITY.md") },
    subagents: { enabled: true, ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }) },
  } });
  const run = vi.fn(async (_prompt: string, _options: any) => ({ text: "done" }));
  const subagents: any = buildSubagentsOptions(config, { runtime: { run } as never, baseModel: config.runtime.model })!.subagents;
  await subagents.run({ systemPrompt: "Work", prompt: "test", definition: { name: "helper", allowedTools: ["Bash", "Exec"] },
    maxTurns: 2, depth: 1, abortSignal: new AbortController().signal,
    ...(detached ? { detached: true } : {}),
    ...(remaining === undefined ? {} : { deadlineAt: Date.now() + remaining }),
  });
  const options = run.mock.calls[0]![1];
  if (expected === undefined) expect(options).not.toHaveProperty("toolLimits");
  else expect(options.toolLimits).toEqual({ bashTimeoutMs: expected });
  expect(options).not.toHaveProperty("processJobsController");
});

it("gives the child the absolute launch deadline and aborts at that deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  let observed: { deadlineAt: number } | undefined;
  const launched = launchInternalProcessJob({ kind: "internal", tool: "Agent", jobId: "deadline", instanceId: "helper", cleanup: async () => {},
    run: async (signal, _write, _progress, execution) => {
      observed = execution;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "timeout", output: "" }), { once: true }));
    } }, 900_000, 64, 5, undefined, undefined, Date.now() + 30_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual({ deadlineAt: 1_030_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await launched.completion).toMatchObject({ timedOut: true, durationMs: 30_000 });
});
