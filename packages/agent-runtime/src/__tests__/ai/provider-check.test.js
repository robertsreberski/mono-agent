import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { classifyProviderCheckFailure, runPiProviderCheck } from "../../ai/provider-check.js";

describe("provider check", () => {
  it("runs one isolated target request with bounded output and the supplied auth context", async () => {
    const resolver = vi.fn();
    const execute = vi.fn(async () => ({ text: "OK", failureKind: null }));
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap", reference: "fixture:cheap" },
      resolvePiApiKey: resolver,
      environment: { FIXTURE_API_KEY: "secret-not-returned" },
      execute,
    });

    expect(outcome).toEqual({ state: "passed", code: "passed", message: "Provider request succeeded." });
    expect(execute).toHaveBeenCalledOnce();
    const [system, options] = execute.mock.calls[0];
    expect(system).toBe("Provider connectivity check. Reply OK.");
    expect(options).toMatchObject({
      model: { provider: "fixture", model: "cheap", reference: "fixture:cheap" },
      messages: [{ role: "user", content: "OK" }],
      effort: "none",
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      maxTurns: 1,
      piMaxRetries: 0,
      compaction: { enabled: false },
      providerCheckMaxTokens: 4,
      resolvePiApiKey: resolver,
    });
    expect(await options.providerCheckAuthContext.env("FIXTURE_API_KEY")).toBe("secret-not-returned");
    expect(options).not.toHaveProperty("sessionId");
    expect(JSON.stringify(outcome)).not.toContain("secret-not-returned");
  });

  it("admits only provider-construction seams into the isolated runtime", async () => {
    const execute = vi.fn(async () => ({ text: "OK", failureKind: null }));
    const supported = {
      customProvider: { id: "fixture" },
      customModel: { provider_id: "fixture", model_name: "cheap" },
      modelCapabilities: { tool_use: false },
      isPrivateProvider: true,
      piResolvedModel: { provider: "fixture", id: "cheap" },
      piResolvedModels: { marker: "models" },
      piResolvedCapabilities: { reasoning: false },
    };
    await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap" },
      execute,
      runtimeOptions: {
        ...supported,
        sessionId: "ordinary-session",
        providerSessionId: "provider-session",
        providerAttributionSessionId: "attribution-session",
        runId: "ordinary-run",
        sessionKeepAlive: true,
        piSessionsRoot: "/tmp/must-not-be-used",
        messages: [{ role: "user", content: "ordinary history" }],
        observers: [() => undefined],
        onEvent: () => undefined,
        toolLifecycleSink: {},
        skills: [{ name: "ordinary-skill" }],
        tools: [{ name: "ordinary-tool" }],
      },
    });

    const options = execute.mock.calls[0][1];
    expect(options).toMatchObject(supported);
    expect(options).not.toHaveProperty("sessionId");
    expect(options).not.toHaveProperty("providerSessionId");
    expect(options).not.toHaveProperty("providerAttributionSessionId");
    expect(options).not.toHaveProperty("runId");
    expect(options).not.toHaveProperty("sessionKeepAlive");
    expect(options).not.toHaveProperty("piSessionsRoot");
    expect(options).not.toHaveProperty("observers");
    expect(options).not.toHaveProperty("onEvent");
    expect(options).not.toHaveProperty("toolLifecycleSink");
    expect(options).not.toHaveProperty("skills");
    expect(options).not.toHaveProperty("tools");
    expect(options.messages).toEqual([{ role: "user", content: "OK" }]);
  });

  function transportFixture(response, { cancel, contextWindow = 4096 } = {}) {
    const faux = fauxProvider({
      provider: "provider-check-fixture",
      models: [{ id: "fixture", maxTokens: 64, contextWindow }],
      tokensPerSecond: undefined,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel("fixture");
    if (!model) throw new Error("faux model missing");
    const dispatch = vi.fn((context, _options, _state, requestModel) => {
      // pi-ai 0.86.0 folds request tools into the transcript's leading system
      // message: replay them with getCurrentTools(), not context.tools.
      expect(getCurrentTools(context.messages)).toEqual([]);
      expect(requestModel.provider).toBe(model.provider);
      expect(requestModel.id).toBe(model.id);
      cancel?.abort();
      return response;
    });
    faux.setResponses([dispatch, dispatch]);
    return {
      faux, dispatch, model,
      input: {
        model: { provider: model.provider, model: model.id },
        resolvePiApiKey: async () => "FAUX_ONLY_NOT_A_CREDENTIAL",
        runtimeOptions: { piResolvedModel: model, piResolvedModels: models },
        ...(cancel ? { abortSignal: cancel.signal } : {}),
      },
    };
  }

  it.each(["stop", "length"])("accepts a real %s terminal response at the four-token cap", async (stopReason) => {
    // Faux estimates ceil(text.length / 4): exactly four output tokens.
    const fixture = transportFixture(fauxAssistantMessage("four token reply", { stopReason }));
    const outcome = await runPiProviderCheck(fixture.input);
    expect(outcome).toEqual({ state: "passed", code: "passed", message: "Provider request succeeded." });
    expect(fixture.faux.state.callCount).toBe(1);
    expect(fixture.dispatch.mock.calls[0][3].maxTokens).toBe(4);
    expect(fixture.model.maxTokens).toBe(64); // No mutation of the shared catalog.
  });

  it.each([
    ["prompt is too long: RAW_PROVIDER_SECRET_SENTINEL", "inconclusive"],
    ["401 Unauthorized RAW_PROVIDER_SECRET_SENTINEL", "auth_failed"],
    ["429 rate limit RAW_PROVIDER_SECRET_SENTINEL", "quota_limited"],
    ["unsupported model RAW_PROVIDER_SECRET_SENTINEL", "model_not_entitled"],
    ["ECONNREFUSED RAW_PROVIDER_SECRET_SENTINEL", "network_failed"],
    // The ordinary runtime labels unrecognized provider errors unavailable.
    ["unrecognized RAW_PROVIDER_SECRET_SENTINEL", "network_failed"],
  ])("does not pass a real transport rejection: %s", async (errorMessage, state) => {
    const fixture = transportFixture(fauxAssistantMessage([], { stopReason: "error", errorMessage }));
    const outcome = await runPiProviderCheck(fixture.input);
    expect(outcome.state).toBe(state);
    expect(JSON.stringify(outcome)).not.toContain("RAW_PROVIDER_SECRET_SENTINEL");
    expect(fixture.faux.state.callCount).toBe(1);
    expect(fixture.dispatch.mock.calls[0][3].maxTokens).toBe(4);
  });

  it("keeps a premature length stop below the probe cap inconclusive", async () => {
    const fixture = transportFixture(fauxAssistantMessage("OK", { stopReason: "length" }));
    expect((await runPiProviderCheck(fixture.input)).state).toBe("inconclusive");
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it("does not pass a length stop with no room for output", async () => {
    const fixture = transportFixture(fauxAssistantMessage([], { stopReason: "length" }), { contextWindow: 16 });
    expect((await runPiProviderCheck(fixture.input)).state).toBe("inconclusive");
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it("keeps ordinary runtime premature-length recovery semantics unchanged", async () => {
    const fixture = transportFixture(fauxAssistantMessage("four token reply", { stopReason: "length" }));
    const outcome = await generatePiNativeResponse("Provider connectivity check. Reply OK.", {
      ...fixture.input.runtimeOptions,
      model: fixture.input.model,
      resolvePiApiKey: fixture.input.resolvePiApiKey,
      messages: [{ role: "user", content: "OK" }],
      allowedTools: [], maxTurns: 1, piMaxRetries: 0, effort: "none",
    });
    expect(outcome.failureKind).toBe("context_limit");
    expect(fixture.dispatch.mock.calls[0][3].maxTokens).toBe(64);
    expect(fixture.faux.state.callCount).toBe(2); // Ordinary reactive compaction is still attempted.
  });

  it("gives cancellation precedence over a real length response", async () => {
    const cancel = new AbortController();
    const fixture = transportFixture(fauxAssistantMessage("four token reply", { stopReason: "length" }), { cancel });
    expect(await runPiProviderCheck(fixture.input)).toMatchObject({ state: "inconclusive", code: "cancelled" });
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it("gives cancellation precedence when execution throws", async () => {
    const cancel = new AbortController();
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap" }, abortSignal: cancel.signal,
      execute: async () => { cancel.abort(); throw new Error("401 RAW_PROVIDER_SECRET_SENTINEL"); },
    });
    expect(outcome).toMatchObject({ state: "inconclusive", code: "cancelled" });
  });

  it("returns only closed sanitized categories for provider-controlled failures", async () => {
    const secret = "RAW_PROVIDER_SECRET_SENTINEL";
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap" },
      execute: vi.fn(async () => ({ error: `401 token_revoked ${secret}`, failureKind: "provider_auth" })),
    });
    expect(outcome).toEqual({
      state: "auth_failed",
      code: "credential_rejected",
      message: "Provider rejected the configured credential.",
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it("never infers success from a generic context-limit failure", async () => {
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap" },
      execute: vi.fn(async () => ({ error: "Assistant request exceeded the context window", failureKind: "context_limit" })),
    });
    expect(outcome.state).toBe("inconclusive");
  });

  it.each([
    ["unrecognized", undefined, "inconclusive"],
    ["401 Unauthorized", undefined, "auth_failed"],
    ["invalid_grant", undefined, "auth_failed"],
    ["429 insufficient_quota", undefined, "quota_limited"],
    ["model_not_found", undefined, "model_not_entitled"],
    ["404 Not Found", undefined, "inconclusive"],
    ["404 model not found", undefined, "model_not_entitled"],
    ["403 Forbidden", undefined, "inconclusive"],
    ["ECONNREFUSED", "provider_unavailable", "network_failed"],
  ])("classifies %s narrowly", (text, failureKind, state) => {
    expect(classifyProviderCheckFailure(text, failureKind).state).toBe(state);
  });
});
