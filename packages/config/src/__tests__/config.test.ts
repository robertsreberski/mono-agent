import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ALLOW_ALL_TOOLS, loadMonoAgentConfig, MonoAgentConfigError, redactMonoAgentConfig, resolveConfiguredProviders } from "../index.js";

const baseEnv = {
  MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
  MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
};

const journalMemoryPrerequisite = {
  MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
};

const bujoMemoryPrerequisites = {
  ...journalMemoryPrerequisite,
  MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
  MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
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
        MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS: "transcribe,documents",
        MONO_AGENT_CONTINUATION_SERVERS: "a8c-control,local-worker",
        MONO_AGENT_MCP_CALL_TIMEOUT_MS: "150000",
        MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS: "2700000",
        MONO_AGENT_MEMORY_PATH: "memory.md",
        MONO_AGENT_MEMORY_WRITE_MODE: "append-host-summary",
        MONO_AGENT_MEMORY_MAX_BYTES: "2048",
        MONO_AGENT_ARTIFACT_DIR: "artifacts",
        MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS: "14",
        MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT: "250",
        MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN: "true",
        MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS: "3",
        MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT: "25",
        MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN: "false",
        MONO_AGENT_TRACE_REGISTRY_DIR: "trace-registry",
        MONO_AGENT_TRACE_SOURCE_ID: "agent-one",
        MONO_AGENT_TRACE_SOURCE_LABEL: "Agent One",
        MONO_AGENT_TRACE_HEARTBEAT_MS: "5000",
        MONO_AGENT_TRACE_STALE_AFTER_MS: "15000",
        MONO_AGENT_TRACE_GLOBAL_DISCOVERY: "false",
      },
    });

    expect(config.runtime).toMatchObject({ effort: "high", maxTurns: 12, workspace: "/repo/workspace" });
    expect(config.runtime.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
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
      mcpRequestContextServers: ["transcribe", "documents"],
      continuationServers: ["a8c-control", "local-worker"],
      mcpCallTimeoutMs: 150000,
      mcpCallMaxTotalTimeoutMs: 2700000,
      web: {
        coordination: "process",
        search: { backend: "auto", codex: { model: "gpt-5.6-luna" } },
        fetch: { render: "never", browserCommand: "agent-browser" },
      },
    });
    expect(config.artifacts.dir).toBe("/repo/artifacts");
    expect(config.artifacts.retention).toEqual({ maxAgeDays: 14, maxCount: 250, dryRun: true });
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 3, maxCount: 25, dryRun: false });
    expect(config.providers?.piAuthPath).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(config.traceability).toEqual({
      registryDir: "/repo/trace-registry",
      sourceId: "agent-one",
      sourceLabel: "Agent One",
      heartbeatMs: 5000,
      staleAfterMs: 15000,
      globalDiscovery: false,
    });
  });

  it("uses finite artifact retention defaults", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });

    expect(config.runtime.compaction).toEqual({ enabled: true, fixedOverheadEnabled: true });
    expect(config.artifacts.retention).toEqual({ maxAgeDays: 365, maxCount: 50000, dryRun: false });
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 7, maxCount: 5000, dryRun: false });
    expect(config.tools.web).toEqual({
      coordination: "process",
      search: { backend: "auto", codex: { model: "gpt-5.6-luna" } },
      fetch: { render: "never", browserCommand: "agent-browser" },
    });
  });

  it("loads local web search and browser-render settings from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_WEB_COORDINATION: "host",
        MONO_AGENT_WEB_SEARCH_BACKEND: "searxng",
        MONO_AGENT_WEB_SEARCH_ENDPOINT: "http://127.0.0.1:8088/",
        MONO_AGENT_WEB_SEARCH_CODEX_MODEL: "gpt-5.6-sol",
        MONO_AGENT_WEB_FETCH_RENDER: "auto",
        MONO_AGENT_WEB_BROWSER_COMMAND: "/opt/homebrew/bin/agent-browser",
      },
    });

    expect(config.tools.web).toEqual({
      coordination: "host",
      search: {
        backend: "searxng",
        endpoint: "http://127.0.0.1:8088",
        codex: { model: "gpt-5.6-sol" },
      },
      fetch: { render: "auto", browserCommand: "/opt/homebrew/bin/agent-browser" },
    });
  });

  it("rejects remote or credentialed SearXNG endpoints and strict mode without an endpoint", () => {
    for (const endpoint of [
      "https://search.example.com",
      "http://user:pass@127.0.0.1:8088",
      "http://192.168.1.2:8088",
      "http://127.0.0.1:8088?format=html",
      "http://127.0.0.1:8088#fragment",
    ]) {
      expect(() => loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_WEB_SEARCH_ENDPOINT: endpoint },
      })).toThrow(MonoAgentConfigError);
    }
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_WEB_SEARCH_BACKEND: "searxng" },
    })).toThrow(/MONO_AGENT_WEB_SEARCH_ENDPOINT/u);
  });

  it("rejects control characters in the direct browser executable", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_WEB_BROWSER_COMMAND: "agent-browser\t--unsafe" },
    })).toThrow(/MONO_AGENT_WEB_BROWSER_COMMAND/u);
  });

  it("accepts strict Codex search without SearXNG and validates its model id", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_WEB_SEARCH_BACKEND: "codex",
        MONO_AGENT_WEB_SEARCH_CODEX_MODEL: "gpt-5.6-luna",
      },
    });
    expect(config.tools.web?.search).toEqual({
      backend: "codex",
      codex: { model: "gpt-5.6-luna" },
    });
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_WEB_SEARCH_CODEX_MODEL: `gpt${"x".repeat(200)}`,
      },
    })).toThrow(/MONO_AGENT_WEB_SEARCH_CODEX_MODEL/u);
  });

  it("loads every runtime compaction override from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_COMPACTION_ENABLED: "false",
        MONO_AGENT_COMPACTION_TRIGGER_RATIO: "0.8",
        MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS: "9000",
        MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS: "3000",
        MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS: "7000",
        MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED: "false",
        MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE: "272000",
      },
    });
    expect(config.runtime.compaction).toEqual({
      enabled: false,
      triggerRatio: 0.8,
      keepRecentTokens: 9_000,
      summaryMaxTokens: 3_000,
      minSavingsTokens: 7_000,
      fixedOverheadEnabled: false,
      contextWindowOverride: 272_000,
    });
  });

  it.each([
    ["MONO_AGENT_COMPACTION_ENABLED", "sometimes"],
    ["MONO_AGENT_COMPACTION_TRIGGER_RATIO", "0.1"],
    ["MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS", "3999"],
    ["MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS", "999"],
    ["MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS", "-1"],
    ["MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED", "sometimes"],
    ["MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE", "31999"],
  ])("rejects invalid compaction env %s=%s", (name, value) => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, [name]: value },
    })).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("expands a home-relative Pi auth path instead of treating tilde as a directory", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_PI_AUTH_PATH: "~/.pi/custom/auth.json" },
    });

    expect(config.providers?.piAuthPath).toBe(join(homedir(), ".pi", "custom", "auth.json"));
  });

  it("defaults memory artifact retention dry-run to the agent retention dry-run", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN: "true",
      },
    });

    expect(config.artifacts.retention.dryRun).toBe(true);
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 7, maxCount: 5000, dryRun: true });
  });

  it("rejects invalid artifact retention values", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS: "0" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT: "-1" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS: "0" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT: "-1" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads permission mode from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PERMISSION_MODE: "bypassPermissions",
      },
    });

    expect(config.runtime.permissionMode).toBe("bypassPermissions");
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

  it("omits permission mode when the env is unset", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.runtime.permissionMode).toBeUndefined();
  });

  it("loads pi-native provider knobs from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PI_TRANSPORT: "sse",
        MONO_AGENT_PI_MAX_RETRIES: "4",
        MONO_AGENT_MAX_RETRY_DELAY_MS: "30000",
        MONO_AGENT_PI_SESSIONS_ROOT: ".mono-agent/sessions",
      },
    });
    expect(config.providers?.piNative).toEqual({
      transport: "sse",
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

  it("rejects an invalid pi transport", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_PI_TRANSPORT: "long-polling" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("rejects an invalid permission mode value", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_PERMISSION_MODE: "yolo" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads a trimmed public agent name and uses it as the default trace label", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_NAME: "  Research Partner  " },
    });

    expect(config.agent).toEqual({ name: "Research Partner" });
    expect(config.traceability.sourceLabel).toBe("Research Partner");
    expect(config.traceability.sourceId).toBeUndefined();
  });

  it("keeps an explicit trace label ahead of the public agent name", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_NAME: "Research Partner",
        MONO_AGENT_TRACE_SOURCE_LABEL: "Operations Trace",
      },
    });

    expect(config.agent?.name).toBe("Research Partner");
    expect(config.traceability.sourceLabel).toBe("Operations Trace");
  });

  it.each(["", "line one\nline two", "x".repeat(81)])("rejects an invalid public agent name %j", (name) => {
    expect(() => loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_NAME: name } }))
      .toThrow(/MONO_AGENT_NAME/u);
  });

  it("loads canonical fallback routes with independent effort", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_EFFORT: "high",
        MONO_AGENT_FALLBACKS_JSON: JSON.stringify([
          { model: "openai-codex:gpt-5.6-sol" },
          { model: "anthropic:claude-sonnet-4-6", effort: "minimal" },
          { model: "ollama:gemma4:31b", effort: "ultra" },
        ]),
      },
    });

    expect(config.runtime.fallbacks).toEqual([
      { model: expect.objectContaining({ provider: "openai-codex", model: "gpt-5.6-sol" }) },
      { model: expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-6" }), effort: "minimal" },
      { model: expect.objectContaining({ provider: "ollama", model: "gemma4:31b" }), effort: "ultra" },
    ]);
  });

  it.each(["minimal", "ultra"])("accepts the %s effort level", (effort) => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_EFFORT: effort } });
    expect(config.runtime.effort).toBe(effort);
  });

  it("rejects duplicate primary and fallback routes deterministically", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "pi:openai-codex:gpt-5.5" }]),
      },
    })).toThrow(/Duplicate runtime route/u);

  });

  it("loads subagent profiles and caps", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
          enabled: true,
          maxConcurrent: 3,
          definitions: [
            { name: "researcher", description: "Reads code.", prompt: "You research.", allowedTools: ["Read", "Grep"] },
            { name: "test-runner", description: "Runs tests.", promptPath: "./agents/test-runner.md", model: "openai-codex:gpt-5.6-sol", timeoutMs: 900_000 },
          ],
        }),
      },
    });

    expect(config.subagents?.enabled).toBe(true);
    expect(config.subagents?.maxConcurrent).toBe(3);
    expect(config.subagents?.definitions?.[0]).toEqual({
      name: "researcher",
      description: "Reads code.",
      prompt: "You research.",
      allowedTools: ["Read", "Grep"],
    });
    expect(config.subagents?.definitions?.[1]?.promptPath).toBe("/repo/agents/test-runner.md");
    expect(config.subagents?.definitions?.[1]?.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.6-sol" });
  });

  it("is absent when no subagents are configured", () => {
    expect(loadMonoAgentConfig({ cwd: "/repo", env: baseEnv }).subagents).toBeUndefined();
  });

  it("loads the in-flight subagent policy", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
          enabled: true,
          inline: { enabled: false, allowedTools: ["Read", "Edit", "Bash"] },
        }),
      },
    });

    expect(config.subagents?.inline).toEqual({ enabled: false, allowedTools: ["Read", "Edit", "Bash"] });
  });

  it.each([
    ["a non-object payload", "[]", /must be a JSON object/u],
    ["a nameless definition", JSON.stringify({ definitions: [{ description: "d", prompt: "p" }] }), /name must be lowercase kebab-case/u],
    ["a non-kebab name", JSON.stringify({ definitions: [{ name: "Researcher", description: "d", prompt: "p" }] }), /name must be lowercase kebab-case/u],
    ["a duplicate name", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p" }, { name: "a", description: "d2", prompt: "p2" }] }), /duplicate definition name "a"/u],
    ["a missing description", JSON.stringify({ definitions: [{ name: "a", prompt: "p" }] }), /needs a non-empty description/u],
    ["both prompt and promptPath", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", promptPath: "./x.md" }] }), /exactly one of prompt or promptPath/u],
    ["neither prompt nor promptPath", JSON.stringify({ definitions: [{ name: "a", description: "d" }] }), /exactly one of prompt or promptPath/u],
    ["the allow-all wildcard", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", allowedTools: ["*"] }] }), /cannot use the \* wildcard/u],
    ["a self-referential Agent grant", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", allowedTools: ["Agent"] }] }), /subagents never spawn subagents/u],
    ["an out-of-range maxConcurrent", JSON.stringify({ maxConcurrent: 99 }), /maxConcurrent must be an integer between 1 and 10/u],
    ["a non-object inline policy", JSON.stringify({ inline: [] }), /inline must be an object/u],
    ["an inline allow-all wildcard", JSON.stringify({ inline: { allowedTools: ["*"] } }), /cannot use the \* wildcard/u],
    ["an inline Agent grant", JSON.stringify({ inline: { allowedTools: ["Agent"] } }), /subagents never spawn subagents/u],
  ])("rejects %s", (_label, payload, expected) => {
    expect(() => loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_SUBAGENTS_JSON: payload } }))
      .toThrow(expected);
  });

  it("materializes same-model retry defaults", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: baseEnv });
    expect(config.runtime.retry).toEqual({ primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 });
  });

  it("reads the retry policy from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_RETRY_PRIMARY_ATTEMPTS: "4",
        MONO_AGENT_RETRY_BACKOFF_MS: "250",
        MONO_AGENT_RETRY_MAX_BACKOFF_MS: "5000",
      },
    });
    expect(config.runtime.retry).toEqual({ primaryAttempts: 4, backoffMs: 250, maxBackoffMs: 5_000 });
  });

  it.each([
    ["MONO_AGENT_RETRY_PRIMARY_ATTEMPTS", "0"],
    ["MONO_AGENT_RETRY_PRIMARY_ATTEMPTS", "11"],
    ["MONO_AGENT_RETRY_PRIMARY_ATTEMPTS", "2.5"],
    ["MONO_AGENT_RETRY_BACKOFF_MS", "-1"],
    ["MONO_AGENT_RETRY_BACKOFF_MS", "60001"],
    ["MONO_AGENT_RETRY_MAX_BACKOFF_MS", "300001"],
  ])("rejects out-of-range %s=%s", (env, value) => {
    expect(() => loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, [env]: value } }))
      .toThrow(/must be an integer between/u);
  });

  it("accepts per-route attempts on canonical fallbacks", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_FALLBACKS_JSON: JSON.stringify([
          { model: "openai-codex:gpt-5.6-sol", attempts: 3 },
          { model: "anthropic:claude-sonnet-4-6", effort: "high", attempts: 2 },
          { model: "ollama:gemma4:31b" },
        ]),
      },
    });
    expect(config.runtime.fallbacks?.map((entry) => entry.attempts)).toEqual([3, 2, undefined]);
  });

  it.each([0, 11, 2.5, "2"])("rejects a fallback attempts value of %s", (attempts) => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "openai-codex:gpt-5.6-sol", attempts }]),
      },
    })).toThrow(/attempts must be an integer between 1 and 10/u);
  });

  it("rejects malformed canonical fallback entries", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ effort: "high" }]) },
    })).toThrow(/non-empty model/u);
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "openai-codex:gpt-5.6-sol", effort: "extreme" }]) },
    })).toThrow(/must be one of/u);
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "openai-codex:gpt-5.6-sol", effort: "" }]) },
    })).toThrow(/must be one of/u);
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "openai-codex:gpt-5.6-sol", efffort: "max" }]) },
    })).toThrow(/unknown field: efffort/u);
  });

  // The repair names the environment variable, not the JSON key: an operator whose `.env`
  // still carries the variable has no JSON key to rewrite.
  it.each([
    [
      "MONO_AGENT_EXECUTION_MODE",
      "runtime.executionMode",
      "`MONO_AGENT_EXECUTION_MODE` was removed; mono-agent runs only the Pi runtime (SDK). Remove the variable from your environment and `.env`.",
    ],
    [
      "MONO_AGENT_ROUTE_SAFETY",
      "runtime.routeSafety",
      "`MONO_AGENT_ROUTE_SAFETY` was removed; every route is Pi-native, so `per-route-native` has no meaning. Remove the variable from your environment and `.env`.",
    ],
    [
      "MONO_AGENT_FALLBACK_MODELS",
      "runtime.fallbackModels",
      "`MONO_AGENT_FALLBACK_MODELS` was replaced by `MONO_AGENT_FALLBACKS_JSON`, a JSON array of `{ \"model\": \"...\" }` objects. Remove the variable and re-express the chain there, or drop it into `runtime.fallbacks` in mono-agent.config.json.",
    ],
    [
      "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
      "memory.llm.executionMode",
      "`MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` was removed for the same reason as `MONO_AGENT_EXECUTION_MODE`: mono-agent runs only the Pi runtime (SDK). Remove the variable from your environment and `.env`.",
    ],
  ] as const)("rejects retired env key %s with migration guidance", (env, path, message) => {
    expect(() => loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, [env]: "retired" } }))
      .toThrowError(expect.objectContaining({
        code: "invalid_env",
        message,
        details: expect.objectContaining({ env, path }),
      }));
  });

  it.each([
    "MONO_AGENT_EXECUTION_MODE",
    "MONO_AGENT_ROUTE_SAFETY",
    "MONO_AGENT_FALLBACK_MODELS",
    "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
  ] as const)("treats an empty retired env key %s as unset", (env) => {
    // Every reader here treats an empty env var as unset, and the layered
    // loader drops empty values before layering, so `KEY=` in a deployed .env
    // never configured anything even before the field was retired. Failing the
    // whole load on an inert leftover line is a startup regression, not a
    // migration signal.
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, [env]: "" } });

    expect(config.runtime.fallbacks).toBeUndefined();
  });

  it("still rejects a whitespace-padded retired env value", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "  ollama:gemma4:31b  " },
    })).toThrow(/MONO_AGENT_FALLBACK_MODELS/u);
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

  it("tolerates the retired MONO_AGENT_MEMORY_SCOPE / _TOOLS_* / _GRAPH_PATH env vars but warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
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
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("MONO_AGENT_MEMORY_GRAPH_PATH");
      expect(message).toContain("MONO_AGENT_MEMORY_SCOPE");
      expect(message).toContain("MONO_AGENT_MEMORY_TOOLS_ENABLED");
    } finally {
      warn.mockRestore();
    }
  });

  it("defaults the runtime session to continuous with a 30-minute idle timeout", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: baseEnv });

    expect(config.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 1_800_000, rollover: "none" });
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

    expect(config.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 60000, rollover: "none" });
  });

  it("preserves explicit session rollover notice env values while omitting the unset field", () => {
    const defaults = loadMonoAgentConfig({ cwd: "/repo", env: baseEnv });
    expect(defaults.runtime.session.rolloverNotice).toBeUndefined();

    const enabled = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_SESSION_ROLLOVER_NOTICE: "true" },
    });
    expect(enabled.runtime.session.rolloverNotice).toBe(true);

    const disabled = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_SESSION_ROLLOVER_NOTICE: "false" },
    });
    expect(disabled.runtime.session.rolloverNotice).toBe(false);
  });

  it("rejects an invalid session rollover notice value", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_SESSION_ROLLOVER_NOTICE: "sometimes" },
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_env", details: { env: "MONO_AGENT_SESSION_ROLLOVER_NOTICE" } });
      return;
    }
    throw new Error("Expected config load to fail.");
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
    expect(redacted.runtime.model).toMatchObject({ provider: "openai-codex" });
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
        MONO_AGENT_PI_TRANSPORT: "websocket-cached",
        MONO_AGENT_PI_MAX_RETRIES: "4",
        MONO_AGENT_MAX_RETRY_DELAY_MS: "30000",
        MONO_AGENT_PI_SESSIONS_ROOT: ".mono-agent/sessions",
      },
    });
    const redacted = redactMonoAgentConfig(config);
    expect(redacted.providers?.piNative).toEqual({
      transport: "websocket-cached",
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

  it("defaults traceability.globalDiscovery to true so agents mirror into the machine-wide registry", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: baseEnv,
    });

    expect(config.traceability.globalDiscovery).toBe(true);
  });

  it("rejects a non-boolean MONO_AGENT_TRACE_GLOBAL_DISCOVERY", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_TRACE_GLOBAL_DISCOVERY: "sometimes" },
      }),
    ).toThrow(MonoAgentConfigError);
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

  it("rejects a bare non-builtin provider entry that Pi cannot reach", () => {
    // A bare `{}` for an id Pi has no catalog for validated, advertised nothing,
    // and only failed at turn time with `pi model not found`.
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "private-provider:model-one",
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({ "private-provider": {} }),
      },
    })).toThrow('give providers.private-provider a "baseUrl"');
  });

  it("resolves a provider-map entry into the deterministic shared view", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "private-provider:model-one",
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({
          "private-provider": { type: "openai_compat", baseUrl: "http://localhost:9000" },
          openrouter: { models: [{ name: "anthropic/claude-opus-4.5" }] },
        }),
      },
    });

    const resolved = resolveConfiguredProviders(config);
    expect(resolved.entries.map((provider) => provider.id)).toEqual(["openrouter", "private-provider"]);
    expect(resolved.byId.get("private-provider")).toMatchObject({
      id: "private-provider",
      enabled: true,
      maxAdvertisedModels: 100,
    });
    expect(resolved.byId.get("openrouter")?.models).toEqual([
      expect.objectContaining({ name: "anthropic/claude-opus-4.5" }),
    ]);
  });

  it("reads reserved Pi settings from the whole providers env projection", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({
          piAuthPath: "~/.worklab/auth.json",
          piNative: {
            transport: "websocket",
            piMaxRetries: 4,
            maxRetryDelayMs: 30_000,
            piSessionsRoot: ".mono-agent/pi-sessions",
          },
        }),
      },
    });

    expect(config.providers).toMatchObject({
      piAuthPath: join(homedir(), ".worklab", "auth.json"),
      piNative: {
        transport: "websocket",
        piMaxRetries: 4,
        maxRetryDelayMs: 30_000,
        piSessionsRoot: "/repo/.mono-agent/pi-sessions",
      },
    });
  });

  it("migrates providers.local[] to the same effective provider set as the map shape", () => {
    const common = {
      type: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ name: "qwen3:8b" }],
    } as const;
    const fromMap = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "ollama:qwen3:8b",
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({ ollama: common }),
      },
    });
    const fromLegacy = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "ollama:qwen3:8b",
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({ local: [{ id: "ollama", ...common }] }),
      },
    });

    expect(resolveConfiguredProviders(fromLegacy).entries).toEqual(resolveConfiguredProviders(fromMap).entries);
  });

  it("rejects a duplicate id across the provider map and providers.local[] with both paths", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({
          ollama: {},
          local: [{ id: "ollama", type: "ollama" }],
        }),
      },
    })).toThrow(/providers\.ollama.*providers\.local\[0\]|providers\.local\[0\].*providers\.ollama/u);
  });

  it("rejects an unlisted non-builtin route with the provider id and exact repair", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MODEL: "private-provider:model-one" },
    })).toThrow('Provider "private-provider" used by runtime.model is not available; add "providers": { "private-provider": { "type": "openai_compat", "baseUrl": "https://..." } }');
  });

  it("rejects an unlisted provider named only by a subagent profile model", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
          definitions: [
            { name: "researcher", description: "digs", prompt: "go", model: "openai-codex:gpt-5.5" },
            { name: "reviewer", description: "checks", prompt: "go", model: "private-provider:model-one" },
          ],
        }),
      },
    })).toThrow('Provider "private-provider" used by subagents.definitions[1].model is not available');
  });

  it("accepts a subagent profile model whose provider is declared in the map", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({
          "my-gateway": { type: "openai_compat", baseUrl: "http://127.0.0.1:9000/v1" },
        }),
        MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
          definitions: [{ name: "reviewer", description: "checks", prompt: "go", model: "my-gateway:model-one" }],
        }),
      },
    });

    expect(config.subagents?.definitions?.[0]?.model).toMatchObject({ provider: "my-gateway" });
  });

  it("admits a bare autodiscoverable route without fabricating a provider endpoint", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "ollama:gemma4:31b",
        MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "lmstudio:qwen3" }]),
      },
    });

    // Deliberate split of duties: load admits the route (an undeclared local id
    // is not a config error), and NOTHING here invents an endpoint the operator
    // never declared. `doctor`/`validate` owns the diagnosis -- see
    // `piModelResolutionIssue` in agent-app, which reports
    // `pi model not found: ollama:gemma4:31b` with the exact repair. Synthesizing
    // `http://localhost:11434` here would turn that honest error into a false
    // "ok" and move the failure to a connection error on the first turn.
    expect(config.providers?.local).toBeUndefined();
    expect(config.providers?.entries).toBeUndefined();
  });

  it("fills the default endpoint for an autodiscoverable provider declared as an empty entry", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MODEL: "ollama:gemma4:31b",
        MONO_AGENT_PROVIDERS_JSON: JSON.stringify({ ollama: {} }),
      },
    });

    // `"providers": { "ollama": {} }` is the whole repair: the id implies the
    // type, and the type implies the localhost endpoint.
    expect(config.providers?.local).toEqual([
      expect.objectContaining({ id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true }),
    ]);
    expect(resolveConfiguredProviders(config).entries.map((entry) => entry.id)).toEqual(["ollama"]);
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
      model: "nomic-embed-text:v1.5",
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
      { MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "true" },
      { MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */2 * * *" },
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

  it("defaults memory.recallTool on for every configured local tier", () => {
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

    // lite tier uses FTS-only recall and is on by default.
    const lite = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "memory", MONO_AGENT_MEMORY_MODE: "lite" },
    });
    expect(lite.memory?.recallTool).toEqual({ enabled: true });

    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "memory", MONO_AGENT_MEMORY_MODE: "journal" },
    })).toThrow(/requires an explicit memory\.embeddings/i);
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

    // Explicit on for lite remains accepted.
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

  it("fails closed when the remember flag is set without a memory path", () => {
    // Adjacent memory flags fail closed here; omitting this one let a declared
    // capability silently resolve to memory: undefined.
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED: "true" },
    })).toThrow(/MONO_AGENT_MEMORY_PATH/u);
  });

  it("defaults memory.rememberTool on for the bujo backend and off for supermemory", () => {
    const lite = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "memory", MONO_AGENT_MEMORY_MODE: "lite" },
    });
    expect(lite.memory?.rememberTool).toEqual({ enabled: true });

    // An external backend has no deterministic remember path to advertise.
    const supermemory = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "lite",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "https://api.supermemory.ai",
      },
    });
    expect(supermemory.memory?.rememberTool).toEqual({ enabled: false });
  });

  it("lets MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED override the rememberTool default in both directions", () => {
    const forcedOff = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "lite",
        MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED: "false",
      },
    });
    expect(forcedOff.memory?.rememberTool).toEqual({ enabled: false });

    const forcedOn = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory",
        MONO_AGENT_MEMORY_MODE: "lite",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "https://api.supermemory.ai",
        MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED: "true",
      },
    });
    expect(forcedOn.memory?.rememberTool).toEqual({ enabled: true });
  });

  it("rejects a non-boolean MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory",
          MONO_AGENT_MEMORY_MODE: "journal",
          ...journalMemoryPrerequisite,
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

  it("rejects memory.mode bujo when either prerequisite is omitted", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    })).toThrow(/requires an explicit memory\.embeddings/i);
  });

  it.each(["lite", "journal"] as const)(
    "rejects a partial memory.llm block in %s mode instead of silently dropping it",
    (mode) => {
      expect(() => loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          ...(mode === "journal" ? journalMemoryPrerequisite : {}),
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: mode,
          MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
          MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
        },
      })).toThrowError(expect.objectContaining({
        code: "invalid_env",
        details: expect.objectContaining({ env: "MONO_AGENT_MEMORY_MODE" }),
      }));
    },
  );

  it("rejects a partial BuJo memory.llm block when its model is missing", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
      },
    })).toThrowError(expect.objectContaining({
      code: "invalid_env",
      details: expect.objectContaining({ env: "MONO_AGENT_MEMORY_LLM_MODEL" }),
    }));
  });

  it("loads memory.llm from env when model is set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
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
        ...journalMemoryPrerequisite,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
    });

    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
    });
  });

  it("loads agent-host memory.llm timeoutMs when set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:opencode-go:kimi-k2.6",
        MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "120000",
      },
    });

    expect(config.memory?.llm).toMatchObject({
      provider: "agent-host",
      model: "pi:opencode-go:kimi-k2.6",
      timeoutMs: 120000,
    });
  });

  it("rejects memory.llm timeoutMs when the provider is not agent-host", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama",
          MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
          MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: "120000",
        },
      }),
    ).toThrow(/MONO_AGENT_MEMORY_LLM_TIMEOUT_MS is only valid when/u);
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

  it("rejects bujo when the memory LLM is unset", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    })).toThrow(/requires an explicit memory\.llm/i);
  });

  it("omits memory.llm.endpoint when only provider and model are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
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

  it("does not treat LM Studio as a memory LLM provider", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          ...journalMemoryPrerequisite,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "lmstudio",
          MONO_AGENT_MEMORY_LLM_MODEL: "chat-model",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_env" }));
  });

  it("loads memory.embeddings.dim from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...bujoMemoryPrerequisites,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "768",
      },
    });

    expect(config.memory?.embeddings?.dim).toBe(768);
  });

  it("loads LM Studio embeddings without requiring an API key", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
        MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: "http://localhost:1234",
      },
    });

    expect(config.memory?.embeddings).toEqual({
      provider: "lmstudio",
      model: "text-embedding-nomic-embed-text-v1.5",
      endpoint: "http://localhost:1234",
    });
  });

  it("preserves an unresolved LM Studio apiKeyEnv without treating its name as a key", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "embed-model",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
      },
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "lmstudio",
      model: "embed-model",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    });
    expect(config.memory?.embeddings?.apiKey).toBeUndefined();
  });

  it("does not substitute a generic literal when a declared LM Studio apiKeyEnv is unresolved", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "stale-provider-secret",
      },
    });

    expect(config.memory?.embeddings?.apiKeyEnv).toBe("LM_STUDIO_API_KEY");
    expect(config.memory?.embeddings?.apiKey).toBeUndefined();
  });

  it("does not let a generic literal satisfy an unresolved OpenAI apiKeyEnv", () => {
    expect(() => loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "OPENAI_EMBEDDINGS_KEY",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "stale-provider-secret",
      },
    })).toThrow(/openai memory embeddings require/u);
  });

  it("resolves an optional LM Studio apiKeyEnv when the named variable is set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "lmstudio",
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "embed-model",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "LM_STUDIO_API_KEY",
        LM_STUDIO_API_KEY: "resolved-token",
        MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "stale-provider-secret",
      },
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "lmstudio",
      apiKey: "resolved-token",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    });
  });

  it("omits embeddings.dim when the env is unset", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "journal",
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
        ...journalMemoryPrerequisite,
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

  it("loads memory.consolidation from env when enabled and cron are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...bujoMemoryPrerequisites,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "true",
        MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */2 * * *",
      },
    });

    expect(config.memory?.consolidation).toEqual({ enabled: true, cron: "0 */2 * * *" });
  });

  it("omits consolidation when neither enabled nor cron env vars are set", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...bujoMemoryPrerequisites,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
      },
    });

    expect(config.memory?.consolidation).toBeUndefined();
  });

  it("loads a consolidation block with only cron set (enabled omitted)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...bujoMemoryPrerequisites,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "30 */4 * * *",
      },
    });

    expect(config.memory?.consolidation).toEqual({ cron: "30 */4 * * *" });
    expect(config.memory?.consolidation?.enabled).toBeUndefined();
  });

  it("loads a consolidation block with only enabled set (cron omitted)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...bujoMemoryPrerequisites,
        MONO_AGENT_MEMORY_PATH: "memory-root",
        MONO_AGENT_MEMORY_MODE: "bujo",
        MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "false",
      },
    });

    expect(config.memory?.consolidation).toEqual({ enabled: false });
    expect(config.memory?.consolidation?.cron).toBeUndefined();
  });

  it("ignores removed reflection and migration env keys without requiring a memory path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
          MONO_AGENT_MEMORY_REFLECTION_CRON: "0 3 * * *",
          MONO_AGENT_MEMORY_MIGRATION_ENABLED: "true",
        },
      });

      expect(config.memory).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("MONO_AGENT_MEMORY_REFLECTION_ENABLED");
      expect(message).toContain("MONO_AGENT_MEMORY_REFLECTION_CRON");
      expect(message).toContain("MONO_AGENT_MEMORY_MIGRATION_ENABLED");
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts memory.writeMode 'capture' with mode 'bujo'", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        ...journalMemoryPrerequisite,
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

  it("defaults memory.backend to 'bujo' when a memory block is configured", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: { ...baseEnv, ...journalMemoryPrerequisite, MONO_AGENT_MEMORY_PATH: "./mem", MONO_AGENT_MEMORY_MODE: "journal" },
    });
    expect(config.memory?.backend).toBe("bujo");
    expect(config.memory?.supermemory).toBeUndefined();
  });

  it("loads the supermemory backend block from env", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:8080",
        MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: "agent-alpha",
        MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: "5000",
        MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER: "true",
      },
    });
    expect(config.memory?.backend).toBe("supermemory");
    expect(config.memory?.supermemory).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      container: "agent-alpha",
      timeoutMs: 5000,
      exposeMcpServer: true,
    });
    // External backend: recall defaults on (it always has search).
    expect(config.memory?.recallTool).toEqual({ enabled: true });
  });

  it("resolves the supermemory api key from apiKeyEnv (name persisted, value resolved)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "https://api.supermemory.ai",
        MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV: "MY_SM_KEY",
        MY_SM_KEY: "sm-secret",
      },
    });
    expect(config.memory?.supermemory).toMatchObject({
      baseUrl: "https://api.supermemory.ai",
      apiKey: "sm-secret",
      apiKeyEnv: "MY_SM_KEY",
    });
  });

  it("rejects backend 'supermemory' without a base URL", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "./mem", MONO_AGENT_MEMORY_BACKEND: "supermemory" },
      }),
    ).toThrow(/SUPERMEMORY_BASE_URL/);
  });

  it("rejects partial supermemory config without a base URL", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "./mem",
          MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: "agent-alpha",
        },
      }),
    ).toThrow(/SUPERMEMORY_BASE_URL/);
  });

  it("accepts memory.writeMode 'capture' for the supermemory backend regardless of mode", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:8080",
        MONO_AGENT_MEMORY_MODE: "lite",
        MONO_AGENT_MEMORY_WRITE_MODE: "capture",
      },
    });
    expect(config.memory?.writeMode).toBe("capture");
  });

  it("ignores stale bujo-only env (embeddings/llm) when backend is supermemory", () => {
    // Switching an existing bujo config to supermemory must not be blocked by leftover bujo env —
    // e.g. an openai embeddings provider with no API key would throw under the bujo backend.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_BACKEND: "supermemory",
          MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
          MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
          MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
          MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
          MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "false",
        },
      });
      expect(config.memory?.backend).toBe("supermemory");
      expect(config.memory?.embeddings).toBeUndefined();
      expect(config.memory?.llm).toBeUndefined();
      expect(config.memory?.consolidation).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("allows the supermemory backend without a memory path (path is bujo-only)", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      },
    });
    expect(config.memory?.backend).toBe("supermemory");
    expect(config.memory?.supermemory?.baseUrl).toBe("http://127.0.0.1:6767");
  });

  it("redacts the supermemory api key", () => {
    const config = loadMonoAgentConfig({
      cwd: "/repo",
      env: {
        ...baseEnv,
        MONO_AGENT_MEMORY_PATH: "./mem",
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "https://api.supermemory.ai",
        MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: "sm-plaintext-secret",
      },
    });
    const redacted = redactMonoAgentConfig(config);
    expect(redacted.memory?.supermemory).toMatchObject({
      baseUrl: "https://api.supermemory.ai",
      apiKey: { present: true, redacted: true },
    });
    expect(JSON.stringify(redacted)).not.toContain("sm-plaintext-secret");
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
            contentPatternRedaction: true,
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
        contentPatternRedaction: true,
        timeoutMs: 7000,
      },
    ]);
  });

  it("defaults the phoenix endpoint, timeout, and redaction opt-ins when omitted", () => {
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
      contentPatternRedaction: false,
      timeoutMs: 5000,
    });
  });

  it("rejects a non-boolean contentPatternRedaction value", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
            { type: "phoenix", contentPatternRedaction: "yes" },
          ]),
        },
      }),
    ).toThrow(/contentPatternRedaction/iu);
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

