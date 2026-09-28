import type {
  AgentReplyAttachmentPart,
  ChannelAskSnapshot,
  ProcessJobProjection,
} from "@mono-agent/agent-contracts";
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentRequest, AgentResponder } from "../adapter.js";
import { createTelegramBot, type CreateTelegramBotOptions } from "../bot.js";
import {
  parseTelegramConversationId,
  telegramConversationId,
  telegramMessageThreadId,
  withoutImplicitTopicReply,
} from "../conversation.js";
import type { TelegramMessage } from "../types.js";

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const FORUM_CHAT = { id: -1001, type: "supergroup", title: "Trips", is_forum: true };
const TOPIC = 77;

interface RecordedCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

type Update = Parameters<Bot["handleUpdate"]>[0];

function harness(options: Partial<CreateTelegramBotOptions> & { responder: AgentResponder }) {
  const calls: RecordedCall[] = [];
  let nextMessageId = 5000;
  const controller = createTelegramBot({
    botToken: "test-token",
    allowedChatIds: [String(FORUM_CHAT.id)],
    ...options,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typed = payload as Record<string, unknown>;
        calls.push({ method, payload: typed });
        if (method === "sendMessage" || method === "sendDocument") {
          const thread = typed.message_thread_id;
          return {
            ok: true,
            result: {
              message_id: nextMessageId++,
              date: 0,
              chat: { id: typed.chat_id, type: "supergroup" },
              ...(typeof thread === "number" ? { message_thread_id: thread, is_topic_message: true } : {}),
              text: typed.text,
            },
          } as never;
        }
        return { ok: true, result: true } as never;
      });
      return bot;
    },
  });
  return { controller, bot: controller.bot, calls };
}

function recordingResponder(requests: AgentRequest[], text = "ok"): AgentResponder {
  return {
    respond: async (request) => {
      requests.push(request);
      return { text };
    },
  };
}

/** A message in a forum topic, carrying Telegram's implicit reply to the topic root. */
function topicMessage(
  text: string,
  options: {
    readonly updateId?: number;
    readonly messageId?: number;
    readonly topic?: number;
    readonly chat?: { id: number; type: string; title?: string; is_forum?: boolean };
    readonly rootCreatedByBot?: boolean;
    readonly mention?: boolean;
    readonly command?: boolean;
  } = {},
): Update {
  const topic = options.topic ?? TOPIC;
  const chat = options.chat ?? FORUM_CHAT;
  const entities = options.command === true
    ? [{ type: "bot_command", offset: 0, length: text.split(" ", 1)[0]!.length }]
    : options.mention === true
      ? [{ type: "mention", offset: text.indexOf("@ExampleBot"), length: "@ExampleBot".length }]
      : undefined;
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: options.messageId ?? 900,
      message_thread_id: topic,
      is_topic_message: true,
      date: 1234,
      chat,
      from: { id: 7, is_bot: false, first_name: "Person A" },
      text,
      ...(entities === undefined ? {} : { entities }),
      reply_to_message: {
        message_id: topic,
        message_thread_id: topic,
        date: 1000,
        chat,
        from: options.rootCreatedByBot === true
          ? BOT_INFO
          : { id: 8, is_bot: false, first_name: "Topic Creator" },
        forum_topic_created: { name: "Budapest", icon_color: 7322096 },
      },
    },
  } as unknown as Update;
}

/** A message in a forum's General topic: no topic id and no implicit reply. */
function generalMessage(
  text: string,
  options: { readonly updateId?: number; readonly mention?: boolean; readonly command?: boolean } = {},
): Update {
  const entities = options.command === true
    ? [{ type: "bot_command", offset: 0, length: text.split(" ", 1)[0]!.length }]
    : options.mention === true
      ? [{ type: "mention", offset: text.indexOf("@ExampleBot"), length: "@ExampleBot".length }]
      : undefined;
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: 800,
      date: 1234,
      chat: FORUM_CHAT,
      from: { id: 7, is_bot: false, first_name: "Person A" },
      text,
      ...(entities === undefined ? {} : { entities }),
    },
  } as unknown as Update;
}

