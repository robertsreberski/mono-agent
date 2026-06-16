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
        MONO_AGENT_MEMORY_TOOLS_ENABLED: "true",
        MONO_AGENT_MEMORY_TOOLS_ALLOW_JOURNAL_APPEND: "true",
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
      mode: "lite",
      path: "/repo/memory.md",
      maxBytes: 2048,
      scope: "single-file",
      writeMode: "append-host-summary",
      tools: {
        enabled: true,
        allowJournalAppend: true,
      },
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

  it("rejects journal append for memory tools that are not enabled", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory",
          MONO_AGENT_MEMORY_MODE: "journal",
          MONO_AGENT_MEMORY_TOOLS_ALLOW_JOURNAL_APPEND: "true",
        },
      }),
    ).toThrow(MonoAgentConfigError);
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

  it("loads the journal memory graph path from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_GRAPH_PATH: "memory/entities.jsonl",
      },
    });

    expect(config.memory?.graphPath).toBe("/repo/memory/entities.jsonl");
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

  it("rejects memory embeddings and graph env without a memory path", () => {
    for (const env of [
      { MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama" },
      { MONO_AGENT_MEMORY_GRAPH_PATH: "graph.jsonl" },
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
    expect(config.memory?.llm?.endpoint).toBeUndefined();
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
});
