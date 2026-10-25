import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { completeContinuityUpkeep, constrainUpkeepPayload, upkeepCapEnforcement } from "../../execution/pi/continuity-upkeep.js";
const apis = ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "google-generative-ai", "google-vertex", "bedrock-converse-stream", "mistral-conversations", "pi-messages"];
const token = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64url")}.fictional`;
const reference = { provider: "fictional", model: "fixture", reference: "fictional:fixture" };
function model(api: string) { return { ...fauxProvider({ models: [{ id: "fixture", contextWindow: 128000, maxTokens: 8192 }] }).getModel(), provider: "fictional", id: "fixture", api, baseUrl: "https://fixture.invalid/v1" }; }
afterEach(() => vi.unstubAllGlobals());

it.each(apis)("proves one real %s request builder, enforcement class and inclusive cap without transport", async api => {
  const network = vi.fn(async () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }); vi.stubGlobal("fetch", network);
  const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
  let captured: any, calls = 0;
  await adapter.streamSimple(model(api), { systemPrompt: "Fictional extraction.", messages: [{ role: "user", content: "Fictional evidence.", timestamp: 0 }] }, {
    apiKey: api === "openai-codex-responses" ? token : "synthetic-test-value", env: { AWS_REGION: "us-east-1" }, transport: "sse", maxRetries: 0, maxTokens: 4096,
    onPayload(payload: any) { calls++; constrainUpkeepPayload(api, payload); captured = payload; throw new Error("OFFLINE_CAPTURE_STOP"); },
  }).result();
  expect(calls).toBe(1); expect(network).not.toHaveBeenCalled();
  const cap = JSON.stringify(captured);
  expect(upkeepCapEnforcement(api)).toBe(api === "openai-codex-responses" ? "stream_abort" : "request");
  if (api === "openai-codex-responses") expect(cap).not.toMatch(/max_output_tokens|maxTokens|max_tokens/);
  else expect(cap).toContain("4096");
});