describe("loadMonoAgentConfig tools.allowedTools default", () => {
  it("defaults to allow-all (['*']) when MONO_AGENT_ALLOWED_TOOLS is unset", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv } });
    expect(config.tools.allowedTools).toEqual([ALLOW_ALL_TOOLS]);
    expect(ALLOW_ALL_TOOLS).toBe("*");
  });

  it("resolves an explicit empty MONO_AGENT_ALLOWED_TOOLS to [] (chat-only)", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_ALLOWED_TOOLS: "" } });
    expect(config.tools.allowedTools).toEqual([]);
  });

  it("resolves MONO_AGENT_ALLOWED_TOOLS='*' to ['*']", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_ALLOWED_TOOLS: "*" } });
    expect(config.tools.allowedTools).toEqual(["*"]);
  });

  it("resolves an explicit tool list unchanged", () => {
    const config = loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_ALLOWED_TOOLS: "Read,Bash" } });
    expect(config.tools.allowedTools).toEqual(["Read", "Bash"]);
  });
});

/**
 * `mono-agent migrate-config` was removed on the argument that hand-migration is safe
 * because the loader names the exact repair for every rejected value. For model
 * references that was false: the parser builds the replacement, the runtime adapter nests
 * it in `details.reason`, and config threw it away. Every operator surface — `doctor`,
 * `mono-agent validate`, `config --json`, startup — renders only `error.message`, so the
 * message is the only place a repair can actually reach a human.
 */
