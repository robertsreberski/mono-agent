import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

const fakeRuntime = {
  run: vi.fn(),
};
const createMonoRuntimeMock = vi.fn((_options: unknown) => fakeRuntime);
const fakeSandboxEngine = { id: "fallback-sandbox-engine" };
const createSrtSandboxEngineMock = vi.fn(() => fakeSandboxEngine);

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createMonoRuntime: (options: unknown) => createMonoRuntimeMock(options),
    createSrtSandboxEngine: () => createSrtSandboxEngineMock(),
  };
});

const { createConfiguredAgentRuntime } = await import("../index.js");

beforeEach(() => {
  createMonoRuntimeMock.mockClear();
  createSrtSandboxEngineMock.mockClear();
});

describe("configured agent runtime fallback models", () => {
  it("passes a fallback chain with the primary model first", () => {
    const config = monoConfig([
      { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" },
    ]);
    createConfiguredAgentRuntime(config);

    expect(createMonoRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackChain: [
          { model: config.runtime.model, attempts: 2 },
          { model: config.runtime.fallbacks?.[0]?.model, effort: null },
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
        fallbacks: [
          { model: { provider: "openai-codex", model: "gpt-5.6-sol", reference: "openai-codex:gpt-5.6-sol" } },
          {
            model: { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" },
            effort: "ultra",
          },
        ],
      },
    };

    createConfiguredAgentRuntime(config);

    expect(createMonoRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      fallbackChain: [
        { model: config.runtime.model, attempts: 2 },
        { model: config.runtime.fallbacks?.[0]?.model, effort: null },
        { model: config.runtime.fallbacks?.[1]?.model, effort: "ultra" },
      ],
    }));
  });

  it("resolves local-provider secrets only for the model actually attempted", () => {
    const base = monoConfig([
      { provider: "openai", model: "gpt-5.5", reference: "openai:gpt-5.5" },
    ]);
    const config: MonoAgentConfig = {
      ...base,
      runtime: {
        ...base.runtime,
        model: { provider: "private-local", model: "local-model", reference: "private-local:local-model" },
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
    const cloud = resolveAttempt?.({ model: config.runtime.fallbacks?.[0]?.model as MonoAgentConfig["runtime"]["model"] });
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
      { model: config.runtime.model, attempts: 2 },
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
            model: { provider: "openai-codex", model: "gpt-5.6-sol", reference: "openai-codex:gpt-5.6-sol" },
            attempts: 3,
          },
          { model: { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" } },
        ],
      },
    };
    createConfiguredAgentRuntime(config);

    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toEqual([
      { model: config.runtime.model, attempts: 2 },
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
  fallbackModels: readonly RuntimeModelReference[] | undefined,
  retry?: Partial<MonoAgentConfig["runtime"]["retry"]>,
): MonoAgentConfig {
  return {
    runtime: {
      model: { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" },
      ...(fallbackModels === undefined ? {} : { fallbacks: fallbackModels.map((model) => ({ model })) }),
      // The loader always materializes these; mirror a real loaded config.
      retry: { primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000, ...retry },
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
