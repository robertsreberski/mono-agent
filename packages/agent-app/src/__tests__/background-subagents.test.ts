import { parseProcessJobProjection, type ProcessJobProjection } from "@mono-agent/agent-contracts";
import { fileURLToPath } from "node:url";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { buildSubagentsOptions } from "../configured-agent.js";
// @ts-expect-error Real Pi test seam; transport only is fake.
import { generatePiNativeResponse } from "../../../agent-runtime/src/ai/providers/pi-native.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import { openProcessJobsService, type ProcessJobsServiceHandle } from "../process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../process-jobs-config.js";
import { openProcessJobStore } from "../process-jobs-store.js";
import { launchInternalProcessJob } from "../process-jobs-internal.js";
// @ts-expect-error Private kernel test seam.
import { createAgentTool, subagentUsageForRun } from "../../../agent-runtime/src/agent/tools/agent-tool.js";
// @ts-expect-error Private kernel test seam.
import { createAgentSendTool } from "../../../agent-runtime/src/agent/tools/agent-send-tool.js";

const origin = { conversationId: "slack:C1:1.1#bucket", baseConversationId: "slack:C1:1.1", bucket: "bucket",
  replyToConversationId: "slack:C1:1.1", normalizedReplyTarget: "slack:C1:1.1", runId: "parent", historyBoundary: "parent", channel: "slack" };
