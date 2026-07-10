import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder, mergeSecretEnvFile } from "../init.js";
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
    expect(config.runtime.model).toBe("codex:gpt-5.6-terra");
    expect(config.runtime.maxTurns).toBeUndefined();
    expect(config.context.identityPath).toBe("./IDENTITY.md");
    expect(config.context).toMatchObject({
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-configure", "mono-agent-memory"],
      skillDisclosure: "index",
    });
    expect(config.webhook.enabled).toBe(true);
    expect(config.memory).toBeUndefined();
    // Deliberate behavior change: the default scaffold now allows all tools (`["*"]`).
    expect(config.tools.allowedTools).toEqual(["*"]);

    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("# Identity");
    expect(identity).toContain("You are Agent App Init");
    expect(identity).toContain("Help the operator work effectively in this folder.");
  });

  it("composes the supplied answers (model + extra channels)", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({
        name: "Atlas",
        purpose: "Coordinate research for this project.",
        model: "pi:ollama:gemma4:31b",
        channels: ["channel:webhook", "channel:slack", "channel:cron"],
      }),
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.model).toBe("pi:ollama:gemma4:31b");
    expect(config.agent).toEqual({ name: "Atlas" });
    expect(config.slack).toEqual({ enabled: true });
    expect(config.cron).toEqual({ dir: "cron" });
    expect(await readFile(result.identityPath, "utf8")).toContain("You are Atlas, a mono agent");
    expect(await readFile(result.identityPath, "utf8")).toContain("Coordinate research for this project.");
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
    expect(config.runtime.fallbacks).toEqual([{
      model: "pi:ollama:gemma4:31b",
      effort: "medium",
    }]);
    expect(config.runtime.fallbackModels).toBeUndefined();
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

    expect(result.plan.envExample).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN");
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN=");
    const configText = await readFile(result.configPath, "utf8");
    expect(configText).not.toContain("telegramToken");
  });

  it("never overwrites existing files", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "codex:gpt-5.6-terra" } }));
    await writeFile(join(dir, "IDENTITY.md"), "# Mine\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.skipped).toContain(configPath);
    expect(result.skipped).toContain(result.identityPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.model).toBe("codex:gpt-5.6-terra");
    expect(await readFile(result.identityPath, "utf8")).toBe("# Mine\n");
  });

  it("refuses to write generated capability files through a symlinked parent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-init-outside-"));
    try {
      await symlink(outside, join(dir, "cron"));
      const answers = defaultAnswers({
        channels: ["channel:cron"],
        moduleInputs: { "channel:cron": { cronExpression: "0 8 * * *" } },
      });

      await expect(initMonoAgentFolder({ dir, answers })).rejects.toThrow(
        /Refusing to create scaffold artifact through symbolic-link parent/u,
      );
      await expect(access(join(outside, "digest.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to create working directories through a symlinked scaffold parent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-workspace-outside-"));
    try {
      await symlink(outside, join(dir, ".mono-agent"));

      await expect(initMonoAgentFolder({ dir })).rejects.toThrow(
        /Refusing to create scaffold artifact through symbolic-link parent/u,
      );
      await expect(access(join(outside, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(outside, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("merges required secrets into a private env file without replacing existing values or comments", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "# retain me\nMONO_AGENT_TELEGRAM_BOT_TOKEN=already-set\nMONO_AGENT_SLACK_BOT_TOKEN=\n");
    await mergeSecretEnvFile(envPath, {
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "replacement-must-not-win",
      MONO_AGENT_SLACK_BOT_TOKEN: "new-value",
    });
    const env = await readFile(envPath, "utf8");
    expect(env).toContain("# retain me");
    expect(env).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN=already-set");
    expect(parseEnv(env).MONO_AGENT_SLACK_BOT_TOKEN).toBe("new-value");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("/.env\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("reports secret persistence precisely without claiming a dry-run write", async () => {
    const result = await initMonoAgentFolder({
      dir,
      dryRun: true,
      secretValues: { MONO_AGENT_SLACK_BOT_TOKEN: "not-written" },
    });

    expect(result.secretsPersisted).toBe(false);
    expect(result.secretPersistence).toMatchObject({ status: "planned", changed: true });
    expect(result.changes).toContainEqual({ path: join(dir, ".env"), kind: "planned-create", sensitive: true });
    await expect(readFile(join(dir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
