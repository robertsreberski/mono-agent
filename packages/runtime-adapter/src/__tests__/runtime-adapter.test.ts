import { describe, expect, it, vi } from "vitest";

import {
  createPiOAuthApiKeyResolver,
  createMonoRuntime,
  describeMonoRuntimeSupport,
  listMonoRuntimeBackends,
  monoRuntimeSupportsLiveInput,
  monoRuntimeSupportsMcpApps,
  monoRuntimeSupportsSessionResume,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
  runtimeBackendForModel,
  RuntimeAdapterError,
} from "../index.js";

describe("runtime adapter model references", () => {
  it("canonicalizes the legacy pi wrapper", () => {
    expect(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5")).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
      reference: "openai-codex:gpt-5.5",
    });
  });

  it("rejects raw or legacy-invalid model references with a stable error", () => {
    expect(() => parseMonoRuntimeModelReference("haiku")).toThrow(RuntimeAdapterError);
    try {
      parseMonoRuntimeModelReference("haiku");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_model_reference" });
    }
  });

  it("preserves the parser's concrete replacement in error details", () => {
    try {
      parseMonoRuntimeModelReference("codex:gpt-5.6-sol");
      throw new Error("Expected the removed runtime reference to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_model_reference",
        details: { reason: expect.stringContaining("openai-codex:gpt-5.6-sol") },
      });
    }
  });

  // Every operator surface (doctor, `mono-agent validate`, `config --json`, cron/webhook
  // override issues) renders `error.message` and nothing else. A replacement that lives
  // only in `details` is a replacement nobody is ever shown, so the message itself must
  // name it for each retired runtime backend.
  it.each([
    ["codex:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
    ["claude:claude-sonnet-4-6", "anthropic:claude-sonnet-4-6"],
    ["claude-code:claude-sonnet-4-6", "anthropic:claude-sonnet-4-6"],
    ["codex-cli:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
    ["vercel:openai:gpt-5.5", "openai:gpt-5.5"],
    ["opencode:openai:gpt-5.5", "openai:gpt-5.5"],
  ])("names the replacement for %s in the message operators see", (reference, replacement) => {
    try {
      parseMonoRuntimeModelReference(reference);
      throw new Error(`Expected ${reference} to be rejected.`);
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeAdapterError);
      expect((error as RuntimeAdapterError).message).toContain(replacement);
    }
  });

  it("names the surviving ACP bridge in the message for an acp: reference", () => {
    try {
      parseMonoRuntimeModelReference("acp:some-agent");
      throw new Error("Expected acp:some-agent to be rejected.");
    } catch (error) {
      expect((error as RuntimeAdapterError).message).toContain("mono-agent bridge acp");
    }
  });

  it("names the tier-alias repair in the message, not only in details", () => {
    try {
      parseMonoRuntimeModelReference("anthropic:opus");
      throw new Error("Expected a tier alias to be rejected.");
    } catch (error) {
      expect((error as RuntimeAdapterError).message).toContain("tier aliases are not valid model ids");
    }
  });

  it("exposes one frozen Pi backend descriptor", () => {
    const model = parseMonoRuntimeModelReference("github-copilot:gpt-4.1");
    const backends = listMonoRuntimeBackends();

    expect(backends).toHaveLength(1);
    const backend = backends[0];
    if (backend === undefined) {
      throw new Error("Expected the sole Pi runtime backend.");
    }
    expect(backend).toMatchObject({
      id: "pi-sdk",
      runtimeBridgeId: "pi",
      sdk: "pi",
      transport: "sdk",
      acceptsProviderIds: true,
      capabilities: expect.objectContaining({
        kind: "pi",
        supports_session_resume: true,
        supports_live_input: true,
        supports_mcp_apps: true,
        tool_policy: "projected",
      }),
    });
    expect(runtimeBackendForModel(model)).toBe(backend);
    expect(Object.isFrozen(backends)).toBe(true);
    expect(Object.isFrozen(backend)).toBe(true);
    expect(Object.isFrozen(backend.capabilities)).toBe(true);
  });

  it("describes every parsed model through the sole Pi backend", () => {
    const model = parseMonoRuntimeModelReference("ollama:qwen3:8b");
    expect(describeMonoRuntimeSupport(model)).toEqual({
      model,
      compatible: true,
      backend: runtimeBackendForModel(model),
    });
  });
});

