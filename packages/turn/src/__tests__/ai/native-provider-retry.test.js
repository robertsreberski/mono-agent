import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple as sdkStreamSimple } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { streamSimple as sdkCodexStreamSimple } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import { generateEngineTurnResponse } from "../../ai/providers/engine-turn.js";

// Keep the real mid-stream retry policy, without its 1 s/2 s/4 s backoff.
vi.mock("../../ai/providers/engine-turn/request-retry.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, requestRetryPolicy: (params) => ({ ...actual.requestRetryPolicy(params), baseDelayMs: 0 }) };
});
afterEach(() => vi.restoreAllMocks());
async function run(fetch, overrides = {}, sdk = sdkStreamSimple) {
  const codex = sdk === sdkCodexStreamSimple;
  const codexToken = ["fictional", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64"), "fictional"].join(".");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "fictional-model" }] });
  const models = createModels(), model = faux.getModel(), requests = [];
  models.setProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(options);
    return sdk({ ...model, provider: codex ? "openai-codex" : "openai", api: codex ? "openai-codex-responses" : "openai-completions", baseUrl: "https://fictional.invalid/v1" }, context,
      { ...options, apiKey: codex ? codexToken : "fictional-unused-key", fetch });
  } });
  const result = await generateEngineTurnResponse("Fictional rules", {
    model: { provider: "faux", model: "fictional-model", reference: "faux:fictional-model" },
    piResolvedModel: model, piResolvedModels: models, effort: "none", allowedTools: [], compaction: { enabled: false },
    piMaxRetries: 2, messages: [{ role: "user", content: "Fictional request" }], ...overrides,
  });
  return { result, requests };
}
function refusal(status, headers = {}) {
  return Response.json({ error: { message: "Fictional refusal" } }, { status, headers: { "retry-after-ms": "0", ...headers } });
}
it.each([408, 409, 429, 501, 507, 529])("retries pre-response HTTP %s by SDK policy, with no extra driver layer", async (status) => {
  const fetch = vi.fn(async () => refusal(status));
  const { result, requests } = await run(fetch);
  expect(result.error).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(3);
  expect(requests).toHaveLength(1); expect(requests[0].maxRetries).toBe(2);
});
it.each([0, 1])("bounds real pre-response transport requests for piMaxRetries=%s", async (piMaxRetries) => {
  const fetch = vi.fn(async () => refusal(503));
  await run(fetch, { piMaxRetries }); expect(fetch).toHaveBeenCalledTimes(piMaxRetries + 1);
});
it.each([[503, "false", 1], [400, "true", 3]])("honours x-should-retry=%s/%s", async (status, header, count) => {
  const fetch = vi.fn(async () => refusal(status, { "x-should-retry": header }));
  await run(fetch); expect(fetch).toHaveBeenCalledTimes(count);
});
it("honours Retry-After instead of silently replacing it with driver backoff", async () => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "Fictional rate limit" } }, { status: 429, headers: { "Retry-After": "20" } }));
  const { result } = await run(fetch, { maxRetryDelayMs: 1000 });
  expect(result.error).toContain("Server requested 20s retry delay"); expect(fetch).toHaveBeenCalledOnce();
});
// The SDK never repeats a started stream; the driver re-sends only transient
// mid-stream failures (three times), each as one fresh SDK request.
it.each([["terminated", 4], ["The upstream provider returned an error", 1]])("repeats a started stream only for transient failures (%s)", async (message, count) => {
  const encoder = new TextEncoder();
  const fetch = vi.fn(async () => {
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent) { controller.error(new Error(message)); return; }
      sent = true;
      controller.enqueue(encoder.encode('data: {"id":"fictional","object":"chat.completion.chunk","created":1,"model":"fictional-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Fictional partial response"},"finish_reason":null}]}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const { result, requests } = await run(fetch);
  expect(result.error).toContain(message); expect(fetch).toHaveBeenCalledTimes(count); expect(requests).toHaveLength(count);
  expect(requests.every((options) => options.maxRetries === 2)).toBe(true);
});
it("keeps real health probes single-shot even if an embedder supplies a retry budget", async () => {
  const fetch = vi.fn(async () => refusal(503));
  const { requests } = await run(fetch, { providerCheckMaxTokens: 4 });
  expect(fetch).toHaveBeenCalledOnce(); expect(requests[0].maxRetries).toBe(0);
});


it.each([400, 401, 429, 503, undefined])("keeps Codex checks single-shot over SSE despite configured websocket and retry budget (status=%s)", async (status) => {
  const fetch = vi.fn(async () => {
    if (status === undefined) throw new Error("Fictional connection lost before response headers");
    return refusal(status);
  });
  const { result, requests } = await run(fetch, { providerCheckMaxTokens: 4, transport: "websocket", piMaxRetries: 8 }, sdkCodexStreamSimple);
  expect(result.error).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ transport: "sse", maxRetries: 0 });
});

it.each([false, true])("does not assistant-retry new upstream-error wording (check=%s)", async (check) => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "The upstream provider returned an error" } }, { status: 400 }));
  const { result, requests } = await run(fetch, check ? { providerCheckMaxTokens: 4 } : {});
  expect(result.error).toContain("The upstream provider returned an error");
  expect(fetch).toHaveBeenCalledOnce(); expect(requests).toHaveLength(1);
});
it("does not repeat an unknown-outcome single-shot connection failure", async () => {
  const fetch = vi.fn(async () => { throw new Error("Fictional connection lost after sending request"); });
  await run(fetch, { providerCheckMaxTokens: 4 });
  expect(fetch).toHaveBeenCalledOnce();
});

