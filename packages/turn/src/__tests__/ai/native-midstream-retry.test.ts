import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { PiTool } from "../../execution/pi/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple as sdkCodexStreamSimple } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import * as sessionAdapter from "../../execution/pi/driver-adapter.js";
import { generateEngineTurnResponse, preparePiNativeDispatch } from "../../execution/pi/run.js";
import { isTransientRequestFailure } from "../../execution/pi/request-retry.js";
import { projectContext } from "../../engine/request-projection.js";

// Production backoff is 1 s, 2 s, 4 s. Keep the real policy and only shrink it.
const backoff = vi.hoisted(() => ({ baseDelayMs: 0 }));
vi.mock("../../execution/pi/request-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../execution/pi/request-retry.js")>();
  return { ...actual, requestRetryPolicy: (params: Parameters<typeof actual.requestRetryPolicy>[0]) => ({ ...actual.requestRetryPolicy(params), baseDelayMs: backoff.baseDelayMs }) };
});

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  backoff.baseDelayMs = 0;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(responses: AssistantMessage[], overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "midstream-retry-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "fictional", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined } as unknown as Parameters<typeof fauxProvider>[0]);
  const models = createModels(); models.setProvider(faux.provider);
  const contexts: Context[] = [];
  faux.setResponses(responses.map((response) => (context) => { contexts.push(structuredClone(context)); return response; }));
  const options = { model: { provider: "faux", model: "fictional", reference: "faux:fictional" }, messages: [{ role: "user", content: "Fictional input" }],
    piResolvedModel: faux.getModel(), piResolvedModels: models, cwd: root, allowedTools: [], compaction: { enabled: false }, ...overrides };
  return { root, faux, models, options, contexts };
}
const failed = (errorMessage: string, content: AssistantMessage["content"] = [fauxText("Fictional partial answer")]) => fauxAssistantMessage(content, { stopReason: "error", errorMessage });
const answer = (text = "Fictional final answer") => fauxAssistantMessage([fauxText(text)]);

/** Snapshot the native journal before the harness closes, and count tool runs. */
function observeHarness() {
  const seen: { entries: Array<{ type: string; message: AssistantMessage }>; toolRuns: string[] } = { entries: [], toolRuns: [] };
  const create = sessionAdapter.createHarnessAdapter;
  vi.spyOn(sessionAdapter, "createHarnessAdapter").mockImplementation(async (session, options) => {
    const harness = await create(session, { ...options, tools: options.tools.map((tool: PiTool) => ({ ...tool,
      async execute(toolCallId: string, ...rest: Parameters<PiTool["execute"]> extends [string, ...infer Rest] ? Rest : never) { seen.toolRuns.push(toolCallId); return tool.execute(toolCallId, ...rest); } })) });
    const close = harness.close.bind(harness);
    harness.close = async () => { seen.entries = await session.rawSession.getEntries(); return close(); };
    return harness;
  });
  return seen;
}
const assistantEntries = (seen: ReturnType<typeof observeHarness>) => seen.entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message);
const retryWarnings = (result: { events: Array<{ type: string; warning_kind?: string; attempt?: number }> }) => result.events.filter((event) => event.type === "runtime_warning" && event.warning_kind === "provider_request_retry");

it.each(["WebSocket error", "WebSocket closed 1006", "WebSocket stream closed before response.completed"])(
  "retries a request that failed mid-stream with %s and replies without the partial", async (errorMessage) => {
    const f = await fixture([failed(errorMessage), answer()]);
    const seen = observeHarness();
    const result = await generateEngineTurnResponse("Fictional rules", f.options);
    expect(result.error).toBeNull(); expect(result.text).toBe("Fictional final answer");
    expect(f.faux.state.callCount).toBe(2);
    // The retry re-sends the identical request: the failed partial never enters it.
    expect(f.contexts[1]!.messages).toEqual(f.contexts[0]!.messages);
    expect(JSON.stringify(f.contexts[1])).not.toContain("Fictional partial answer");
    // The failed attempt stays journaled as an error (trace + accounting), outside the projected context.
    const assistants = assistantEntries(seen);
    expect(assistants.map((message) => message.stopReason)).toEqual(["error", "stop"]);
    expect(assistants[0]!.errorMessage).toBe(errorMessage);
    const context = projectContext(seen.entries)!.messages!.filter((message) => message.role === "assistant");
    expect(context).toHaveLength(1); expect(context[0]!.content).toEqual([{ type: "text", text: "Fictional final answer" }]);
    // Partial paid usage is still billed to the run.
    const sum = (key: "input" | "output") => assistants.reduce((total, message) => total + message.usage[key], 0);
    expect(assistants[0]!.usage.input).toBeGreaterThan(0);
    expect(result.usage.input_tokens).toBe(sum("input")); expect(result.usage.output_tokens).toBe(sum("output"));
    expect(retryWarnings(result)).toEqual([expect.objectContaining({ source: "pi", attempt: 2, max_attempts: 4, reason: expect.any(String) })]);
    expect(result.diagnostics.pi_request_retries).toBe(1);
  });