describe("rejected model references name their replacement in the message", () => {
  it("names openai-codex for a retired codex: primary", () => {
    try {
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "codex:gpt-5.6-sol" } });
      throw new Error("Expected codex:gpt-5.6-sol to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect((error as MonoAgentConfigError).code).toBe("invalid_model_reference");
      expect((error as MonoAgentConfigError).message).toContain("openai-codex:gpt-5.6-sol");
      expect((error as MonoAgentConfigError).message).toContain("codex:gpt-5.6-sol");
      // One framing sentence, not two: config unwraps the adapter's own generic wrapper
      // rather than nesting it inside its own.
      expect((error as MonoAgentConfigError).message).not.toContain("Invalid runtime model reference");
      expect((error as MonoAgentConfigError).details.reason).toBe(
        "codex is no longer a runtime backend; use openai-codex:gpt-5.6-sol",
      );
    }
  });

  it("names anthropic for a retired claude: primary", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "claude:claude-sonnet-4-6" } }),
    ).toThrow(/anthropic:claude-sonnet-4-6/u);
  });

  it("names the direct replacement for a retired vercel: primary", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "vercel:openai:gpt-5.5" } }),
    ).toThrow(/use openai:gpt-5\.5 directly/u);
  });

  it("names the surviving ACP bridge for a retired acp: primary", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "acp:some-agent" } }),
    ).toThrow(/mono-agent bridge acp/u);
  });

  it("names openai-codex for a retired codex: fallback route", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "codex:gpt-5.6-sol" }]),
        },
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("names openai-codex for a retired codex: subagent model", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
            enabled: true,
            definitions: [
              { name: "helper", description: "d", prompt: "p", model: "codex:gpt-5.6-sol" },
            ],
          }),
        },
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("names openai-codex for a retired codex: agent-host memory LLM", () => {
    expect(() =>
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_MEMORY_PATH: "memory-root",
          MONO_AGENT_MEMORY_MODE: "bujo",
          MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
          MONO_AGENT_MEMORY_LLM_MODEL: "codex:gpt-5.6-sol",
        },
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("still names the grammar for a reference with no structural separator", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "gpt-5.5" } }),
    ).toThrow(/expected <provider>:<model>/u);
  });

  it("still names the tier-alias repair", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: "anthropic:opus" } }),
    ).toThrow(/tier aliases are not valid model ids/u);
  });
});

