import { describe, expect, it } from "vitest";

import { parseTelegramConversationId } from "@mono-agent/telegram-adapter";

import { slackTargetFromConversation, telegramChatIdFromConversation } from "../channels.js";
import { telegramConversationIdFor, telegramTargetFromConversation } from "../telegram-destination.js";

describe("telegramChatIdFromConversation", () => {
  it("extracts numeric and group chat ids, stripping a rollover bucket", () => {
    expect(telegramChatIdFromConversation("telegram:42")).toBe(42);
    expect(telegramChatIdFromConversation("telegram:-1001234567890")).toBe(-1001234567890);
    expect(telegramChatIdFromConversation("telegram:42#2026-06-19")).toBe(42);
  });

  it("trims surrounding whitespace so a model-supplied id still parses to a number", () => {
    expect(telegramChatIdFromConversation("telegram: 42")).toBe(42);
    expect(telegramChatIdFromConversation("telegram:42 ")).toBe(42);
    expect(telegramChatIdFromConversation("telegram: 42 #2026-06-19")).toBe(42);
  });

  it("returns undefined for a non-telegram or empty target", () => {
    expect(telegramChatIdFromConversation("slack:C1:1")).toBeUndefined();
    expect(telegramChatIdFromConversation("telegram:")).toBeUndefined();
    expect(telegramChatIdFromConversation("telegram:   ")).toBeUndefined();
  });

  it("returns the chat of a forum-topic conversation and rejects a malformed topic", () => {
    expect(telegramChatIdFromConversation("telegram:-1001234567890:12")).toBe(-1001234567890);
    expect(telegramChatIdFromConversation("telegram:-1001234567890:12#2026-09-28")).toBe(-1001234567890);
    expect(telegramChatIdFromConversation("telegram:-1001234567890:abc")).toBeUndefined();
  });
});

describe("telegramTargetFromConversation", () => {
  const cases = [
    "telegram:42",
    "telegram:-1001234567890",
    "telegram:-1001234567890:12",
    "telegram:-1001234567890:12#2026-09-28",
    "telegram: 42 #2026-06-19",
    "telegram:@trips",
    "telegram:@trips:3",
    "telegram:",
    "telegram:-1001:",
    "telegram:-1001:0",
    "telegram:-1001:-5",
    "telegram:-1001:1.5",
    "telegram:1:2:3",
    "slack:C1:1",
  ];

  it("parses chats and forum topics exactly like the Telegram adapter", () => {
    for (const conversationId of cases) {
      expect(telegramTargetFromConversation(conversationId), conversationId)
        .toEqual(parseTelegramConversationId(conversationId));
    }
    expect(telegramTargetFromConversation("telegram:-1001:12")).toEqual({ chatId: -1001, messageThreadId: 12 });
  });

  it("round-trips a target into its conversation id", () => {
    expect(telegramConversationIdFor({ chatId: -1001 })).toBe("telegram:-1001");
    expect(telegramConversationIdFor({ chatId: -1001, messageThreadId: 12 })).toBe("telegram:-1001:12");
  });
});

describe("slackTargetFromConversation", () => {
  it("parses thread-targeted and bare-channel destinations", () => {
    expect(slackTargetFromConversation("slack:C1:171.5")).toEqual({ channelId: "C1", threadTs: "171.5" });
    expect(slackTargetFromConversation("slack:C1")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack:C1:171.5#2026-06-19")).toEqual({ channelId: "C1", threadTs: "171.5" });
  });

  it("trims surrounding whitespace so the value reaching the Slack API matches the allowlist check", () => {
    expect(slackTargetFromConversation("slack: C1")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack:C1 ")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack: C1 : 123 ")).toEqual({ channelId: "C1", threadTs: "123" });
  });

  it("rejects a malformed (colon-bearing) threadTs rather than passing garbage downstream", () => {
    // A canonical Slack threadTs never contains a colon, so a stray/double colon is
    // an operator typo — return undefined so the driver warns + skips cleanly.
    expect(slackTargetFromConversation("slack:C1::extra")).toBeUndefined();
    expect(slackTargetFromConversation("slack:C1:171.5:")).toBeUndefined();
  });

  it("returns undefined for a non-slack or empty target", () => {
    expect(slackTargetFromConversation("telegram:42")).toBeUndefined();
    expect(slackTargetFromConversation("slack:")).toBeUndefined();
  });
});
