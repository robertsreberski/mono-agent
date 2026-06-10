import { describe, expect, it } from "vitest";

import {
  assertExecutionModeCompatible,
  createMonoRuntime,
  defaultExecutionModeForModel,
  describeMonoRuntimeSupport,
  listMonoRuntimeBackends,
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
  });

  it("accepts compatible execution modes", () => {
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).not.toThrow();
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).not.toThrow();
  });

  it("lists the runtime backend matrix exposed by agent-runtime", () => {
    const backends = listMonoRuntimeBackends();
    expect(backends.map((backend) => backend.id)).toEqual([
      "claude-sdk",
      "claude-code-cli",
      "codex-app-cli",
      "openai-agents-sdk",
      "pi-sdk",
    ]);
    expect(backends.find((backend) => backend.id === "claude-sdk")).toMatchObject({
      runtimeBridgeId: "claude",
      sdk: "claude",
      executionMode: "sdk",
      transport: "sdk",
    });
    expect(backends.find((backend) => backend.id === "codex-app-cli")?.capabilities).toMatchObject({
      kind: "codex-app",
      supports_mcp: true,
    });
    expect(backends.find((backend) => backend.id === "pi-sdk")?.acceptsProviderIds).toBe(true);
  });

  it("resolves runtime backend support by model and execution mode", () => {
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6")).id).toBe("claude-sdk");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli").id).toBe("claude-code-cli");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("codex:gpt-5.5")).id).toBe("codex-app-cli");
    expect(runtimeBackendForModel(parseMonoRuntimeModelReference("pi:github-copilot:gpt-4.1")).id).toBe("pi-sdk");
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

describe("runtime adapter provider sessions", () => {
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

  it("exposes session disposal on the mono runtime", async () => {
    const runtime = createMonoRuntime();
    expect(typeof runtime.disposeSession).toBe("function");
    expect(typeof runtime.disposeAllSessions).toBe("function");
    await expect(runtime.disposeSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
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
          apiKey: "secret-from-env",
        },
      ],
    );
    expect(gateway.customProvider).toMatchObject({
      id: "local-gateway",
      provider_type: "openai_compat",
      base_url: "https://api.example.com/openai",
      api_key: "secret-from-env",
    });
    expect(gateway.isPrivateProvider).toBe(false);
  });
});
