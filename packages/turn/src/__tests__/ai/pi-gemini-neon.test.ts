import { afterEach, expect, it, vi } from "vitest";
import { generateEngineTurnResponse } from "../../execution/pi/run.js";
import { getPiBuiltinModel, listPiBuiltinModels } from "../../providers/pi/catalog.js";
import { resolvePiRuntimeModel } from "../../providers/pi/models.js";
import { resolvePricing } from "../../telemetry/cost.js";

const id = "gemini-4-neon";
const cost = { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 };
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["google", "google-generative-ai", ["low", "medium", "high"]],
  ["github-copilot", "openai-completions", ["low", "medium", "high", "xhigh"]],
] as const)("lists, resolves and prices Neon via %s", (provider, api, levels) => {
  const reference = `${provider}:${id}`;
  const model = getPiBuiltinModel(provider, id);
  expect(model).toMatchObject({ api, name: "Gemini 4 Neon", contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true, cost });
  expect(listPiBuiltinModels(provider).filter((row) => row.id === id)).toEqual([model]);
  expect(resolvePiRuntimeModel({ provider, model: id }, {})).toMatchObject({
    model, capabilities: { reasoning_levels: levels, reasoning_disable_supported: false },
  });
  expect(resolvePricing({ model: reference })).toMatchObject({ ...cost, priced: true });
});

it.each([
  ["google", "medium", "medium"],
  ["google", "xhigh", "high"], // An older or authored override still follows Pi's clamping.
  ["github-copilot", "xhigh", "xhigh"],
] as const)("dispatches %s Neon with requested %s and effective %s", async (provider, effort, effectiveEffort) => {
  const google = provider === "google";
  const fixtureToken = "fictional-neon-transport-token";
  const stream = google
    ? [{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Fictional answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } }]
    : [{ id: "fixture", model: id, choices: [{ index: 0, delta: { content: "Fictional answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }];
  const transport = vi.fn(async (_url: string | URL, _request: RequestInit) => new Response(
    stream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (google ? "" : "data: [DONE]\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  ));
  vi.stubGlobal("fetch", transport);
  const credential = google
    ? { type: "api_key" as const, key: fixtureToken }
    : { type: "oauth" as const, access: fixtureToken, refresh: "fictional-unused-refresh", expires: Date.now() + 3_600_000 };
  const reference = `${provider}:${id}`;
  const result = await generateEngineTurnResponse("Fictional system instructions", {
    model: { provider, model: id, reference }, effort, allowedTools: [],
    messages: [{ role: "user", content: "Fictional request" }],
    resolvePiApiKey: Object.assign(async () => fixtureToken, { readCredential: async () => credential }),
  });
  expect(result.error).toBeNull();
  expect(result).toMatchObject({ model: reference, sdk: "pi", text: "Fictional answer", effort, effectiveEffort, failureKind: null });
  expect(transport).toHaveBeenCalledOnce();
  const [url, init] = transport.mock.calls[0]!;
  const headers = new Headers(init.headers);
  const payload = JSON.parse(init.body as string);
  if (google) {
    expect(String(url)).toContain(`/v1beta/models/${id}:streamGenerateContent`);
    expect(headers.get("x-goog-api-key")).toBe(fixtureToken);
    expect(payload.generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: effectiveEffort.toUpperCase() });
  } else {
    expect(String(url)).toMatch(/\.githubcopilot\.com\/chat\/completions$/);
    expect(headers.get("authorization")).toBe(`Bearer ${fixtureToken}`);
    expect(payload).toMatchObject({ model: id, reasoning_effort: effectiveEffort });
  }
});