it("fails with the provider classification and attempt count when the failure persists", async () => {
  const f = await fixture(Array.from({ length: 6 }, () => failed("WebSocket error")));
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(f.faux.state.callCount).toBe(4);
  expect(result.error).toBe("WebSocket error (failed after 4 provider request attempts)");
  expect(result.failureKind).toBe("provider_unavailable");
  expect(retryWarnings(result).map((warning) => warning.attempt)).toEqual([2, 3, 4]);
  expect(result.diagnostics.pi_request_retries).toBe(3);
  // Like a single-shot failure, only the terminal partial is reported, never one per attempt.
  expect(result.text).toBe("Fictional partial answer");
});

it("never re-runs a tool executed by an earlier message, and never runs a failed partial's call", async () => {
  const f = await fixture([], { allowedTools: ["Read"] });
  await writeFile(join(f.root, "fictional.txt"), "Fictional contents");
  const read = (id: string) => fauxToolCall("Read", { file_path: join(f.root, "fictional.txt") }, { id });
  const responses = [
    fauxAssistantMessage([read("executed-call")], { stopReason: "toolUse" }),
    failed("WebSocket closed 1006", [fauxText("Reading again"), read("partial-call")]),
    answer(),
  ];
  f.faux.setResponses(responses.map((response) => (context) => { f.contexts.push(structuredClone(context)); return response; }));
  const seen = observeHarness();
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional final answer");
  expect(f.faux.state.callCount).toBe(3);
  expect(seen.toolRuns).toEqual(["executed-call"]);
  // The retried request keeps the earlier assistant call and its tool result intact.
  expect(f.contexts[2]!.messages).toEqual(f.contexts[1]!.messages);
  expect(f.contexts[2]!.messages.some((message) => message.role === "toolResult" && message.toolCallId === "executed-call")).toBe(true);
  expect(JSON.stringify(f.contexts[2])).not.toContain("partial-call");
});

it.each([
  "401 Unauthorized: invalid api key",
  "You have hit your ChatGPT usage limit (fictional plan). Try again in 20 min.",
  "Your input exceeds the context window of this model.",
  "400 invalid_request_error: Unknown parameter: 'fictional'",
  "insufficient_quota: billing hard limit reached",
])("does not retry non-transient mid-stream failures: %s", async (errorMessage) => {
  const f = await fixture([failed(errorMessage), answer()]);
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(f.faux.state.callCount).toBe(1); expect(result.error).toBeTruthy();
  expect(result.error).not.toContain("provider request attempts"); expect(retryWarnings(result)).toEqual([]);
});

it.each(["WebSocket error", "503 service unavailable"])("leaves failures before a response starts to the SDK layer (%s)", async (errorMessage) => {
  const f = await fixture([]);
  const stream = vi.fn((model: Model<string>) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
    queueMicrotask(() => { events.push({ type: "error", reason: "error", error: message }); events.end(message); });
    return events;
  });
  f.models.setProvider({ ...f.faux.provider, streamSimple: stream });
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(stream).toHaveBeenCalledOnce(); expect(result.error).toBe(errorMessage);
});

it("stops promptly when cancelled during the retry backoff", async () => {
  backoff.baseDelayMs = 60_000;
  const f = await fixture([failed("WebSocket error"), answer()]);
  const controller = new AbortController();
  const started = performance.now();
  const result = await generateEngineTurnResponse("Fictional rules", { ...f.options, abortSignal: controller.signal,
    onEvent: (event: { type: string; warning_kind?: string }) => { if (event.type === "runtime_warning" && event.warning_kind === "provider_request_retry") controller.abort(); } });
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(result.cancelled).toBe(true); expect(f.faux.state.callCount).toBe(1);
});

it.each([{ piMaxRetries: 0 }, { providerCheckMaxTokens: 16 }])("keeps %j single-shot", async (overrides) => {
  const f = await fixture([failed("WebSocket error"), answer()], overrides);
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(f.faux.state.callCount).toBe(1); expect(result.error).toBe("WebSocket error");
});

it("retries mid-stream failures on primary-only prepared native dispatch", async () => {
  const f = await fixture([failed("WebSocket error"), answer()]);
  const lease = await preparePiNativeDispatch("Fictional rules", f.options);
  cleanups.push(() => lease.close());
  const result = await lease.run();
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional final answer");
  expect(f.faux.state.callCount).toBe(2);
});

