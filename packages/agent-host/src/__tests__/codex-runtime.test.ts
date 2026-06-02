import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@worklab-ai/config";

const codexMocks = vi.hoisted(() => {
  const runtime = {
    run: vi.fn(async () => ({ text: "codex runtime" })),
  };
  return {
    runtime,
    createCodexAppRuntime: vi.fn(() => runtime),
  };
});

vi.mock("@worklab-ai/codex-app-runtime", () => ({
  createCodexAppRuntime: codexMocks.createCodexAppRuntime,
}));

const { createConfiguredAgentRuntime } = await import("../index.js");

describe("agent host Codex runtime routing", () => {
  it("uses the direct Codex app runtime for codex CLI models", async () => {
    const runtime = createConfiguredAgentRuntime(codexConfig());

    await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
      executionMode: "cli",
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(codexMocks.createCodexAppRuntime).toHaveBeenCalledTimes(1);
    expect(codexMocks.runtime.run).toHaveBeenCalledWith(
      "system",
      expect.objectContaining({
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        executionMode: "cli",
      }),
    );
  });
});

function codexConfig(): MonoAgentConfig {
  const dir = "/tmp/mono-agent-codex-host";
  return {
    runtime: {
      model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
      executionMode: "cli",
      maxTurns: 4,
      workspace: dir,
    },
    context: {
      identityPath: join(dir, "IDENTITY.md"),
      selectedSkills: [],
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: join(dir, "artifacts"),
    },
    traceability: {
      registryDir: join(dir, "trace-sources"),
    },
  };
}
