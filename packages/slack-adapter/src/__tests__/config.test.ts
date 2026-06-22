import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSlackAdapterConfig,
  redactSlackAdapterConfig,
  SlackAdapterConfigError,
} from "../config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-slack-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSlackAdapterConfig", () => {
  it("loads adapter-owned Slack settings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111", "C222"],
          botUserIds: ["Ubot"],
          mentionTextAliases: ["@mono"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config).toEqual({
      enabled: true,
      botToken: "json-bot-token",
      appToken: "json-app-token",
      allowedChannelIds: ["D111", "C222"],
      allowAllChannels: false,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stripMentionText: true,
    });
  });

  it("lets env override JSON and supports explicit allow-all", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["C111"],
          stripMentionText: true,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({
      env: {
        MONO_AGENT_SLACK_ENABLED: "true",
        MONO_AGENT_SLACK_BOT_TOKEN: "env-bot-token",
        MONO_AGENT_SLACK_APP_TOKEN: "env-app-token",
        MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS: "",
        MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true",
        MONO_AGENT_SLACK_BOT_USER_IDS: "U1, U2",
        MONO_AGENT_SLACK_MENTION_TEXT_ALIASES: "@agent, Assistant",
        MONO_AGENT_SLACK_STRIP_MENTION_TEXT: "false",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      botToken: "env-bot-token",
      appToken: "env-app-token",
      allowedChannelIds: [],
      allowAllChannels: true,
      botUserIds: ["U1", "U2"],
      mentionTextAliases: ["@agent", "Assistant"],
      stripMentionText: false,
    });
  });

  it("requires tokens and an explicit allowlist or allow-all choice when enabled", async () => {
    await expect(
      loadSlackAdapterConfig({ env: { MONO_AGENT_SLACK_ENABLED: "true", MONO_AGENT_SLACK_BOT_TOKEN: "bot-token" } }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);

    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_ENABLED: "true",
          MONO_AGENT_SLACK_BOT_TOKEN: "bot-token",
          MONO_AGENT_SLACK_APP_TOKEN: "app-token",
        },
      }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);
  });

  it("is disabled by default and skips credential validation", async () => {
    const config = await loadSlackAdapterConfig({ env: {} });
    expect(config).toEqual({
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds: [],
      allowAllChannels: false,
      botUserIds: [],
      mentionTextAliases: [],
      stripMentionText: false,
    });
  });

  it("rejects invalid booleans", async () => {
    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_BOT_TOKEN: "bot-token",
          MONO_AGENT_SLACK_APP_TOKEN: "app-token",
          MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "sometimes",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactSlackAdapterConfig", () => {
  it("redacts tokens and reports identifiers only by count", () => {
    const redacted = redactSlackAdapterConfig({
      enabled: true,
      botToken: "redacted-bot-token",
      appToken: "redacted-app-token",
      allowedChannelIds: ["D111", "C222"],
      allowAllChannels: false,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stripMentionText: true,
    });

    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(JSON.stringify(redacted)).not.toContain("D111");
    expect(JSON.stringify(redacted)).not.toContain("Ubot");
    expect(redacted).toEqual({
      enabled: true,
      botToken: { present: true, redacted: true },
      appToken: { present: true, redacted: true },
      allowedChannelIds: { count: 2 },
      allowAllChannels: false,
      botUserIds: { count: 1 },
      mentionTextAliases: { count: 1 },
      stripMentionText: true,
    });
  });
});
