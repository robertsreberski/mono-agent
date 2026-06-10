import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfiguredAgentResponder: vi.fn(),
  createMonoRuntime: vi.fn(),
  loadMonoAgentConfig: vi.fn(),
  startA2AProvider: vi.fn(),
}));

vi.mock("@mono-agent/a2a-adapter", () => ({
  startA2AProvider: mocks.startA2AProvider,
}));

vi.mock("@mono-agent/agent-host", () => ({
  createConfiguredAgentResponder: mocks.createConfiguredAgentResponder,
}));

vi.mock("@mono-agent/config", () => ({
  loadMonoAgentConfig: mocks.loadMonoAgentConfig,
}));

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mono-agent/runtime-adapter")>()),
  createMonoRuntime: mocks.createMonoRuntime,
}));

import { startAgentsSdkDemo } from "../agents-sdk-demo.js";
import type { AgentsSdkRuntimeChoice } from "../agents-sdk-demo.js";

const CLAUDE_CHOICE: AgentsSdkRuntimeChoice = {
  name: "claude",
  model: { sdk: "claude", model: "claude-sonnet-4-6" },
  port: 41100,
  cardSkillId: "claude-agent-skill",
  cardSkillName: "Claude agent-runtime backend",
  cardDescription: "Agent backed by the runtime Claude SDK bridge.",
};

describe("startAgentsSdkDemo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMonoRuntime.mockReturnValue({ run: vi.fn() });
    mocks.createConfiguredAgentResponder.mockReturnValue({ respond: vi.fn() });
    mocks.loadMonoAgentConfig.mockReturnValue({
      runtime: {},
      context: {},
      tools: {},
      artifacts: {},
      traceability: {},
    });
    mocks.startA2AProvider.mockResolvedValue({
      agentCardUrl: "http://127.0.0.1:41100/.well-known/agent-card",
      stop: vi.fn(async () => undefined),
    });
  });

  it("starts the Claude choice through the shared Mono runtime", async () => {
    const runtime = { run: vi.fn() };
    mocks.createMonoRuntime.mockReturnValue(runtime);

    const result = await startAgentsSdkDemo({
      env: {
        ANTHROPIC_API_KEY: "test-anthropic-key",
        MONO_AGENT_MODEL: "claude:claude-sonnet-4-6",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      choices: [CLAUDE_CHOICE],
    });

    expect(mocks.createMonoRuntime).toHaveBeenCalledOnce();
    expect(mocks.createConfiguredAgentResponder).toHaveBeenCalledWith(expect.objectContaining({
      runtime,
      model: CLAUDE_CHOICE.model,
    }));
    expect(result.statuses).toEqual([{
      name: "claude",
      kind: "running",
      agentCardUrl: "http://127.0.0.1:41100/.well-known/agent-card",
      model: CLAUDE_CHOICE.model,
    }]);
  });

  it("skips the Claude choice when ANTHROPIC_API_KEY is missing", async () => {
    const result = await startAgentsSdkDemo({
      env: {
        MONO_AGENT_MODEL: "claude:claude-sonnet-4-6",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      choices: [CLAUDE_CHOICE],
    });

    expect(mocks.createMonoRuntime).not.toHaveBeenCalled();
    expect(mocks.startA2AProvider).not.toHaveBeenCalled();
    expect(result.statuses).toEqual([{
      name: "claude",
      kind: "skipped",
      reason: "ANTHROPIC_API_KEY not set",
    }]);
  });
});