/**
 * Hand-migration is only safe if one load names everything that still has to change.
 * Retired settings are the bulk of a 0.21.0 migration, so the loader reports all of them
 * at once rather than making the operator re-run the loader per key — and an env var's
 * repair has to be an env repair, not a pointer at a JSON key the operator does not have.
 */
describe("retired settings are reported completely and in the operator's own surface", () => {
  it("reports every retired env var in one load, not just the first", () => {
    try {
      loadMonoAgentConfig({
        cwd: "/repo",
        env: {
          ...baseEnv,
          MONO_AGENT_EXECUTION_MODE: "sdk",
          MONO_AGENT_ROUTE_SAFETY: "per-route-native",
          MONO_AGENT_FALLBACK_MODELS: "ollama:gemma4:31b",
          MONO_AGENT_MEMORY_LLM_EXECUTION_MODE: "sdk",
        },
      });
      throw new Error("Expected the retired env vars to be rejected.");
    } catch (error) {
      const message = (error as MonoAgentConfigError).message;
      expect(message).toContain("MONO_AGENT_EXECUTION_MODE");
      expect(message).toContain("MONO_AGENT_ROUTE_SAFETY");
      expect(message).toContain("MONO_AGENT_FALLBACK_MODELS");
      expect(message).toContain("MONO_AGENT_MEMORY_LLM_EXECUTION_MODE");
      expect((error as MonoAgentConfigError).details.envs).toEqual([
        "MONO_AGENT_EXECUTION_MODE",
        "MONO_AGENT_ROUTE_SAFETY",
        "MONO_AGENT_FALLBACK_MODELS",
        "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
      ]);
    }
  });

  it("names MONO_AGENT_FALLBACKS_JSON as the env re-expression of MONO_AGENT_FALLBACK_MODELS", () => {
    expect(() =>
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_FALLBACK_MODELS: "ollama:gemma4:31b" } }),
    ).toThrow(/MONO_AGENT_FALLBACKS_JSON/u);
  });

  it.each([
    "MONO_AGENT_EXECUTION_MODE",
    "MONO_AGENT_ROUTE_SAFETY",
    "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
  ] as const)("tells the operator to remove the variable %s, not a JSON key", (env) => {
    try {
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, [env]: "sdk" } });
      throw new Error(`Expected ${env} to be rejected.`);
    } catch (error) {
      const message = (error as MonoAgentConfigError).message;
      expect(message).toContain(env);
      expect(message).toMatch(/Remove the variable/u);
    }
  });
});

