import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createDispatchProgress, isDispatchProgress, hasNoDispatchProgress } from "../../ai/providers/pi-native/dispatch-progress.js";
import { activateTurnHarness, startLiveInput } from "../../ai/providers/pi-native/turn-runner.js";
import { generatePiNativeResponse, preparePiNativeDispatch } from "../../ai/providers/pi-native.js";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function active() {
  const dispatchProgress = createDispatchProgress(), hooks = {};
  let subscriber;
  const runState = { dispatchProgress, assistantTexts: [], assistantThinking: [], textDeltaIndexes: new Set(), thinkingDeltaIndexes: new Set(), toolStartTimes: new Map(), toolApprovals: new Map(), toolExecutionsThisTurn: 0, turnCount: 0 };
  const harness = { on(type, handler) { hooks[type] = handler; }, subscribe(handler) { subscriber = handler; }, abort: async () => {}, getModel: () => ({ contextWindow: 10000 }) };
  expect(hasNoDispatchProgress(dispatchProgress)).toBe(false);
  activateTurnHarness(runState, { harness, onEvent() {}, options: {}, toolLimits: {}, sdk: "pi", reference: "faux:fictional" });
  expect(hasNoDispatchProgress(dispatchProgress)).toBe(true);
  return { dispatchProgress, hooks, emit: (event) => subscriber(event) };
}

it.each(["text_delta", "text_end", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"])("detects %s, including end-only output and tool-call-only streams", (type) => {
  const f = active();
  f.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type, delta: "Fictional output", content: "Fictional output", contentIndex: 0 } });
  expect(f.dispatchProgress.assistantOutput).toBe(true); expect(hasNoDispatchProgress(f.dispatchProgress)).toBe(false);
  for (const type of ["start", "done", "error"]) f.emit({ type: "message_update", assistantMessageEvent: { type } });
  expect(f.dispatchProgress.assistantOutput).toBe(true); // Later events/re-prompts cannot clear it.
});

it.each(["subscriber", "after_response"])("detects tool-only message_end through %s without a delta", (path) => {
  const f = active(), message = { role: "assistant", content: [{ type: "toolCall", id: "fictional-call", name: "Read", arguments: {} }] };
  if (path === "subscriber") f.emit({ type: "message_end", message }); else f.hooks.after_response({ message });
  expect(f.dispatchProgress.assistantOutput).toBe(true); expect(f.dispatchProgress.toolAdmitted).toBe(false);
});

it("ignores empty messages and lifecycle-only start/done/error events", () => {
  const f = active();
  for (const type of ["start", "done", "error"]) f.emit({ type: "message_update", assistantMessageEvent: { type } });
  f.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
  f.hooks.after_response({ message: { role: "user", content: [{ type: "text", text: "Fictional replay" }] } });
  expect(hasNoDispatchProgress(f.dispatchProgress)).toBe(true);
});

it.each(["before_tool", "tool_execution_start"])("detects tool admission at %s", (path) => {
  const f = active();
  if (path === "before_tool") f.hooks.before_tool({ toolName: "Read" });
  else f.emit({ type: path, toolName: "FictionalLookup", toolCallId: "fictional-call", args: {} });
  expect(f.dispatchProgress.toolAdmitted).toBe(true); expect(hasNoDispatchProgress(f.dispatchProgress)).toBe(false);
});

it.each([false, true])("marks yielded live input before steering, even when steering throws (throws=%s)", async (throws) => {
  const f = active(), delivered = Promise.withResolvers();
  const harness = { async steer() { expect(f.dispatchProgress.liveInputTaken).toBe(true); delivered.resolve(); if (throws) throw new Error("Fictional uncertain delivery"); return "fictional-entry"; }, cancelQueued: async () => ({ status: "cancelled" }) };
  const consumer = startLiveInput({ harness, options: { liveInput: (async function* () { yield { body: "Fictional steer" }; })() }, onEvent() {}, dispatchProgress: f.dispatchProgress });
  await delivered.promise; await consumer.stop(); expect(f.dispatchProgress.liveInputTaken).toBe(true);
});

