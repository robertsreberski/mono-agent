import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isWithinQuietHours,
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

  it("parses telegram.commands from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          commands: [
            { command: "brief", description: "Morning brief", prompt: "Compose the brief" },
            { command: "about", description: "What this agent does" },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config.commands).toEqual([
      { command: "brief", description: "Morning brief", prompt: "Compose the brief" },
      { command: "about", description: "What this agent does" },
    ]);
  });

  it("rejects a command that redefines a built-in", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          commands: [{ command: "cancel", description: "nope" }],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });

  it("rejects duplicate command names", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          commands: [
            { command: "brief", description: "one" },
            { command: "brief", description: "two" },
          ],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });

  it("rejects a command name with invalid characters", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          commands: [{ command: "My Brief!", description: "bad name" }],
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });

  it("parses telegram.reactions: true as all states enabled", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: { enabled: true, botToken: "123456:json-token", allowAllChats: true, reactions: true },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config.reactions).toEqual({ working: true, done: true, error: true });
  });

  it("parses a granular telegram.reactions object, defaulting unspecified states to on", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: { enabled: true, botToken: "123456:json-token", allowAllChats: true, reactions: { done: false } },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config.reactions).toEqual({ working: true, done: false, error: true });
  });

  it("treats an all-off telegram.reactions object as disabled", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          reactions: { working: false, done: false, error: false },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config.reactions).toBeUndefined();
  });

  it("lets MONO_AGENT_TELEGRAM_REACTIONS override the JSON object to all-on", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: { enabled: true, botToken: "123456:json-token", allowAllChats: true, reactions: { done: false } },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({
      env: { MONO_AGENT_TELEGRAM_REACTIONS: "true" },
      jsonPath: path,
    });
    expect(config.reactions).toEqual({ working: true, done: true, error: true });
  });

  it("rejects a non-boolean telegram.reactions state flag", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          reactions: { working: "yes" },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });

  it("parses telegram.quietHours from JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Rome" },
        },
      })}\n`,
      "utf8",
    );

    const config = await loadTelegramAdapterConfig({ env: {}, jsonPath: path });
    expect(config.quietHours).toEqual({ start: "22:00", end: "07:00", timezone: "Europe/Rome" });
  });

  it("rejects a malformed quietHours clock time", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          quietHours: { start: "9am", end: "07:00", timezone: "Europe/Rome" },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });

  it("rejects an unrecognized quietHours timezone", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        telegram: {
          enabled: true,
          botToken: "123456:json-token",
          allowAllChats: true,
          quietHours: { start: "22:00", end: "07:00", timezone: "Mars/Olympus" },
        },
      })}\n`,
      "utf8",
    );

    await expect(loadTelegramAdapterConfig({ env: {}, jsonPath: path })).rejects.toBeInstanceOf(
      TelegramAdapterConfigError,
    );
  });
});

describe("isWithinQuietHours", () => {
  const zone = "UTC";

  it("matches an overnight window that wraps midnight", () => {
    const quietHours = { start: "22:00", end: "07:00", timezone: zone };
    // 23:30 UTC is inside the window.
    expect(isWithinQuietHours(new Date("2026-06-25T23:30:00Z"), quietHours)).toBe(true);
    // 03:00 UTC (after midnight) is still inside.
    expect(isWithinQuietHours(new Date("2026-06-25T03:00:00Z"), quietHours)).toBe(true);
    // 12:00 UTC (midday) is outside.
    expect(isWithinQuietHours(new Date("2026-06-25T12:00:00Z"), quietHours)).toBe(false);
  });

  it("matches a same-day window", () => {
    const quietHours = { start: "09:00", end: "17:00", timezone: zone };
    expect(isWithinQuietHours(new Date("2026-06-25T10:00:00Z"), quietHours)).toBe(true);
    // The end boundary is exclusive.
    expect(isWithinQuietHours(new Date("2026-06-25T17:00:00Z"), quietHours)).toBe(false);
    expect(isWithinQuietHours(new Date("2026-06-25T08:59:00Z"), quietHours)).toBe(false);
  });

  it("treats a degenerate start === end window as never active", () => {
    const quietHours = { start: "08:00", end: "08:00", timezone: zone };
    expect(isWithinQuietHours(new Date("2026-06-25T08:00:00Z"), quietHours)).toBe(false);
  });

  it("interprets the window in the configured timezone", () => {
    // 23:00 UTC is 01:00 in Europe/Rome (UTC+2 in June), inside a 00:00–06:00 Rome window.
    const quietHours = { start: "00:00", end: "06:00", timezone: "Europe/Rome" };
    expect(isWithinQuietHours(new Date("2026-06-25T23:00:00Z"), quietHours)).toBe(true);
    // 12:00 UTC is 14:00 Rome — outside.
    expect(isWithinQuietHours(new Date("2026-06-25T12:00:00Z"), quietHours)).toBe(false);
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
