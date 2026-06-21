import type { RunnerHandle } from "@grammyjs/runner";
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import { startTelegramAdapter } from "../start.js";

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

function recordingBot(): { bot: Bot; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let nextMessageId = 900;
  const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    const typedPayload = payload as Record<string, unknown>;
    calls.push({ method, payload: typedPayload });
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: 0,
          chat: { id: typedPayload.chat_id, type: "private" },
          text: typedPayload.text,
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return { bot, calls };
}

class FakeRunner implements RunnerHandle {
  running = true;
  stopCalls = 0;
  start(): void {
    this.running = true;
  }
  stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
    return Promise.resolve();
  }
  size(): number {
    return 0;
  }
  task(): Promise<void> | undefined {
    return this.running ? Promise.resolve() : undefined;
  }
  isRunning(): boolean {
    return this.running;
  }
}

function messageUpdate(text: string, chatId = 42, updateId = 1): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: chatId, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      text,
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function documentUpdate(mimeType: string, updateId = 1): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      caption: "summarize",
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "brief.pdf",
        mime_type: mimeType,
        file_size: 12_345,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

describe("startTelegramAdapter", () => {
  it("exposes notify() that runs a proactive turn and delivers to the chat", async () => {
    const { bot, calls } = recordingBot();
    const responder: AgentResponder = {
      async respond() {
        return { text: "ping delivered" };
      },
    };
    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder,
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    const outcome = await result.notify(99, "say hi");

    expect(outcome).toEqual({ delivered: true });
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload).toMatchObject({ chat_id: 99, text: "ping delivered" });
    await result.stop();
  });

  it("wires the grammY bot + runner and starts polling", async () => {
    const { bot, calls } = recordingBot();
    let capturedToken: string | undefined;
    let runner: FakeRunner | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      botFactory: (token) => {
        capturedToken = token;
        return bot;
      },
      runnerFactory: () => {
        runner = new FakeRunner();
        return runner;
      },
    });

    expect(capturedToken).toBe("test-token");
    expect(runner?.isRunning()).toBe(true);
    expect(calls.some((call) => call.method === "deleteWebhook")).toBe(true);

    await result.stop();
    expect(runner?.stopCalls).toBe(1);
    expect(runner?.isRunning()).toBe(false);
  });

  it("routes a fake update through the wired bot to the responder", async () => {
    const { bot } = recordingBot();
    const respondCalls: Array<{ text: string; chatId: unknown }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        respondCalls.push({ text: request.text, chatId: request.chatId });
        return { text: "pong" };
      },
    };

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowedChatIds: [42],
      responder,
      stream: { editDebounceMs: 0 },
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await bot.handleUpdate(messageUpdate("ping"));

    expect(respondCalls).toEqual([{ text: "ping", chatId: 42 }]);

    await result.stop();
  });

  it("stop() is idempotent", async () => {
    const { bot } = recordingBot();
    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await result.stop();
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it("forwards a narrower attachments policy through to the download path", async () => {
    const { bot, calls } = recordingBot();
    const requests: Array<{ attachments: unknown }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        requests.push({ attachments: request.attachments });
        return { text: "ok" };
      },
    };

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder,
      stream: { editDebounceMs: 0 },
      // A policy NARROWER than the default: application/pdf is on the default
      // allowlist but NOT on this custom one, so it must be filtered out before
      // any download (proving the policy reached downloadTelegramAttachments).
      attachments: { mimeAllowlist: ["text/plain"], maxBytes: 5 },
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await bot.handleUpdate(documentUpdate("application/pdf"));

    expect(requests).toHaveLength(1);
    // The disallowed MIME type was filtered: no download, no attachment bytes.
    expect(requests[0]?.attachments).toBeUndefined();
    // getFile is the first step of a download; it must never have been called.
    expect(calls.some((call) => call.method === "getFile")).toBe(false);

    await result.stop();
  });

  it("fails closed when neither allowedChatIds nor allowAllChats is provided", async () => {
    await expect(
      startTelegramAdapter({
        botToken: "test-token",
        responder: { respond: vi.fn() } satisfies AgentResponder,
        botFactory: () => recordingBot().bot,
        runnerFactory: () => new FakeRunner(),
      }),
    ).rejects.toThrow(/allowedChatIds/);
  });
});
