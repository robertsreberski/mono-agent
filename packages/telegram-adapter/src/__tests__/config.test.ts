import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  TelegramAdapterConfigError,
} from "../config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-telegram-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadTelegramAdapterConfig", () => {
  it("loads adapter-owned Telegram settings from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowedChatIds: ["111", "222"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config).toEqual({
      enabled: true,
      botToken: "123456:json-token",
      allowedChatIds: ["111", "222"],
      allowAllChats: false,
    });
  });

  it("lets env override JSON and supports explicit allow-all", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          botToken: "123456:json-token",
          allowedChatIds: ["111"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({
      env: {
        MONO_AGENT_TELEGRAM_ENABLED: "true",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:env-token",
        MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "",
        MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "true",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      botToken: "123456:env-token",
      allowedChatIds: [],
      allowAllChats: true,
    });
  });

  it("requires either an explicit allowlist or explicit allow-all choice when enabled", async () => {
    await expect(
      loadTelegramAdapterConfig({
        env: { MONO_AGENT_TELEGRAM_ENABLED: "true", MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:token" },
      }),
    ).rejects.toBeInstanceOf(TelegramAdapterConfigError);
  });

  it("is disabled by default and skips credential validation", async () => {
    const config = await loadTelegramAdapterConfig({ env: {} });
    expect(config).toEqual({
      enabled: false,
      botToken: "",
      allowedChatIds: [],
      allowAllChats: false,
    });
  });

  it("parses transport.ipFamily and pollWatchdogMs from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          transport: { ipFamily: 4 },
          pollWatchdogMs: 90000,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config).toMatchObject({ enabled: true, ipFamily: 4, pollWatchdogMs: 90000 });
  });

  it("lets env override the IPv4/IPv6 transport pin", async () => {
    const config = await loadTelegramAdapterConfig({
      env: {
        MONO_AGENT_TELEGRAM_ENABLED: "true",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:env-token",
        MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "true",
        MONO_AGENT_TELEGRAM_IP_FAMILY: "6",
      },
    });
    expect(config.ipFamily).toBe(6);
  });

  it("rejects an ipFamily other than 4 or 6", async () => {
    await expect(
      loadTelegramAdapterConfig({
        env: {
          MONO_AGENT_TELEGRAM_ENABLED: "true",
          MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:token",
          MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "true",
          MONO_AGENT_TELEGRAM_IP_FAMILY: "5",
        },
      }),
    ).rejects.toBeInstanceOf(TelegramAdapterConfigError);
  });
});

describe("redactTelegramAdapterConfig", () => {
  it("redacts bot tokens and reports chat ids by count", () => {
    const redacted = redactTelegramAdapterConfig({
      enabled: true,
      botToken: "123456:test-token",
      allowedChatIds: ["111", "222"],
      allowAllChats: false,
    });

    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("111");
    expect(redacted).toEqual({
      enabled: true,
      botToken: { present: true, redacted: true },
      allowedChatIds: { count: 2 },
      allowAllChats: false,
    });
  });
});
