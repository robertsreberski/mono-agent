import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createDispatchProgress, isDispatchProgress, withDispatchProgress } from "../../execution/pi/dispatch-progress.js";
import * as sessionAdapter from "../../execution/pi/driver-adapter.js";
import * as sessionLifecycle from "../../execution/pi/session-results.js";
import { createRouterRuntime } from "../../runtime/router.js";
import { activateTurnHarness, startLiveInput } from "../../execution/pi/turn-runner.js";
import { generateEngineTurnResponse, preparePiNativeDispatch } from "../../execution/pi/run.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function active() {
  const dispatchProgress = createDispatchProgress(), hooks: Record<string, (event: unknown) => unknown> = {};
  let subscriber: (event: unknown) => void;
  const runState = { dispatchProgress, assistantTexts: [], assistantThinking: [], textDeltaIndexes: new Set(), thinkingDeltaIndexes: new Set(), toolStartTimes: new Map(), toolApprovals: new Map(), toolExecutionsThisTurn: 0, turnCount: 0 };
  const harness = { on(type: string, handler: (event: unknown) => unknown) { hooks[type] = handler; }, subscribe(handler: typeof subscriber) { subscriber = handler; }, abort: async () => {}, getModel: () => ({ contextWindow: 10000 }) };
  expect(dispatchProgress.armed).toBe(false);
  activateTurnHarness(runState, { harness, onEvent() {}, options: {}, toolLimits: {}, sdk: "pi", reference: "faux:fictional" });
  expect(dispatchProgress).toEqual({ version: 1, armed: true, toolAdmitted: false, liveInputTaken: false });
  return { dispatchProgress, hooks, emit: (event: unknown) => subscriber(event) };
}

it.each(["before_tool", "tool_execution_start"])("detects tool admission at %s", (path) => {
  const f = active();
  if (path === "before_tool") f.hooks.before_tool!({ toolName: "Read" });
  else f.emit({ type: path, toolName: "FictionalLookup", toolCallId: "fictional-call", args: {} });
  expect(f.dispatchProgress.toolAdmitted).toBe(true);
});

it.each([false, true])("marks yielded live input before steering, even when steering throws (throws=%s)", async (throws) => {
  const f = active(), delivered = Promise.withResolvers();
  const harness = { async steer() { expect(f.dispatchProgress.liveInputTaken).toBe(true); delivered.resolve(); if (throws) throw new Error("Fictional uncertain delivery"); return "fictional-entry"; }, cancelQueued: async () => ({ status: "cancelled" }) };
  const consumer = startLiveInput({ harness, options: { liveInput: (async function* () { yield { body: "Fictional steer" }; })() }, onEvent() {}, dispatchProgress: f.dispatchProgress });
  await delivered.promise; await consumer.stop(); expect(f.dispatchProgress.liveInputTaken).toBe(true);
});

it.each([undefined, null, {}, { version: 2, armed: true, toolAdmitted: false, liveInputTaken: false }, { version: 1, armed: true, toolAdmitted: "false", liveInputTaken: false }, { version: 1, armed: true, toolAdmitted: false }])("rejects absent/malformed progress markers: %j", (marker) => {
  expect(isDispatchProgress(marker)).toBe(false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-progress-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "fictional", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined } as unknown as Parameters<typeof fauxProvider>[0]), models = createModels(); models.setProvider(faux.provider);
  const options = { model: { provider: "faux", model: "fictional", reference: "faux:fictional" }, messages: [{ role: "user", content: "Fictional input" }], piResolvedModel: faux.getModel(), piResolvedModels: models,
    cwd: root, allowedTools: [], compaction: { enabled: false }, piMaxRetries: 0, providerCheckMaxTokens: 4096 };
  return { root, faux, options };
}

