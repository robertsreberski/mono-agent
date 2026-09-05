import {
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  parseMonoRuntimeModelReference,
  RuntimeAdapterError,
  sanitizeModelReferenceText,
} from "@mono-agent/runtime-adapter";
import type { LocalProviderDefinition, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import { describe, expect, it, vi } from "vitest";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";

import {
  createRequestModelOverrideRuntimeExtension,
  requestModelOverrideRoutesOnlyPiNative,
  requestModelOverrideTargetsPiNative,
} from "../request-model-override.js";
import { composeRuntimeOptionExtensions } from "../runtime-option-extensions.js";

interface RunOptions {
  readonly logger?: { warn: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> };
  readonly localProviders?: readonly LocalProviderDefinition[];
  readonly baseModel?: RuntimeModelReference;
  readonly fallbackModels?: readonly RuntimeModelReference[];
  readonly baseEffort?: string;
}

function run(metadata: Record<string, unknown> | undefined, options: RunOptions = {}, userMessage?: string) {
  const extension = createRequestModelOverrideRuntimeExtension({
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.localProviders === undefined ? {} : { localProviders: options.localProviders }),
    ...(options.baseModel === undefined ? {} : { baseModel: options.baseModel }),
    ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels }),
    ...(options.baseEffort === undefined ? {} : { baseEffort: options.baseEffort }),
  });
  return extension({
    request: {
      ...(metadata === undefined ? {} : { metadata }),
      ...(userMessage === undefined ? {} : { userMessage }),
    },
  });
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

