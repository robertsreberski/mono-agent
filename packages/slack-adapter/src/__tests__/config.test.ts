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
          botToken: "xoxb-json-token",
          appToken: "xapp-json-token",
          allowedChannelIds: ["D111", "C222"],
          botUserIds: ["Ubot"],
          mentionTextAliases: ["@mono"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({ env: {}, jsonPath: path });

    expect(config).toEqual({
      botToken: "xoxb-json-token",
      appToken: "xapp-json-token",
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
          botToken: "xoxb-json-token",
          appToken: "xapp-json-token",
          allowedChannelIds: ["C111"],
          stripMentionText: true,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadSlackAdapterConfig({
      env: {
        MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-env-token",
        MONO_AGENT_SLACK_APP_TOKEN: "xapp-env-token",
        MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS: "",
        MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true",
        MONO_AGENT_SLACK_BOT_USER_IDS: "U1, U2",
        MONO_AGENT_SLACK_MENTION_TEXT_ALIASES: "@mono, Mono Agent",
        MONO_AGENT_SLACK_STRIP_MENTION_TEXT: "false",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      botToken: "xoxb-env-token",
      appToken: "xapp-env-token",
      allowedChannelIds: [],
      allowAllChannels: true,
      botUserIds: ["U1", "U2"],
      mentionTextAliases: ["@mono", "Mono Agent"],
      stripMentionText: false,
    });
  });

  it("requires tokens and an explicit allowlist or allow-all choice", async () => {
    await expect(
      loadSlackAdapterConfig({ env: { MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-token" } }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);

    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-token",
          MONO_AGENT_SLACK_APP_TOKEN: "xapp-token",
        },
      }),
    ).rejects.toBeInstanceOf(SlackAdapterConfigError);
  });

  it("rejects invalid booleans", async () => {
    await expect(
      loadSlackAdapterConfig({
        env: {
          MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-token",
          MONO_AGENT_SLACK_APP_TOKEN: "xapp-token",
          MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "sometimes",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactSlackAdapterConfig", () => {
  it("redacts tokens and reports identifiers only by count", () => {
    const redacted = redactSlackAdapterConfig({
      botToken: "xoxb-secret",
      appToken: "xapp-secret",
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

describe("slackFieldGroup", () => {
  it("declares Slack adapter token, allowlist, and mention settings", () => {
    expect(slackFieldGroup.id).toBe("slack");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.botToken")?.kind).toBe("secret");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.appToken")?.kind).toBe("secret");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.allowedChannelIds")?.kind).toBe("csv");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.allowAllChannels")?.kind).toBe("switch");
    expect(slackFieldGroup.fields.find((field) => field.id === "slack.stripMentionText")?.kind).toBe("switch");
  });
});