it("classifies transient transport/server failures only", async () => {
  const { requestRetryPolicy: realPolicy } = await vi.importActual<typeof import("../../execution/pi/request-retry.js")>("../../execution/pi/request-retry.js");
  for (const text of ["WebSocket error", "WebSocket closed 1006", "WebSocket closed 1011 internal error", "WebSocket stream closed before response.completed",
    "WebSocket idle timeout after 300000ms", "terminated", "socket hang up", "Connection error.", "read ECONNRESET", "Overloaded", "502 Bad Gateway",
    "429 Too Many Requests", "Anthropic stream ended before message_stop"]) expect(isTransientRequestFailure(text), text).toBe(true);
  for (const text of ["401 Unauthorized", "invalid api key", "403 Forbidden", "You have hit your ChatGPT usage limit", "insufficient_quota",
    "context_length_exceeded: maximum context length is 200000 tokens", "Request was aborted", "Assistant request exceeded the context window",
    "400 Bad Request: invalid_request_error", "Fictional validation failure", "", null]) expect(isTransientRequestFailure(text), String(text)).toBe(false);
  expect(realPolicy({ maxRetries: 2, maxRetryDelayMs: 60_000, providerCheck: false })).toMatchObject({ enabled: true, maxRetries: 3, baseDelayMs: 1000 });
  expect(realPolicy({ maxRetries: 0, maxRetryDelayMs: 60_000, providerCheck: false })).toMatchObject({ enabled: false, maxRetries: 0 });
  expect(realPolicy({ maxRetries: 8, maxRetryDelayMs: 60_000, providerCheck: true })).toMatchObject({ enabled: false, maxRetries: 0 });
  expect(realPolicy({ maxRetries: 2, maxRetryDelayMs: 60_000, providerCheck: false }).shouldRetry({ errorMessage: "WebSocket error" }, { responseStarted: false })).toBe(false);
});

// Real Codex SDK transport over a scripted websocket: failures after the first
// stream event are thrown as-is by pi-ai (no in-request SSE fallback). pi-ai
// then pins the session to SSE, so the driver's retry is served over SSE.
function codexEvents(n: number, text: string) {
  const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: `resp_${n}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } };
  return { started: [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
  ], completed: [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }] };
}
class FictionalCodexSocket extends EventTarget {
  static plan = "error"; static instances: FictionalCodexSocket[] = [];
  declare readyState: number;
  declare sent: Array<{ input: unknown }>;
  constructor() {
    super(); this.readyState = 0; this.sent = []; FictionalCodexSocket.instances.push(this);
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(data: string) { this.sent.push(JSON.parse(data)); setTimeout(() => this.respond()); }
  close() { this.readyState = 3; }
  message(payload: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(payload) })); }
  respond() {
    for (const event of codexEvents(1, "Fictional partial answer").started) this.message(event);
    setTimeout(() => {
      if (FictionalCodexSocket.plan === "error") this.dispatchEvent(new Event("error"));
      else this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "", wasClean: false }));
    }, 5);
  }
}

it.each([["error", "WebSocket error"], ["close", "WebSocket closed 1006"]])("retries a real Codex websocket %s after the stream started", async (plan, errorMessage) => {
  FictionalCodexSocket.plan = plan; FictionalCodexSocket.instances = [];
  vi.stubGlobal("WebSocket", FictionalCodexSocket);
  const f = await fixture([], { piTransport: "websocket" });
  const codexToken = ["fictional", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64"), "fictional"].join(".");
  const bodies: Array<{ input: unknown }> = [];
  const fetch = vi.fn(async (_url, init) => {
    const raw = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body).toString("utf8") : String(init.body);
    bodies.push(JSON.parse(raw));
    const { started, completed } = codexEvents(2, "Fictional final answer");
    return new Response([...started, ...completed].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  });
  f.models.setProvider({ ...f.faux.provider, streamSimple: (model, context, options) => sdkCodexStreamSimple({ ...model, provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: "https://fictional.invalid/backend-api" }, context, { ...options, apiKey: codexToken, fetch }) });
  const seen = observeHarness();
  const result = await generateEngineTurnResponse("Fictional rules", f.options);
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional final answer");
  expect(FictionalCodexSocket.instances).toHaveLength(1); expect(fetch).toHaveBeenCalledOnce();
  // The retry re-sends the same input; the failed partial is not part of it.
  expect(bodies[0]!.input).toEqual(FictionalCodexSocket.instances[0]!.sent[0]!.input);
  expect(JSON.stringify(bodies[0])).not.toContain("Fictional partial answer");
  const assistants = assistantEntries(seen);
  expect(assistants.map((message) => [message.stopReason, message.errorMessage])).toEqual([["error", errorMessage], ["stop", undefined]]);
  expect(result.usage.input_tokens).toBe(assistants.reduce((total, message) => total + message.usage.input, 0));
  expect(retryWarnings(result)).toHaveLength(1);
});