const spec = { id: "helper", name: "helper", systemPrompt: "Review", definition: { name: "helper", description: "Review", systemPrompt: "Review" } };
const roots: string[] = [];
const services: ProcessJobsServiceHandle[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(overrides = {}, retireSession: (id: string, root: string) => Promise<unknown> = async () => undefined, surfaceUpdate?: (job: ProcessJobProjection) => Promise<void>) {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.background-subagents-")); roots.push(root);
  const wake = vi.fn(async (_input: unknown) => ({ delivered: true as const }));
  const signalProcess = vi.fn();
  const store = await openProcessJobStore(root, resolve(root, "jobs"));
  const options = { cwd: root, workspace: root, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir: resolve(root, "jobs"), ...overrides },
    ...(surfaceUpdate ? { surfaceUpdate } : {}),
    registration: {} as never, attestRegistration: async () => ({} as never), wake, signalProcess,
    acquireLock: async () => ({ release: async () => undefined }) as never };
  const service = await openProcessJobsService(options); services.push(service); await service.activateWakes();
  const registry = createSubagentInstanceRegistry({ root: resolve(root, "children"), retireSession });
  const instances = await registry.open(origin.conversationId);
  return { root, service, instances, registry, wake, signalProcess, options, store };
}
function tools(f: Awaited<ReturnType<typeof fixture>>, run: (request: any) => Promise<any>, extra = {}) {
  const options = { instances: f.instances, run, backgroundSubagentController: f.service.internalController(origin, 0), ...extra };
  return { options, agent: createAgentTool(options), send: createAgentSendTool(options) };
}
const done = async (service: ProcessJobsServiceHandle, id: string) => {
  await vi.waitFor(async () => expect((await service.get(id))?.wake.state).toBe("delivered"), { timeout: 5000 });
  const job = (await service.get(id))!;
  if (job.kind !== "internal") throw new Error("Expected an internal subagent job");
  return job;
};

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

  it.each(["timeout", "cancel"])("reports unresolved %s once, retains the lock/question, and permits continuation only after late settlement", async (mode) => {
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
    await vi.waitFor(async () => expect((await f.instances.get("helper"))?.status).toBe("awaiting_reply"));
    expect((await f.instances.get("helper"))?.lastStatus).toBe(mode === "timeout" ? "timeout" : "cancelled");
    expect(await f.service.get(receipt.details.jobId)).toEqual(job);
    expect(f.wake).toHaveBeenCalledOnce();
    expect((await f.instances.get("helper"))?.usage).toMatchObject({ input: 7, output: 2, costUsd: 0.1 });
    expect(subagentUsageForRun(options)).toMatchObject({ input: 0, output: 0, costUsd: 0 });
    const next = tools(f, async () => ({ text: "replied" }));
    expect((await next.send.execute("reply", { id: "helper", message: "Small", close: true })).details.subagent.instance.status).toBe("closed");
  }, 12_000);

  it("stop aborts active work, bounds waiting, and restart delivers the retained interruption once", async () => {
    const f = await fixture(); const gate = deferred<any>();
    const { agent } = tools(f, () => gate.promise);
    const receipt = await agent.execute("a", { persist: true, background: true, id: "helper", prompt: "work" });
    await f.service.stop();
    expect(await f.service.get(receipt.details.jobId)).toMatchObject({ state: "interrupted", childStillBusy: true, wake: { state: "pending" } });
    expect((await f.instances.get("helper"))?.status).toBe("running");
    gate.resolve({ text: "late" });
    await vi.waitFor(async () => expect((await f.instances.get("helper"))?.status).toBe("idle"));
    const restarted = await openProcessJobsService(f.options); services.push(restarted); await restarted.activateWakes();
    await done(restarted, receipt.details.jobId);
    expect(f.wake).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
  }, 12_000);

  it("recovers persisted internal running work without process signals or replay", async () => {
    const f = await fixture(); await f.service.stop();
    // Produce a valid record through admission, then simulate its crash snapshot.
    const live = await openProcessJobsService(f.options); services.push(live);
    const id = randomUUID();
    await live.internalController(origin, 0).startInternal({ kind: "internal", jobId: id, instanceId: "helper", tool: "Agent", run: async () => ({ status: "ok", output: "done" }), cleanup: async () => {} });
    await vi.waitFor(async () => expect((await live.get(id))?.state).toBe("succeeded")); await live.stop();
    const store = await openProcessJobStore(f.root, f.options.settings.stateDir);
    await store.mutate((records) => { const r = records.get(id)!; r.state = "running"; r.completedAt = null; r.exitCode = null; r.durationMs = null; r.wake.state = "pending"; });
    const restarted = await openProcessJobsService({ ...f.options, store }); services.push(restarted); await restarted.activateWakes();
    expect(await done(restarted, id)).toMatchObject({ state: "interrupted", childStillBusy: false, lastError: { code: "process_job_agent_restarted" } });
    expect(f.wake).toHaveBeenCalledOnce(); expect(f.signalProcess).not.toHaveBeenCalled();
  });

  it("validates background schemas, close-only and persist requirements before admission", async () => {
    const f = await fixture(); const run = vi.fn(); const { agent, send } = tools(f, run);
    expect(agent.parameters.properties.background).toBeDefined(); expect(send.parameters.properties.background).toBeDefined();
    await expect(agent.execute("a", { prompt: "x", background: true })).rejects.toThrow(/persist/);
    await expect(send.execute("b", { id: "helper", close: true, background: true })).rejects.toThrow(/message/);
    const bare = createAgentTool({ instances: f.instances, run });
    expect(bare.parameters.properties.background).toBeUndefined();
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
    const launched = launchInternalProcessJob({ kind: "internal", tool: "AgentSend", jobId: randomUUID(), instanceId: "helper",
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


it("real Pi fake transport: detached AskParent and background reply resume one JSONL, then close", async () => {
  const owner = createMonoRuntime();
  const f = await fixture({}, async (id, root) => owner.retireDurableSession!(id, root));
  try {
    const config = loadMonoAgentConfig({ cwd: f.root, env: {
      MONO_AGENT_IDENTITY_PATH: resolve(f.root, "IDENTITY.md"),
      MONO_AGENT_MODEL: "openai-codex:gpt-5.5", MONO_AGENT_ALLOWED_TOOLS: "Agent,AgentSend",
      MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, instances: { root: resolve(f.root, "children") } }),
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
    const second = await createAgentSendTool(subagents).execute("second", { id: "helper", message: "Small", background: true });
    expect((await done(f.service, second.details.jobId)).state).toBe("succeeded");
    expect(JSON.stringify(input.messages)).toContain("first task"); expect(JSON.stringify(input.messages)).toContain("Which scope?");
    expect(await transcripts()).toEqual(files);
    expect(await f.instances.get("helper")).toMatchObject({ status: "idle", turns: 2 });
    faux.setResponses([fauxAssistantMessage([fauxText("Closed successfully")])]);
    const third = await createAgentSendTool(subagents).execute("third", { id: "helper", message: "Finish", background: true, close: true });
    await done(f.service, third.details.jobId);
    expect((await f.instances.get("helper"))?.status).toBe("closed");
    expect(await transcripts()).toEqual([]); expect(f.wake).toHaveBeenCalledTimes(3);
  } finally { await owner.disposeAllSessions?.(); }
}, 15000);

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
  await vi.waitFor(async () => expect((await f.service.get(id) as any).subagentProgress?.toolCalls).toBe(1));
  expect(parentEvents.mock.calls.flat().some((event: any) => event.type === "subagent_activity")).toBe(false);
  await vi.waitFor(async () => expect((await f.store.get(id))?.subagentProgress?.toolCalls).toBe(1));
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
  await f.service.internalController(origin, 0).startInternal({ kind: "internal", tool: "AgentSend", jobId: id, instanceId: "helper", cleanup: async () => {},
    run: async (_signal, _write, report) => { emit = report; return gate.promise; } });
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  surface.mockClear();
  for (let i = 0; i < 100; i++) {
    emit({ type: "tool_started", id: String(i), toolName: "Read", argsSummary: "src/file.ts" });
    emit({ type: "tool_completed", id: String(i), failed: i % 2 === 0 });
  }
  expect((await f.service.get(id) as any).subagentProgress).toMatchObject({ toolCalls: 100, failedCalls: 50 });
  await vi.waitFor(async () => expect((await f.store.get(id))?.subagentProgress?.toolCalls).toBe(100));
  await vi.waitFor(() => expect(surface).toHaveBeenCalled());
  expect(surface.mock.calls.length).toBeLessThanOrEqual(2);
  gate.resolve({ status: "ok", output: '{"answer":"original output"}', answer: "Separate report" });
  const job = await done(f.service, id);
  expect(job.subagentProgress?.recent).toHaveLength(50);
  expect(job.subagentProgress?.answerHead).toBe("Separate report");
  expect((await f.store.get(id))?.subagentProgress).toEqual(job.subagentProgress);
  expect((f.wake.mock.calls[0]![0] as any).prompt).not.toContain("Separate report");
});

it("does not append private progress or the UI answer to the internal stdout lane", async () => {
  const output = JSON.stringify({ instanceId: "helper", answer: "Original wake report", artifacts: [] });
  const launched = launchInternalProcessJob({ kind: "internal", tool: "Agent", jobId: randomUUID(), instanceId: "helper", cleanup: async () => {},
    run: async (_signal, _write, report) => {
      report({ type: "started", profile: "helper" });
      return { status: "ok", output, answer: "Separate UI report" };
    } }, 1_000, 8_000);
  expect(await launched.completion).toMatchObject({ stdout: output, answer: "Separate UI report" });
});

it("propagates only detached Agent/AgentSend admitted deadlines, not foreground ones", async () => {
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
  const config = loadMonoAgentConfig({ cwd: process.cwd(), env: {
    MONO_AGENT_IDENTITY_PATH: resolve(process.cwd(), "IDENTITY.md"),
    MONO_AGENT_MODEL: "openai-codex:gpt-5.5",
    MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, commandTimeoutMs }),
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
