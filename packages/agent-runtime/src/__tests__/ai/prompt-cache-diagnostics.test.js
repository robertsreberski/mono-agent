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
    ["openai-responses", { api: "azure-openai-responses", provider: "azure-openai", id: "gpt" }, { instructions: "SYS", input: [{ role: "user", content: "PRIVATE" }], tools: [{ name: "Read" }], prompt_cache_key: "KEY" }, "keyed"],
    ["openai-codex", { api: "openai-codex-responses", provider: "openai-codex", id: "gpt" }, { instructions: "SYS", input: [{ role: "user", content: "PRIVATE" }], tools: [{ name: "Read" }], prompt_cache_key: "KEY" }, "keyed"],
    ["google", { api: "google-generative-ai", provider: "google", id: "gemini" }, { contents: [{ role: "user", parts: [{ text: "PRIVATE" }] }], config: { systemInstruction: "SYS", tools: [{ functionDeclarations: [{ name: "Read" }] }] } }, "provider-default"],
    ["google", { api: "google-vertex", provider: "google", id: "gemini" }, { contents: [{ role: "user", parts: [{ text: "PRIVATE" }] }], config: { systemInstruction: "SYS", tools: [{ functionDeclarations: [{ name: "Read" }] }] } }, "provider-default"],
    ["pi-messages", { api: "pi-messages", provider: "custom", id: "model" }, { context: { messages: [{ role: "system", content: "SYS", toolsAdded: [{ name: "Read" }], timestamp: 0 }] }, options: { sessionId: "KEY" } }, "keyed"],
    ["bedrock", { api: "bedrock-converse-stream", provider: "amazon-bedrock", id: "claude" }, { system: [{ text: "SYS", cachePoint: { type: "default" } }], messages: [{ role: "user", content: [{ text: "PRIVATE" }] }], toolConfig: { tools: [{ toolSpec: { name: "Read" } }] } }, "explicit"],
  ])("normalizes %s without emitting content", (family, model, payload, cacheMode) => {
    const state = fixture();
    state.emit({ model, payload });
    const event = state.onEvent.mock.calls[0][0];
    const encoded = JSON.stringify(event);
    expect(event).toMatchObject({ payloadFamily: family, supported: true, model: `${model.provider}:${model.id}`, api: model.api, toolDefinitionCount: 1, messageCount: 1, cacheMode });
    expect(encoded).not.toMatch(/SYS|PRIVATE|KEY/u);
  });

  it("reports an explicit zero tool count when the provider payload carries no tools", () => {
    const state = fixture();
    state.emit({ model: { api: "openai-responses", provider: "openai", id: "gpt" }, payload: { input: [{ role: "user", content: "PRIVATE" }] } });
    expect(state.onEvent.mock.calls[0][0]).toMatchObject({ payloadFamily: "openai-responses", supported: true, toolDefinitionCount: 0, messageCount: 1 });
  });

  it.each([
    ["openai-responses", { api: "openai-responses", provider: "openai", id: "gpt" }],
    ["openai-responses", { api: "azure-openai-responses", provider: "azure-openai", id: "gpt" }],
  ])("replays the %s system prompt from converted input when instructions is absent", (family, model) => {
    const wireInput = (text) => ({ input: [{ role: "system", content: text }, { role: "user", content: [{ type: "input_text", text: "PRIVATE" }] }], tools: [{ name: "Read" }] });
    const one = fixture();
    one.emit({ model, payload: wireInput("SYS-ONE") });
    const first = one.onEvent.mock.calls[0][0];
    const two = fixture();
    two.emit({ model, payload: wireInput("SYS-TWO") });
    const second = two.onEvent.mock.calls[0][0];
    expect(first).toMatchObject({ payloadFamily: family, supported: true, toolDefinitionCount: 1, messageCount: 2 });
    expect(first.systemBytes).toBeGreaterThan(0);
    expect(first.systemFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(second.systemFingerprint).not.toBe(first.systemFingerprint);
    expect(JSON.stringify(first)).not.toMatch(/SYS-ONE|SYS-TWO|PRIVATE/u);
  });

  it("replays transcript-shaped input and developer-role instructions for openai-responses", () => {
    const model = { api: "openai-responses", provider: "openai", id: "gpt" };
    const transcript = fixture();
    transcript.emit({ model, payload: { input: [{ role: "system", content: "SYS", toolsAdded: [{ name: "Read" }], timestamp: 0 }, { role: "user", content: "PRIVATE", timestamp: 1 }], tools: [{ name: "Read" }] } });
    expect(transcript.onEvent.mock.calls[0][0]).toMatchObject({ payloadFamily: "openai-responses", supported: true, toolDefinitionCount: 1 });
    expect(transcript.onEvent.mock.calls[0][0].systemBytes).toBeGreaterThan(0);
    const reasoning = fixture();
    reasoning.emit({ model, payload: { input: [{ role: "developer", content: "SYS" }, { role: "user", content: "PRIVATE" }] } });
    expect(reasoning.onEvent.mock.calls[0][0].systemBytes).toBeGreaterThan(0);
  });

  it("prefers explicit instructions over replayed input for openai-codex-responses", () => {
    const state = fixture();
    state.emit({ model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt" }, payload: { instructions: "SYS", input: [{ role: "system", content: "STALE" }] } });
    const event = state.onEvent.mock.calls[0][0];
    expect(event).toMatchObject({ payloadFamily: "openai-codex", supported: true });
    expect(event.systemBytes).toBe(3);
    expect(JSON.stringify(event)).not.toMatch(/SYS|STALE/u);
  });

  it("marks unknown payloads unsupported instead of fingerprinting empty projections", () => {
    const state = fixture();
    state.emit({ model: { api: "future-api", provider: "future", id: "m" }, payload: { request: "PRIVATE" } });
    expect(state.onEvent.mock.calls[0][0]).toEqual({ type: "prompt_cache_diagnostic", phase: "assistant", requestId: expect.any(String), requestOrdinal: 1, model: "future:m", api: "future-api", payloadFamily: "unsupported", supported: false, unsupportedReason: "unrecognized_api:future-api", requestedCacheRetention: "unset" });
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