/**
 * Naming the rejected value is what tells an operator which field to open, so it stays. But a
 * model field takes arbitrary operator text -- a token, a key, a URL with credentials pasted
 * in by mistake -- and every one of these messages is rendered into the terminal, `doctor`,
 * the daemon log and launchd's captured stdout, which are durable and routinely shared. The
 * echo is therefore bounded, and the diagnostic surfaces are line-oriented, so a value must
 * not be able to forge lines that read as the loader's own.
 */
describe("echoed model references are bounded and cannot forge diagnostic lines", () => {
  const utf8 = (value: string): number => new TextEncoder().encode(value).length;
  const oversized = `codex:${"sk-live-AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD".repeat(12)}`;
  const forged = "codex:gpt-5.6-sol\n[ok]    Core config\n    Loaded mono-agent.config.json.";

  const messageOf = (env: Record<string, string | undefined>): string => {
    try {
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, ...env } });
    } catch (error) {
      if (error instanceof MonoAgentConfigError) return error.message;
      throw error;
    }
    throw new Error("Expected the model reference to be rejected.");
  };

  const paths = {
    primary: (model: string) => ({ MONO_AGENT_MODEL: model }),
    fallback: (model: string) => ({ MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model }]) }),
    subagent: (model: string) => ({
      MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({
        enabled: true,
        definitions: [{ name: "helper", description: "d", prompt: "p", model }],
      }),
    }),
    memoryLlm: (model: string) => ({
      MONO_AGENT_MEMORY_PATH: "memory-root",
      MONO_AGENT_MEMORY_MODE: "bujo",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
      MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
      MONO_AGENT_MEMORY_LLM_MODEL: model,
    }),
  } as const;
  const pathNames = Object.keys(paths) as (keyof typeof paths)[];

  it.each(pathNames)("keeps the replacement guidance for a normal bad ref on the %s path", (path) => {
    const message = messageOf(paths[path]("codex:gpt-5.6-sol"));
    expect(message).toContain("`codex:gpt-5.6-sol`");
    expect(message).toContain("use openai-codex:gpt-5.6-sol");
  });

  it.each(pathNames)("bounds an oversized value on the %s path", (path) => {
    const message = messageOf(paths[path](oversized));
    expect(utf8(oversized)).toBe(486);
    // Both halves are bounded: the echo of the operator's value and the parser's derived
    // repair, which interpolates that same value a second time.
    expect(utf8(message)).toBeLessThan(utf8(oversized));
    expect(message).toContain("…");
    expect(message).not.toContain(oversized);
    // The actionable half survives the bound.
    expect(message).toContain("use openai-codex:sk-live-AAAA");
  });

  it.each(pathNames)("escapes an embedded newline on the %s path", (path) => {
    const message = messageOf(paths[path](forged));
    expect(message).not.toContain("\n");
    expect(message.split("\n")).toHaveLength(1);
    expect(message).toContain("\\n[ok]    Core config");
  });

  it("bounds details.reason too, not only the rendered message", () => {
    try {
      loadMonoAgentConfig({ cwd: "/repo", env: { ...baseEnv, MONO_AGENT_MODEL: oversized } });
      throw new Error("Expected the model reference to be rejected.");
    } catch (error) {
      const details = (error as MonoAgentConfigError).details;
      expect(utf8(details.reason as string)).toBeLessThanOrEqual(224);
      expect(details.reason).not.toContain("\n");
    }
  });
});
