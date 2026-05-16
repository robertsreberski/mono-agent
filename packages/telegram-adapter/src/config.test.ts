import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  telegramFieldGroup,
  TelegramAdapterConfigError,
} from "./config.js";

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
          botToken: "123456:json-token",
          allowedChatIds: ["111", "222"],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config).toEqual({
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
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:env-token",
        MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "",
        MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "true",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      botToken: "123456:env-token",
      allowedChatIds: [],
      allowAllChats: true,
    });
  });

  it("requires either an explicit allowlist or explicit allow-all choice", async () => {
    await expect(
      loadTelegramAdapterConfig({
        env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:token" },
      }),
    ).rejects.toBeInstanceOf(TelegramAdapterConfigError);
  });
});

describe("redactTelegramAdapterConfig", () => {
  it("redacts bot tokens and reports chat ids by count", () => {
    const redacted = redactTelegramAdapterConfig({
      botToken: "123456:secret-token",
      allowedChatIds: ["111", "222"],
      allowAllChats: false,
    });

    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("111");
    expect(redacted).toEqual({
      botToken: { present: true, redacted: true },
      allowedChatIds: { count: 2 },
      allowAllChats: false,
    });
  });
});

describe("telegramFieldGroup", () => {
  it("declares Telegram adapter settings including the write-only token", () => {
    expect(telegramFieldGroup.id).toBe("telegram");
    expect(telegramFieldGroup.fields.find((field) => field.id === "telegram.botToken")?.kind).toBe("secret");
    expect(telegramFieldGroup.fields.find((field) => field.id === "telegram.allowAllChats")?.kind).toBe("switch");
  });
});
