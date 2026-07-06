import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMonoAgentConfigWithSources, layerJsonOntoEnv } from "../layered-loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-layer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("layerJsonOntoEnv", () => {
  it("returns env values unchanged when JSON is empty", () => {
    const layered = layerJsonOntoEnv({}, { FOO: "bar" });
    expect(layered).toEqual({ FOO: "bar" });
  });

  it("translates JSON sections to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          fallbackModels: ["claude:claude-sonnet-4-6", "pi:ollama:gemma4:31b"],
          maxTurns: 12,
        },
        context: { identityPath: "IDENTITY.md", selectedSkills: ["a", "b"] },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
        },
        tools: {
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
          mcpCallTimeoutMs: 150000,
          mcpCallMaxTotalTimeoutMs: 2700000,
        },
        artifacts: {
          dir: ".mono-agent/artifacts",
          retention: { maxAgeDays: 21, maxCount: 300, dryRun: true },
          memoryRetention: { maxAgeDays: 5, maxCount: 30, dryRun: false },
        },
        traceability: { registryDir: ".mono-agent/traces", sourceId: "json-source", staleAfterMs: 60000 },
        providers: {
          piAuthPath: ".pi/auth.json",
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
            },
          ],
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_FALLBACK_MODELS).toBe("claude:claude-sonnet-4-6,pi:ollama:gemma4:31b");
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("12");
    expect(layered.MONO_AGENT_IDENTITY_PATH).toBe("IDENTITY.md");
    expect(layered.MONO_AGENT_SELECTED_SKILLS).toBe("a,b");
    expect(layered.MONO_AGENT_MEMORY_MODE).toBe("journal");
    expect(layered.MONO_AGENT_MEMORY_PATH).toBe(".mono-agent/memory");
    expect(layered.MONO_AGENT_ALLOWED_TOOLS).toBe("Read");
    expect(layered.MONO_AGENT_DISALLOWED_TOOLS).toBe("Bash");
    expect(layered.MONO_AGENT_MCP_CALL_TIMEOUT_MS).toBe("150000");
    expect(layered.MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS).toBe("2700000");
    expect(layered.MONO_AGENT_ARTIFACT_DIR).toBe(".mono-agent/artifacts");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS).toBe("21");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT).toBe("300");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN).toBe("true");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS).toBe("5");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT).toBe("30");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN).toBe("false");
    expect(layered.MONO_AGENT_TRACE_REGISTRY_DIR).toBe(".mono-agent/traces");
    expect(layered.MONO_AGENT_TRACE_SOURCE_ID).toBe("json-source");
    expect(layered.MONO_AGENT_TRACE_STALE_AFTER_MS).toBe("60000");
    expect(layered.MONO_AGENT_PI_AUTH_PATH).toBe(".pi/auth.json");
    expect(JSON.parse(layered.MONO_AGENT_LOCAL_PROVIDERS_JSON ?? "[]")).toEqual([
      {
        id: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        enabled: true,
      },
    ]);
  });

  it("translates JSON providers.piNative knobs to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        providers: {
          piNative: { piMaxRetries: 4, maxRetryDelayMs: 30000, piSessionsRoot: ".mono-agent/sessions" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_PI_MAX_RETRIES).toBe("4");
    expect(layered.MONO_AGENT_MAX_RETRY_DELAY_MS).toBe("30000");
    expect(layered.MONO_AGENT_PI_SESSIONS_ROOT).toBe(".mono-agent/sessions");
  });

  it("translates JSON runtime permission mode to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions" } },
      {},
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("bypassPermissions");
  });

  it("lets env override JSON permission mode", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions" } },
      {
        MONO_AGENT_PERMISSION_MODE: "default",
      },
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("default");
  });

  it("translates JSON concurrency to env keys", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4 } },
      {},
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("4");
  });

  it("translates JSON concurrency.maxPendingRuns to env keys", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4, maxPendingRuns: 16 } },
      {},
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("4");
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS).toBe("16");
  });

  it("lets env override JSON concurrency", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4, maxPendingRuns: 16 } },
      {
        MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "8",
        MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS: "32",
      },
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("8");
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS).toBe("32");
  });

  it("translates JSON memory embeddings timeoutMs and circuit breaker to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            timeoutMs: 5000,
            circuitBreaker: { failureThreshold: 5, cooldownMs: 20000 },
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD).toBe("5");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS).toBe("20000");
  });

  it("translates JSON memory.recallTool.enabled to an env key", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "journal", path: ".mono-agent/memory", recallTool: { enabled: false } } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED).toBe("false");
  });

  it("lets env override JSON memory.recallTool.enabled", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "journal", path: ".mono-agent/memory", recallTool: { enabled: false } } },
      { MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "true" },
    );
    expect(layered.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED).toBe("true");
  });

  it("translates the JSON memory.backend + supermemory block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          backend: "supermemory",
          path: ".mono-agent/memory",
          supermemory: {
            baseUrl: "http://127.0.0.1:8080",
            apiKeyEnv: "SM_KEY",
            container: "agent-alpha",
            timeoutMs: 5000,
            exposeMcpServer: true,
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_BACKEND).toBe("supermemory");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL).toBe("http://127.0.0.1:8080");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV).toBe("SM_KEY");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER).toBe("agent-alpha");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER).toBe("true");
  });

  it("translates JSON runtime.session to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000, rolloverNotice: true } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("per-message");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("120000");
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("true");
  });

  it("lets env override JSON session values", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000, rolloverNotice: true } } },
      {
        MONO_AGENT_SESSION_MODE: "continuous",
        MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000",
        MONO_AGENT_SESSION_ROLLOVER_NOTICE: "false",
      },
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("continuous");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("false");
  });

  it("lets env override JSON values", () => {
    const layered = layerJsonOntoEnv(
      {
        runtime: { maxTurns: 4 },
        providers: {
          piAuthPath: ".json/pi-auth.json",
          local: [{ id: "json-ollama", type: "ollama", baseUrl: "http://localhost:11434" }],
        },
      },
      {
        MONO_AGENT_MAX_TURNS: "16",
        MONO_AGENT_PI_AUTH_PATH: "/env/pi-auth.json",
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
      },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("16");
    expect(layered.MONO_AGENT_PI_AUTH_PATH).toBe("/env/pi-auth.json");
    expect(layered.MONO_AGENT_LOCAL_PROVIDERS_JSON).toBeUndefined();
    expect(layered.MONO_AGENT_LOCAL_PROVIDER_ID).toBe("ollama");
  });

  it("translates the JSON sandbox section to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        sandbox: {
          mode: "native",
          network: { mode: "allowlist", allowlist: ["github.com", "api.github.com"] },
          readableRoots: [".", "../shared-docs"],
          writableRoots: ["out"],
          denyWrite: [".env", "secrets/**"],
          fallback: "fail-closed",
          unsafeAllowHostProcess: false,
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_SANDBOX_MODE).toBe("native");
    expect(layered.MONO_AGENT_SANDBOX_NETWORK).toBe("allowlist");
    expect(layered.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST).toBe("github.com,api.github.com");
    expect(layered.MONO_AGENT_SANDBOX_READABLE_ROOTS).toBe(".,../shared-docs");
    expect(layered.MONO_AGENT_SANDBOX_WRITABLE_ROOTS).toBe("out");
    expect(layered.MONO_AGENT_SANDBOX_DENY_WRITE).toBe(".env,secrets/**");
    expect(layered.MONO_AGENT_SANDBOX_FALLBACK).toBe("fail-closed");
    expect(layered.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS).toBe("false");
  });

  it("translates JSON memory embeddings to env keys (graphPath is a no-op — retired)", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            endpoint: "http://localhost:11434",
            apiKeyEnv: "EMBEDDINGS_KEY",
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_GRAPH_PATH).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER).toBe("ollama");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL).toBe("nomic-embed-text");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT).toBe("http://localhost:11434");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV).toBe("EMBEDDINGS_KEY");
  });

  it("translates JSON memory bujo mode and llm block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_MODE).toBe("bujo");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_DIM).toBe("768");
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("ollama");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("qwen3.6:latest");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBe("http://localhost:11434");
  });

  it("translates JSON agent-host memory llm block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5", executionMode: "sdk" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_MEMORY_LLM_EXECUTION_MODE).toBe("sdk");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("translates JSON memory llm timeoutMs to its env key", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "agent-host", model: "pi:opencode-go:kimi-k2.6", timeoutMs: 120000 },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS).toBe("120000");
  });

  it("drops a stale JSON Ollama LLM endpoint when env switches memory llm to agent-host", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("preserves an explicit env endpoint so invalid agent-host env config can fail validation", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
      },
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBe("http://localhost:11434");
  });

  it("omits LLM env keys when llm block is absent in JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "bujo", path: ".mono-agent/memory" } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("translates JSON memory consolidation block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED).toBe("true");
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_CRON).toBe("0 */2 * * *");
  });

  it("omits consolidation env keys when consolidation block is absent in JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "bujo", path: ".mono-agent/memory" } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_CRON).toBeUndefined();
  });

  it("does not translate removed JSON reflection and migration blocks to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          reflection: { enabled: true, cron: "0 3 * * *" },
          migration: { enabled: false, cron: "0 4 1 * *" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_CRON).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_CRON).toBeUndefined();
  });

  it("uses lite as the default memory mode when mode is omitted from JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { path: ".mono-agent/memory" } },
      {},
    );
    // mode not set from JSON — the loader supplies the lite default
    expect(layered.MONO_AGENT_MEMORY_MODE).toBeUndefined();
  });

  it("translates JSON context.skillMaxBytes to an env key", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md", skillMaxBytes: 24000 } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_MAX_BYTES).toBe("24000");
  });

  it("translates JSON context.skillDisclosure to an env key", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md", skillDisclosure: "index" } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_DISCLOSURE).toBe("index");
  });

  it("omits MONO_AGENT_SKILL_DISCLOSURE when context.skillDisclosure is absent", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md" } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_DISCLOSURE).toBeUndefined();
  });

  it("translates JSON runtime.session.isolateProactive to an env key", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { isolateProactive: true } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ISOLATE_PROACTIVE).toBe("true");
  });

  it("translates JSON runtime.session.rolloverNotice false to an env key", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { rolloverNotice: false } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("false");
  });

  it("rejects non-boolean JSON runtime.session.rolloverNotice", () => {
    expect(() =>
      layerJsonOntoEnv(
        { runtime: { session: { rolloverNotice: "false" as unknown as boolean } } },
        {},
      ),
    ).toThrow(/runtime\.session\.rolloverNotice must be a boolean/u);
  });

  it("omits MONO_AGENT_SESSION_ISOLATE_PROACTIVE when session.isolateProactive is absent", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "continuous" } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ISOLATE_PROACTIVE).toBeUndefined();
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBeUndefined();
  });

  it("treats empty env values as absent so JSON wins", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { maxTurns: 4 } },
      { MONO_AGENT_MAX_TURNS: "   " },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("4");
  });

  it("translates JSON observability.exporters to MONO_AGENT_OBSERVABILITY_EXPORTERS", () => {
    const exporters = [
      { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false },
    ];
    const layered = layerJsonOntoEnv({ observability: { exporters } }, {});
    expect(JSON.parse(layered.MONO_AGENT_OBSERVABILITY_EXPORTERS ?? "[]")).toEqual(exporters);
  });

  it("lets env override JSON observability exporters", () => {
    const layered = layerJsonOntoEnv(
      {
        observability: {
          exporters: [{ type: "phoenix", endpoint: "http://json-host:6006/v1/traces" }],
        },
      },
      {
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
          { type: "phoenix", endpoint: "http://env-host:6006/v1/traces" },
        ]),
      },
    );
    expect(JSON.parse(layered.MONO_AGENT_OBSERVABILITY_EXPORTERS ?? "[]")).toEqual([
      { type: "phoenix", endpoint: "http://env-host:6006/v1/traces" },
    ]);
  });
});

