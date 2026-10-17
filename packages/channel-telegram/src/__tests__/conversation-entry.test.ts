import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatTelegramConversationTarget, parseTelegramConversationId, type TelegramConversationTarget } from "../conversation-entry.js";
import { telegramConversationId } from "../conversation.js";

describe("pure conversation entry", () => {
  it("loads the built entry without any SDK or client dependency", () => {
    expect(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { registerHooks } from "node:module";
      const target = import.meta.resolve("@mono-agent/channel-telegram/conversation");
      const allowed = new Set([target, new URL("./conversation.js", target).href]);
      registerHooks({ load(url, context, next) {
        if (!allowed.has(url)) throw new Error("Unexpected routing dependency: " + url);
        return next(url, context);
      } });
      const routing = await import(target);
      const expected = ["formatTelegramConversationTarget", "parseTelegramConversationId", "telegramMessageThreadId"];
      if (JSON.stringify(Object.keys(routing).sort()) !== JSON.stringify(expected)) throw new Error("Unexpected public routing surface");
      console.log(routing.formatTelegramConversationTarget({ chatId: "@fictional", messageThreadId: 12 }));
    `], { encoding: "utf8" }).trim()).toBe("telegram:@fictional:12");
  });

  it("keeps raw formatting distinct from destination validation", () => {
    for (const messageThreadId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      const target = { chatId: -1001, messageThreadId };
      expect(formatTelegramConversationTarget(target)).toBe(`telegram:-1001:${messageThreadId}`);
      expect(() => telegramConversationId(target)).toThrow("Telegram messageThreadId must be a positive safe integer.");
    }
    expect(formatTelegramConversationTarget({ chatId: "@fictional" })).toBe("telegram:@fictional");
  });

  it.each(["telegram:1:0", "telegram:1:-1", "telegram:1:1.5", "telegram:1:9007199254740992", "telegram:1:abc", "telegram:1:2:3", "telegram:"])("refuses malformed %s", (id) => {
    expect(parseTelegramConversationId(id)).toBeUndefined();
  });

  it("retains target readonly and optional guarantees", () => {
    if (false) {
      const target: TelegramConversationTarget = { chatId: "@fictional" };
      // @ts-expect-error chat identity remains readonly.
      target.chatId = 1;
      // @ts-expect-error optional topic requires narrowing.
      const thread: number = target.messageThreadId;
      void thread;
    }
    expect(parseTelegramConversationId("telegram: 42 #bucket")).toEqual({ chatId: 42 });
  });
});
