import { describe, expect, it, vi } from "vitest";

import {
  assertExecutionModeCompatible,
  createPiOAuthApiKeyResolver,
  createMonoRuntime,
  defaultExecutionModeForModel,
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
  it("parses canonical Pi model references", () => {
    expect(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5")).toEqual({
      sdk: "pi",
      provider: "openai-codex",
      model: "gpt-5.5",
      reference: "pi:openai-codex:gpt-5.5",
    });
  });

  it("parses Codex model references and defaults them to CLI", () => {
    const model = parseMonoRuntimeModelReference("codex:gpt-5.5");
    expect(model).toEqual({ sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" });
    expect(defaultExecutionModeForModel(model)).toBe("cli");
  });

  it("parses OpenCode model references and defaults them to CLI", () => {
    const model = parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1");
    expect(model).toEqual({
      sdk: "opencode",
      provider: "github-copilot",
      model: "gpt-4.1",
      reference: "opencode:github-copilot:gpt-4.1",
    });
    expect(defaultExecutionModeForModel(model)).toBe("cli");
  });

  it("parses ACP profile references and defaults them to the dedicated ACP transport", () => {
    const model = parseMonoRuntimeModelReference("acp:personal-agent");
    expect(model).toEqual({ sdk: "acp", model: "personal-agent", reference: "acp:personal-agent" });
    expect(defaultExecutionModeForModel(model)).toBe("acp");
  });

  it("rejects raw or legacy-invalid model references with a stable error", () => {
    expect(() => parseMonoRuntimeModelReference("haiku")).toThrow(RuntimeAdapterError);
    try {
      parseMonoRuntimeModelReference("haiku");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_model_reference" });
    }
  });

  it("rejects incompatible execution modes before calling the runtime", () => {
    const model = parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5");
    expect(() => assertExecutionModeCompatible(model, "cli")).toThrow(/only runs under SDK execution mode/u);
    expect(() => assertExecutionModeCompatible(model, "other")).toThrow(/sdk, cli, or acp/u);
  });

  it("accepts compatible execution modes", () => {
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("acp:personal-agent"), "acp")).not.toThrow();
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("acp:personal-agent"), "cli"))
      .toThrow(/require ACP execution mode/i);
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).not.toThrow();
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).not.toThrow();
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1"), "cli")).not.toThrow();
  });

  it("lists the runtime backend matrix exposed by agent-runtime", () => {
    const backends = listMonoRuntimeBackends();
    expect(backends.map((backend) => backend.id)).toEqual([
      "acp-stdio",
      "claude-sdk",
      "claude-code-cli",
      "codex-app-cli",
      "opencode-app-cli",
      "pi-sdk",
    ]);
    expect(backends.find((backend) => backend.id === "acp-stdio")).toMatchObject({
      runtimeBridgeId: "acp-stdio",
      sdk: "acp",
      executionMode: "acp",
      transport: "acp",
      capabilities: expect.objectContaining({
        kind: "acp",
        supports_session_resume: true,
        supports_mcp: false,
        tool_policy: "allow_all_only",
      }),
    });
    expect(backends.find((backend) => backend.id === "claude-sdk")).toMatchObject({
      runtimeBridgeId: "claude",
      sdk: "claude",
      executionMode: "sdk",
      transport: "sdk",
      capabilities: expect.objectContaining({ tool_policy: "projected" }),
    });
    expect(backends.find((backend) => backend.id === "codex-app-cli")?.capabilities).toMatchObject({
      kind: "codex-app",
      supports_mcp: true,
      tool_policy: "allow_all_only",
    });
    expect(backends.find((backend) => backend.id === "opencode-app-cli")).toMatchObject({
      runtimeBridgeId: "opencode-app",
      sdk: "opencode",
      executionMode: "cli",
      transport: "cli",
      acceptsProviderIds: true,
      capabilities: expect.objectContaining({
        kind: "opencode-app",
        supports_mcp: false,
        supports_session_resume: false,
        tool_policy: "allow_all_only",
      }),
    });
    expect(backends.find((backend) => backend.id === "pi-sdk")).toMatchObject({
      acceptsProviderIds: true,
      capabilities: expect.objectContaining({ tool_policy: "projected" }),
    });
  });

  it("resolves runtime backend support by model and execution mode", () => {
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("acp:personal-agent")).id).toBe("acp-stdio");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6")).id).toBe("claude-sdk");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli").id).toBe("claude-code-cli");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("codex:gpt-5.5")).id).toBe("codex-app-cli");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1")).id).toBe("opencode-app-cli");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("pi:github-copilot:gpt-4.1")).id).toBe("pi-sdk");
  });

  it("describes OpenCode support through the registered CLI bridge", () => {
    expect(describeMonoRuntimeSupport(
      parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1"),
    )).toMatchObject({
      executionMode: "cli",
      compatible: true,
      backend: {
        id: "opencode-app-cli",
        runtimeBridgeId: "opencode-app",
      },
    });
  });

  it("describes incompatible runtime support without hiding the reason", () => {
    expect(describeMonoRuntimeSupport(parseMonoRuntimeModelReference("codex:gpt-5.5"), "sdk")).toMatchObject({
      compatible: false,
      incompatibilityReason: "Codex CLI requires CLI execution mode.",
    });
    expect(describeMonoRuntimeSupport(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"), "cli")).toMatchObject({
      compatible: false,
      incompatibilityReason: "Provider `openai-codex` only runs under SDK execution mode; use codex:<model> for Codex CLI.",
    });
    expect(() => runtimeBackendForModel(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"), "cli"))
      .toThrow(RuntimeAdapterError);
  });
});