describe("loadMonoAgentConfigWithSources", () => {
  it("loads config from JSON when env is missing the required fields", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
        context: { identityPath: "IDENTITY.md" },
        providers: {
          piAuthPath: ".worklab/auth.json",
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
              models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
            },
          ],
        },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: {},
      cwd: dir,
      jsonPath: path,
    });
    expect(config.runtime.maxTurns).toBe(12);
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
    expect(config.providers?.piAuthPath).toBe(join(dir, ".worklab", "auth.json"));
    expect(config.providers?.local?.[0]?.models?.[0]?.capabilities).toMatchObject({ context_window: 32768 });
  });

  it("env local-provider settings beat JSON provider defaults", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:ollama:qwen3:8b" },
        context: { identityPath: "IDENTITY.md" },
        providers: {
          local: [{ id: "json-ollama", type: "ollama", baseUrl: "http://localhost:11434" }],
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_BASE_URL: "http://localhost:11434",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.providers?.local?.map((provider) => provider.id)).toEqual(["ollama"]);
  });

  it("env beats JSON for overlapping fields", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 4 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MAX_TURNS: "20" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.runtime.maxTurns).toBe(20);
  });

  it("treats a JSON runtime maxTurns value of zero as unlimited", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 0 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: {},
      cwd: dir,
      jsonPath: path,
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("lets env runtime max turns of zero override JSON to unlimited", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 4 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MAX_TURNS: "0" },
      cwd: dir,
      jsonPath: path,
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("loads session settings from JSON and lets env win for overlaps", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { mode: "per-message", idleTimeoutMs: 120_000 },
        },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 120_000, rollover: "none" });

    const withEnv = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_SESSION_MODE: "continuous", MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000" },
      cwd: dir,
      jsonPath: path,
    });
    expect(withEnv.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 5000, rollover: "none" });
  });

  it("loads session.rollover + rolloverTimezone from json and env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-rollover-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { rollover: "daily", rolloverTimezone: "Europe/Rome" },
        },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.runtime.session.rollover).toBe("daily");
    expect(fromJson.runtime.session.rolloverTimezone).toBe("Europe/Rome");

    const withEnv = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_SESSION_ROLLOVER: "none", MONO_AGENT_SESSION_ROLLOVER_TIMEZONE: "UTC" },
      cwd: dir,
      jsonPath: path,
    });
    // Env overrides json (higher precedence).
    expect(withEnv.runtime.session.rollover).toBe("none");
    expect(withEnv.runtime.session.rolloverTimezone).toBe("UTC");
  });

  it("round-trips context.skillDisclosure + session.isolateProactive + session.rolloverNotice from JSON through to the config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-disclosure-isolate-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { isolateProactive: true, rolloverNotice: true },
        },
        context: { identityPath: "IDENTITY.md", skillDisclosure: "index" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.context.skillDisclosure).toBe("index");
    expect(fromJson.runtime.session.isolateProactive).toBe(true);
    expect(fromJson.runtime.session.rolloverNotice).toBe(true);

    // These keys default to UNSET so legacy behavior is byte-for-byte preserved.
    const path2 = join(dir, "config2.json");
    await writeFile(
      path2,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const defaults = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path2 });
    expect(defaults.context.skillDisclosure).toBeUndefined();
    expect(defaults.runtime.session.isolateProactive).toBeUndefined();
    expect(defaults.runtime.session.rolloverNotice).toBeUndefined();

    // Env overrides JSON (higher precedence).
    const withEnv = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_SKILL_DISCLOSURE: "full",
        MONO_AGENT_SESSION_ISOLATE_PROACTIVE: "false",
        MONO_AGENT_SESSION_ROLLOVER_NOTICE: "false",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(withEnv.context.skillDisclosure).toBe("full");
    expect(withEnv.runtime.session.isolateProactive).toBe(false);
    expect(withEnv.runtime.session.rolloverNotice).toBe(false);
  });

  it("loads a sandbox policy from the JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        sandbox: {
          mode: "native",
          network: { mode: "localhost" },
          denyWrite: [".env", "secrets/**"],
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.sandbox).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "localhost" },
      denyWrite: [".env", "secrets/**"],
    });
  });

  it("loads memory embeddings from the JSON config file (graphPath is retired — ignored)", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory).not.toHaveProperty("graphPath");
    expect(config.memory?.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text" });
  });

  it("works without a jsonPath (pure env loader behavior)", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
    });
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("treats a missing JSON file as an empty layer", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
      jsonPath: join(dir, "absent.json"),
    });
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("loads lite mode from a JSON config file (no embeddings, no llm)", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "lite",
          path: ".mono-agent/memory",
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("lite");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
    expect(config.memory?.consolidation).toBeUndefined();
  });

  it("loads journal mode from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("journal");
    expect(config.memory?.embeddings).toMatchObject({ provider: "ollama", model: "nomic-embed-text", dim: 768 });
    expect(config.memory?.llm).toBeUndefined();
  });

  it("loads bujo mode with consolidation block from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
          llm: { provider: "ollama", model: "qwen3:8b" },
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.consolidation).toEqual({ enabled: true, cron: "0 */2 * * *" });
  });

  it("env consolidation cron beats JSON consolidation cron", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */4 * * *" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.consolidation?.cron).toBe("0 */4 * * *");
  });

  it("loads bujo mode with llm block from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text:v1.5",
            dim: 768,
          },
          llm: {
            provider: "ollama",
            model: "qwen3.6:latest",
          },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });

    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.path).toBe(join(dir, ".mono-agent", "memory"));
    expect(config.memory?.embeddings).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      dim: 768,
    });
    expect(config.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
    });
  });
});
