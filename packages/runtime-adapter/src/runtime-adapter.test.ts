import { describe, expect, it } from "vitest";

import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  describeMonoRuntimeSupport,
  listMonoRuntimeBackends,
  parseMonoRuntimeModelReference,
  runtimeBackendForModel,
  RuntimeAdapterError,
} from "./index.js";

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