describe("runtime adapter Pi auth exports", () => {
  it("re-exports the Pi OAuth API key resolver factory", () => {
    expect(typeof createPiOAuthApiKeyResolver).toBe("function");
  });
});

describe("runtime adapter provider sessions", () => {
  it("reports MCP Apps support only for the host-routed Pi runtime", () => {
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"))).toBe(true);
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "sdk")).toBe(false);
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).toBe(false);
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).toBe(false);
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1"), "cli")).toBe(false);
    expect(monoRuntimeSupportsMcpApps(parseMonoRuntimeModelReference("acp:personal-agent"), "acp")).toBe(false);
  });

  it("reports live-input support from the selected runtime backend", () => {
    expect(monoRuntimeSupportsLiveInput(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "sdk")).toBe(true);
    expect(monoRuntimeSupportsLiveInput(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).toBe(false);
    expect(monoRuntimeSupportsLiveInput(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).toBe(true);
    expect(monoRuntimeSupportsLiveInput(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"))).toBe(true);
    expect(monoRuntimeSupportsLiveInput(parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1"), "cli")).toBe(false);
  });

  it("reports session resume support for every backend", () => {
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "sdk")).toBe(true);
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).toBe(true);
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).toBe(true);
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"))).toBe(true);
  });

  it("resolves the default execution mode when omitted", () => {
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"))).toBe(true);
    expect(monoRuntimeSupportsSessionResume(parseMonoRuntimeModelReference("codex:gpt-5.5"))).toBe(true);
  });

  it("exposes session sync, strict refresh, disposal, and invalidation on the mono runtime", async () => {
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

describe("runtime adapter ACP run contracts", () => {
  it("rejects request-scoped MCP servers before resolving a direct ACP profile", async () => {
    const resolveAcpProfile = vi.fn();
    const runtime = createMonoRuntime();

    await expect(runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("acp:personal-agent"),
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
      resolveAcpProfile,
      mcpServers: { filesystem: { command: "/absolute/mcp-server" } },
    })).rejects.toMatchObject({
      name: "RuntimeAdapterError",
      code: "invalid_runtime_options",
      details: expect.objectContaining({ option: "mcpServers" }),
    });
    expect(resolveAcpProfile).not.toHaveBeenCalled();
  });

  it("capability-skips an ACP-only route chain carrying request-scoped MCP servers", async () => {
    const resolveAcpProfile = vi.fn();
    const resolveAttempt = vi.fn(() => ({ options: { resolveAcpProfile } }));
    const runtime = createMonoRuntime({
      fallbackChain: [{ model: parseMonoRuntimeModelReference("acp:personal-agent") }],
      resolveAttempt,
    });

    const result = await runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("acp:personal-agent"),
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
      mcpServers: { filesystem: { command: "/absolute/mcp-server" } },
    });

    expect(result.failureKind).toBe("skipped_capability_mismatch");
    expect(resolveAttempt).not.toHaveBeenCalled();
    expect(resolveAcpProfile).not.toHaveBeenCalled();
  });
});

describe("runtime adapter OpenCode routing", () => {
  it("routes an omitted execution mode to OpenCode CLI through createMonoRuntime", async () => {
    const runtime = createMonoRuntime();
    const result = await runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("opencode:github-copilot:gpt-4.1"),
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
      // The direct OpenCode bridge deliberately rejects this policy before it
      // starts a server, making the assertion deterministic while still proving
      // the adapter selected and invoked the real registered bridge.
      allowedTools: [],
      disallowedTools: [],
    });

    expect(result).toMatchObject({
      sdk: "opencode",
      model: "opencode:github-copilot:gpt-4.1",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_tool_policy_unsupported" },
    });
  });
});