// Exercise the real Anthropic transport, not a copied rejection predicate.
async function anthropic(fetch) {
  const { streamSimple } = await import("@earendil-works/pi-ai/api/anthropic-messages");
  const { getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
  return streamSimple({ ...getBuiltinModel("anthropic", "claude-haiku-5-5"), baseUrl: "https://fictional.invalid" }, normalizeContext({
    systemPrompt: "Fictional rules", messages: [{ role: "user", content: "Fictional request", timestamp: 1 }],
    tools: ["prefer", "require"].map((strict) => ({ name: `Fictional_${strict}`, description: "Fictional tool",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      constrainedSampling: { type: "json_schema", strict } })),
  }), { apiKey: "fictional-unused-key", fetch, maxRetries: 0 }).result();
}
const grammarRejection = (status = 400, type = "invalid_request_error", message = "The compiled grammar is too large") => Response.json({ type: "error",
  error: { type, message } }, { status });
it.each(["The compiled grammar is too large", "Too many strict tools (fictional)", "Schemas contains too many parameters with union types (fictional)"])("downgrades preferred strict tools only after definite 400 rejection (%s), even with maxRetries=0", async (message) => {
  const payloads = [];
  const fetch = vi.fn(async (_url, init) => { payloads.push(JSON.parse(init.body)); return grammarRejection(400, "invalid_request_error", message); });
  const result = await anthropic(fetch);
  expect(result.stopReason).toBe("error");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(payloads[0].tools.filter((tool) => tool.name.startsWith("Fictional_")).map((tool) => tool.strict)).toEqual([true, true]);
  expect(payloads[1].tools.filter((tool) => tool.name.startsWith("Fictional_")).map((tool) => tool.strict)).toEqual([undefined, true]);
});
it.each([401, 429, 503])("does not strict-downgrade or SDK retry Anthropic HTTP %s with maxRetries=0", async (status) => {
  const fetch = vi.fn(async () => grammarRejection(status));
  await anthropic(fetch); expect(fetch).toHaveBeenCalledOnce();
});
it("does not strict-downgrade an unknown-outcome Anthropic request", async () => {
  const fetch = vi.fn(async () => { throw new Error("The compiled grammar is too large: fictional connection lost"); });
  await anthropic(fetch); expect(fetch).toHaveBeenCalledOnce();
});
it("does not strict-downgrade an Anthropic stream that already started", async () => {
  const fetch = vi.fn(async () => new Response([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"fictional","type":"message","role":"assistant","model":"claude-haiku-5-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large"}}\n\n',
  ].join(""), { headers: { "content-type": "text/event-stream" } }));
  const result = await anthropic(fetch);
  expect(result.stopReason).toBe("error"); expect(fetch).toHaveBeenCalledOnce();
});