describe("runtime adapter Pi exports and capabilities", () => {
  it("re-exports the Pi OAuth API key resolver factory", () => {
    expect(typeof createPiOAuthApiKeyResolver).toBe("function");
  });

  it("reads constant capabilities from the sole backend", () => {
    expect(monoRuntimeSupportsMcpApps()).toBe(true);
    expect(monoRuntimeSupportsLiveInput()).toBe(true);
    expect(monoRuntimeSupportsSessionResume()).toBe(true);
  });

  it("exposes session lifecycle on the mono runtime", async () => {
    const runtime = createMonoRuntime();
    expect(typeof runtime.syncSession).toBe("function");
    expect(typeof runtime.refreshSession).toBe("function");
    expect(typeof runtime.retireDurableSession).toBe("function");
    expect(typeof runtime.disposeSession).toBe("function");
    expect(typeof runtime.invalidateSession).toBe("function");
    expect(typeof runtime.disposeAllSessions).toBe("function");
    await expect(runtime.syncSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.refreshSession?.("no-such-session")).resolves.toBeUndefined();
    await expect(runtime.retireDurableSession?.("no-such-session", "/tmp/mono-agent-no-sessions")).resolves.toBeUndefined();
    await expect(runtime.disposeSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.invalidateSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });
});

describe("runtime adapter fallback chain", () => {
  it("builds a Pi router that still exposes session lifecycle", async () => {
    const runtime = createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5") },
        { model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6") },
      ],
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.configureTools).toBe("function");
    await expect(runtime.syncSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.refreshSession?.("no-such-session")).resolves.toBeUndefined();
    await expect(runtime.retireDurableSession?.("no-such-session", "/tmp/mono-agent-no-sessions-router")).resolves.toBeUndefined();
    await expect(runtime.disposeSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.invalidateSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });

  it("rejects an empty fallback chain", () => {
    expect(() => createMonoRuntime({ fallbackChain: [] })).toThrow(RuntimeAdapterError);
  });

  it("forwards the actual attempted model and exact effort tri-state", async () => {
    const attempts: Array<{ model: string; effort: unknown }> = [];
    const configureTools = vi.fn();
    const fakeRuntime = {
      configureTools,
      async run(_systemPrompt: string, options: { model: { model: string }; effort?: string }) {
        attempts.push({
          model: options.model.model,
          effort: Object.hasOwn(options, "effort") ? options.effort : "provider-default",
        });
        return { text: "ok", events: [], cancelled: false, usage: {} };
      },
    };
    const model = parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6");
    const runtime = createMonoRuntime({
      fallbackChain: [{ model, effort: null }],
      resolveAttempt: (context) => {
        expect(context).toEqual({
          attemptIndex: 0,
          retryIndex: 0,
          model,
        });
        return { runtime: fakeRuntime as never, options: { privateSentinel: "not-telemetry" } };
      },
    });

    const result = await runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("openai-codex:ignored-by-chain"),
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(configureTools).toHaveBeenCalledOnce();
    expect(attempts).toEqual([{
      model: "claude-sonnet-4-6",
      effort: "provider-default",
    }]);
    expect(JSON.stringify(result)).not.toContain("privateSentinel");
  });

  it("rejects malformed effort values", () => {
    expect(() => createMonoRuntime({
      fallbackChain: [{
        model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6"),
        effort: " high",
      }],
    })).toThrow(RuntimeAdapterError);
  });

  it("rejects chain entries with unparsed model references", () => {
    expect(() =>
      createMonoRuntime({
        fallbackChain: [{ model: { provider: "", model: "", reference: "" } }],
      }),
    ).toThrow(RuntimeAdapterError);
  });

  it("rejects non-object chain entries with a typed error", () => {
    for (const entry of [null, undefined, "anthropic:claude-sonnet-4-6", ["anthropic"]]) {
      expect(() =>
        createMonoRuntime({
          fallbackChain: [entry as never],
        }),
      ).toThrow(RuntimeAdapterError);
    }
  });

  it("rejects duplicate routes authored with mixed pi-wrapper spellings", () => {
    expect(() => createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("pi:anthropic:claude-sonnet-4-6") },
        { model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6") },
      ],
    })).toThrow(/duplicate model anthropic:claude-sonnet-4-6/u);
  });
});

