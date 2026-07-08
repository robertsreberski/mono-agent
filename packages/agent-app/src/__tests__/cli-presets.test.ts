import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs, renderPresetList, renderPresetShow } from "../cli.js";
import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder } from "../init.js";
import { answersFromCli } from "../wizard/from-flags.js";
import { findPreset, presetAnswers, presetIds } from "../wizard/presets.js";

describe("parseCliArgs preset flags & alias normalization", () => {
  it("collects positionals for `presets show <id>`", () => {
    expect(parseCliArgs(["presets", "show", "code-sandbox"])).toMatchObject({
      command: "presets",
      positionals: ["show", "code-sandbox"],
    });
  });

  it("parses init --preset --with --dry-run", () => {
    expect(parseCliArgs(["init", "--preset", "telegram-assistant", "--with", "slack,cron", "--dry-run"])).toMatchObject({
      command: "init",
      preset: "telegram-assistant",
      withChannels: ["slack", "cron"],
      dryRun: true,
    });
  });

  it("parses init --yes", () => {
    expect(parseCliArgs(["init", "--yes"])).toMatchObject({ command: "init", yes: true });
    // Without --yes there is no `yes` key (conditional spread).
    expect(parseCliArgs(["init"]).yes).toBeUndefined();
  });

  it("parses validate --preset", () => {
    expect(parseCliArgs(["validate", "--preset", "code-sandbox"])).toMatchObject({
      command: "validate",
      preset: "code-sandbox",
    });
  });

  it("normalizes `setup` to `init`", () => {
    expect(parseCliArgs(["setup", "--preset", "starter"])).toMatchObject({ command: "init", preset: "starter" });
  });

  it("normalizes `recipes` to `presets`", () => {
    expect(parseCliArgs(["recipes", "show", "starter"])).toMatchObject({
      command: "presets",
      positionals: ["show", "starter"],
    });
  });

  it("keeps --recipe as a deprecated alias flag", () => {
    expect(parseCliArgs(["init", "--recipe", "minimal-webhook"])).toMatchObject({
      command: "init",
      recipe: "minimal-webhook",
    });
  });
});

describe("answersFromCli", () => {
  it("unions --with channels onto the preset channels and recomputes tools", () => {
    const answers = answersFromCli({ presetId: "telegram-assistant", withChannels: ["slack"] });
    expect(answers.channels).toContain("channel:telegram");
    expect(answers.channels).toContain("channel:slack");
    expect(answers.allowedTools).toContain("TelegramSendMessage");
    expect(answers.allowedTools).toContain("SlackSendMessage");
    // The read-only safe defaults are always present.
    expect(answers.allowedTools).toContain("Read");
  });

  it("maps --memory to a module id and lets --model override the preset model", () => {
    const answers = answersFromCli({ presetId: "local-private", model: "codex:gpt-5.5", memory: "lite" });
    expect(answers.model).toBe("codex:gpt-5.5");
    expect(answers.memory).toBe("memory:lite");
  });

  it("defaults to the webhook channel with no preset and no flags", () => {
    expect(answersFromCli({}).channels).toEqual(["channel:webhook"]);
  });
});

describe("renderPresetList", () => {
  it("lists every catalog preset id and the scaffold hint", () => {
    const out = renderPresetList();
    for (const id of presetIds()) {
      expect(out).toContain(id);
    }
    expect(out).toContain("mono-agent init --preset");
  });
});

describe("renderPresetShow", () => {
  it("includes the composed sandbox config for code-sandbox", () => {
    const out = renderPresetShow(findPreset("code-sandbox")!);
    expect(out).toContain("Generated mono-agent.config.json");
    expect(out).toContain(MONO_AGENT_CONFIG_SCHEMA_URL);
    expect(out).toContain("\"sandbox\"");
    expect(out).toContain("\"fail-closed\"");
    expect(out).toContain("Follow-up checklist");
  });

  it("includes the .env.example and never inlines the secret token", () => {
    const out = renderPresetShow(findPreset("telegram-assistant")!);
    expect(out).toContain(".env.example");
    expect(out).toContain("MONO_AGENT_TELEGRAM_TOKEN");
    expect(out).not.toMatch(/"telegramToken"\s*:/u);
  });
});

describe("init --preset --dry-run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mono-agent-init-preset-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("plans the telegram preset's config + .env.example without writing anything", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("telegram-assistant")!),
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.created.some((path) => path.endsWith("mono-agent.config.json"))).toBe(true);
    expect(result.created.some((path) => path.endsWith(".env.example"))).toBe(true);
    // Nothing was actually written.
    expect(await readdir(dir)).toEqual([]);
    expect(existsSync(join(dir, "mono-agent.config.json"))).toBe(false);
  });
});
