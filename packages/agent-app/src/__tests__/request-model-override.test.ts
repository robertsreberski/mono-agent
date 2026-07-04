import type { LocalProviderDefinition } from "@mono-agent/runtime-adapter";
import { describe, expect, it, vi } from "vitest";

import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";

interface RunOptions {
  readonly logger?: { warn: ReturnType<typeof vi.fn> };
  readonly localProviders?: readonly LocalProviderDefinition[];
}

function run(metadata: Record<string, unknown> | undefined, options: RunOptions = {}) {
  const extension = createRequestModelOverrideRuntimeExtension({
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.localProviders === undefined ? {} : { localProviders: options.localProviders }),
  });
  return extension({ request: { ...(metadata === undefined ? {} : { metadata }) } });
}

const LMSTUDIO_PROVIDER: LocalProviderDefinition = {
  id: "lmstudio",
  type: "lmstudio",
  baseUrl: "http://localhost:1234",
  enabled: true,
};

const OLLAMA_PROVIDER: LocalProviderDefinition = {
  id: "ollama",
  type: "ollama",
  baseUrl: "http://localhost:11434",
  enabled: true,
};

describe("createRequestModelOverrideRuntimeExtension", () => {
  it("applies a webhook model + effort override (executionMode is left to the harness)", async () => {
    const result = await run({ webhook: { model: "claude:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("applies a cron model override without an effort", async () => {
    const result = await run({ cron: { model: "codex:gpt-5.5" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex", model: "gpt-5.5" }));
    expect(result.runtimeOptions.effort).toBeUndefined();
  });

  it("prefers webhook metadata over cron metadata when both are present", async () => {
    const result = await run({
      webhook: { model: "claude:claude-opus-4-8" },
      cron: { model: "codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude" }));
  });

  it("applies a tui per-session model + effort override", async () => {
    const result = await run({ tui: { model: "claude:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("low");
  });

  it("prefers cron metadata over tui metadata when both are present", async () => {
    const result = await run({
      cron: { model: "codex:gpt-5.5" },
      tui: { model: "claude:claude-opus-4-8" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex" }));
  });

  it("warns and ignores an invalid model string (no override applied)", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { model: "not a model" } }, { logger });
    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request model"),
      expect.objectContaining({ model: "not a model" }),
    );
  });

  it("warns and ignores an invalid effort value", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { effort: "turbo" } }, { logger });
    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request effort"),
      expect.objectContaining({ effort: "turbo" }),
    );
  });

  it("is a no-op for interactive turns (no cron/webhook metadata)", async () => {
    const result = await run(undefined);
    expect(result.runtimeOptions).toEqual({});
  });

  it("recomputes the local-provider endpoint block for a local-model override", async () => {
    const result = await run(
      { tui: { model: "pi:lmstudio:qwen/qwen3-8b" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
    );
    const options = result.runtimeOptions as Record<string, unknown>;
    expect(options.customProvider).toMatchObject({
      id: "lmstudio",
      provider_type: "lmstudio",
      base_url: "http://localhost:1234",
    });
    expect(options.customModel).toMatchObject({ model_name: "qwen/qwen3-8b" });
    expect(options.modelCapabilities).toEqual(expect.any(Object));
    expect(options.isPrivateProvider).toBe(true);
  });

  it("CLEARS the endpoint block (null) for a cloud-model override so the host default cannot leak", async () => {
    const result = await run(
      { webhook: { model: "claude:claude-opus-4-8", effort: "high" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    // A model override OWNS the block: for a cloud model every endpoint field is
    // an explicit null so the harness merge deletes the host default's block.
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "claude" }),
      effort: "high",
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when the override's local provider is not configured", async () => {
    const result = await run(
      { tui: { model: "pi:lmstudio:qwen/qwen3-8b" } },
      { localProviders: [OLLAMA_PROVIDER] },
    );
    // The model ref applies, but an unconfigured provider id is non-local → clear
    // (so the run cannot inherit the default local endpoint under the new name).
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when no local providers are configured", async () => {
    const result = await run({ tui: { model: "pi:lmstudio:qwen/qwen3-8b" } });
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("leaves the endpoint block UNTOUCHED for an effort-only override (no model)", async () => {
    const result = await run(
      { tui: { effort: "medium" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    // No model override → the default block is correct for the default model, so
    // the four keys are neither set nor cleared (no null sentinels emitted).
    expect(result.runtimeOptions).toEqual({ effort: "medium" });
  });

  it("CLEARS the block and warns (never fails) for a misconfigured local provider", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { model: "pi:gateway:gpt-oss" } },
      {
        logger,
        // Untrusted public HTTP URL → runtimeOptionsForLocalProvider throws; the
        // extension warns-and-ignores and treats it as non-local (block cleared).
        localProviders: [{ id: "gateway", type: "openai_compat", baseUrl: "http://api.example.com", enabled: true }],
      },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "pi", provider: "gateway", model: "gpt-oss" }),
    );
    expect(result.runtimeOptions.customProvider).toBeNull();
    expect(result.runtimeOptions.customModel).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("local-provider endpoint"),
      expect.objectContaining({ model: "pi:gateway:gpt-oss" }),
    );
  });
});
