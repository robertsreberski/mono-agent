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
        fallbackChain: [
          { model: config.runtime.model, executionMode: "sdk" },
          { model: config.runtime.fallbackModels?.[0] },
        ],
      }),
    );
  });

  it("omits the fallback chain when no backup models are configured", () => {
    createConfiguredAgentRuntime(monoConfig(undefined));

    const options = createMonoRuntimeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.fallbackChain).toBeUndefined();
  });
});

function monoConfig(
  fallbackModels: MonoAgentConfig["runtime"]["fallbackModels"],
): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      ...(fallbackModels === undefined ? {} : { fallbackModels }),
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
    },
    traceability: {
      registryDir: "/repo/.mono-agent/trace",
    },
  };
}
