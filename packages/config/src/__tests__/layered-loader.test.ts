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
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
        context: { identityPath: "IDENTITY.md", selectedSkills: ["a", "b"] },
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
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("12");
    expect(layered.MONO_AGENT_IDENTITY_PATH).toBe("IDENTITY.md");
    expect(layered.MONO_AGENT_SELECTED_SKILLS).toBe("a,b");
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
});
