import { describe, expect, it, vi } from "vitest";

import {
  AgentResponderCancelledError,
  SlackAdapter,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  nextTs = 200;

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }

  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    this.postMessageCalls.push(params);
    return { ok: true, channel: params.channel, ts: `${this.nextTs++}.000001` };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }
}

describe("SlackAdapter", () => {
  it("fails closed unless channels are explicitly allowed", () => {
    expect(
      () =>
        new SlackAdapter({
          api: new FakeSlackApi(),
          responder: responderFrom(async () => ({ text: "ok" })),
        }),
    ).toThrow(/allowedChannelIds/);
  });

  it("handles /start and /help commands with deterministic replies", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({ api, responder, allowAllChannels: true });

    await expect(adapter.handleEventCallback(directMessage("/start"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "start",
    });
    await expect(adapter.handleEventCallback(directMessage("/help"))).resolves.toMatchObject({
      kind: "handled",
      action: "command",
      command: "help",
    });

    expect(api.postMessageCalls.map((call) => call.text)).toEqual([
      "Hello! Send me a Slack message and I will pass it to the configured agent.",
      "Send a Slack DM or mention the app in a channel. Use /cancel in a thread to stop the current response.",
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("denies unauthorized channels without calling the responder", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowedChannelIds: ["C999"],
    });

    await expect(adapter.handleEventCallback(directMessage("hello", { channel: "D123" }))).resolves.toEqual({
      kind: "unauthorized",
      eventId: "Ev1",
      channelId: "D123",
    });

    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "This Slack channel is not authorized to use this bot.",
        thread_ts: "171.000001",
      },
    ]);
    expect(responder.respond).not.toHaveBeenCalled();
  });

  it("invokes the responder for DMs with bounded Slack metadata", async () => {
    const api = new FakeSlackApi();
    const requests: AgentRequest[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request, stream) => {
        requests.push(request);
        await stream.append("partial");
        return { text: "final", metadata: { provider: "fake" } };
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("  hello agent  "))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
      metadata: { provider: "fake" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "slack:D123:171.000001",
      channelId: "D123",
      messageTs: "171.000001",
      threadTs: "171.000001",
      eventId: "Ev1",
      teamId: "T1",
      userId: "Ualice",
      text: "hello agent",
      trigger: "direct",
      metadata: {
        slack: {
          teamId: "T1",
          apiAppId: "A1",
          eventId: "Ev1",
          eventTime: 171,
          channel: { id: "D123", type: "im" },
          message: { ts: "171.000001", eventTs: "171.000001" },
          user: { id: "Ualice" },
          trigger: "direct",
        },
      },
    });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(api.postMessageCalls[0]).toEqual({
      channel: "D123",
      text: "Thinking...",
      thread_ts: "171.000001",
      mrkdwn: true,
    });
    expect(api.updateCalls.map((call) => call.text)).toEqual(["partial", "final"]);
  });

  it("sends responder Markdown as Slack mrkdwn", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => ({
        text: "**Done** [details](https://example.com/report)",
      })),
    });

    await expect(adapter.handleEventCallback(directMessage("summarize"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    expect(api.postMessageCalls[0]).toEqual({
      channel: "D123",
      text: "Thinking...",
      thread_ts: "171.000001",
      mrkdwn: true,
    });
    expect(api.updateCalls.at(-1)).toEqual({
      channel: "D123",
      ts: "200.000001",
      text: "*Done* <https://example.com/report|details>",
      mrkdwn: true,
    });
  });

  it("handles app mentions and strips configured bot mentions and aliases", async () => {
    let capturedRequest: AgentRequest | undefined;
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      botUserIds: ["Ubot"],
      mentionTextAliases: ["@mono"],
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        capturedRequest = request;
        return { text: request.text };
      }),
    });

    const result = await adapter.handleEventCallback(appMention("<@Ubot> @mono help me"));

    expect(result).toMatchObject({ kind: "handled", action: "responded" });
    expect(capturedRequest).toMatchObject({
      conversationId: "slack:C123:172.000001",
      channelId: "C123",
      text: "help me",
      trigger: "app_mention",
      metadata: {
        slack: {
          channel: { id: "C123" },
          trigger: "app_mention",
        },
      },
    });
    expect(api.updateCalls.at(-1)?.text).toBe("help me");
  });

  it("ignores bot/self/subtyped and unsupported events without sending", async () => {
    const api = new FakeSlackApi();
    const responder = { respond: vi.fn() } satisfies AgentResponder;
    const adapter = new SlackAdapter({
      api,
      responder,
      allowAllChannels: true,
      botUserIds: ["Ubot"],
    });

    await expect(adapter.handleEventCallback(directMessage("self", { user: "Ubot" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "from_self",
    });
    await expect(adapter.handleEventCallback(directMessage("bot", { botId: "B1" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "from_bot",
    });
    await expect(adapter.handleEventCallback(directMessage("join", { subtype: "channel_join" }))).resolves.toMatchObject({
      kind: "ignored",
      reason: "unsupported_message",
    });
    await expect(adapter.handleEventCallback({ ...directMessage("x"), event: { type: "reaction_added" } })).resolves.toMatchObject({
      kind: "ignored",
      reason: "unsupported_event",
    });

    expect(responder.respond).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([]);
  });

  it("returns busy for a second message in the same Slack thread", async () => {
    const api = new FakeSlackApi();
    const deferred = createDeferred<{ text: string }>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => deferred.promise),
    });

    const first = adapter.handleEventCallback(directMessage("first"));
    await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(1));

    await expect(
      adapter.handleEventCallback(directMessage("second", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "busy", channelId: "D123" });
    expect(api.postMessageCalls.at(-1)).toEqual({
      channel: "D123",
      text: "I am still working on this Slack thread. Use /cancel to stop it.",
      thread_ts: "171.000001",
    });

    deferred.resolve({ text: "done" });
    await expect(first).resolves.toMatchObject({ kind: "handled" });
  });

  it("aborts an active run on /cancel in the same Slack thread", async () => {
    const api = new FakeSlackApi();
    let capturedSignal: AbortSignal | undefined;
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(
        async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          }),
      ),
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(api.postMessageCalls.some((call) => call.text === "Cancelled.")).toBe(true);
    expect(api.updateCalls.at(-1)?.text).toBe("Cancelled.");
  });

  it("surfaces responder failures without fake success", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => {
        throw new Error("runtime exploded");
      }),
    });

    const result = await adapter.handleEventCallback(directMessage("boom"));

    expect(result).toMatchObject({ kind: "error", channelId: "D123" });
    expect(api.updateCalls.at(-1)?.text).toBe("The agent failed while processing your Slack message.");
  });

  it("finishes with cancelled text when the responder reports cancellation", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponderCancelledError();
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("please stop"))).resolves.toMatchObject({
      kind: "cancelled",
      channelId: "D123",
    });
    expect(api.updateCalls.at(-1)?.text).toBe("Cancelled.");
  });
});

function responderFrom(respond: AgentResponder["respond"]): AgentResponder {
  return { respond };
}

function directMessage(
  text: string,
  options: {
    channel?: string;
    eventId?: string;
    ts?: string;
    threadTs?: string;
    user?: string;
    botId?: string;
    subtype?: string;
  } = {},
): SlackEventCallback {
  const event: Record<string, unknown> = {
    type: "message",
    channel: options.channel ?? "D123",
    user: options.user ?? "Ualice",
    text,
    ts: options.ts ?? "171.000001",
    event_ts: options.ts ?? "171.000001",
    channel_type: "im",
  };
  if (options.threadTs !== undefined) {
    event.thread_ts = options.threadTs;
  }
  if (options.botId !== undefined) {
    event.bot_id = options.botId;
  }
  if (options.subtype !== undefined) {
    event.subtype = options.subtype;
  }
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: options.eventId ?? "Ev1",
    event_time: 171,
    event,
  };
}

function appMention(text: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev2",
    event_time: 172,
    event: {
      type: "app_mention",
      channel: "C123",
      user: "Ualice",
      text,
      ts: "172.000001",
      event_ts: "172.000001",
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
