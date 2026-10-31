import { afterEach, expect, it, vi } from "vitest";
import { runtimeOptionsForLocalProvider } from "../providers/local-providers.js";
import { createMonoRuntime } from "../create-runtime.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const model = { provider: "fictional", model: "primary", reference: "fictional:primary" };
const options = () => ({ model, messages: [], abortSignal: new AbortController().signal });

it("skips resource-owning attempt resolvers and releases their preflight resources", async () => {
  const cleanup = vi.fn(), prepare = vi.fn();
  const resolveAttempt = vi.fn(() => ({ cleanup, runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare } }));
  const runtime = createMonoRuntime({ fallbackChain: [{ model }, { model: { ...model, model: "backup", reference: "fictional:backup" } }], resolveAttempt });
  expect(await runtime.prepareContinuityUpkeep!(options())).toBeUndefined();
  expect(resolveAttempt).toHaveBeenCalledOnce();
  expect(resolveAttempt).toHaveBeenCalledWith({ model, attemptIndex: 0, retryIndex: 0 });
  expect(cleanup).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled();
});

it("delegates only selected inference inputs, without injecting outer account or pricing defaults", async () => {
  const hostAuth = vi.fn(), hostPricing = vi.fn();
  const prepare = vi.fn(async () => undefined);
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolvePiApiKey: hostAuth, resolveCustomPricing: hostPricing,
    resolveAttempt: () => ({ runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare }, options: { customModel: { id: "primary" } } }) });
  const request = options();
  await runtime.prepareContinuityUpkeep!({ ...request, mcpServers: { forbidden: {} }, sessionId: "fictional-session", allowedTools: ["Exec"] }, { requireRequestCap: true });
  expect(prepare).toHaveBeenCalledWith({ ...request, customModel: { id: "primary" } }, {
    pinned: false, requireRequestCap: true,
  });
  expect(hostAuth).not.toHaveBeenCalled(); expect(hostPricing).not.toHaveBeenCalled();
});

it("does not substitute another runtime when the selected custom route lacks preflight", async () => {
  const run = vi.fn();
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolveAttempt: () => ({ runtime: { run } }) });
  expect(await runtime.prepareContinuityUpkeep!(options())).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

it("fails closed when an unpinned requested model differs from the routed primary", async () => {
  const resolveAttempt = vi.fn();
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolveAttempt });
  expect(await runtime.prepareContinuityUpkeep!({ ...options(), model: { ...model, model: "other", reference: "fictional:other" } })).toBeUndefined();
  expect(resolveAttempt).not.toHaveBeenCalled();
});

it("uses the answer router's attempt-scoped merge before delegating inference", async () => {
  const prepare = vi.fn(async () => undefined);
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolveAttempt: () => ({ runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare } }) });
  const request = options();
  await runtime.prepareContinuityUpkeep!({ ...request, customProvider: { id: "stale", api_key: "fictional-wrong-key", base_url: "https://stale.invalid" }, customModel: { id: "stale" }, modelCapabilities: {}, isPrivateProvider: false });
  expect(prepare).toHaveBeenCalledWith(request, { pinned: false, requireRequestCap: false });
});

it.each([false, true])("dispatches to the selected endpoint/key, preserving static primary overrides only without a resolver (routed=%s)", async routed => {
  const selected = runtimeOptionsForLocalProvider(model, [{ id: "fictional", type: "openai_compat", trustPublicUrl: true, baseUrl: "https://selected.invalid/v1", apiKey: "fictional-selected-key" }]);
  const stale = runtimeOptionsForLocalProvider({ ...model, model: "outgoing", reference: "fictional:outgoing" }, [{ id: "fictional", type: "openai_compat", trustPublicUrl: true, baseUrl: "https://stale.invalid/v1", apiKey: "fictional-stale-key" }]);
  const fetch = vi.fn(async (url: unknown, options: RequestInit) => {
    expect(String(url)).toBe("https://selected.invalid/v1/chat/completions");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer fictional-selected-key");
    const frame = { id: "fictional", choices: [{ index: 0, delta: { role: "assistant", content: "{}" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], ...(routed ? { resolveAttempt: () => ({ options: selected }) } : {}) });
  const binding = await runtime.prepareContinuityUpkeep!({ ...options(), ...(routed ? stale : selected) });
  const result = await binding!.complete("Fictional evidence.", new AbortController().signal);
  expect(result.receipt).toMatchObject({ providerInvoked: true, model: model.reference, status: "valid" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not bill an outer account when a delegated runtime uses its own environment auth", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "fictional-delegate-key");
  const selected = { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" };
  const outerAuth = vi.fn(async () => "fictional-outer-key"), configAuth = vi.fn(async () => "fictional-config-key"), outerPricing = vi.fn();
  const fetch = vi.fn(async (url: unknown, options: RequestInit) => {
    const frames = [{ type: "message_start", message: { id: "fictional", type: "message", role: "assistant", content: [], model: selected.model, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
    return new Response(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  const delegate = createMonoRuntime(), runtime = createMonoRuntime({ fallbackChain: [{ model: selected }], resolvePiApiKey: outerAuth, resolveCustomPricing: outerPricing,
    resolveAttempt: () => ({ runtime: delegate }) });
  const stale = runtimeOptionsForLocalProvider({ ...selected, model: "outgoing", reference: "anthropic:outgoing" }, [{ id: "anthropic", type: "openai_compat", trustPublicUrl: true, baseUrl: "https://stale.invalid/v1", apiKey: "fictional-stale-key" }]);
  const binding = await runtime.prepareContinuityUpkeep!({ ...options(), ...stale, model: selected }, { defaults: { resolvePiApiKey: configAuth } });
  const result = await binding!.complete("Fictional evidence.", new AbortController().signal);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, sent] = fetch.mock.calls[0]!;
  expect(new URL(String(url)).origin).toBe("https://api.anthropic.com");
  expect(new Headers(sent.headers).get("x-api-key")).toBe("fictional-delegate-key");
  expect(result.receipt, JSON.stringify(result.receipt)).toMatchObject({ providerInvoked: true, status: "valid" });
  expect(outerAuth).not.toHaveBeenCalled(); expect(configAuth).not.toHaveBeenCalled(); expect(outerPricing).not.toHaveBeenCalled();
});

it("permits an explicit pin independently of the routed primary", async () => {
  const prepare = vi.fn(async () => undefined), pinned = { ...model, model: "pin", reference: "fictional:pin" };
  const resolver = vi.fn(() => ({ runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare } }));
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolveAttempt: resolver });
  const request = { ...options(), model: pinned };
  await runtime.prepareContinuityUpkeep!(request, { pinned: true });
  expect(resolver).toHaveBeenCalledWith({ model: pinned, attemptIndex: 0, retryIndex: 0 });
  expect(prepare).toHaveBeenCalledWith(request, { pinned: true, requireRequestCap: false });
});
