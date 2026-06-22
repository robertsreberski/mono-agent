import { Bot } from "grammy";
import { describe, expect, it } from "vitest";

import type { AgentRequest, AgentResponder } from "../adapter.js";
import { createTelegramBot } from "../bot.js";

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function ok(result: unknown): never {
  return { ok: true, result } as never;
}

function buildNotifiableBot(responder: AgentResponder): {
  controller: ReturnType<typeof createTelegramBot>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let nextMessageId = 2000;
  const controller = createTelegramBot({
    botToken: "test-token",
    allowAllChats: true,
    responder,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typedPayload = payload as Record<string, unknown>;
        calls.push({ method, payload: typedPayload });
        if (method === "sendMessage") {
          return ok({
            message_id: nextMessageId++,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        if (method === "editMessageText") {
          return ok({
            message_id: typedPayload.message_id ?? 0,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        return ok(true);
      });
      return bot;
    },
  });
  return { controller, calls };
}

describe("createTelegramBot notify (proactive)", () => {
  it("runs a turn keyed on telegram:<chatId> and delivers the answer to that chat", async () => {
    let captured: AgentRequest | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        captured = request as AgentRequest;
        return { text: "Morning brief ready" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(42, "Compose and report the morning brief.");

    expect(result).toEqual({ delivered: true });
    expect(captured?.conversationId).toBe("telegram:42");
    expect(captured?.text).toBe("Compose and report the morning brief.");
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload).toMatchObject({
      chat_id: 42,
      text: "Morning brief ready",
    });
  });

  it("posts nothing (and reports the reason) when the proactive turn produces no answer", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(7, "Anything urgent?");

    expect(result).toEqual({ delivered: false, reason: "agent produced no answer" });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("reports the queue-full reason when the chat is at its concurrency cap", async () => {
    // Hold the first turn open so a flood past the depth cap is rejected by the
    // per-chat admission queue while the run is still in-flight.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder: AgentResponder = {
      async respond() {
        await gate;
        return { text: "done" };
      },
    };
    const { controller } = buildNotifiableBot(responder);

    // Fill the queue to its depth cap (100) with notifies that park on `gate`,
    // then the next notify is rejected synchronously as queue-full.
    const inflight = Array.from({ length: 100 }, () => controller.notify(5, "tick"));
    const rejected = await controller.notify(5, "one too many");

    expect(rejected).toEqual({ delivered: false, reason: "chat at concurrency cap" });

    release?.();
    await Promise.all(inflight);
  });
});
