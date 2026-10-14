import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { streamSimple as sdkStreamSimple } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { generateEngineTurnResponse } from "../../ai/providers/engine-turn.js";

afterEach(() => vi.restoreAllMocks());
async function run(fetch, overrides = {}) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "fictional-model" }] });
  const models = createModels(), model = faux.getModel(), requests = [];
  models.setProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(options);
    return sdkStreamSimple({ ...model, provider: "openai", api: "openai-completions", baseUrl: "https://fictional.invalid/v1" }, context,
      { ...options, apiKey: "fictional-unused-key", fetch });
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
it("does not repeat a paid response after its stream starts and terminates", async () => {
  const encoder = new TextEncoder();
  const fetch = vi.fn(async () => {
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent) { controller.error(new Error("terminated")); return; }
      sent = true;
      controller.enqueue(encoder.encode('data: {"id":"fictional","object":"chat.completion.chunk","created":1,"model":"fictional-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Fictional partial response"},"finish_reason":null}]}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const { result, requests } = await run(fetch);
  expect(result.error).toContain("terminated"); expect(fetch).toHaveBeenCalledOnce(); expect(requests).toHaveLength(1);
});
it("keeps real health probes single-shot even if an embedder supplies a retry budget", async () => {
  const fetch = vi.fn(async () => refusal(503));
  const { requests } = await run(fetch, { providerCheckMaxTokens: 4 });
  expect(fetch).toHaveBeenCalledOnce(); expect(requests[0].maxRetries).toBe(0);
});