describe("requestModelOverrideTargetsPiNative", () => {
  it("offers Pi-native tools when an accepted override targets Pi", () => {
    expect(requestModelOverrideTargetsPiNative(
      { tui: { model: "openai-codex:gpt-5.6-terra" } },
      { baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8") },
    )).toBe(true);
  });

  it("offers Pi-native tools when only a configured fallback targets Pi", () => {
    expect(requestModelOverrideTargetsPiNative(undefined, {
      baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8"),
      fallbackModels: [parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra")],
    })).toBe(true);
  });

  it("offers Pi-native tools for every parsed provider route", () => {
    expect(requestModelOverrideTargetsPiNative(undefined, {
      baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8"),
      fallbackModels: [parseMonoRuntimeModelReference("github-copilot:gpt-5.1")],
    })).toBe(true);
  });
});

describe("requestModelOverrideRoutesOnlyPiNative", () => {
  const piPrimary = parseMonoRuntimeModelReference("openai-codex:gpt-5.6-sol");
  const piFallback = parseMonoRuntimeModelReference("ollama:qwen3:8b");
  it("accepts an all-Pi primary and fallback chain", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [piFallback],
    })).toBe(true);
  });

  it("accepts any parsed provider fallback", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [parseMonoRuntimeModelReference("anthropic:claude-opus-4-8")],
    })).toBe(true);
  });

  it("uses an accepted Pi request override as primary and removes its duplicate configured fallback", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(
      { tui: { model: "ollama:qwen3:8b" } },
      {
        baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8"),
        fallbackModels: [piFallback],
      },
    )).toBe(true);
  });

  it("accepts a parsed configured fallback behind a request override", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(
      { tui: { model: "ollama:qwen3:8b" } },
      {
        baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8"),
        fallbackModels: [parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6")],
      },
    )).toBe(true);
  });

  it("accepts a parsed request override when every configured fallback resolves", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(
      { tui: { model: "anthropic:claude-opus-4-8" } },
      {
        baseModel: piPrimary,
        fallbackModels: [piFallback],
      },
    )).toBe(true);
  });

  it("uses the unchanged base chain when there is no request override", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [piFallback],
    })).toBe(true);
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [parseMonoRuntimeModelReference("anthropic:claude-opus-4-8")],
    })).toBe(true);
  });

  it("fails closed for empty, malformed, and duplicate reachable chains", () => {
    expect(requestModelOverrideRoutesOnlyPiNative(undefined)).toBe(false);
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [undefined as never],
    })).toBe(false);
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      baseModel: piPrimary,
      fallbackModels: [piFallback, piFallback],
    })).toBe(false);
  });

  // Regression for mono-agent#664: this predicate fails closed on an
  // unresolvable chain, which at every call site is indistinguishable from a
  // genuinely non-Pi route. Discarding the cause made that failure impossible
  // to diagnose from outside, so the reason must reach the logger.
  it("warns with the swallowed reason instead of discarding an unresolvable chain", () => {
    const logger = { warn: vi.fn() };
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, { logger })).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toContain("could not be resolved");
    expect(logger.warn.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ reason: expect.stringContaining("model reference") }),
    );
  });

  it("does not warn when the chain resolves", () => {
    const logger = { warn: vi.fn() };
    expect(requestModelOverrideRoutesOnlyPiNative(undefined, {
      logger,
      baseModel: parseMonoRuntimeModelReference("anthropic:claude-opus-4-8"),
      fallbackModels: [piFallback],
    })).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("createRequestModelOverrideRuntimeExtension", () => {
  it("applies a webhook model + effort override (executionMode is left to the harness)", async () => {
    const result = await run({ webhook: { model: "anthropic:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("applies a cron model override without an effort", async () => {
    const result = await run({ cron: { model: "openai-codex:gpt-5.5" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "openai-codex", model: "gpt-5.5" }));
    expect(result.runtimeOptions.effort).toBeUndefined();
  });

  it("prefers webhook metadata over cron metadata when both are present", async () => {
    const result = await run({
      webhook: { model: "anthropic:claude-opus-4-8" },
      cron: { model: "openai-codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic" }));
  });

  it("applies a tui per-session model + effort override", async () => {
    const result = await run({ tui: { model: "anthropic:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("low");
  });

  it("applies a web per-thread model + effort override", async () => {
    const result = await run({ web: { model: "anthropic:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("low");
  });

  it("does not retain a web override across later channel or API requests", async () => {
    const extension = createRequestModelOverrideRuntimeExtension({});
    const web = await extension({ request: { metadata: {
      web: { model: "anthropic:claude-opus-4-8", effort: "high" },
    } } });
    expect(web.runtimeOptions).toMatchObject({
      model: expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-8" }),
      effort: "high",
    });

    for (const metadata of [
      { telegram: {} },
      { slack: {} },
      { cron: {} },
      { webhook: {} },
      { tui: {} },
      {},
    ]) {
      const next = await extension({ request: { metadata } });
      expect(next.runtimeOptions).toEqual({});
    }
    expect((await extension({ request: {} })).runtimeOptions).toEqual({});
  });

  it("applies a Telegram per-chat model + effort override", async () => {
    const result = await run({ telegram: { model: "anthropic:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      provider: "anthropic",
      model: "claude-opus-4-8",
    }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("applies a Slack conversation model + effort override", async () => {
    const result = await run({ slack: { model: "anthropic:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      provider: "anthropic",
      model: "claude-opus-4-8",
    }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("preserves existing Telegram precedence when malformed metadata carries both channel blocks", async () => {
    const result = await run({
      telegram: { model: "anthropic:claude-opus-4-8" },
      slack: { model: "openai-codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic" }));
  });

  it("prefers web metadata over its TUI compatibility mirror", async () => {
    const result = await run({
      web: { model: "anthropic:claude-opus-4-8", effort: "high" },
      tui: { model: "openai-codex:gpt-5.5", effort: "low" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("prefers cron metadata over tui metadata when both are present", async () => {
    const result = await run({
      cron: { model: "openai-codex:gpt-5.5" },
      tui: { model: "anthropic:claude-opus-4-8" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ provider: "openai-codex" }));
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
      { tui: { model: "lmstudio:qwen/qwen3-8b" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ provider: "lmstudio", model: "qwen/qwen3-8b" }),
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
      { webhook: { model: "anthropic:claude-opus-4-8", effort: "high" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    // A model override OWNS the block: for a cloud model every endpoint field is
    // an explicit null so the harness merge deletes the host default's block.
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ provider: "anthropic" }),
      effort: "high",
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when the override's local provider is not configured", async () => {
    const result = await run(
      { tui: { model: "lmstudio:qwen/qwen3-8b" } },
      { localProviders: [OLLAMA_PROVIDER] },
    );
    // The model ref applies, but an unconfigured provider id is non-local → clear
    // (so the run cannot inherit the default local endpoint under the new name).
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ provider: "lmstudio", model: "qwen/qwen3-8b" }),
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when no local providers are configured", async () => {
    const result = await run({ tui: { model: "lmstudio:qwen/qwen3-8b" } });
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ provider: "lmstudio", model: "qwen/qwen3-8b" }),
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
      { tui: { model: "gateway:gpt-oss" } },
      {
        logger,
        // Untrusted public HTTP URL → runtimeOptionsForLocalProvider throws; the
        // extension warns-and-ignores and treats it as non-local (block cleared).
        localProviders: [{ id: "gateway", type: "openai_compat", baseUrl: "http://api.example.com", enabled: true }],
      },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ provider: "gateway", model: "gpt-oss" }),
    );
    expect(result.runtimeOptions.customProvider).toBeNull();
    expect(result.runtimeOptions.customModel).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("local-provider endpoint"),
      expect.objectContaining({ model: "gateway:gpt-oss" }),
    );
  });

  describe("effort keyword escalation", () => {
    it("escalates a plain interactive turn containing 'think' to high", async () => {
      const result = await run(undefined, {}, "think about this bug");
      expect(result.runtimeOptions.effort).toBe("high");
      expect(result.runtimeOptions.model).toBeUndefined();
    });

    it("escalates 'ultrathink' to max and 'extra think' to xhigh", async () => {
      expect((await run(undefined, {}, "ultrathink: what is 2+2")).runtimeOptions.effort).toBe("max");
      expect((await run(undefined, {}, "please extra think about it")).runtimeOptions.effort).toBe("xhigh");
    });

    it("escalates above the configured base effort", async () => {
      const result = await run(undefined, { baseEffort: "medium" }, "ultra think");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("is a no-op when the base effort already meets the keyword level", async () => {
      const result = await run(undefined, { baseEffort: "xhigh" }, "think about this");
      expect(result.runtimeOptions.effort).toBeUndefined();
    });

    it("is a no-op without a trigger phrase or with word fragments", async () => {
      expect((await run(undefined, {}, "keep thinking about it")).runtimeOptions.effort).toBeUndefined();
      expect((await run(undefined, {}, "rethink the approach")).runtimeOptions.effort).toBeUndefined();
      expect((await run(undefined, {})).runtimeOptions.effort).toBeUndefined();
    });

    it("never downgrades a higher metadata effort override", async () => {
      const result = await run({ webhook: { effort: "max" } }, {}, "think about this");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("outranks a lower metadata effort override", async () => {
      const result = await run({ webhook: { effort: "low" } }, {}, "ultra think through it");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("escalates over the base effort when the metadata effort was invalid (warned and ignored)", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      const result = await run({ webhook: { effort: "turbo" } }, { logger, baseEffort: "low" }, "think it over");
      expect(result.runtimeOptions.effort).toBe("high");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid per-request effort"),
        expect.objectContaining({ effort: "turbo" }),
      );
    });

    it("logs the matched keyword and the from/to efforts via logger.info", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      await run(undefined, { logger, baseEffort: "medium" }, "Ultra Think this through");
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Escalating per-turn effort"),
        expect.objectContaining({ keyword: "Ultra Think", from: "medium", to: "max" }),
      );
    });
  });
});

// Mirrors the app.ts wiring shape: sibling extensions composed BEFORE the
// model-override extension, merged later-wins — escalation must survive the
// merge and sibling keys must not be dropped.
describe("composeRuntimeOptionExtensions with keyword escalation", () => {
  it("escalates from the harness request userMessage and preserves sibling runtime options", async () => {
    const sibling = async () => ({
      runtimeOptions: {
        mcpServers: { memo: { url: "http://127.0.0.1:1" } },
        allowedTools: ["memo_tool"],
      },
      cleanup: async () => {},
    });
    const overrideExtension = createRequestModelOverrideRuntimeExtension({ baseEffort: "medium" });
    const composed = composeRuntimeOptionExtensions([
      sibling,
      async (input) => overrideExtension({ request: input.request }),
    ]);
    expect(composed).toBeDefined();

    const input = {
      request: {
        conversationId: "conv-1",
        userMessage: "please ultrathink this",
        abortSignal: new AbortController().signal,
      },
      runId: "run-1",
      context: {},
    } as unknown as AgentHarnessRuntimeOptionsInput;
    const result = await composed!(input);

    expect(result.runtimeOptions?.effort).toBe("max");
    expect(result.runtimeOptions?.mcpServers).toEqual({ memo: { url: "http://127.0.0.1:1" } });
    expect(result.runtimeOptions?.allowedTools).toContain("memo_tool");
    await result.cleanup?.();
  });
});

/**
 * A rejected per-request override is operator-supplied text that failed to parse, so it
 * carries none of a parsed reference's printable/single-line/bounded guarantees. Structured
 * JSON logging escapes a newline on the way out, but it does not bound anything -- a
 * 1,000,000-byte webhook `model` wrote a 1,000,000-byte log record per turn.
 */
describe("per-request override warnings bound the value they echo", () => {
  const NEWLINE = String.fromCharCode(10);
  const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
  const echo = (value: string): string => sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);

  it("leaves a short rejected model override quoted whole", async () => {
    const logger = { warn: vi.fn() };
    await run({ webhook: { model: "codex:gpt-5.6-sol" } }, { logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request model"),
      expect.objectContaining({ model: "codex:gpt-5.6-sol" }),
    );
  });

  it("escapes a newline in a rejected model override", async () => {
    const model = `codex:gpt-5.6-sol${NEWLINE}[ok] Core config: everything fine`;
    const logger = { warn: vi.fn() };
    await run({ webhook: { model } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { model: string; reason: string };
    expect(logged.model).toBe(echo(model));
    expect(logged.model).not.toContain(NEWLINE);
    expect(logged.reason).not.toContain(NEWLINE);
  });

  /**
   * The value has to be rejected for a reason that is NOT a length ceiling: whether the
   * grammar layer caps a reference at all is a separate, moving decision, and this assertion
   * is about what the WARNING does with an oversized value it was handed.
   */
  it("clamps an oversized rejected model override", async () => {
    const model = `codex:${"x".repeat(1_000_000)}`;
    const logger = { warn: vi.fn() };
    await run({ webhook: { model } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { model: string; reason: string };
    expect(logged.model).toBe(echo(model));
    // Against the exported budgets, not a round number that happens to sit above them:
    // a regression that emitted 900 bytes here would satisfy `< 1_000` and be wrong.
    expect(byteLength(logged.model)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(byteLength(logged.reason)).toBeLessThanOrEqual(MODEL_REFERENCE_REASON_MAX_BYTES);
  });

  it("escapes a newline in a rejected effort override", async () => {
    const effort = `extreme${NEWLINE}[ok] Core config: everything fine`;
    const logger = { warn: vi.fn() };
    await run({ webhook: { effort } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { effort: string };
    expect(logged.effort).toBe(echo(effort));
    expect(logged.effort).not.toContain(NEWLINE);
  });

  it("clamps an oversized rejected effort override", async () => {
    const effort = "e".repeat(100_000);
    const logger = { warn: vi.fn() };
    await run({ webhook: { effort } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { effort: string };
    expect(logged.effort).toBe(echo(effort));
    expect(byteLength(logged.effort)).toBeLessThan(1_000);
  });

  /**
   * The escalation `info` is the same kind of record as the warnings above it: the keyword it
   * prints is a slice of the operator's own message, so it carries no printable/single-line
   * guarantee of its own and gets the one echo budget every other operator surface uses.
   */
  it("escapes a newline inside the matched keyword it logs", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    await run(undefined, { logger, baseEffort: "medium" }, `ultra${NEWLINE}think about it`);
    const logged = logger.info.mock.calls[0]?.[1] as { keyword: string };
    expect(logged.keyword).toBe(echo(`ultra${NEWLINE}think`));
    expect(logged.keyword).not.toContain(NEWLINE);
  });

  /**
   * The phrase separator is any ONE whitespace code point, and `\s` includes U+2028 -- a line
   * separator, invisible and cursor-moving. A newline-only escape is not enough here, which is
   * why the keyword goes through the same full sanitizer as every other echo.
   */
  it("escapes a line separator used as the phrase separator", async () => {
    const separator = String.fromCharCode(0x2028);
    const logger = { warn: vi.fn(), info: vi.fn() };
    await run(undefined, { logger, baseEffort: "medium" }, `ultra${separator}think about it`);
    const logged = logger.info.mock.calls[0]?.[1] as { keyword: string };
    expect(logged.keyword).toBe(String.raw`ultra\u2028think`);
    expect(logged.keyword).not.toContain(separator);
  });

  it("bounds the matched keyword when the message floods the phrase separator", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    await run(undefined, { logger, baseEffort: "medium" }, `ultra${" ".repeat(1_000_000)}think`);
    const logged = logger.info.mock.calls[0]?.[1] as { keyword: string; to: string };
    expect(byteLength(logged.keyword)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    // A million spaces is not the phrase "ultra think", so the standalone `think` is what
    // actually matched -- the escalation stays, one rung lower, and is reported as such.
    expect(logged.keyword).toBe("think");
    expect(logged.to).toBe("high");
  });

  /** The error the parser actually throws for `model`, for asserting against its two layers. */
  const rejectionOf = (model: string): RuntimeAdapterError => {
    try {
      parseMonoRuntimeModelReference(model);
    } catch (error) {
      if (error instanceof RuntimeAdapterError) return error;
      throw error;
    }
    throw new Error("Expected the model reference to be rejected.");
  };

  /**
   * `echoReason` covers the arbitrary throws BELOW the adapter, but the adapter's own error is
   * already an over-budget carrier: its message is a fixed prefix PLUS a reason bounded to the
   * whole reason budget, so the wrapped message necessarily exceeds it. Asserting on a short
   * reason (which an earlier round did) passes with or without the sanitizer.
   */
  it("bounds a reason whose wrapped message exceeds the reason budget", async () => {
    const model = `codex:${"m".repeat(MODEL_REFERENCE_REASON_MAX_BYTES)}`;
    const logger = { warn: vi.fn() };
    await run({ webhook: { model } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { reason: string };
    const error = rejectionOf(model);
    expect(byteLength(error.message)).toBeGreaterThan(MODEL_REFERENCE_REASON_MAX_BYTES);
    expect(byteLength(logged.reason)).toBeLessThanOrEqual(MODEL_REFERENCE_REASON_MAX_BYTES);
    // The INNER reason is the contract, not the adapter's wrapped message: the message adds a
    // 32-byte generic prefix around a reason already at budget, so clamping the wrapped form
    // spends the budget on a prefix and pays for it out of the repair (asserted below).
    expect(logged.reason).toBe(
      sanitizeModelReferenceText(error.details.reason as string, MODEL_REFERENCE_REASON_MAX_BYTES),
    );
  });

  /**
   * The kernel parser is the only layer that knows the concrete repair, and for the retired
   * `vercel:<provider>:<model>` form it puts that repair AFTER the operator's own value. The
   * adapter's reason holds it whole; clamping the WRAPPED message instead cut the corrected
   * reference short and dropped the closing word entirely -- the actionable half, lost to a
   * prefix the warning's own message already carries.
   */
  it("keeps the trailing repair a wrapped-message clamp would have cut", async () => {
    const model = `vercel:openai:${"m".repeat(140)}`;
    const logger = { warn: vi.fn() };
    await run({ webhook: { model } }, { logger });
    const logged = logger.warn.mock.calls[0]?.[1] as { reason: string };
    const error = rejectionOf(model);

    // Precondition: this is a case where the two layers genuinely disagree.
    const wrapped = sanitizeModelReferenceText(error.message, MODEL_REFERENCE_REASON_MAX_BYTES);
    expect(wrapped.endsWith("…")).toBe(true);

    expect(logged.reason).toBe(error.details.reason);
    expect(logged.reason.endsWith("…")).toBe(false);
    expect(logged.reason).toContain("directly");
    expect(logged.reason).not.toContain("Invalid runtime model reference:");
    expect(byteLength(logged.reason)).toBeLessThanOrEqual(MODEL_REFERENCE_REASON_MAX_BYTES);
  });

  it("bounds the local-provider endpoint warning's echo too", async () => {
    const logger = { warn: vi.fn() };
    await run(
      { tui: { model: "gateway:gpt-oss" } },
      {
        logger,
        localProviders: [{ id: "gateway", type: "openai_compat", baseUrl: "http://api.example.com", enabled: true }],
      },
    );
    const logged = logger.warn.mock.calls[0]?.[1] as { model: string; reason: string };
    expect(logged.model).toBe("gateway:gpt-oss");
    expect(logged.reason).toBe(sanitizeModelReferenceText(logged.reason, MODEL_REFERENCE_REASON_MAX_BYTES));
  });

  /**
   * This warning fires on a reference that PARSED, which the previous case exercised with a
   * 15-byte one -- so it proved nothing about the echo budget. The parser has no length rule
   * any more, so a valid reference can be any size, and this is the one warning path where an
   * oversized value is not a typo but a working model id the operator will see quoted back.
   */
  it("bounds an oversized VALID reference in the local-provider endpoint warning", async () => {
    const model = `gateway:${"g".repeat(500_000)}`;
    const logger = { warn: vi.fn() };
    await run(
      { tui: { model } },
      {
        logger,
        localProviders: [{ id: "gateway", type: "openai_compat", baseUrl: "http://api.example.com", enabled: true }],
      },
    );
    const logged = logger.warn.mock.calls[0]?.[1] as { model: string; reason: string };
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("local-provider endpoint"),
      expect.anything(),
    );
    expect(logged.model).toBe(echo(model));
    expect(byteLength(logged.model)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(byteLength(logged.reason)).toBeLessThanOrEqual(MODEL_REFERENCE_REASON_MAX_BYTES);
    expect(logged.model).not.toContain("g".repeat(200));
    expect(logged.reason).not.toContain("g".repeat(200));
  });
});
