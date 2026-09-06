import { describe, expect, it, vi } from "vitest";
import { installPromptCacheDiagnostics } from "../../ai/providers/pi-native/prompt-cache-diagnostics.js";

function fixture(options = {}) {
  let hook;
  const remove = vi.fn();
  const onEvent = vi.fn();
  const harness = { hooks: { on: vi.fn((_name, handler) => { hook = handler; return remove; }) } };
  const dispose = installPromptCacheDiagnostics(harness, { promptCacheDiagnostics: true, onEvent, model: {}, ...options });
  return { harness, onEvent, remove, dispose, emit: (event) => hook(event) };
}

describe("prompt cache diagnostics", () => {
  it("is disabled by default", () => {
    const hooks = { on: vi.fn() };
    expect(installPromptCacheDiagnostics({ hooks }, { onEvent: vi.fn() })()).toBeUndefined();
    expect(hooks.on).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic", { api: "anthropic-messages", provider: "anthropic", id: "claude" }, { system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }], tools: [{ name: "Read" }], messages: [{ role: "user", content: "PRIVATE" }], max_tokens: 10 }, "explicit"],
    ["openai-responses", { api: "openai-responses", provider: "openai", id: "gpt" }, { input: [{ role: "user", content: "PRIVATE" }], tools: [{ name: "Read" }], prompt_cache_key: "KEY" }, "keyed"],
    ["openai-codex", { api: "openai-codex-responses", provider: "openai-codex", id: "gpt" }, { instructions: "SYS", input: [{ role: "user", content: "PRIVATE" }], tools: [{ name: "Read" }], prompt_cache_key: "KEY" }, "keyed"],
    ["google", { api: "google-generative-ai", provider: "google", id: "gemini" }, { contents: [{ role: "user", parts: [{ text: "PRIVATE" }] }], config: { systemInstruction: "SYS", tools: [{ functionDeclarations: [{ name: "Read" }] }] } }, "provider-default"],
    ["pi-messages", { api: "pi-messages", provider: "custom", id: "model" }, { context: { systemPrompt: "SYS", tools: [{ name: "Read" }], messages: [{ role: "user", content: "PRIVATE" }] }, options: { sessionId: "KEY" } }, "keyed"],
    ["bedrock", { api: "bedrock-converse-stream", provider: "amazon-bedrock", id: "claude" }, { system: [{ text: "SYS", cachePoint: { type: "default" } }], messages: [{ role: "user", content: [{ text: "PRIVATE" }] }], toolConfig: { tools: [{ toolSpec: { name: "Read" } }] } }, "explicit"],
  ])("normalizes %s without emitting content", (family, model, payload, cacheMode) => {
    const state = fixture();
    state.emit({ model, payload });
    const event = state.onEvent.mock.calls[0][0];
    const encoded = JSON.stringify(event);
    expect(event).toMatchObject({ payloadFamily: family, supported: true, model: `${model.provider}:${model.id}`, api: model.api, toolDefinitionCount: 1, messageCount: 1, cacheMode });
    expect(encoded).not.toMatch(/SYS|PRIVATE|KEY/u);
  });

  it("marks unknown payloads unsupported instead of fingerprinting empty projections", () => {
    const state = fixture();
    state.emit({ model: { api: "future-api", provider: "future", id: "m" }, payload: { request: "PRIVATE" } });
    expect(state.onEvent.mock.calls[0][0]).toEqual({ type: "prompt_cache_diagnostic", requestOrdinal: 1, model: "future:m", api: "future-api", payloadFamily: "unsupported", supported: false, unsupportedReason: "unrecognized_api:future-api" });
  });

  it("marks known but unsupported Pi payload families explicitly", () => {
    const state = fixture();
    state.emit({ model: { api: "openai-completions", provider: "openai", id: "gpt" }, payload: { messages: [{ role: "user", content: "PRIVATE" }], max_tokens: 10 } });
    expect(state.onEvent.mock.calls[0][0]).toMatchObject({ payloadFamily: "unsupported", supported: false, unsupportedReason: "unrecognized_api:openai-completions" });
  });

  it("reports logical deltas and does not overclaim Codex wire deltas", () => {
    const responses = fixture();
    responses.emit({ model: { api: "openai-responses", provider: "openai", id: "gpt" }, payload: { input: [], previous_response_id: "SECRET-ID" } });
    expect(responses.onEvent.mock.calls[0][0]).toMatchObject({ logicalInputInterpretation: "delta", inputInterpretation: "delta", inputInterpretationSource: "provider_payload" });
    expect(JSON.stringify(responses.onEvent.mock.calls[0][0])).not.toContain("SECRET-ID");

    const codex = fixture();
    codex.emit({ model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt" }, payload: { input: [] } });
    expect(codex.onEvent.mock.calls[0][0]).toMatchObject({ logicalInputInterpretation: "full", inputInterpretation: "unavailable", inputInterpretationSource: "pre_transport_payload" });
  });

  it("reports an explicitly disabled cache mode without fingerprinting a dormant session key", () => {
    const state = fixture();
    state.emit({ model: { api: "pi-messages", provider: "custom", id: "m" }, payload: { context: { messages: [] }, options: { cacheRetention: "none", sessionId: "KEY" } } });
    expect(state.onEvent.mock.calls[0][0]).toMatchObject({ cacheMode: "disabled" });
    expect(state.onEvent.mock.calls[0][0]).not.toHaveProperty("cacheKeyFingerprint");
  });

  it("bounds message fingerprints and releases the hook", () => {
    const state = fixture();
    state.emit({ model: { api: "openai-responses", provider: "openai", id: "gpt" }, payload: { input: Array.from({ length: 140 }, (_, index) => ({ role: "user", content: String(index) })) } });
    expect(state.onEvent.mock.calls[0][0]).toMatchObject({ messageCount: 140, messageFingerprintsTruncated: true });
    expect(state.onEvent.mock.calls[0][0].messageFingerprints).toHaveLength(128);
    state.dispose();
    expect(state.remove).toHaveBeenCalledOnce();
  });
});