it.each([false, true])("stamps real direct/prepared execution after replay seeding (prepared=%s)", async (prepared) => {
  const f = await fixture(); f.faux.setResponses([fauxAssistantMessage([fauxText("Fictional answer")])]);
  const options = { ...f.options, messages: [{ role: "assistant", content: "Fictional earlier answer" }, ...f.options.messages] };
  const lease = prepared ? await preparePiNativeDispatch("Fictional rules", options) : undefined;
  if (lease) cleanups.push(() => lease.close());
  const result = lease ? await lease.run() : await generateEngineTurnResponse("Fictional rules", options);
  expect(result.dispatchProgress).toEqual({ version: 1, armed: true, toolAdmitted: false, liveInputTaken: false });
  expect(Object.isFrozen(result.dispatchProgress)).toBe(true);
});

it.each(["abort", "invalid descriptor", "no output error", "tool then error"])("stamps the %s result path", async (path) => {
  const f = await fixture();
  const controller = new AbortController(); if (path === "abort") controller.abort();
  const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "Fictional connection failure" });
  f.faux.setResponses(path === "tool then error" ? [fauxAssistantMessage([fauxToolCall("Read", { file_path: join(f.root, "fictional-missing.txt") })]), failure] : [failure]);
  const result = await generateEngineTurnResponse("Fictional rules", { ...f.options, messages: [{ role: "assistant", content: "Fictional restored output" }, ...f.options.messages], abortSignal: controller.signal,
    ...(path === "invalid descriptor" ? { sessionTurn: { kind: "invalid" } } : {}), ...(path === "tool then error" ? { allowedTools: ["Read"] } : {}) });
  expect(isDispatchProgress(result.dispatchProgress)).toBe(true);
  if (path !== "abort") expect(result.error).toBeTruthy();
  if (path === "abort" || path === "invalid descriptor") expect(result.dispatchProgress.armed).toBe(false);
  else if (path === "no output error") expect(result.dispatchProgress).toEqual({ version: 1, armed: true, toolAdmitted: false, liveInputTaken: false });
  else expect(result.dispatchProgress).toMatchObject({ armed: true, toolAdmitted: true });
});

it("stamps the native catch result without treating seeded history as output", async () => {
  const f = await fixture();
  vi.spyOn(f.faux.provider, "streamSimple").mockImplementation(() => { throw new Error("Fictional provider exception"); });
  const result = await generateEngineTurnResponse("Fictional rules", { ...f.options, messages: [{ role: "assistant", content: "Fictional seeded answer" }, ...f.options.messages] });
  expect(result.error).toBeTruthy(); expect(result.dispatchProgress).toEqual({ version: 1, armed: true, toolAdmitted: false, liveInputTaken: false });
});


it.each([new Error("Fictional error"), Object.freeze(new Error("Fictional frozen error")), "Fictional primitive throw"])("attaches immutable progress to extensible/frozen/primitive throws", (error) => {
  const progress = { ...createDispatchProgress(), armed: true, toolAdmitted: true };
  const annotated = withDispatchProgress(error, progress);
  expect(annotated.dispatchProgress.toolAdmitted).toBe(true); expect(Object.isFrozen(annotated.dispatchProgress)).toBe(true);
  progress.toolAdmitted = false; expect(annotated.dispatchProgress.toolAdmitted).toBe(true);
  if (error instanceof Error && Object.isExtensible(error)) expect(annotated).toBe(error); else expect(annotated.cause).toBe(error);
});

function beforeToolHook(handler: (event: unknown) => unknown, { hideToolStarts = false, execute }: { hideToolStarts?: boolean; execute?: (...args: unknown[]) => unknown } = {}) {
  const create = sessionAdapter.createHarnessAdapter;
  vi.spyOn(sessionAdapter, "createHarnessAdapter").mockImplementation(async (session, options) => {
    const harness = await create(session, { ...options, tools: options.tools.map((tool: { name: string; execute: (...args: unknown[]) => unknown }) =>
      tool.name === "Read" && execute ? { ...tool, execute } : tool) }), on = harness.on.bind(harness);
    harness.on = (type, callback) => {
      const remove = on(type, callback);
      if (type === "before_tool") on(type, handler); // after the bridge's progress hook
      return remove;
    };
    if (hideToolStarts) {
      const subscribe = harness.subscribe.bind(harness);
      harness.subscribe = (listener) => subscribe((event: { type: string }) => { if (!event.type.startsWith("tool_execution_")) listener(event); });
    }
    return harness;
  });
}

