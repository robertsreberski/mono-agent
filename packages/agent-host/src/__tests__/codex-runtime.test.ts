import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@worklab-ai/config";

import { createConfiguredAgentRuntime } from "../index.js";

describe("agent host Codex runtime routing", () => {
  it("routes codex CLI models through the shared Mono runtime with session support", () => {
    const runtime = createConfiguredAgentRuntime(codexConfig());

    expect(runtime.run).toEqual(expect.any(Function));
    expect(runtime.configureTools).toEqual(expect.any(Function));
    expect(runtime.disposeSession).toEqual(expect.any(Function));
    expect(runtime.disposeAllSessions).toEqual(expect.any(Function));
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
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
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
