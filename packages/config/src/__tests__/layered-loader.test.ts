import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MonoAgentConfigError } from "../config.js";
import { loadMonoAgentConfig } from "../layered-loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-layer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: unknown, name = "mono-agent.config.json"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(json), "utf8");
  return path;
}

const base = {
  runtime: { model: "openai-codex:gpt-5.5" },
  context: { identityPath: "IDENTITY.md" },
};

describe("loadMonoAgentConfig JSON diagnostics", () => {
  it("attributes missing required fields to JSON paths", async () => {
    const path = await writeConfig({});
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "runtime.model" },
    });
  });

  it("attributes strict Journal prerequisites to the JSON path that needs repair", async () => {
    const path = await writeConfig({
      ...base,
      memory: { mode: "journal", path: ".mono-agent/memory" },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.embeddings"),
      details: { path: "memory.embeddings", code: "invalid_json" },
    });
  });

  it("attributes strict BuJo LLM prerequisites to the JSON path that needs repair", async () => {
    const path = await writeConfig({
      ...base,
      memory: { mode: "bujo", path: ".mono-agent/memory", embeddings: { provider: "ollama" } },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.llm"),
      details: { path: "memory.llm", code: "invalid_json" },
    });
  });

  it.each([
    ["provider", { provider: "ollama" }],
    ["endpoint", { endpoint: "http://localhost:11434" }],
    ["trace", { trace: false }],
    ["timeoutMs", { timeoutMs: 120_000 }],
    ["provider and endpoint", { provider: "ollama", endpoint: "http://localhost:11434" }],
  ])("rejects a BuJo JSON memory.llm block with only %s", async (_name, llm) => {
    const path = await writeConfig({
      ...base,
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm,
      },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.llm"),
      details: { path: "memory.llm.model", code: "invalid_json" },
    });
  });

  it("rejects active legacy observability JSON with the JSON path", async () => {
    const path = await writeConfig({
      observability: {
        exporters: [{ type: "phoenix", headers: { authorization: "Bearer secret-token" } }],
      },
    });
    try {
      await loadMonoAgentConfig({ cwd: dir, jsonPath: path });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_json", details: { path: "observability" } });
      expect(String(error)).toContain("observability.exporters");
      expect(String(error)).not.toContain("secret-token");
      return;
    }
    throw new Error("Expected active legacy JSON to fail.");
  });

  it("accepts the narrow empty observability compatibility shapes", async () => {
    for (const observability of [{}, { exporters: [] }]) {
      const path = await writeConfig(
        { ...base, observability },
        `config-${JSON.stringify(observability).length}.json`,
      );
      await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).resolves.not.toHaveProperty(
        "observability",
      );
    }
  });

  it("rejects a string promptCacheDiagnostics with the JSON boolean message", async () => {
    const path = await writeConfig({
      ...base,
      providers: { piNative: { promptCacheDiagnostics: "true" } },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toThrow(
      "providers.piNative.promptCacheDiagnostics must be a boolean.",
    );
  });

  it("rejects the retired Hound endpoint with the JSON path", async () => {
    const path = await writeConfig({
      ...base,
      tools: { web: { search: { backend: "hound", hound: { endpoint: "retired" } } } },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toThrow(
      /tools\.web\.search\.hound\.endpoint.*was removed/,
    );
  });

  it("attributes a public custom Ollama origin to its JSON trust path", async () => {
    const path = await writeConfig({
      ...base,
      tools: {
        web: { search: { backend: "ollama", ollama: { baseUrl: "https://search.example.com" } } },
      },
    });
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toThrow(
      /tools\.web\.search\.ollama\.trustPublicUrl/u,
    );
  });
});

describe("JSON-sourced runtime failures name the JSON path, not an env var", () => {
  const failureOf = async (json: unknown): Promise<MonoAgentConfigError> => {
    const path = await writeConfig(json);
    try {
      await loadMonoAgentConfig({ cwd: dir, jsonPath: path });
    } catch (error) {
      if (error instanceof MonoAgentConfigError) return error;
      throw error;
    }
    throw new Error("Expected the layered load to fail.");
  };

  const fileBase = { context: { identityPath: "IDENTITY.md" } };

  it.each([
    [
      "runtime.model",
      { ...fileBase, runtime: { model: "codex:gpt-5.6-sol" } },
      "MONO_AGENT_MODEL",
      "runtime.model",
    ],
    [
      "runtime.fallbacks[0].model",
      {
        ...fileBase,
        runtime: { model: "openai-codex:gpt-5.5", fallbacks: [{ model: "codex:gpt-5.6-sol" }] },
      },
      "MONO_AGENT_FALLBACKS_JSON",
      "runtime.fallbacks[0].model",
    ],
    [
      "subagents",
      {
        ...fileBase,
        runtime: { model: "openai-codex:gpt-5.5" },
        subagents: {
          enabled: true,
          definitions: [{ name: "helper", description: "d", prompt: "p", model: "codex:gpt-5.6-sol" }],
        },
      },
      "subagents",
      "subagents",
    ],
  ])("attributes a rejected %s to the file", async (path, json, source, detailPath) => {
    const error = await failureOf(json);
    expect(error.code).toBe("invalid_model_reference");
    expect(error.details.path).toBe(detailPath);
    expect(error.details.env).toBeUndefined();
    expect(error.message).toContain(path);
    if (source !== path) expect(error.message).not.toContain(source);
    expect(error.message).toContain("use openai-codex:gpt-5.6-sol");
  });

  it("attributes a hosted Ollama block's missing apiKeyEnv to its JSON path", async () => {
    const error = await failureOf({
      ...fileBase,
      runtime: { model: "openai-codex:gpt-5.5" },
      tools: {
        web: {
          search: {
            backend: "ollama",
            ollama: { baseUrl: "https://ollama.com" },
          },
        },
      },
    });
    expect(error.code).toBe("invalid_json");
    expect(error.details.path).toBe("tools.web.search.ollama.apiKeyEnv");
    expect(error.details.env).toBeUndefined();
    expect(error.message).toContain("tools.web.search.ollama.apiKeyEnv");
    expect(error.message).not.toContain("MONO_AGENT_WEB_SEARCH_OLLAMA_API_KEY_ENV");
  });

  it("bounds and escapes a JSON-sourced value the same way the env path does", async () => {
    const error = await failureOf({
      ...fileBase,
      runtime: { model: "codex:gpt-5.6-sol\n[ok]    Core config" },
    });
    expect(error.message.split("\n")).toHaveLength(1);
    expect(error.message).toContain("runtime.model `codex:gpt-5.6-sol\\n[ok]    Core config`");
  });
});

describe("JSON attribution rewrites the diagnostic's subject, never the operator's value", () => {
  const failureOf = async (json: unknown): Promise<MonoAgentConfigError> => {
    const path = await writeConfig(json);
    try {
      await loadMonoAgentConfig({ cwd: dir, jsonPath: path });
    } catch (error) {
      if (error instanceof MonoAgentConfigError) return error;
      throw error;
    }
    throw new Error("Expected the layered load to fail.");
  };

  const fileBase = { context: { identityPath: "IDENTITY.md" } };

  it.each([
    [
      "runtime.model",
      { ...fileBase, runtime: { model: "codex:MONO_AGENT_MODEL" } },
      "codex:MONO_AGENT_MODEL",
    ],
    [
      "runtime.fallbacks[0].model",
      {
        ...fileBase,
        runtime: {
          model: "openai-codex:gpt-5.5",
          fallbacks: [{ model: "codex:MONO_AGENT_FALLBACKS_JSON" }],
        },
      },
      "codex:MONO_AGENT_FALLBACKS_JSON",
    ],
    [
      "subagents",
      {
        ...fileBase,
        runtime: { model: "openai-codex:gpt-5.5" },
        subagents: {
          enabled: true,
          definitions: [
            { name: "helper", description: "d", prompt: "p", model: "codex:MONO_AGENT_SUBAGENTS_JSON" },
          ],
        },
      },
      "codex:MONO_AGENT_SUBAGENTS_JSON",
    ],
    [
      "memory.llm.model",
      {
        ...fileBase,
        runtime: { model: "openai-codex:gpt-5.5" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
          llm: { provider: "agent-host", model: "codex:MONO_AGENT_MEMORY_LLM_MODEL" },
        },
      },
      "codex:MONO_AGENT_MEMORY_LLM_MODEL",
    ],
  ])("leaves a %s value that spells its own env var intact", async (path, json, value) => {
    const error = await failureOf(json);

    expect(error.details.path).toBe(path);
    expect(error.message.startsWith(path)).toBe(true);
    expect(error.message).toContain(`\`${value}\``);
    expect(error.message).toContain(`use openai-${value}`);
  });

  it("still re-attributes a source named mid-sentence", async () => {
    const error = await failureOf({
      ...fileBase,
      runtime: { model: "openai-codex:gpt-5.5" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { provider: "openai", model: "text-embedding-3-small" },
      },
    });

    expect(error.details.path).toBe("memory.embeddings.apiKey");
    expect(error.message).toBe(
      "openai memory embeddings require memory.embeddings.apiKey or memory.embeddings.apiKeyEnv.",
    );
  });

  it("leaves a value that contains a backtick intact", async () => {
    const value = "codex:a`MONO_AGENT_MODEL";
    const error = await failureOf({ ...fileBase, runtime: { model: value } });

    expect(error.details.path).toBe("runtime.model");
    expect(error.message).toContain(`\`${value}\``);
    expect(error.message).toContain(`use openai-${value}`);
    expect(error.message).not.toContain("codex:a`runtime.model");
  });

  it("still strips the env var when it is only the subject", async () => {
    const error = await failureOf({ ...fileBase, runtime: { model: "codex:gpt-5.6-sol" } });

    expect(error.message.startsWith("runtime.model ")).toBe(true);
    expect(error.message).not.toContain("MONO_AGENT_MODEL");
  });
});

describe("retired settings compatibility", () => {
  it("loads and ignores legacy monitors blocks with at most one warning per resolved config path", async () => {
    const jsonPath = join(dir, "mono-agent.config.json");
    const config = { runtime: { model: "pi:openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" } };
    await writeFile(jsonPath, JSON.stringify(config));
    const baseline = await loadMonoAgentConfig({ cwd: dir, jsonPath });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(jsonPath, JSON.stringify({ ...config, monitors: { enabled: true, maxActive: 999 } }));
      expect(await loadMonoAgentConfig({ cwd: dir, jsonPath })).toEqual(baseline);
      expect(await loadMonoAgentConfig({ cwd: dir, jsonPath: `${dir}/./mono-agent.config.json` })).toEqual(
        baseline,
      );
      expect(await loadMonoAgentConfig({ cwd: dir, jsonPath })).toEqual(baseline);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring deprecated monitors config"));
      const secondPath = join(dir, "second.config.json");
      await writeFile(secondPath, JSON.stringify({ ...config, monitors: { unknownNestedKey: true } }));
      expect(
        await loadMonoAgentConfig({ cwd: dir, jsonPath: secondPath, warnOnDeprecatedConfig: false }),
      ).toEqual(baseline);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await loadMonoAgentConfig({ cwd: dir, jsonPath: secondPath })).toEqual(baseline);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("JSON-only public loader", () => {
  it("attributes missing required fields to JSON paths", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, "{}", "utf8");
    await expect(loadMonoAgentConfig({ cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "runtime.model" },
    });
  });

  it("silently ignores representative active and retired MONO_AGENT config variables", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "openai-codex:gpt-5.6-sol", maxTurns: 7 },
        context: { identityPath: "IDENTITY.md" },
        providers: { piAuthPath: ".pi/auth.json" },
      }),
      "utf8",
    );

    const stale: Record<string, string> = {
      MONO_AGENT_MODEL: "anthropic:ignored",
      MONO_AGENT_MAX_TURNS: "99",
      MONO_AGENT_IDENTITY_PATH: "IGNORED.md",
      MONO_AGENT_PI_AUTH_PATH: "/ignored/auth.json",
      MONO_AGENT_PERMISSION_MODE: "ignored-retired-value",
    };
    const saved: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(stale)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    try {
      const config = await loadMonoAgentConfig({ cwd: dir, jsonPath: path });
      expect(config.runtime.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.6-sol" });
      expect(config.runtime.maxTurns).toBe(7);
      expect(config.context.identityPath).toBe(join(dir, "IDENTITY.md"));
      expect(config.providers?.piAuthPath).toBe(join(dir, ".pi/auth.json"));
    } finally {
      for (const name of Object.keys(stale)) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});
