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
        tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
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

  it("translates JSON runtime permission mode and reasoning summary to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions", reasoningSummary: "detailed" } },
      {},
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("bypassPermissions");
    expect(layered.MONO_AGENT_REASONING_SUMMARY).toBe("detailed");
  });

  it("lets env override JSON permission mode and reasoning summary", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions", reasoningSummary: "detailed" } },
      {
        MONO_AGENT_PERMISSION_MODE: "default",
        MONO_AGENT_REASONING_SUMMARY: "concise",
      },
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("default");
    expect(layered.MONO_AGENT_REASONING_SUMMARY).toBe("concise");
  });

  it("translates JSON concurrency to env keys", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4 } },
      {},
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("4");
  });

  it("lets env override JSON concurrency", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4 } },
      {
        MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "8",
      },
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("8");
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

  it("translates JSON runtime.session to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000 } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("per-message");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("120000");
  });

  it("lets env override JSON session values", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000 } } },
      {
        MONO_AGENT_SESSION_MODE: "continuous",
        MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000",
      },
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("continuous");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("5000");
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

  it("translates JSON memory reflection and migration ritual blocks to env keys", () => {
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
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_ENABLED).toBe("true");
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_CRON).toBe("0 3 * * *");
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_ENABLED).toBe("false");
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_CRON).toBe("0 4 1 * *");
  });

  it("omits ritual env keys when ritual blocks are absent in JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "bujo", path: ".mono-agent/memory" } },
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

  it("treats empty env values as absent so JSON wins", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { maxTurns: 4 } },
      { MONO_AGENT_MAX_TURNS: "   " },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("4");
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
    expect(fromJson.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 120_000 });

    const withEnv = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_SESSION_MODE: "continuous", MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000" },
      cwd: dir,
      jsonPath: path,
    });
    expect(withEnv.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 5000 });
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
    expect(config.memory?.reflection).toBeUndefined();
    expect(config.memory?.migration).toBeUndefined();
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

  it("loads bujo mode with reflection and migration ritual blocks from a JSON config file", async () => {
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
          reflection: { enabled: true, cron: "0 3 * * *" },
          migration: { enabled: true, cron: "0 4 1 * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.reflection).toEqual({ enabled: true, cron: "0 3 * * *" });
    expect(config.memory?.migration).toEqual({ enabled: true, cron: "0 4 1 * *" });
  });

  it("env ritual cron beats JSON ritual cron", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          reflection: { enabled: true, cron: "0 3 * * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_REFLECTION_CRON: "0 2 * * *" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.reflection?.cron).toBe("0 2 * * *");
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
