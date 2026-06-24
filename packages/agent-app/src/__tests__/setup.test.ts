import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initMonoAgentFolder } from "../init.js";
import { findRecipe } from "../recipes/index.js";
import { collectSetupOptions, type SetupPromptSource } from "../setup.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-setup-"));
  tempDirs.push(dir);
  return dir;
}

function stubPrompt(answers: readonly string[]): SetupPromptSource {
  const queue = [...answers];
  return {
    async question() {
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error("No stubbed prompt answer left.");
      }
      return answer;
    },
  };
}

describe("collectSetupOptions", () => {
  it("maps prompted non-secret inputs into recipe config and keeps secrets out of JSON", async () => {
    const recipe = findRecipe("personal-telegram-bujo");
    expect(recipe).toBeDefined();

    const collected = await collectSetupOptions({
      prompt: stubPrompt(["codex:gpt-5.5", "12345,67890", "pi:ollama:gemma4:31b", "slack,cron"]),
      recipe: recipe!,
    });

    expect(collected.recipeInputs).toMatchObject({
      model: "codex:gpt-5.5",
      allowedChatIds: "12345,67890",
    });
    expect(collected.secrets).toEqual([
      expect.objectContaining({ id: "telegramToken", envVar: "MONO_AGENT_TELEGRAM_TOKEN" }),
    ]);

    const dir = await tempDir();
    const result = await initMonoAgentFolder({
      dir,
      recipe: collected.recipe,
      recipeInputs: collected.recipeInputs,
      fallbackModels: collected.fallbackModels,
      withChannels: collected.withChannels,
    });

    const configText = await readFile(result.configPath, "utf8");
    const config = JSON.parse(configText);
    expect(config.runtime.model).toBe("codex:gpt-5.5");
    expect(config.runtime.fallbackModels).toEqual(["pi:ollama:gemma4:31b"]);
    expect(config.telegram.allowedChatIds).toEqual(["12345", "67890"]);
    expect(config.slack.enabled).toBe(true);
    expect(config.cron.enabled).toBe(true);
    expect(configText).not.toContain("MONO_AGENT_TELEGRAM_TOKEN");
    expect(configText).not.toContain("telegramToken");
  });

  it("uses --model as the default model answer", async () => {
    const recipe = findRecipe("minimal-webhook");
    const collected = await collectSetupOptions({
      prompt: stubPrompt(["", "", ""]),
      recipe: recipe!,
      model: "pi:ollama:gemma4:31b",
      fallbackModels: ["codex:gpt-5.5"],
    });

    expect(collected.recipeInputs.model).toBe("pi:ollama:gemma4:31b");
    expect(collected.fallbackModels).toEqual(["codex:gpt-5.5"]);
    expect(collected.withChannels).toEqual([]);
  });
});

describe("initMonoAgentFolder recipeInputs", () => {
  it("defensively drops secret recipe inputs before writing generated files", async () => {
    const recipe = findRecipe("personal-telegram-bujo");
    const dir = await tempDir();
    const result = await initMonoAgentFolder({
      dir,
      recipe: recipe!,
      recipeInputs: {
        allowedChatIds: "12345",
        telegramToken: "secret-token-should-not-appear",
      },
    });

    const configText = await readFile(result.configPath, "utf8");
    const envExampleText = await readFile(join(dir, ".env.example"), "utf8");
    expect(configText).toContain("12345");
    expect(configText).not.toContain("secret-token-should-not-appear");
    expect(envExampleText).toContain("MONO_AGENT_TELEGRAM_TOKEN=");
    expect(envExampleText).not.toContain("secret-token-should-not-appear");
  });
});
