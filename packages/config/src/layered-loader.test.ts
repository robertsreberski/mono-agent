import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMonoAgentConfigWithSources, layerJsonOntoEnv } from "./layered-loader.js";

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
        telegram: { botToken: "abc", allowedChatIds: ["111", "222"] },
        context: { identityPath: "IDENTITY.md", selectedSkills: ["a", "b"] },
        tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
      },
      {},
    );
    expect(layered.MONO_AGENT_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("12");
    expect(layered.MONO_AGENT_TELEGRAM_BOT_TOKEN).toBe("abc");
    expect(layered.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS).toBe("111,222");
    expect(layered.MONO_AGENT_IDENTITY_PATH).toBe("IDENTITY.md");
    expect(layered.MONO_AGENT_SELECTED_SKILLS).toBe("a,b");
    expect(layered.MONO_AGENT_ALLOWED_TOOLS).toBe("Read");
    expect(layered.MONO_AGENT_DISALLOWED_TOOLS).toBe("Bash");
  });

  it("lets env override JSON values", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { maxTurns: 4 } },
      { MONO_AGENT_MAX_TURNS: "16" },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("16");
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
        telegram: { botToken: "json-token", allowedChatIds: ["111"] },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: {},
      cwd: dir,
      jsonPath: path,
    });
    expect(config.telegram.botToken).toBe("json-token");
    expect(config.runtime.maxTurns).toBe(12);
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("env beats JSON for overlapping fields", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 4 },
        telegram: { botToken: "json-token", allowedChatIds: ["111"] },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MAX_TURNS: "20", MONO_AGENT_TELEGRAM_BOT_TOKEN: "env-token" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.runtime.maxTurns).toBe(20);
    expect(config.telegram.botToken).toBe("env-token");
  });

  it("works without a jsonPath (pure env loader behavior)", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "abc",
        MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "111",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
    });
    expect(config.telegram.botToken).toBe("abc");
  });

  it("treats a missing JSON file as an empty layer", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "abc",
        MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "111",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
      jsonPath: join(dir, "absent.json"),
    });
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });
});