it.each([undefined, null, {}, { version: 2, armed: true, assistantOutput: false, toolAdmitted: false, liveInputTaken: false }, { version: 1, armed: true, assistantOutput: "false", toolAdmitted: false, liveInputTaken: false }, { version: 1, armed: true, assistantOutput: false, toolAdmitted: false }, { version: 1, armed: false, assistantOutput: false, toolAdmitted: false, liveInputTaken: false }])("never certifies absent/malformed/unarmed progress as empty: %j", (marker) => {
  expect(hasNoDispatchProgress(marker)).toBe(false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-progress-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "fictional", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined }), models = createModels(); models.setProvider(faux.provider);
  const options = { model: { provider: "faux", model: "fictional", reference: "faux:fictional" }, messages: [{ role: "user", content: "Fictional input" }], piResolvedModel: faux.getModel(), piResolvedModels: models,
    cwd: root, allowedTools: [], compaction: { enabled: false }, piMaxRetries: 0, providerCheckMaxTokens: 4096 };
  return { root, faux, options };
}

it.each([false, true])("stamps real direct/prepared execution after replay seeding (prepared=%s)", async (prepared) => {
  const f = await fixture(); f.faux.setResponses([fauxAssistantMessage([fauxText("Fictional answer")])]);
  const options = { ...f.options, messages: [{ role: "assistant", content: "Fictional earlier answer" }, ...f.options.messages] };
  const lease = prepared ? await preparePiNativeDispatch("Fictional rules", options) : undefined;
  if (lease) cleanups.push(() => lease.close());
  const result = lease ? await lease.run() : await generatePiNativeResponse("Fictional rules", options);
  expect(result.dispatchProgress).toEqual({ version: 1, armed: true, assistantOutput: true, toolAdmitted: false, liveInputTaken: false });
  expect(Object.isFrozen(result.dispatchProgress)).toBe(true);
});

it.each(["abort", "invalid descriptor", "no output error", "tool then error"])("stamps the %s result path", async (path) => {
  const f = await fixture();
  const controller = new AbortController(); if (path === "abort") controller.abort();
  const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "Fictional connection failure" });
  f.faux.setResponses(path === "tool then error" ? [fauxAssistantMessage([fauxToolCall("Read", { path: join(f.root, "fictional-missing.txt") })]), failure] : [failure]);
  const result = await generatePiNativeResponse("Fictional rules", { ...f.options, messages: [{ role: "assistant", content: "Fictional restored output" }, ...f.options.messages], abortSignal: controller.signal,
    ...(path === "invalid descriptor" ? { sessionTurn: { kind: "invalid" } } : {}), ...(path === "tool then error" ? { allowedTools: ["Read"] } : {}) });
  expect(isDispatchProgress(result.dispatchProgress)).toBe(true);
  if (path !== "abort") expect(result.error).toBeTruthy();
  if (path === "abort" || path === "invalid descriptor") expect(result.dispatchProgress.armed).toBe(false);
  else if (path === "no output error") expect(hasNoDispatchProgress(result.dispatchProgress)).toBe(true);
  else expect(result.dispatchProgress).toMatchObject({ armed: true, assistantOutput: true, toolAdmitted: true });
});

it("stamps the native catch result without treating seeded history as output", async () => {
  const f = await fixture();
  vi.spyOn(f.faux.provider, "streamSimple").mockImplementation(() => { throw new Error("Fictional provider exception"); });
  const result = await generatePiNativeResponse("Fictional rules", { ...f.options, messages: [{ role: "assistant", content: "Fictional seeded answer" }, ...f.options.messages] });
  expect(result.error).toBeTruthy(); expect(hasNoDispatchProgress(result.dispatchProgress)).toBe(true);
});
