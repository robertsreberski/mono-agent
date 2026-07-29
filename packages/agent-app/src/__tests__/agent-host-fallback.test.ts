import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

const fakeRuntime = {
  run: vi.fn(),
};
const createMonoRuntimeMock = vi.fn((_options: unknown) => fakeRuntime);

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createMonoRuntime: (options: unknown) => createMonoRuntimeMock(options),
  };
});

const { createConfiguredAgentRuntime } = await import("../index.js");

beforeEach(() => {
  createMonoRuntimeMock.mockClear();
});

describe("configured agent runtime fallback models", () => {
  it("passes a fallback chain with the primary model first", () => {
    const config = monoConfig([
      { sdk: "claude", model: "claude-sonnet-4-6", reference: "claude:claude-sonnet-4-6" },
    ]);
    createConfiguredAgentRuntime(config);

    expect(createMonoRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routeSafety: "uniform",
        fallbackChain: [
          { model: config.runtime.model, executionMode: "sdk", attempts: 2 },
          { model: config.runtime.fallbackModels?.[0] },
        ],
        resolveAttempt: expect.any(Function),
      }),
    );
  });

  it("preserves canonical provider-default and fixed effort semantics across mixed routes", () => {
    const base = monoConfig(undefined);
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        effort: "high",
        routeSafety: "per-route-native",
        fallbacks: [
          { model: { sdk: "codex", model: "gpt-5.6-sol", reference: "codex:gpt-5.6-sol" } },
          {
            model: { sdk: "claude", model: "claude-sonnet-4-6", reference: "claude:claude-sonnet-4-6" },
            effort: "ultra",
          },
        ],
      },
    };

    createConfiguredAgentRuntime(config);

    expect(createMonoRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      routeSafety: "per-route-native",
      fallbackChain: [
        { model: config.runtime.model, executionMode: "sdk", attempts: 2 },
        { model: config.runtime.fallbacks?.[0]?.model, effort: null },
        { model: config.runtime.fallbacks?.[1]?.model, effort: "ultra" },
      ],
    }));
  });

  it("resolves local-provider secrets only for the model actually attempted", () => {
    const base = monoConfig([
      { sdk: "pi", provider: "openai", model: "gpt-5.5", reference: "pi:openai:gpt-5.5" },
    ]);
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        model: { sdk: "pi", provider: "private-local", model: "local-model", reference: "pi:private-local:local-model" },
      },
      providers: {
        local: [{
          id: "private-local",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: "local-secret",
          models: [{ name: "local-model" }],
        }],
      },
    };

    createConfiguredAgentRuntime(config);
    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as {
      readonly resolveAttempt?: (input: { readonly model: MonoAgentConfig["runtime"]["model"] }) => {
        readonly options?: Record<string, unknown>;
      };
    };
    const resolveAttempt = options.resolveAttempt;
    expect(resolveAttempt).toEqual(expect.any(Function));

    const local = resolveAttempt?.({ model: config.runtime.model });
    const cloud = resolveAttempt?.({ model: config.runtime.fallbackModels?.[0] as MonoAgentConfig["runtime"]["model"] });
    expect(local?.options).toMatchObject({
      customProvider: { id: "private-local", api_key: "local-secret" },
      customModel: { provider_id: "private-local", model_name: "local-model" },
    });
    expect(cloud?.options).toEqual({});
  });

  it("builds a retry-only single-entry chain when retries are on and no backups are configured", () => {
    // Without this the router never runs for a fallback-less agent, so the
    // primary-retry default would silently do nothing for most deployments.
    const config = monoConfig(undefined);
    createConfiguredAgentRuntime(config);

    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toEqual([
      { model: config.runtime.model, executionMode: "sdk", attempts: 2 },
    ]);
    expect(options.retry).toEqual({ backoffMs: 1_000, maxBackoffMs: 15_000 });
  });

  it("omits the fallback chain when retries are disabled and no backups are configured", () => {
    createConfiguredAgentRuntime(monoConfig(undefined, { primaryAttempts: 1 }));

    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toBeUndefined();
  });

  it("forwards per-route attempts and leaves omitted backups single-shot", () => {
    const base = monoConfig(undefined);
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        fallbacks: [
          {
            model: { sdk: "codex", model: "gpt-5.6-sol", reference: "codex:gpt-5.6-sol" },
            attempts: 3,
          },
          { model: { sdk: "claude", model: "claude-sonnet-4-6", reference: "claude:claude-sonnet-4-6" } },
        ],
      },
    };
    createConfiguredAgentRuntime(config);

    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toEqual([
      { model: config.runtime.model, executionMode: "sdk", attempts: 2 },
      { model: config.runtime.fallbacks?.[0]?.model, effort: null, attempts: 3 },
      { model: config.runtime.fallbacks?.[1]?.model, effort: null },
    ]);
  });

  it("degrades a caller-built config without a retry block to single-shot instead of crashing", () => {
    const base = monoConfig(undefined);
    const legacy = { ...base, runtime: { ...base.runtime } } as { runtime: Record<string, unknown> };
    delete legacy.runtime.retry;

    expect(() => createConfiguredAgentRuntime(legacy as unknown as MonoAgentConfig)).not.toThrow();
    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toBeUndefined();
  });
});

function monoConfig(
  fallbackModels: MonoAgentConfig["runtime"]["fallbackModels"],
  retry?: Partial<MonoAgentConfig["runtime"]["retry"]>,
): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      ...(fallbackModels === undefined ? {} : { fallbackModels }),
      // The loader always materializes these; mirror a real loaded config.
      retry: { primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000, ...retry },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: "/repo",
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    context: {
      identityPath: "/repo/IDENTITY.md",
      selectedSkills: [],
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "/repo/.mono-agent/artifacts",
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: {
      registryDir: "/repo/.mono-agent/trace",
    },
  };
}