describe("runtime adapter fallback chain", () => {
  it("builds a router-backed runtime that still exposes session lifecycle", async () => {
    const runtime = createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6") },
        { model: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5") },
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

  it("rejects chain entries with incompatible execution modes at construction", () => {
    expect(() =>
      createMonoRuntime({
        fallbackChain: [
          {
            model: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"),
            executionMode: "cli",
          },
        ],
      }),
    ).toThrow(RuntimeAdapterError);
  });

  it.each([
    ["direct Codex primary", ["codex:gpt-5.6-terra", "pi:openai-codex:gpt-5.5"]],
    ["direct Codex fallback", ["claude:claude-sonnet-4-6", "codex:gpt-5.6-terra"]],
  ])("accepts a mixed runtime family with a %s under an explicit route contract", async (_label, references) => {
    const runtime = createMonoRuntime({
      fallbackChain: references.map((reference) => ({
        model: parseMonoRuntimeModelReference(reference),
      })),
      routeSafety: "per-route-native",
    });
    expect(typeof runtime.run).toBe("function");
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });

  it("forwards route safety, the actual attempted model, and exact effort tri-state", async () => {
    const attempts: Array<{ model: string; effort: unknown }> = [];
    const fakeRuntime = {
      async run(_systemPrompt: string, options: { model: { model: string }; effort?: string }) {
        attempts.push({
          model: options.model.model,
          effort: Object.hasOwn(options, "effort") ? options.effort : "provider-default",
        });
        return { text: "ok", events: [], cancelled: false, usage: {} };
      },
    };
    const runtime = createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), effort: null },
      ],
      routeSafety: "per-route-native",
      resolveAttempt: (context) => {
        expect(context).toMatchObject({
          attemptIndex: 0,
          routeSafety: "per-route-native",
          model: { model: "claude-sonnet-4-6" },
        });
        return { runtime: fakeRuntime as never, options: { privateSentinel: "not-telemetry" } };
      },
    });
    const result = await runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("claude:ignored-by-chain"),
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
    });
    expect(attempts).toEqual([{
      model: "claude-sonnet-4-6",
      effort: "provider-default",
    }]);
    expect(JSON.stringify(result)).not.toContain("privateSentinel");
  });

  it("rejects invalid route safety and malformed effort values", () => {
    expect(() => createMonoRuntime({ routeSafety: "unsafe" as never })).toThrow(RuntimeAdapterError);
    expect(() => createMonoRuntime({
      fallbackChain: [{
        model: parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"),
        effort: " high",
      }],
    })).toThrow(RuntimeAdapterError);
  });

  it("accepts an all-direct-Codex fallback chain", async () => {
    const runtime = createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("codex:gpt-5.6-terra") },
        { model: parseMonoRuntimeModelReference("codex:gpt-5.5") },
      ],
    });

    expect(typeof runtime.run).toBe("function");
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });

  it("rejects chain entries with unparsed model references", () => {
    expect(() =>
      createMonoRuntime({
        fallbackChain: [{ model: { sdk: "", model: "" } }],
      }),
    ).toThrow(RuntimeAdapterError);
  });

  it("rejects non-object chain entries with a typed error", () => {
    for (const entry of [null, undefined, "claude:claude-sonnet-4-6", ["claude"]]) {
      expect(() =>
        createMonoRuntime({
          fallbackChain: [entry as never],
        }),
      ).toThrow(RuntimeAdapterError);
    }
  });
});

describe("runtime adapter local providers", () => {
  it("maps Ollama provider config to agent-runtime custom Pi options", () => {
    const options = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("pi:ollama:qwen3:8b"),
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
      parseMonoRuntimeModelReference("pi:ollama:llama3"),
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

  it("does nothing for built-in Pi providers and non-Pi model references", () => {
    const localProviders = [
      {
        id: "ollama",
        type: "ollama" as const,
        baseUrl: "http://localhost:11434",
        enabled: true,
      },
    ];

    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5"),
      localProviders,
    )).toEqual({});
    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("codex:gpt-5.5"),
      localProviders,
    )).toEqual({});
  });

  it("rejects untrusted public HTTP local-provider URLs", () => {
    expect(() => runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("pi:gateway:gpt-oss"),
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
      parseMonoRuntimeModelReference("pi:lmstudio:local-model"),
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
      parseMonoRuntimeModelReference("pi:local-gateway:gpt-oss"),
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

describe("createMonoRuntime same-model retry options", () => {
  const model = { sdk: "claude", model: "claude-sonnet-4-6", reference: "claude:claude-sonnet-4-6" } as const;

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
});