async function codex(events: unknown[], strict = false, abortSignal = new AbortController().signal, budget?: { operationId: string; inputTokens: 64000 | 128000 }, prompt = "Fictional source selection.") {
  const adapter = await import("@earendil-works/pi-ai/api/openai-codex-responses");
  let signal: AbortSignal | undefined, optionsSeen: any, payloadSeen: any;
  const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  const transport = vi.fn(async (_url: unknown, options: RequestInit) => {
    signal = options.signal ?? undefined;
    return new Response(wire, { status: 200, headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", transport);
  const selected = { ...model("openai-codex-responses"), reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" } };
  const stream = vi.fn((m: any, context: any, options: any) => { optionsSeen = options; return adapter.streamSimple(m, context, { ...options, apiKey: token, onPayload(payload: any) { options.onPayload(payload); payloadSeen = payload; } }); });
  const models = { getModel: () => selected, streamSimple: stream };
  const result = await completeContinuityUpkeep(prompt, { model: reference, messages: [], abortSignal, piResolvedModels: models as never }, strict, budget);
  return { result, transport, stream, signal, optionsSeen, payloadSeen };
}
const created = { type: "response.created", response: { id: "fictional-response" } };
const added = { type: "response.output_item.added", output_index: 0, item: { id: "fictional-output", type: "message", role: "assistant", content: [] } };
const done = (output: number, input = 100, cached = 0) => ({ type: "response.completed", response: { id: "fictional-response", status: "completed", output: [], usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, total_tokens: output + input } } });

it("aborts Codex visible output at the cap even when scripted SSE keeps emitting, and rejects all output", async () => {
  const frames = [created, added, ...Array.from({ length: 20 }, () => ({ type: "response.output_text.delta", output_index: 0, delta: "x".repeat(1024) })), done(6000)];
  const { result, transport, stream, signal, optionsSeen } = await codex(frames);
  expect(stream).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
  expect(optionsSeen).toMatchObject({ transport: "sse", maxRetries: 0, maxTokens: 4096, reasoning: "minimal" });
  expect(signal?.aborted).toBe(true); expect(result.receipt.capEnforcement).toBe("stream_abort");
  expect(result.receipt.status).toBe("invalid"); expect(result.receipt.visibleEstimate).toBeGreaterThanOrEqual(4096);
  expect(result.text).toBeUndefined();
});

it("strict mode skips Codex before any completion or mocked transport invocation", async () => {
  const { result, transport, stream } = await codex([], true);
  expect(stream).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  expect(result.receipt).toMatchObject({ status: "skipped", reason: "cap_unsupported", capEnforcement: "stream_abort", providerInvoked: false, costUsd: 0 });
});

it("retains reported output overrun in the content-free receipt without a repair call", async () => {
  const { result, transport } = await codex([created, added, done(5000)]);
  expect(transport).toHaveBeenCalledTimes(1); expect(result.receipt.outputOverrun).toBe(true);
  expect(result.receipt.outputTokens).toBe(5000); expect(result.receipt.status).toBe("invalid");
});

it("rejects reported cached-plus-uncached input overruns before publication", async () => {
  const { result, transport } = await codex([created, added, { type: "response.output_text.delta", output_index: 0, delta: "{}" }, done(1, 66000, 65000)]);
  expect(transport).toHaveBeenCalledTimes(1); expect(result.receipt).toMatchObject({ status: "invalid", reason: "input_overrun", inputTokens: 66000 });
  expect(result.text).toBeUndefined();
});
it("honors an already aborted caller without dispatch", async () => {
  const controller = new AbortController(); controller.abort();
  const { result, stream, transport } = await codex([], false, controller.signal);
  expect(stream).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  expect(result.receipt).toMatchObject({ status: "skipped", reason: "aborted", providerInvoked: false });
});
it("refuses a mismatched resolved model rather than silently substituting it", async () => {
  const stream = vi.fn();
  const result = await completeContinuityUpkeep("Fictional input.", { model: reference, messages: [], abortSignal: new AbortController().signal,
    piResolvedModels: { getModel: () => ({ ...model("openai-responses"), id: "wrong" }), streamSimple: stream } as never });
  expect(stream).not.toHaveBeenCalled(); expect(result.receipt).toMatchObject({ status: "skipped", reason: "model_identity" });
});

it("guards full visible Codex items even when a stream omits incremental deltas", async () => {
  const completed = { type: "response.output_item.done", output_index: 0, item: { id: "fictional-output", type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(5000) }] } };
  const { result, transport, signal } = await codex([created, added, completed, done(0)]);
  expect(transport).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true);
  expect(result.receipt).toMatchObject({ status: "invalid", reason: "output_aborted" });
  expect(result.receipt.visibleEstimate).toBeGreaterThanOrEqual(5000); expect(result.text).toBeUndefined();
});

it("reaches an actual local-provider builder without injected resolved models", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }] }), { status: 200, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
  const result = await completeContinuityUpkeep("Fictional local input.", { model: { provider: "ollama", model: "fixture", reference: "ollama:fixture" }, messages: [], abortSignal: new AbortController().signal,
    customProvider: { id: "ollama", enabled: true, provider_type: "ollama", base_url: "http://127.0.0.1:1" }, modelCapabilities: { context_window: 128000, max_tokens: 8192 }, isPrivateProvider: true } as never);
  expect(fetch).toHaveBeenCalledTimes(1); expect(result.receipt.reason).not.toBe("model_identity"); expect(result.receipt.providerInvoked).toBe(true);
});
it("classifies a swallowed onPayload cap refusal as a zero-dispatch skip", async () => {
  const stream = vi.fn((m, c, options) => {
    const finish = async () => { try { options.onPayload({}); } catch {} return { stopReason: "error" }; };
    return { async *[Symbol.asyncIterator]() {}, result: finish };
  });
  const result = await completeContinuityUpkeep("Fictional.", { model: reference, messages: [], abortSignal: new AbortController().signal, piResolvedModels: { getModel: () => model("openai-responses"), streamSimple: stream } as never });
  expect(result.receipt).toMatchObject({ status: "skipped", reason: "cap_unsupported", providerInvoked: false, inputTokens: 0, costUsd: 0 });
});
it("overwrites a real reasoning builder cap when maxTokens is omitted", async () => {
  const adapter = await import("@earendil-works/pi-ai/api/anthropic-messages"); let before: number | undefined, after: number | undefined;
  const network = vi.fn(); vi.stubGlobal("fetch", network);
  await adapter.streamSimple({ ...model("anthropic-messages"), api: "anthropic-messages", reasoning: true }, normalizeContext({ messages: [{ role: "user", content: "Fictional.", timestamp: 0 }] }), {
    apiKey: "fictional", reasoning: "low", onPayload(payload: any) { before = payload.max_tokens; constrainUpkeepPayload("anthropic-messages", payload); after = payload.max_tokens; throw new Error("OFFLINE_CAPTURE_STOP"); },
  }).result();
  expect(before).toBeGreaterThan(4096); expect(after).toBe(4096); expect(network).not.toHaveBeenCalled();
});
it("requests guard-sized Codex output and suppresses reasoning summaries", async () => {
  const text = JSON.stringify({ entries: Array.from({ length: 8 }, () => ({ kind: "open_work", value: "x".repeat(96), status: "unknown", sources: ["s0"] })), covered: ["s0"] });
  const { result, payloadSeen } = await codex([created, added, { type: "response.output_text.delta", output_index: 0, delta: text }, done(600)]);
  expect(result.receipt.status).toBe("valid"); expect(Buffer.byteLength(text)).toBeLessThan(3072);
  const body = payloadSeen; expect(body.reasoning.summary).toBeUndefined(); expect(JSON.stringify(body)).toContain("OUTPUT LIMIT OVERRIDE");
  expect(JSON.stringify(body)).toContain("covered must be the deduplicated array");
  expect(JSON.stringify(body)).not.toContain("s(N-1)");
});
it("retains a distinct estimated paid input cost after a Codex abort", async () => {
  const { result } = await codex([created, added, { type: "response.output_text.delta", output_index: 0, delta: "x".repeat(5000) }]);
  expect(result.receipt).toMatchObject({ providerInvoked: true, status: "invalid" }); expect(result.receipt.estimatedInputTokens).toBeGreaterThan(0); expect(result.receipt.estimatedInputCostUsd).not.toBeNull();
});

