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
    expect(config.memory).toMatchObject({ mode: "lite", path: "/repo/memory.md", writeMode: "append-host-summary" });
    expect(config.memory).not.toHaveProperty("scope");
    expect(config.memory).not.toHaveProperty("graphPath");
    expect(config.memory).not.toHaveProperty("tools");
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

  it("loads permission mode and reasoning summary from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PERMISSION_MODE: "bypassPermissions",
        MONO_AGENT_REASONING_SUMMARY: "detailed",
      },
    });

    expect(config.runtime.permissionMode).toBe("bypassPermissions");
    expect(config.runtime.reasoningSummary).toBe("detailed");
  });

  it("treats an omitted runtime max turns value as unlimited", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("treats runtime max turns of zero as unlimited", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MAX_TURNS: "0",
      },
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("omits permission mode and reasoning summary when the env is unset", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.runtime.permissionMode).toBeUndefined();
    expect(config.runtime.reasoningSummary).toBeUndefined();
  });

  it("loads pi-native provider knobs from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PI_MAX_RETRIES: "4",
        MONO_AGENT_MAX_RETRY_DELAY_MS: "30000",
        MONO_AGENT_PI_SESSIONS_ROOT: ".mono-agent/sessions",
      },
    });
    expect(config.providers?.piNative).toEqual({
      piMaxRetries: 4,
      maxRetryDelayMs: 30_000,
      piSessionsRoot: join("/repo", ".mono-agent", "sessions"),
    });
  });

  it("omits pi-native provider knobs when the env is unset", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.providers?.piNative).toBeUndefined();
  });

  it("rejects an out-of-range pi max retries value", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_PI_MAX_RETRIES: "99" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("rejects invalid permission mode and reasoning summary values", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_PERMISSION_MODE: "yolo" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_REASONING_SUMMARY: "verbose" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads ordered fallback models from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_FALLBACK_MODELS: "claude:claude-sonnet-4-6, pi:ollama:gemma4:31b",
      },
    });

    expect(config.runtime.fallbackModels).toEqual([
      expect.objectContaining({ sdk: "claude", model: "claude-sonnet-4-6" }),
      expect.objectContaining({ sdk: "pi", provider: "ollama", model: "gemma4:31b" }),
    ]);
  });

  it("omits fallbackModels when the env is unset", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.runtime.fallbackModels).toBeUndefined();
  });

  it("rejects invalid fallback model references with the offending entry", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "claude:claude-sonnet-4-6,not-a-model" },
      }),
    ).toThrow(/not-a-model/u);
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "not-a-model" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_model_reference" });
    }
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

  it("ignores the retired MONO_AGENT_MEMORY_SCOPE / _TOOLS_* / _GRAPH_PATH env vars", () => {
    const config = loadMonoAgentConfig({
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_SCOPE: "per-conversation",
        MONO_AGENT_MEMORY_TOOLS_ENABLED: "true",
        MONO_AGENT_MEMORY_GRAPH_PATH: "g.jsonl" },
      cwd: "/repo",
    });
    expect(config.memory).not.toHaveProperty("scope");
    expect(config.memory).not.toHaveProperty("tools");
    expect(config.memory).not.toHaveProperty("graphPath");
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

  it("preserves non-secret pi-native provider knobs through redaction", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PI_MAX_RETRIES: "4",
        MONO_AGENT_MAX_RETRY_DELAY_MS: "30000",
        MONO_AGENT_PI_SESSIONS_ROOT: ".mono-agent/sessions",
      },
    });
    const redacted = redactMonoAgentConfig(config);
    expect(redacted.providers?.piNative).toEqual({
      piMaxRetries: 4,
      maxRetryDelayMs: 30_000,
      piSessionsRoot: join("/repo", ".mono-agent", "sessions"),
    });
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

  it("loads sandbox filesystem scopes from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_WORKSPACE: "workspace",
        MONO_AGENT_SANDBOX_MODE: "native",
        MONO_AGENT_SANDBOX_READABLE_ROOTS: ". , ../shared-docs",
        MONO_AGENT_SANDBOX_WRITABLE_ROOTS: "out",
        MONO_AGENT_SANDBOX_DENY_WRITE: ".env, secrets/**",
      },
    });

    expect(config.sandbox).toMatchObject({
      mode: "native",
      readableRoots: ["/repo/workspace", "/repo/shared-docs"],
      writableRoots: ["/repo/workspace/out"],
      denyWrite: [".env", "secrets/**"],
    });
  });

  it("loads memory embeddings from env with the Ollama default model", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: "http://localhost:11434",
      },
    });

    expect(config.memory?.embeddings).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      endpoint: "http://localhost:11434",
    });
  });

  it("resolves the embeddings api key from apiKeyEnv", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "MY_OPENAI_KEY",
        MY_OPENAI_KEY: "embeddings-secret",
      },
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "embeddings-secret",
      apiKeyEnv: "MY_OPENAI_KEY",
    });
  });

  it("rejects openai embeddings without an api key", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory",
          MONO_AGENT_MEMORY_MODE: "journal",
          MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_env",
        details: { env: "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY" },
      });
      return;
    }
    throw new Error("Expected openai embeddings without an api key to fail.");
  });

  it("rejects any memory env var set without a memory path", () => {
    for (const env of [
      { MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama" },
      { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "768" },
      { MONO_AGENT_MEMORY_MODE: "bujo" },
      { MONO_AGENT_MEMORY_WRITE_MODE: "capture" },
      { MONO_AGENT_MEMORY_MAX_BYTES: "8000" },
      { MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama" },
      { MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" },
      { MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "true" },
      { MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true" },
      { MONO_AGENT_MEMORY_MIGRATION_CRON: "0 3 * * *" },
    ]) {
      try {
        loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, ...env } });
      } catch (error) {
        expect(error).toBeInstanceOf(MonoAgentConfigError);
        expect(error).toMatchObject({ code: "invalid_env" });
        continue;
      }
      throw new Error("Expected memory extras without MONO_AGENT_MEMORY_PATH to fail.");
    }
  });

  it("defaults memory.recallTool on for journal/bujo with embeddings and off for lite", () => {
    const withEmbeddings = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      },
    });
    expect(withEmbeddings.memory?.recallTool).toEqual({ enabled: true });

    // lite tier (no embeddings) → off by default.
    const lite = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "memory", MONO_AGENT_MEMORY_MODE: "lite" },
    });
    expect(lite.memory?.recallTool).toEqual({ enabled: false });

    // journal mode but no embeddings configured → off by default (recall can't rank semantically).
    const journalNoEmbeddings = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "memory", MONO_AGENT_MEMORY_MODE: "journal" },
    });
    expect(journalNoEmbeddings.memory?.recallTool).toEqual({ enabled: false });
  });

  it("lets MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED override the recallTool default in both directions", () => {
    // Explicit off on a tier that would default on.
    const forcedOff = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "false",
      },
    });
    expect(forcedOff.memory?.recallTool).toEqual({ enabled: false });

    // Explicit on for lite (FTS-only): the operator opts in despite no embeddings default.
    const forcedOn = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "lite",
        MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "true",
      },
    });
    expect(forcedOn.memory?.recallTool).toEqual({ enabled: true });
  });

  it("rejects a non-boolean MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory",
          MONO_AGENT_MEMORY_MODE: "journal",
          MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "maybe",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED" } });
      return;
    }
    throw new Error("Expected an invalid recallTool flag to fail.");
  });

  it("redacts the embeddings api key", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "embeddings-secret",
      },
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.embeddings?.apiKey).toEqual({ present: true, redacted: true });
    expect(JSON.stringify(redacted)).not.toContain("embeddings-secret");
  });

  it("loads context.skillMaxBytes from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_SKILL_MAX_BYTES: "24000" },
    });

    expect(config.context.skillMaxBytes).toBe(24000);
  });

  it("omits skillMaxBytes when the env is unset and rejects invalid values", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.context.skillMaxBytes).toBeUndefined();

    for (const raw of ["not-a-number", "0", "1000001"]) {
      try {
        loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_SKILL_MAX_BYTES: raw } });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_SKILL_MAX_BYTES" } });
        continue;
      }
      throw new Error(`Expected config load to fail for ${raw}.`);
    }
  });

  it("loads concurrency.maxConcurrentRuns from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "4" },
    });

    expect(config.concurrency?.maxConcurrentRuns).toBe(4);
  });

  it("loads concurrency.maxPendingRuns from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS: "16" },
    });

    expect(config.concurrency?.maxPendingRuns).toBe(16);
    // maxPendingRuns is independent of maxConcurrentRuns: setting only it still
    // omits the unset sibling.
    expect(config.concurrency?.maxConcurrentRuns).toBeUndefined();
  });

  it("loads both concurrency bounds together from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "4",
        MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS: "16",
      },
    });

    expect(config.concurrency?.maxConcurrentRuns).toBe(4);
    expect(config.concurrency?.maxPendingRuns).toBe(16);
  });

  it("omits concurrency when the env is unset and rejects invalid values", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.concurrency).toBeUndefined();

    for (const raw of ["not-a-number", "0", "-1"]) {
      try {
        loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: raw } });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS" } });
        continue;
      }
      throw new Error(`Expected concurrency load to fail for ${raw}.`);
    }

    for (const raw of ["not-a-number", "0", "-1"]) {
      try {
        loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS: raw } });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS" } });
        continue;
      }
      throw new Error(`Expected pending-runs load to fail for ${raw}.`);
    }
  });

  it("loads memory embeddings timeoutMs and circuit breaker from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: "5000",
        MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: "5",
        MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: "20000",
      },
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "ollama",
      timeoutMs: 5000,
      circuitBreaker: { failureThreshold: 5, cooldownMs: 20000 },
    });
  });

  it("omits embeddings timeoutMs/circuitBreaker when unset and rejects invalid values", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      },
    });
    expect(config.memory?.embeddings).not.toHaveProperty("timeoutMs");
    expect(config.memory?.embeddings).not.toHaveProperty("circuitBreaker");

    const invalidByEnv: ReadonlyArray<readonly [string, string]> = [
      ["MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS", "0"],
      ["MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS", "not-a-number"],
      ["MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "0"],
      ["MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS", "-1"],
    ];
    for (const [key, raw] of invalidByEnv) {
      try {
        loadMonoAgentConfig({
          cwd: "/repo",
          env: {
            ...baseEnv,
            MONO_AGENT_MEMORY_PATH: "memory",
            MONO_AGENT_MEMORY_MODE: "journal",
            MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
            [key]: raw,
          },
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_env", details: { env: key } });
        continue;
      }
      throw new Error(`Expected embeddings load to fail for ${key}=${raw}.`);
    }
  });

  it("rejects embeddings timeoutMs and circuit breaker env without a memory path", () => {
    for (const key of [
      "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
    ]) {
      try {
        loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, [key]: "5000" } });
      } catch (error) {
        expect(error).toBeInstanceOf(MonoAgentConfigError);
        expect(error).toMatchObject({ code: "invalid_env" });
        continue;
      }
      throw new Error(`Expected ${key} without MONO_AGENT_MEMORY_PATH to fail.`);
    }
  });

  it("redacts the non-secret embeddings tuning fields", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: "5000",
        MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: "5",
      },
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.embeddings?.timeoutMs).toBe(5000);
    expect(redacted.memory?.embeddings?.circuitBreaker).toEqual({ failureThreshold: 5 });
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

  it("loads memory.mode bujo from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    });

    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.path).toBe("/repo/memory-root");
  });

  it("loads memory.llm from env when model is set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
      },
    });

    expect(config.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434",
    });
  });

  it("loads agent-host memory.llm with a runtime model reference", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
    });

    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
    });
  });

  it("loads agent-host memory.llm execution mode when explicitly set to sdk", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_MEMORY_LLM_EXECUTION_MODE: "sdk",
      },
    });

    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
    });
  });

  it("rejects agent-host memory.llm endpoint because runtime models do not use Ollama endpoints", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
          MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
          MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("rejects invalid agent-host memory.llm model references", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
          MONO_AGENT_MEMORY_LLM_MODEL: "not-a-runtime-model",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_model_reference" }));
  });

  it("rejects CLI-backed agent-host memory.llm model references", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
          MONO_AGENT_MEMORY_LLM_MODEL: "codex:gpt-5.5",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible_execution_mode" }));
  });

  it("rejects explicit cli execution mode for agent-host memory.llm", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
          MONO_AGENT_MEMORY_LLM_MODEL: "claude:claude-sonnet-4-6",
          MONO_AGENT_MEMORY_LLM_EXECUTION_MODE: "cli",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible_execution_mode" }));
  });

  it("rejects memory.llm execution mode for the ollama provider", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
          MONO_AGENT_MEMORY_LLM_MODEL: "qwen3:8b",
          MONO_AGENT_MEMORY_LLM_EXECUTION_MODE: "sdk",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("omits memory.llm when LLM model env is unset", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    });

    expect(config.memory?.llm).toBeUndefined();
  });

  it("omits memory.llm.endpoint when only provider and model are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3:8b",
      },
    });

    expect(config.memory?.llm).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(config.memory?.llm?.provider).toBe("ollama");
    if (config.memory?.llm?.provider !== "ollama") {
      throw new Error("Expected ollama memory LLM config.");
    }
    expect(config.memory.llm.endpoint).toBeUndefined();
  });

  it("rejects an unsupported memory.llm provider from env", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_LLM_MODEL: "gpt-4o",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "openai",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads memory.embeddings.dim from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "768",
      },
    });

    expect(config.memory?.embeddings?.dim).toBe(768);
  });

  it("omits embeddings.dim when the env is unset", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      },
    });

    expect(config.memory?.embeddings?.dim).toBeUndefined();
  });

  it("redacts bujo config without leaking llm model or endpoint (no secrets to redact)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
      },
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.mode).toBe("bujo");
    expect(redacted.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects invalid memory mode from env", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "unknown-mode",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("rejects the removed 'markdown' mode from env", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "markdown",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads memory.mode lite from env (FTS-only, no embeddings required)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "lite",
      },
    });

    expect(config.memory?.mode).toBe("lite");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
  });

  it("defaults memory mode to lite when path is set but mode is unset", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
      },
    });

    expect(config.memory?.mode).toBe("lite");
  });

  it("loads memory.mode journal from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      },
    });

    expect(config.memory?.mode).toBe("journal");
  });

  it("loads memory.reflection from env when enabled and cron are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
        MONO_AGENT_MEMORY_REFLECTION_CRON: "0 3 * * *",
      },
    });

    expect(config.memory?.reflection).toEqual({ enabled: true, cron: "0 3 * * *" });
  });

  it("loads memory.migration from env when enabled and cron are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_MIGRATION_ENABLED: "false",
        MONO_AGENT_MEMORY_MIGRATION_CRON: "0 4 1 * *",
      },
    });

    expect(config.memory?.migration).toEqual({ enabled: false, cron: "0 4 1 * *" });
  });

  it("omits ritual blocks when neither enabled nor cron env vars are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    });

    expect(config.memory?.reflection).toBeUndefined();
    expect(config.memory?.migration).toBeUndefined();
  });

  it("loads a ritual block with only cron set (enabled omitted)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_REFLECTION_CRON: "30 2 * * *",
      },
    });

    expect(config.memory?.reflection).toEqual({ cron: "30 2 * * *" });
    expect(config.memory?.reflection?.enabled).toBeUndefined();
  });

  it("loads a ritual block with only enabled set (cron omitted)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_MIGRATION_ENABLED: "true",
      },
    });

    expect(config.memory?.migration).toEqual({ enabled: true });
    expect(config.memory?.migration?.cron).toBeUndefined();
  });

  it("accepts memory.writeMode 'capture' with mode 'bujo'", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_WRITE_MODE: "capture",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
      },
    });
    expect(config.memory?.writeMode).toBe("capture");
  });

  it("rejects memory.writeMode 'capture' unless mode is 'bujo'", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "./mem",
          MONO_AGENT_MEMORY_MODE: "journal",
          MONO_AGENT_MEMORY_WRITE_MODE: "capture",
        },
      }),
    ).toThrow(/capture.*requires.*bujo/i);
  });

  it("loads a valid phoenix observability exporter from env JSON", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
          {
            type: "phoenix",
            endpoint: "http://127.0.0.1:6006/v1/traces",
            headers: { authorization: "Bearer secret-token" },
            includeSensitiveData: true,
            timeoutMs: 7000,
          },
        ]),
      },
    });

    expect(config.observability?.exporters).toEqual([
      {
        type: "phoenix",
        endpoint: "http://127.0.0.1:6006/v1/traces",
        headers: { authorization: "Bearer secret-token" },
        includeSensitiveData: true,
        timeoutMs: 7000,
      },
    ]);
  });

  it("defaults the phoenix endpoint, timeout, and includeSensitiveData when omitted", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: "phoenix" }]),
      },
    });

    expect(config.observability?.exporters[0]).toEqual({
      type: "phoenix",
      endpoint: "http://127.0.0.1:6006/v1/traces",
      includeSensitiveData: false,
      timeoutMs: 5000,
    });
  });

  it("rejects an unknown observability exporter type", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: "langfuse" }]),
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env" });
      return;
    }
    throw new Error("Expected an unknown exporter type to fail.");
  });

  it("rejects a present-but-non-string exporter type instead of defaulting to phoenix", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: 123 }]),
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env" });
      return;
    }
    throw new Error("Expected a non-string exporter type to fail validation.");
  });

  it("rejects an invalid exporter endpoint string without any network attempt", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", endpoint: "not a url" },
          ]),
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env" });
      return;
    }
    throw new Error("Expected an invalid endpoint to fail.");
  });

  it("rejects a non-string exporter header value", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", headers: { authorization: 123 } },
          ]),
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_env" });
      return;
    }
    throw new Error("Expected a non-string header value to fail.");
  });

  it("rejects more than one configured exporter (only the first is wired)", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" },
            { type: "phoenix", endpoint: "http://127.0.0.1:6007/v1/traces" },
          ]),
        },
      }),
    ).toThrow(/single exporter/iu);
  });

  it("rejects an endpoint that embeds credentials in userinfo", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", endpoint: "https://user:pass@127.0.0.1:6006/v1/traces" },
          ]),
        },
      }),
    ).toThrow(/credentials/iu);
  });

  it("rejects an endpoint with a query string (secrets belong in headers)", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces?api_key=SECRET" },
          ]),
        },
      }),
    ).toThrow(/query string/iu);
  });

  it("rejects an endpoint with a URL fragment", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces#token" },
          ]),
        },
      }),
    ).toThrow(/fragment/iu);
  });

  it("rejects an exporter timeoutMs out of range or non-integer", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: "phoenix", timeoutMs: 0 }]),
        },
      }),
    ).toThrow(MonoAgentConfigError);

    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: "phoenix", timeoutMs: 1.5 }]),
        },
      }),
    ).toThrow(MonoAgentConfigError);
  });

  it("rejects malformed observability exporter JSON with invalid_json", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: "{not-json",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_json" });
      return;
    }
    throw new Error("Expected malformed exporter JSON to fail.");
  });

  it("redacts exporter header values in the redacted config", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
          {
            type: "phoenix",
            headers: { authorization: "Bearer super-secret-token" },
          },
        ]),
      },
    });

    const redacted = redactMonoAgentConfig(config);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("super-secret-token");
    expect(redacted.observability?.exporters[0]?.headers?.authorization).toBe("[redacted]");
  });

  it("leaves observability undefined when no exporter env is set", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.observability).toBeUndefined();
  });
});