it("retains before-tool evidence when native cleanup throws, blocking retry and backup", async () => {
  const f = await fixture(), beforeTool = vi.fn(() => { throw new Error("Fictional failure before execution"); });
  beforeToolHook(beforeTool, { hideToolStarts: true });
  vi.spyOn(sessionLifecycle, "commitSession").mockRejectedValue(new Error("Fictional settlement failure after admission"));
  const cleanup = vi.spyOn(sessionLifecycle, "cleanupSessionOnThrow").mockRejectedValue(new Error("Connection error."));
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("Read", { file_path: join(f.root, "fictional-missing.txt") })])]);
  const primaryRun = vi.fn((prompt, options) => generateEngineTurnResponse(prompt, { ...f.options, ...options, allowedTools: ["Read"] })), backupRun = vi.fn();
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 2 }, { provider: "anthropic", model: "fictional-backup", reference: "anthropic:fictional-backup" }], retry: { backoffMs: 0, maxBackoffMs: 0 },
    resolveAttempt: ({ attemptIndex }) => ({ runtime: { configureTools() {}, run: attemptIndex ? backupRun : primaryRun } }) });
  const events: Array<{ type: string; message?: { content?: Array<{ type: string }> } }> = [], result = await router.run("Fictional rules", { ...f.options, onEvent: (event) => events.push(event) });
  expect(beforeTool, String(result.error)).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
  expect(primaryRun).toHaveBeenCalledOnce(); expect(backupRun).not.toHaveBeenCalled();
  expect(result.dispatchProgress).toMatchObject({ armed: true, toolAdmitted: true });
  expect(Object.isFrozen(result.dispatchProgress)).toBe(true);
  expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({ reason: "tool_already_executed" }));
  expect(events.some((event) => event.type === "tool_execution_start" || event.message?.content?.some((part) => part.type === "tool_use"))).toBe(false);
});

it("counts a before-tool hook-blocked call conservatively without executing it", async () => {
  const f = await fixture(), blocked = vi.fn(() => ({ block: { reason: "Fictional blocked admission", terminate: true } })), execute = vi.fn();
  beforeToolHook(blocked, { execute });
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("Read", { file_path: join(f.root, "fictional-missing.txt") })])]);
  const result = await generateEngineTurnResponse("Fictional rules", { ...f.options, allowedTools: ["Read"] });
  expect(blocked, String(result.error)).toHaveBeenCalledOnce(); expect(result.dispatchProgress.toolAdmitted).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

it("blocks a real faux-Pi backup after yielded live input and provider failure", async () => {
  const f = await fixture(), yielded = Promise.withResolvers(), backupRun = vi.fn();
  f.faux.setResponses([async () => { await yielded.promise; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." }); }]);
  const liveInput = { async *[Symbol.asyncIterator]() { yielded.resolve(); yield { id: "fictional-live", body: "Fictional guidance" }; } };
  const primaryRun = vi.fn((prompt, options) => generateEngineTurnResponse(prompt, { ...f.options, ...options }));
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 2 }, { provider: "anthropic", model: "fictional-backup", reference: "anthropic:fictional-backup" }], retry: { backoffMs: 0, maxBackoffMs: 0 },
    resolveAttempt: ({ attemptIndex }) => ({ runtime: { configureTools() {}, run: attemptIndex ? backupRun : primaryRun } }) });
  const result = await router.run("Fictional rules", { ...f.options, liveInput });
  expect(result.dispatchProgress).toMatchObject({ armed: true, liveInputTaken: true, toolAdmitted: false });
  expect(primaryRun).toHaveBeenCalledOnce(); expect(backupRun).not.toHaveBeenCalled();
  expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({ reason: "live_input_consumed" }));
});
