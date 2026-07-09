import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder } from "../init.js";
import { defaultAnswers } from "../wizard/answers.js";
import { findPreset, presetAnswers } from "../wizard/presets.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("initMonoAgentFolder", () => {
  it("scaffolds the default config, identity, and working dirs in an empty folder", async () => {
    const result = await initMonoAgentFolder({ dir });

    expect(result.created).toContain(result.configPath);
    expect(result.created).toContain(result.identityPath);
    expect(result.knowledgeFiles).toEqual([]);
    expect(result.plan.configJson).toBeDefined();

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.$schema).toBe(MONO_AGENT_CONFIG_SCHEMA_URL);
    expect(config.runtime.model).toBe("pi:openai-codex:gpt-5.5");
    expect(config.runtime.maxTurns).toBeUndefined();
    expect(config.context.identityPath).toBe("./IDENTITY.md");
    expect(config.webhook.enabled).toBe(true);
    expect(config.memory).toBeUndefined();
    // Deliberate behavior change: the default scaffold now allows all tools (`["*"]`).
    expect(config.tools.allowedTools).toEqual(["*"]);

    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("# Identity");
  });

  it("composes the supplied answers (model + extra channels)", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({
        model: "pi:ollama:gemma4:31b",
        channels: ["channel:webhook", "channel:slack", "channel:cron"],
      }),
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.model).toBe("pi:ollama:gemma4:31b");
    expect(config.slack).toEqual({ enabled: true });
    expect(config.cron).toEqual({ enabled: true });
  });

  it("writes fallback models, effort, and memory when the answers request them", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({
        model: "claude:claude-sonnet-4-6",
        effort: "medium",
        fallbackModels: ["pi:ollama:gemma4:31b"],
        memory: "memory:journal",
      }),
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.fallbackModels).toEqual(["pi:ollama:gemma4:31b"]);
    expect(config.runtime.effort).toBe("medium");
    expect(config.memory).toMatchObject({ mode: "journal", path: "./.mono-agent/memory" });
  });

  it("writes lite and bujo memory blocks with a directory path", async () => {
    const bujo = await initMonoAgentFolder({ dir, answers: defaultAnswers({ memory: "memory:bujo" }) });
    const bujoConfig = JSON.parse(await readFile(bujo.configPath, "utf8"));
    expect(bujoConfig.memory).toMatchObject({ mode: "bujo" });
    expect(bujoConfig.memory.path).toContain(".mono-agent/memory");
  });

  it("references existing knowledge files in the generated identity", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.knowledgeFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("`AGENTS.md`");
    expect(identity).toContain("`CLAUDE.md`");
  });

  it("writes a telegram preset's .env.example with the token placeholder, never in JSON", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("telegram-assistant")!),
    });

    expect(result.plan.envExample).toContain("MONO_AGENT_TELEGRAM_TOKEN");
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toContain("MONO_AGENT_TELEGRAM_TOKEN=");
    const configText = await readFile(result.configPath, "utf8");
    expect(configText).not.toContain("telegramToken");
  });

  it("never overwrites existing files", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "codex:gpt-5.5" } }));
    await writeFile(join(dir, "IDENTITY.md"), "# Mine\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.skipped).toContain(configPath);
    expect(result.skipped).toContain(result.identityPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.model).toBe("codex:gpt-5.5");
    expect(await readFile(result.identityPath, "utf8")).toBe("# Mine\n");
  });
});
