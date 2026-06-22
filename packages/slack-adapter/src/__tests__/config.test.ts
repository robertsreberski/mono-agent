import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSlackAdapterConfig,
  redactSlackAdapterConfig,
  slackFieldGroup,
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
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
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
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
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
      shortcuts: [],
      homeTab: { enabled: false, buttons: [] },
    });
  });

  it("loads slack.shortcuts bindings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D111" }],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config.shortcuts).toEqual([
      { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D111" },
    ]);
  });

  it("rejects a malformed slack.shortcuts entry", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          shortcuts: [{ callbackId: "", prompt: "missing id" }],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("loads slack.homeTab config from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: {
            enabled: true,
            headerText: "Controls",
            buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D111" }],
          },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config.homeTab).toEqual({
      enabled: true,
      headerText: "Controls",
      buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D111" }],
    });
  });

  it("rejects a malformed slack.homeTab button", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "json-bot-token",
          appToken: "json-app-token",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, buttons: [{ actionId: "sync_now", prompt: "no label" }] },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects duplicate slack.shortcuts callbackId", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          shortcuts: [
            { callbackId: "dup", prompt: "one", channelId: "D111" },
            { callbackId: "dup", prompt: "two", channelId: "D111" },
          ],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects duplicate slack.homeTab actionId", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          homeTab: {
            enabled: true,
            buttons: [
              { actionId: "dup", label: "A", prompt: "one", channelId: "D111" },
              { actionId: "dup", label: "B", prompt: "two", channelId: "D111" },
            ],
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects an enabled homeTab with no buttons and no headerText", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: { enabled: true, botToken: "b", appToken: "a", allowedChannelIds: ["D111"], homeTab: { enabled: true } },
      })}\n`,
      "utf8",
    );

    await expect(loadSlackAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("accepts an enabled header-only homeTab (no buttons)", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        slack: {
          enabled: true,
          botToken: "b",
          appToken: "a",
          allowedChannelIds: ["D111"],
          homeTab: { enabled: true, headerText: "Welcome" },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });
    expect(config.homeTab).toEqual({ enabled: true, headerText: "Welcome", buttons: [] });
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
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync." }],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run." }] },
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
      shortcuts: { count: 1 },
      homeTab: { enabled: true, buttonCount: 1 },
    });
  });
});

describe("slackFieldGroup", () => {
  it("declares Slack adapter token, allowlist, and mention settings", () => {
    expect(slackFieldGroup.id).toBe("slack");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.enabled")?.kind).toBe("switch");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.botToken")?.kind).toBe("secret");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.appToken")?.kind).toBe("secret");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.allowedChannelIds")?.kind).toBe("csv");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.allowAllChannels")?.kind).toBe("switch");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.stripMentionText")?.kind).toBe("switch");
  });
});
