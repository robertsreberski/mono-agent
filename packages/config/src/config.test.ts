import { describe, expect, it } from "vitest";

import { loadMonoAgentConfig, MonoAgentConfigError, redactMonoAgentConfig } from "./index.js";

const baseEnv = {
  MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
  MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
};

describe("loadMonoAgentConfig", () => {
  it("loads required runtime, context, tools, memory, and artifact config", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_EFFORT: "high",
        MONO_AGENT_MAX_TURNS: "12",
        MONO_AGENT_WORKSPACE: "workspace",
        MONO_AGENT_SOUL_PATH: "SOUL.md",
        MONO_AGENT_SKILLS_ROOT: "skills",
        MONO_AGENT_SELECTED_SKILLS: "research,review",
        MONO_AGENT_ALLOWED_TOOLS: "Read, Grep",
        MONO_AGENT_DISALLOWED_TOOLS: "Bash",
        MONO_AGENT_MCP_CONFIG_PATH: "mcp.json",
        MONO_AGENT_MEMORY_PATH: "memory.md",
        MONO_AGENT_MEMORY_WRITE_MODE: "append-host-summary",
        MONO_AGENT_MEMORY_SCOPE: "single-file",
        MONO_AGENT_MEMORY_MAX_BYTES: "2048",
        MONO_AGENT_ARTIFACT_DIR: "artifacts",
      },
    });

    expect(config.runtime).toMatchObject({ executionMode: "sdk", effort: "high", maxTurns: 12, workspace: "/repo/workspace" });
    expect(config.runtime.model).toMatchObject({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" });
    expect(config.context).toEqual({
      identityPath: "/repo/IDENTITY.md",
      soulPath: "/repo/SOUL.md",
      skillsRoot: "/repo/skills",
      selectedSkills: ["research", "review"],
    });
    expect(config.memory).toEqual({
      path: "/repo/memory.md",
      maxBytes: 2048,
      scope: "single-file",
      writeMode: "append-host-summary",
    });
    expect(config.tools).toEqual({
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpConfigPath: "/repo/mcp.json",
    });
    expect(config.artifacts.dir).toBe("/repo/artifacts");
  });

  it("defaults Codex model references to CLI execution mode", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MODEL: "codex:gpt-5.5" },
    });
    expect(config.runtime.executionMode).toBe("cli");
  });

  it("rejects incompatible model/execution-mode combinations", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_EXECUTION_MODE: "cli" },
    })).toThrow(/incompatible/u);
  });

  it("redacts core config without adapter-specific sections", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: baseEnv });
    const redacted = redactMonoAgentConfig(config);

    expect("telegram" in redacted).toBe(false);
    expect(redacted.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("does not include adapter env values in validation errors", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:super-secret-token",
          MONO_AGENT_MAX_TURNS: "not-a-number",
        },
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("super-secret-token");
      expect(error).toMatchObject({ code: "invalid_env" });
      return;
    }
    throw new Error("Expected config load to fail.");
  });
});