it("uses the admitted bootstrap cap for both estimated and reported cumulative input", async () => {
  const frames = [created, added, { type: "response.output_text.delta", output_index: 0, delta: "{}" }, done(2, 68000, 65000)];
  const bootstrap = await codex(frames, false, undefined, { operationId: "bootstrap-operation", inputTokens: 128000 }, "Fictional ".repeat(14000));
  expect(bootstrap.transport).toHaveBeenCalledTimes(1);
  expect(bootstrap.result.receipt).toMatchObject({ operationId: "bootstrap-operation", status: "valid", inputTokens: 68000,
    providerUsage: { input: 3000, cacheRead: 65000, cacheWrite: 0, output: 2 } });
  const incremental = await codex(frames, false, undefined, { operationId: "incremental-operation", inputTokens: 64000 }, "Fictional ".repeat(14000));
  expect(incremental.transport).not.toHaveBeenCalled(); expect(incremental.stream).not.toHaveBeenCalled();
  expect(incremental.result.receipt).toMatchObject({ status: "skipped", reason: "input_budget" });
});
it("rejects bootstrap input above 128k including cache and never repairs it", async () => {
  const overrun = await codex([created, added, { type: "response.output_text.delta", output_index: 0, delta: "{}" }, done(2, 129000, 125000)], false, undefined, { operationId: "bootstrap-operation", inputTokens: 128000 });
  expect(overrun.transport).toHaveBeenCalledTimes(1); expect(overrun.stream).toHaveBeenCalledTimes(1);
  expect(overrun.result.receipt).toMatchObject({ status: "invalid", reason: "input_overrun", inputTokens: 129000 });
  const estimate = await codex([], false, undefined, { operationId: "bootstrap-operation", inputTokens: 128000 }, "Fictional ".repeat(23000));
  expect(estimate.transport).not.toHaveBeenCalled(); expect(estimate.result.receipt.reason).toBe("input_budget");
});

it("retains explicit zero provider counters in the durable-outcome companion", async () => {
  const { result, transport } = await codex([created, added, { type: "response.output_text.delta", output_index: 0, delta: "{}" }, done(0, 0, 0)]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(result.receipt.providerUsage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