function sends(calls: readonly RecordedCall[], method = "sendMessage"): RecordedCall[] {
  return calls.filter((call) => call.method === method);
}

function askSnapshot(): ChannelAskSnapshot {
  return {
    interactionId: "ask-topic",
    questions: [{
      id: "q0",
      header: "Dates",
      question: "Which weekend?",
      options: [
        { id: "a", label: "First", description: "The first weekend." },
        { id: "b", label: "Second", description: "The second weekend." },
      ],
      multiSelect: false,
    }],
    answers: [],
    activeQuestionIndex: 0,
    status: "pending",
    createdAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-09-28T09:10:00.000Z",
  };
}

describe("Telegram conversation ids", () => {
  it("keeps the chat id for the main conversation and appends a forum topic", () => {
    expect(telegramConversationId(-1001)).toBe("telegram:-1001");
    expect(telegramConversationId({ chatId: -1001 })).toBe("telegram:-1001");
    expect(telegramConversationId({ chatId: -1001, messageThreadId: 77 })).toBe("telegram:-1001:77");
  });

  it("parses chat and topic ids, ignoring a rollover bucket, and fails closed on malformed topics", () => {
    expect(parseTelegramConversationId("telegram:42")).toEqual({ chatId: 42 });
    expect(parseTelegramConversationId("telegram:-1001:77#2026-09-28")).toEqual({
      chatId: -1001,
      messageThreadId: 77,
    });
    expect(parseTelegramConversationId("telegram:@trips")).toEqual({ chatId: "@trips" });
    for (const malformed of ["telegram:", "telegram:-1001:", "telegram:-1001:0", "telegram:-1001:x", "telegram:1:2:3", "slack:C1:1"]) {
      expect(parseTelegramConversationId(malformed)).toBeUndefined();
    }
  });

  it("treats only is_topic_message as a forum topic", () => {
    expect(telegramMessageThreadId({ message_thread_id: 77, is_topic_message: true })).toBe(77);
    // Non-forum supergroups set message_thread_id for plain reply threads.
    expect(telegramMessageThreadId({ message_thread_id: 77 })).toBeUndefined();
    expect(telegramMessageThreadId({})).toBeUndefined();
  });

  it("drops only the implicit topic-root reply", () => {
    const implicit = (topicMessage("hi").message as unknown as TelegramMessage);
    expect(withoutImplicitTopicReply(implicit).reply_to_message).toBeUndefined();
    const explicit: TelegramMessage = {
      ...implicit,
      reply_to_message: { message_id: 950, chat: implicit.chat, text: "earlier" },
    };
    expect(withoutImplicitTopicReply(explicit).reply_to_message?.message_id).toBe(950);
  });
});

