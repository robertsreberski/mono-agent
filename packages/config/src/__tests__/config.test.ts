import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMonoAgentConfig, MonoAgentConfigError, redactMonoAgentConfig } from "../index.js";

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
        MONO_AGENT_TRACE_REGISTRY_DIR: "trace-registry",
        MONO_AGENT_TRACE_SOURCE_ID: "agent-one",
        MONO_AGENT_TRACE_SOURCE_LABEL: "Agent One",
        MONO_AGENT_TRACE_HEARTBEAT_MS: "5000",
        MONO_AGENT_TRACE_STALE_AFTER_MS: "15000",
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
      mode: "markdown",
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
    expect(config.providers?.piAuthPath).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(config.traceability).toEqual({
      registryDir: "/repo/trace-registry",
      sourceId: "agent-one",
      sourceLabel: "Agent One",
      heartbeatMs: 5000,
      staleAfterMs: 15000,
    });
  });

  it("loads the Pi OAuth auth path from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PI_AUTH_PATH: "/tmp/pi-auth.json",
      },
    });

    expect(config.providers?.piAuthPath).toBe("/tmp/pi-auth.json");
  });

  it("defaults the runtime session to continuous with a 30-minute idle timeout", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: baseEnv });

    expect(config.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 1_800_000 });
    expect(config.sandbox).toBeUndefined();
  });

  it("loads sandbox policy from env when configured", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_WORKSPACE: "workspace",
        MONO_AGENT_SANDBOX_MODE: "native",
        MONO_AGENT_SANDBOX_NETWORK: "allowlist",
        MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST: "github.com, api.github.com",
      },
    });

    expect(config.sandbox).toMatchObject({
      mode: "native",
      engine: "srt",
      root: "/repo/workspace",
      fallback: "fail-closed",
      network: {
        mode: "allowlist",
        allowlist: ["github.com", "api.github.com"],
      },
    });
  });

  it("rejects unsafe sandbox fallback unless explicitly opted in", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_SANDBOX_MODE: "native",
          MONO_AGENT_SANDBOX_FALLBACK: "unsafe-host-process",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_env",
        details: { env: "MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS" },
      });
      expect(String(error)).toContain("unsafeAllowHostProcess");
      return;
    }
    throw new Error("Expected unsafe sandbox fallback to fail.");
  });

  it("allows unsafe sandbox fallback with the explicit opt-in", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_SANDBOX_MODE: "native",
        MONO_AGENT_SANDBOX_FALLBACK: "unsafe-host-process",
        MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS: "true",
      },
    });

    expect(config.sandbox).toMatchObject({
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
  });

  it("reports the sandbox allowlist env when allowlist mode has no domains", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_SANDBOX_MODE: "native",
          MONO_AGENT_SANDBOX_NETWORK: "allowlist",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_env",
        details: { env: "MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST" },
      });
      expect(String(error)).toContain("allowlist network mode");
      return;
    }
    throw new Error("Expected sandbox allowlist without domains to fail.");
  });

  it("respects session env overrides", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_SESSION_MODE: "per-message",
        MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "60000",
      },
    });

    expect(config.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 60000 });
  });

  it("rejects an invalid session mode", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_SESSION_MODE: "forever" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_SESSION_MODE" } });
      return;
    }
    throw new Error("Expected config load to fail.");
  });

  it("rejects invalid or out-of-bounds session idle timeouts", () => {
    for (const raw of ["not-a-number", "999", "86400001"]) {
      try {
        loadMonoAgentConfig({
          cwd: "/repo",
          env: { ...baseEnv, MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: raw },
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_SESSION_IDLE_TIMEOUT_MS" } });
        continue;
      }
      throw new Error(`Expected config load to fail for ${raw}.`);
    }
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
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_BASE_URL: "http://localhost:11434",
        MONO_AGENT_LOCAL_PROVIDER_API_KEY: "redacted-value",
      },
    });
    const redacted = redactMonoAgentConfig(config);

    expect("telegram" in redacted).toBe(false);
    expect(redacted.runtime.model).toMatchObject({ sdk: "pi" });
    expect(redacted.providers?.local?.[0]).toMatchObject({
      id: "ollama",
      type: "ollama",
      apiKey: { present: true, redacted: true },
    });
    expect(redacted.providers?.piAuthPath).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(JSON.stringify(redacted)).not.toContain("redacted-value");
  });

  it("defaults traceability to a host-shared registry path", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: baseEnv,
    });

    expect(config.traceability.registryDir).toMatch(/\.mono-agent\/trace-sources$/u);
  });

  it("loads a local Ollama provider from the one-provider env shape", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_BASE_URL: "http://localhost:11434",
        MONO_AGENT_LOCAL_PROVIDER_ENABLED: "true",
        MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL: "false",
        MONO_AGENT_LOCAL_PROVIDER_API_KEY: "redacted-value",
      },
    });

    expect(config.providers?.local?.[0]).toMatchObject({
      id: "ollama",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      enabled: true,
      trustPublicUrl: false,
      apiKey: "redacted-value",
    });
  });

  it("loads a local provider registry from env JSON", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
        MONO_AGENT_LOCAL_PROVIDERS_JSON: JSON.stringify([
          {
            id: "ollama",
            type: "ollama",
            baseUrl: "http://localhost:11434",
            enabled: true,
            models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
          },
        ]),
      },
    });

    expect(config.providers?.local?.[0]?.models?.[0]).toMatchObject({
      name: "qwen3:8b",
      capabilities: { context_window: 32768 },
    });
  });

  it("rejects invalid local-provider JSON and URLs", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_LOCAL_PROVIDERS_JSON: "{not-json",
      },
    })).toThrow(MonoAgentConfigError);

    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_BASE_URL: "http://api.example.com",
      },
    })).toThrow(/public host/u);
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