describe("runtime adapter local providers", () => {
  it("maps Ollama provider config to agent-runtime custom Pi options", () => {
    const options = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("ollama:qwen3:8b"),
      [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: true,
          models: [
            {
              name: "qwen3:8b",
              capabilities: { context_window: 32768 },
            },
          ],
        },
      ],
    );

    expect(options.customProvider).toMatchObject({
      id: "ollama",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
      enabled: true,
    });
    expect(options.customModel).toMatchObject({
      model_name: "qwen3:8b",
      display_name: "qwen3:8b",
      enabled: true,
      pricing: {},
    });
    expect(options.modelCapabilities).toMatchObject({
      context_window: 32768,
      json_mode: true,
      reasoning: true,
      reasoning_mode: "toggle",
    });
    expect(options.isPrivateProvider).toBe(true);
  });

  it("preserves disabled local providers so agent-runtime can fail honestly", () => {
    const options = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("ollama:llama3"),
      [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: false,
        },
      ],
    );

    expect(options.customProvider).toMatchObject({
      id: "ollama",
      provider_type: "ollama",
      enabled: false,
    });
  });

  it("does nothing for providers that are not configured locally", () => {
    const localProviders = [
      {
        id: "ollama",
        type: "ollama" as const,
        baseUrl: "http://localhost:11434",
        enabled: true,
      },
    ];

    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("openai-codex:gpt-5.5"),
      localProviders,
    )).toEqual({});
    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6"),
      localProviders,
    )).toEqual({});
  });

  it("rejects untrusted public HTTP local-provider URLs", () => {
    expect(() => runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("gateway:gpt-oss"),
      [
        {
          id: "gateway",
          type: "openai_compat",
          baseUrl: "http://api.example.com",
          enabled: true,
        },
      ],
    )).toThrow(RuntimeAdapterError);
  });

  it("maps LM Studio and trusted OpenAI-compatible providers through the same custom-provider contract", () => {
    const lmStudio = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("lmstudio:local-model"),
      [
        {
          id: "lmstudio",
          type: "lmstudio",
          baseUrl: "http://localhost:1234",
          enabled: true,
        },
      ],
    );
    expect(lmStudio.customProvider).toMatchObject({
      id: "lmstudio",
      provider_type: "lmstudio",
      base_url: "http://localhost:1234",
    });
    expect(lmStudio.isPrivateProvider).toBe(true);

    const gateway = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("local-gateway:gpt-oss"),
      [
        {
          id: "local-gateway",
          type: "openai_compat",
          baseUrl: "https://api.example.com/openai",
          trustPublicUrl: true,
          enabled: true,
          apiKey: "fixture-key-from-env",
        },
      ],
    );
    expect(gateway.customProvider).toMatchObject({
      id: "local-gateway",
      provider_type: "openai_compat",
      base_url: "https://api.example.com/openai",
      api_key: "fixture-key-from-env",
    });
    expect(gateway.isPrivateProvider).toBe(false);
  });
});

describe("createMonoRuntime same-model retry options", () => {
  const model = { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" } as const;

  it.each([0, 11, 1.5, "2" as unknown as number])("rejects a fallback attempts value of %s", (attempts) => {
    expect(() => createMonoRuntime({ fallbackChain: [{ model, attempts }] }))
      .toThrow(/attempts must be an integer between 1 and 10/u);
  });

  it("accepts an omitted or in-range attempts value", () => {
    expect(() => createMonoRuntime({ fallbackChain: [{ model }] })).not.toThrow();
    expect(() => createMonoRuntime({ fallbackChain: [{ model, attempts: 3 }] })).not.toThrow();
  });

  it.each([
    ["backoffMs", -1],
    ["maxBackoffMs", Number.POSITIVE_INFINITY],
  ])("rejects a non-negative-finite retry %s", (key, value) => {
    expect(() => createMonoRuntime({
      fallbackChain: [{ model }],
      retry: { [key]: value } as Record<string, number>,
    })).toThrow(/must be a non-negative finite number/u);
  });
});