describe("createTelegramBot forum topics", () => {
  it("gives a topic its own conversation and routes the typing action, status and answer into it", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = harness({
      responder: recordingResponder(requests, "Topic answer"),
      stream: { initialStatusText: "Working…" },
    });

    await bot.handleUpdate(topicMessage("plan Budapest"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.conversationId).toBe("telegram:-1001:77");
    expect(requests[0]?.replyTo).toEqual({ conversationId: "telegram:-1001:77" });
    expect(requests[0]?.metadata.telegram.messageThreadId).toBe(TOPIC);
    // The implicit reply to the topic root is not quoted into the turn.
    expect(requests[0]?.text).toBe("plan Budapest");
    expect(requests[0]?.metadata.telegram.replyToMessage).toBeUndefined();
    const posted = sends(calls);
    expect(posted.length).toBeGreaterThan(0);
    for (const call of posted) {
      expect(call.payload.message_thread_id).toBe(TOPIC);
    }
    expect(posted.map((call) => call.payload.text)).toContain("Topic answer");
    for (const call of calls.filter((entry) => entry.method === "sendChatAction")) {
      expect(call.payload.message_thread_id).toBe(TOPIC);
    }
  });

  it("keeps General-topic and non-forum reply-thread messages in the chat conversation without a thread", async () => {
    const requests: AgentRequest[] = [];
    const { bot, calls } = harness({ responder: recordingResponder(requests) });

    await bot.handleUpdate(generalMessage("general question"));
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 801,
        // A non-forum supergroup reply thread: thread id present, not a topic.
        message_thread_id: 500,
        date: 1234,
        chat: { id: -1001, type: "supergroup", title: "Trips" },
        from: { id: 7, is_bot: false, first_name: "Person A" },
        text: "reply thread",
        reply_to_message: {
          message_id: 500,
          date: 1000,
          chat: { id: -1001, type: "supergroup", title: "Trips" },
          from: { id: 8, is_bot: false, first_name: "Other" },
          text: "original",
        },
      },
    } as unknown as Update);

    expect(requests.map((request) => request.conversationId)).toEqual(["telegram:-1001", "telegram:-1001"]);
    expect(requests[0]?.metadata.telegram.messageThreadId).toBeUndefined();
    // A real reply keeps its quoted context.
    expect(requests[1]?.metadata.telegram.replyToMessage?.id).toBe(500);
    for (const call of sends(calls)) {
      expect(call.payload).not.toHaveProperty("message_thread_id");
    }
  });

  it("does not treat a bot-created topic's root as a reply in mention mode", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = harness({ groupMode: "mention", responder: recordingResponder(requests) });

    await bot.handleUpdate(topicMessage("chatter between us", { rootCreatedByBot: true }));
    await bot.handleUpdate(topicMessage("@ExampleBot what about trains?", {
      updateId: 2,
      messageId: 901,
      rootCreatedByBot: true,
      mention: true,
    }));

    expect(requests.map((request) => request.text)).toEqual(["what about trains?"]);
    expect(requests[0]?.conversationId).toBe("telegram:-1001:77");
  });

  it("applies per-topic trigger overrides while General and other topics keep the group mode", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = harness({
      groupMode: "mention",
      topics: [
        { chatId: -1001, topicId: TOPIC, groupMode: "any" },
        { chatId: "-1001", topicId: 78, groupMode: "inherit" },
      ],
      responder: recordingResponder(requests),
    });

    await bot.handleUpdate(topicMessage("no ping needed here"));
    await bot.handleUpdate(topicMessage("inherited topic chatter", { updateId: 2, topic: 78 }));
    await bot.handleUpdate(topicMessage("unlisted topic chatter", { updateId: 3, topic: 79 }));
    await bot.handleUpdate(generalMessage("general chatter", { updateId: 4 }));
    await bot.handleUpdate(generalMessage("@ExampleBot general ping", { updateId: 5, mention: true }));

    expect(requests.map((request) => [request.conversationId, request.text])).toEqual([
      ["telegram:-1001:77", "no ping needed here"],
      ["telegram:-1001", "general ping"],
    ]);
  });

  it("lets a topic opt back into mention mode under an any-mode group", async () => {
    const requests: AgentRequest[] = [];
    const { bot } = harness({
      groupMode: "any",
      topics: [{ chatId: -1001, topicId: TOPIC, groupMode: "mention" }],
      responder: recordingResponder(requests),
    });

    await bot.handleUpdate(topicMessage("quiet topic chatter"));
    await bot.handleUpdate(generalMessage("general chatter", { updateId: 2 }));

    expect(requests.map((request) => request.conversationId)).toEqual(["telegram:-1001"]);
  });

  it("never lets a topic override admit a chat outside the allowlist", async () => {
    const requests: AgentRequest[] = [];
    const outsider = { id: -2002, type: "supergroup", title: "Elsewhere", is_forum: true };
    const { bot, calls } = harness({
      topics: [{ chatId: -2002, topicId: TOPIC, groupMode: "any" }],
      responder: recordingResponder(requests),
    });

    await bot.handleUpdate(topicMessage("let me in", { chat: outsider }));

    expect(requests).toHaveLength(0);
    expect(sends(calls).map((call) => call.payload.text)).toEqual([
      "This Telegram chat is not authorized to use this bot.",
    ]);
    expect(sends(calls)[0]?.payload.message_thread_id).toBe(TOPIC);
  });

  it("cancels and resets only the topic that ran /cancel or /new", async () => {
    const cancel = vi.fn();
    const pendingCancel = vi.fn();
    const startNewSession = vi.fn(async () => undefined);
    const { bot } = harness({
      responder: { respond: async () => ({ text: "ok" }), cancel },
      pendingAsks: {
        getPendingAsk: async () => undefined,
        submitAskAnswers: async () => ({ accepted: false, code: "not_found" as const }),
        cancel: pendingCancel,
      },
      startNewSession,
    });

    await bot.handleUpdate(topicMessage("/cancel", { command: true }));
    await bot.handleUpdate(topicMessage("/new", { updateId: 2, command: true }));
    await bot.handleUpdate(generalMessage("/cancel", { updateId: 3, command: true }));

    expect(cancel.mock.calls.map((call) => call[0])).toEqual([
      "telegram:-1001:77",
      "telegram:-1001:77",
      "telegram:-1001",
    ]);
    expect(pendingCancel.mock.calls.map((call) => call[0])).toEqual([
      "telegram:-1001:77",
      "telegram:-1001:77",
      "telegram:-1001",
    ]);
    expect(startNewSession).toHaveBeenCalledWith("telegram:-1001:77");
  });

  it("posts proactive notifications into a topic and records them to that topic's history", async () => {
    const deliverVerbatim = vi.fn(async (_conversationId: string, _text: string) => undefined);
    const requests: AgentRequest[] = [];
    const { controller, calls } = harness({
      responder: { ...recordingResponder(requests, "Daily digest"), deliverVerbatim },
    });

    await expect(controller.notify({ chatId: -1001, messageThreadId: TOPIC }, "Verbatim report", { verbatim: true }))
      .resolves.toMatchObject({ delivered: true });
    await expect(controller.notify({ chatId: -1001, messageThreadId: TOPIC }, "Run the digest"))
      .resolves.toMatchObject({ delivered: true });
    await expect(controller.notify(-1001, "General nudge", { verbatim: true }))
      .resolves.toMatchObject({ delivered: true });

    expect(deliverVerbatim.mock.calls.map((call) => call[0])).toEqual(["telegram:-1001:77", "telegram:-1001"]);
    expect(requests[0]?.conversationId).toBe("telegram:-1001:77");
    expect(requests[0]?.metadata.telegram.messageThreadId).toBe(TOPIC);
    const posted = sends(calls).map((call) => [call.payload.text, call.payload.message_thread_id]);
    expect(posted).toContainEqual(["Verbatim report", TOPIC]);
    expect(posted).toContainEqual(["Daily digest", TOPIC]);
    expect(posted).toContainEqual(["General nudge", undefined]);
  });

  it("asks questions in the topic and accepts answers only from that topic", async () => {
    const snapshot = askSnapshot();
    const getPendingAsk = vi.fn(async (conversationId: string) =>
      conversationId === "telegram:-1001:77" ? snapshot : undefined);
    const submitAskAnswers = vi.fn(async () => ({ accepted: true, snapshot }));
    const requests: AgentRequest[] = [];
    const { controller, bot, calls } = harness({
      groupMode: "any",
      responder: recordingResponder(requests),
      pendingAsks: { getPendingAsk, submitAskAnswers, cancel: vi.fn() },
    });

    await controller.presentAsk({ chatId: -1001, messageThreadId: TOPIC }, snapshot);
    const question = sends(calls).at(-1);
    expect(question?.payload.message_thread_id).toBe(TOPIC);

    await bot.handleUpdate(generalMessage("second weekend", { updateId: 2 }));
    await bot.handleUpdate(topicMessage("second weekend please", { updateId: 3 }));

    expect(submitAskAnswers).toHaveBeenCalledTimes(1);
    expect(submitAskAnswers).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "telegram:-1001:77",
      interactionId: "ask-topic",
    }));
    // The General message ran as its own turn instead of answering the topic question.
    expect(requests.map((request) => request.conversationId)).toEqual(["telegram:-1001"]);

    // An update aimed at the chat's main conversation does not edit the topic's question.
    await controller.updateAsk(-1001, { ...snapshot, status: "answered" });
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    await controller.updateAsk({ chatId: -1001, messageThreadId: TOPIC }, { ...snapshot, status: "answered" });
    expect(calls.some((call) => call.method === "editMessageText")).toBe(true);
  });

  it("posts tool status and process-job cards into the originating topic", async () => {
    const { controller, calls } = harness({ responder: recordingResponder([]) });

    await controller.postStatus({ chatId: -1001, messageThreadId: TOPIC }, "Searching…", { key: "k", state: "working" });
    await controller.postStatus(-1001, "Searching…", { key: "k", state: "working" });
    expect(sends(calls).map((call) => call.payload.message_thread_id)).toEqual([TOPIC, undefined]);

    const projection = {
      schema: "mono-agent.process-job-projection.v1",
      jobId: "pj_topic",
      tool: "Exec",
      state: "running",
      summary: "Exec command (values redacted)",
      origin: {
        conversationId: "telegram:-1001:77#2026-09-28",
        channel: "telegram",
        runId: "run",
        historyBoundary: "run",
        bucket: "2026-09-28",
      },
      timestamps: {
        admittedAt: "2026-09-28T00:00:00.000Z",
        queueDeadlineAt: "2026-09-28T00:05:00.000Z",
        startedAt: "2026-09-28T00:00:01.000Z",
        runtimeDeadlineAt: "2026-09-28T00:30:01.000Z",
        completedAt: null,
      },
      limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1024, previewChars: 100, chainDepth: 0 },
      output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null },
      wake: { state: "pending", attempts: 0, deliveryKey: "process-job:pj_topic", lastAttemptAt: null },
      exitCode: null,
      signal: null,
      durationMs: null,
      cancelRequested: false,
      lastError: null,
    } as unknown as ProcessJobProjection;

    // The chat's main conversation is a different destination from the topic that owns the job.
    await expect(controller.updateProcessJob(-1001, projection))
      .resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
    await expect(controller.updateProcessJob({ chatId: -1001, messageThreadId: TOPIC }, projection))
      .resolves.toMatchObject({ delivered: true, code: "surface_posted" });
    expect(sends(calls).at(-1)?.payload.message_thread_id).toBe(TOPIC);
  });

  it("uploads generated reply files into the topic", async () => {
    const attachment: AgentReplyAttachmentPart = {
      type: "attachment",
      id: "reply-file-topic",
      reference: { scheme: "mono-agent-artifact", id: "22222222-2222-4222-8222-222222222222" },
      name: "itinerary.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      integrityId: `sha256:${"c".repeat(64)}`,
    };
    const { bot, calls } = harness({
      responder: {
        async respond() { return { text: "Here it is", parts: [attachment] }; },
        async openReplyArtifact() {
          return {
            attachment,
            body: (async function* () { yield new TextEncoder().encode("hello"); })(),
          };
        },
      },
    });

    await bot.handleUpdate(topicMessage("send the itinerary"));

    const documents = sends(calls, "sendDocument");
    expect(documents).toHaveLength(1);
    expect(documents[0]?.payload.message_thread_id).toBe(TOPIC);
  });
});
