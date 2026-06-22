import { describe, expect, it, vi } from "vitest";

import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

import {
  SerialQueue,
  SerialQueueFullError,
  SlackAdapter,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackDownloadFileParams,
  SlackReactionsAddParams,
  SlackRequestOptions,
  SlackEventCallback,
  SlackViewsPublishParams,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  readonly reactionsAddCalls: SlackReactionsAddParams[] = [];
  readonly viewsPublishCalls: SlackViewsPublishParams[] = [];
  readonly setAssistantStatusCalls: Array<{ channelId: string; threadTs: string; status: string }> = [];
  /**
   * When true, setAssistantStatus rejects (simulating a regular channel/DM that is
   * NOT a Slack AI-assistant thread). Defaults true since most threads are not
   * assistant threads → the adapter falls back to the 👀 reaction. Assistant-thread
   * tests set this false.
   */
  failSetAssistantStatus = true;
  nextTs = 200;

  async authTest() {
    return { ok: true as const };
  }

  async setAssistantStatus(params: { channelId: string; threadTs: string; status: string }): Promise<void> {
    this.setAssistantStatusCalls.push(params);
    if (this.failSetAssistantStatus) {
      throw new Error("not_in_assistant_thread");
    }
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

  async reactionsAdd(params: SlackReactionsAddParams): Promise<void> {
    this.reactionsAddCalls.push(params);
  }

  async viewsPublish(params: SlackViewsPublishParams): Promise<void> {
    this.viewsPublishCalls.push(params);
  }

  async downloadFile(
    _params: SlackDownloadFileParams,
    _options?: SlackRequestOptions,
  ): Promise<Uint8Array> {
    return new Uint8Array();
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

  it("notify() runs a proactive turn on the target thread and posts the answer there", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "morning brief" };
      }),
    });

    const result = await adapter.notify("C1", "171.5", "Compose the brief");

    expect(result).toEqual({ delivered: true });
    expect(captured?.conversationId).toBe("slack:C1:171.5");
    expect(captured?.text).toBe("Compose the brief");
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("C1");
    expect(post?.thread_ts).toBe("171.5");
    expect(post?.text).toContain("morning brief");
    // A proactive turn does not react to a (non-existent) inbound message.
    expect(api.reactionsAddCalls).toEqual([]);
  });

  it("notify() reports an honest drop when the agent produces no answer", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => ({ text: "   " })),
    });

    const result = await adapter.notify("C1", "171.5", "Compose the brief");

    expect(result).toEqual({ delivered: false, reason: "agent produced no answer" });
    // Nothing is posted when the agent has nothing to say.
    expect(api.postMessageCalls).toEqual([]);
  });

  it("notify() reports an honest drop when the conversation is at its concurrency cap", async () => {
    const api = new FakeSlackApi();
    const blocked = createDeferred<{ text: string }>();
    let activeStarted = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => {
        activeStarted = true;
        // The active proactive run holds the queue's running slot so the flood
        // parks behind it and the cap+1-th notify is rejected.
        return blocked.promise;
      }),
    });

    // One blocking active run takes the queue's running slot (depth 1).
    const activeRun = adapter.notify("C1", "171.5", "active");
    await vi.waitFor(() => expect(activeStarted).toBe(true));

    // The admission SerialQueue caps depth at 100. Fill it to the cap with 99
    // more same-conversation notifies, then the next one must be dropped.
    const maxDepth = 100;
    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < maxDepth - 1; i += 1) {
      queued.push(adapter.notify("C1", "171.5", `fill-${i}`));
    }

    const overCap = await adapter.notify("C1", "171.5", "over-cap");

    expect(overCap).toEqual({ delivered: false, reason: "conversation at concurrency cap" });

    // Drain: settle the active run and let the genuinely-queued fills resolve.
    blocked.resolve({ text: "done" });
    await activeRun;
    await Promise.allSettled(queued);
  });

  it("notify() into a thread registers under the /cancel key so a concurrent /cancel aborts it", async () => {
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

    // A threaded proactive run registers under the inbound /cancel runKey
    // `${channelId}:${threadTs}` rather than `proactive:...`, so a /cancel
    // posted to the same thread can abort it mid-flight.
    const notifyRun = adapter.notify("D123", "171.000001", "nudge");
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(
        directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
      ),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);

    await expect(notifyRun).resolves.toEqual({ delivered: false, reason: "cancelled" });
  });

  it("notify() without a thread posts top-level and keys on the bare channel", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "channel ping" };
      }),
    });

    await adapter.notify("C2", undefined, "Post an announcement");

    expect(captured?.conversationId).toBe("slack:C2");
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("C2");
    expect(post?.thread_ts).toBeUndefined();
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
      userId: "UUSER1",
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
          user: { id: "UUSER1" },
          trigger: "direct",
        },
      },
    });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    // Final-only delivery: the answer arrives as a single chat.postMessage at
    // finish() — no interim "Thinking..." post and no streaming edits.
    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "final",
        thread_ts: "171.000001",
        mrkdwn: true,
      },
    ]);
    expect(api.updateCalls).toEqual([]);
    // A 👀 "seen" reaction was added once to the triggering message while working.
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
  });

  it("sets an assistant-thread status while working when setAssistantStatus is available", async () => {
    const api = new FakeSlackApi();
    api.failSetAssistantStatus = false; // this conversation IS an assistant thread
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("partial");
        return { text: "final" };
      }),
    });

    await adapter.handleEventCallback(directMessage("hello"));

    // The official assistant-thread status is set (Slack auto-clears it when the
    // final message posts), and the 👀 reaction fallback is NOT used.
    expect(api.setAssistantStatusCalls).toEqual([
      { channelId: "D123", threadTs: "171.000001", status: "is thinking…" },
    ]);
    expect(api.reactionsAddCalls).toEqual([]);
  });

  it("falls back to the 👀 reaction when assistant status is unavailable (not an assistant thread)", async () => {
    const api = new FakeSlackApi();
    api.failSetAssistantStatus = true;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.append("partial");
        return { text: "final" };
      }),
    });

    await adapter.handleEventCallback(directMessage("hello"));

    // It tried the assistant status, hit the not-an-assistant-thread error, and
    // fell back to the 👀 reaction (added once).
    expect(api.setAssistantStatusCalls.length).toBeGreaterThanOrEqual(1);
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
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

    // Final-only delivery: the Markdown answer is rendered to Slack mrkdwn and
    // sent in a single chat.postMessage at finish() — no separate placeholder
    // post and no chat.update edit.
    expect(api.postMessageCalls).toEqual([
      {
        channel: "D123",
        text: "*Done* <https://example.com/report|details>",
        thread_ts: "171.000001",
        mrkdwn: true,
      },
    ]);
    expect(api.updateCalls).toEqual([]);
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
    // Final-only delivery: the stripped text is the final answer, posted once.
    expect(api.postMessageCalls.at(-1)?.text).toBe("help me");
    expect(api.updateCalls).toEqual([]);
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

  it("admits a concurrent same-thread message in arrival order without rejecting it", async () => {
    const api = new FakeSlackApi();
    const first = createDeferred<{ text: string }>();
    const second = createDeferred<{ text: string }>();
    const queue = [first, second];
    let started = 0;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      // Concurrent same-thread messages are admitted through a per-conversation
      // serial queue: the second waits for the first (preserving order) and is
      // never rejected with a "busy" reply.
      responder: responderFrom(async () => {
        started += 1;
        return queue.shift()!.promise;
      }),
    });

    const firstRun = adapter.handleEventCallback(directMessage("first"));
    await vi.waitFor(() => expect(started).toBe(1));

    const secondRun = adapter.handleEventCallback(
      directMessage("second", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );
    // The second message is queued behind the first (serial admission): its
    // responder has NOT run yet, and no "busy" copy is posted.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(1);
    expect(
      api.postMessageCalls.some((call) =>
        call.text.includes("still working on this Slack thread"),
      ),
    ).toBe(false);

    // Completing the first admits the second, in order.
    first.resolve({ text: "done-1" });
    await vi.waitFor(() => expect(started).toBe(2));
    second.resolve({ text: "done-2" });

    await expect(firstRun).resolves.toMatchObject({ kind: "handled", action: "responded" });
    await expect(secondRun).resolves.toMatchObject({ kind: "handled", action: "responded" });

    // Delivered in arrival order, one final post each.
    expect(api.postMessageCalls.map((call) => call.text)).toEqual(["done-1", "done-2"]);
    expect(api.updateCalls).toEqual([]);
  });

  it("rejects an over-cap same-thread flood with a busy result and posts busyText without leaking its controller", async () => {
    const api = new FakeSlackApi();
    const active = createDeferred<{ text: string }>();
    let respondCalls = 0;
    let activeStarted = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        respondCalls += 1;
        activeStarted = true;
        // The first run blocks forever (until the test settles it), holding the
        // queue's active slot so the flood parks behind it.
        return active.promise;
      }),
    });

    // One blocking active run takes the queue's running slot (depth 1).
    const activeRun = adapter.handleEventCallback(directMessage("active"));
    await vi.waitFor(() => expect(activeStarted).toBe(true));

    // The admission SerialQueue caps depth at 100. The active run holds 1 slot, so
    // 99 more same-thread messages fill the queue to the cap; the 100th queued
    // message (the cap+1-th in total) must be rejected as busy.
    const maxDepth = 100;
    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < maxDepth - 1; i += 1) {
      queued.push(
        adapter.handleEventCallback(
          directMessage(`fill-${i}`, {
            eventId: `Evfill${i}`,
            ts: `171.0001${i}`,
            threadTs: "171.000001",
          }),
        ),
      );
    }

    // This over-cap message is rejected synchronously by the queue (depth === cap)
    // and never reaches the responder.
    const overCap = await adapter.handleEventCallback(
      directMessage("over-cap", {
        eventId: "EvOverCap",
        ts: "171.000999",
        threadTs: "171.000001",
      }),
    );

    expect(overCap).toEqual({ kind: "busy", eventId: "EvOverCap", channelId: "D123" });
    // The busy terminal copy was posted to the thread.
    expect(api.postMessageCalls.at(-1)).toEqual({
      channel: "D123",
      text: "I am still working on this Slack thread. Use /cancel to stop it.",
      thread_ts: "171.000001",
    });
    // Only the active run reached the responder; the over-cap message did not.
    expect(respondCalls).toBe(1);

    // The over-cap message's controller was unregistered on the rejected path (no
    // leak): only the active run + the 99 genuinely-queued fills remain tracked
    // (exactly maxDepth), NOT maxDepth + 1. respondToEvent's finally never ran for
    // the rejected message, so the busy path must clean its eager controller up.
    const controllers = (
      adapter as unknown as {
        activeControllers: Map<string, Set<AbortController>>;
      }
    ).activeControllers;
    const tracked = [...controllers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(tracked).toBe(maxDepth);

    // Drain: settle the active run and let the genuinely-queued fills resolve.
    active.resolve({ text: "done" });
    await activeRun;
    await Promise.allSettled(queued);

    // After draining, every controller is unregistered (the rejected one left
    // nothing behind, and the run-through fills cleaned up in their finally).
    const remaining = [...controllers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(remaining).toBe(0);
  });

  it("preserves arrival order when an earlier same-thread message stalls on file download", async () => {
    const api = new FakeSlackApi();
    const order: string[] = [];
    const firstDownload = createDeferred<void>();
    api.downloadFile = async () => {
      await firstDownload.promise; // the first message's download stalls
      return new Uint8Array([1, 2, 3]);
    };
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      attachments: { allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async (request) => {
        order.push(request.text);
        return { text: `ok:${request.text}` };
      }),
    });

    // A has a (stalled) file; B has none and would otherwise race ahead.
    const aRun = adapter.handleEventCallback(
      directMessage("A-with-file", {
        files: [{ id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://files.slack.test/a.png" }],
      }),
    );
    const bRun = adapter.handleEventCallback(
      directMessage("B-no-file", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    // B must NOT have reached the responder before A (it is queued behind A).
    expect(order).toEqual([]);

    firstDownload.resolve();
    await Promise.all([aRun, bRun]);
    // The responder saw the messages in arrival order, not download-completion order.
    expect(order).toEqual(["A-with-file", "B-no-file"]);
  });

  it("aborts active runs and clears queued follow-ups on /cancel in the same Slack thread", async () => {
    const api = new FakeSlackApi();
    let capturedSignal: AbortSignal | undefined;
    const cancelCalls: string[] = [];
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) =>
          await new Promise<{ text: string }>((resolve) => {
            capturedSignal = request.abortSignal;
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
          }),
        cancel: (conversationId: string) => {
          cancelCalls.push(conversationId);
        },
      },
    });

    const first = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    expect(capturedSignal?.aborted).toBe(true);
    expect(cancelCalls).toEqual(["slack:D123:171.000001"]);
    await expect(first).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    // Final-only delivery: the terminal "Cancelled." copy is the single final post.
    expect(api.postMessageCalls.at(-1)?.text).toBe("Cancelled.");
    expect(api.updateCalls).toEqual([]);
  });

  it("/cancel silences a queued same-thread follow-up before it reaches the responder", async () => {
    const api = new FakeSlackApi();
    let respondCalls = 0;
    const aBlocked = createDeferred<{ text: string }>();
    const responderStarted = createDeferred<void>();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: {
        respond: async (request) => {
          respondCalls += 1;
          // A blocks until aborted; B must never reach here (it is silenced by the
          // /cancel that fires while it is still parked in the admission queue).
          return await new Promise<{ text: string }>((resolve) => {
            request.abortSignal.addEventListener(
              "abort",
              () => resolve({ text: "should not be used" }),
              { once: true },
            );
            responderStarted.resolve(undefined);
            void aBlocked.promise.then(resolve);
          });
        },
        cancel: () => undefined,
      },
    });

    // A becomes the active run.
    const aRun = adapter.handleEventCallback(directMessage("long task"));
    await responderStarted.promise;

    // B arrives on the same thread and parks behind A in the admission queue
    // (its controller is registered eagerly, before the queued task starts).
    const bRun = adapter.handleEventCallback(
      directMessage("queued follow-up", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }),
    );

    // /cancel aborts every controller for the thread — including B's still-queued one.
    await expect(
      adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev3", ts: "171.000003", threadTs: "171.000001" })),
    ).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });

    await expect(aRun).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });
    await expect(bRun).resolves.toMatchObject({ kind: "cancelled", channelId: "D123" });

    // The responder ran exactly once (A only) — B bailed before responder.respond.
    expect(respondCalls).toBe(1);
    // No agent answer for B is posted after cancel; the last copy is the terminal.
    expect(api.postMessageCalls.at(-1)?.text).toBe("Cancelled.");
  });

  it("does not require a responder.cancel to handle /cancel", async () => {
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
  });

  it("signals activity with a 👀 reaction and never leaks tool/reasoning text", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "WebSearch" });
        await stream.event?.({ type: "assistant_thought", text: "secret reasoning" });
        return { text: "final answer" };
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("look it up"))).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    const allText = [
      ...api.postMessageCalls.map((call) => call.text),
      ...api.updateCalls.map((call) => call.text),
    ];
    // Final-only delivery: no interim hint text is posted/edited; the user sees a
    // 👀 "seen" reaction while the agent works, then just the final answer.
    expect(api.reactionsAddCalls).toEqual([
      { channel: "D123", timestamp: "171.000001", name: "eyes" },
    ]);
    // Neither friendly tool hints nor private reasoning ever reach the channel.
    expect(allText.some((text) => text.includes("Searching the web"))).toBe(false);
    expect(allText.some((text) => text.includes("WebSearch"))).toBe(false);
    expect(allText.some((text) => text.includes("secret reasoning"))).toBe(false);
    // The final answer is delivered as the single posted message.
    expect(api.postMessageCalls.map((call) => call.text)).toEqual(["final answer"]);
    expect(api.updateCalls).toEqual([]);
  });

  it("downloads inbound files into request.attachments with base64 data", async () => {
    const api = new FakeSlackApi();
    const downloads: Array<{ url: string; signalAborted: boolean }> = [];
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const textBytes = new TextEncoder().encode("hello doc");
    api.downloadFile = async (params, options) => {
      downloads.push({ url: params.url, signalAborted: options?.signal?.aborted === true });
      if (params.url.includes("photo")) {
        return imageBytes;
      }
      return textBytes;
    };

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("here are files", {
      files: [
        {
          id: "F1",
          name: "photo.png",
          mimetype: "image/png",
          url_private: "https://files.slack.test/photo.png",
          size: imageBytes.byteLength,
        },
        {
          id: "F2",
          title: "Notes",
          name: "notes.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.test/notes.txt",
          size: textBytes.byteLength,
        },
      ],
    });

    await expect(adapter.handleEventCallback(callback)).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });

    expect(downloads.map((d) => d.url)).toEqual([
      "https://files.slack.test/photo.png",
      "https://files.slack.test/notes.txt",
    ]);
    expect(downloads.every((d) => d.signalAborted === false)).toBe(true);

    expect(captured?.attachments).toHaveLength(2);
    expect(captured?.attachments?.[0]).toEqual({
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from(imageBytes).toString("base64"),
      name: "photo.png",
      sizeBytes: imageBytes.byteLength,
    });
    // Text mimetypes are also decoded to UTF-8 text.
    expect(captured?.attachments?.[1]).toEqual({
      kind: "document",
      mimeType: "text/plain",
      data: Buffer.from(textBytes).toString("base64"),
      name: "notes.txt",
      sizeBytes: textBytes.byteLength,
      text: "hello doc",
    });
  });

  it("downloads files from a file_share subtyped message instead of ignoring it", async () => {
    const api = new FakeSlackApi();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    api.downloadFile = async () => imageBytes;

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    // Slack delivers a file upload as subtype "file_share"; it must NOT be
    // rejected as an unsupported subtyped message.
    const callback = directMessage("here is a screenshot", {
      subtype: "file_share",
      files: [
        { id: "F1", name: "shot.png", mimetype: "image/png", url_private: "https://files.slack.test/shot.png", size: imageBytes.byteLength },
      ],
    });

    await expect(adapter.handleEventCallback(callback)).resolves.toMatchObject({
      kind: "handled",
      action: "responded",
    });
    expect(captured?.attachments).toHaveLength(1);
    expect(captured?.attachments?.[0]?.name).toBe("shot.png");
  });

  it("skips a file whose download fails and keeps the rest", async () => {
    const api = new FakeSlackApi();
    const okBytes = new Uint8Array([1, 2, 3]);
    api.downloadFile = async (params) => {
      if (params.url.includes("bad")) {
        throw new Error("download failed");
      }
      return okBytes;
    };

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("files", {
      files: [
        { id: "F1", name: "bad.png", mimetype: "image/png", url_private: "https://files.slack.test/bad.png" },
        { id: "F2", name: "good.png", mimetype: "image/png", url_private: "https://files.slack.test/good.png" },
      ],
    });

    await adapter.handleEventCallback(callback);

    expect(captured?.attachments).toHaveLength(1);
    expect(captured?.attachments?.[0]?.name).toBe("good.png");
  });

  it("enforces the maxBytes cap and mimetype allowlist", async () => {
    const api = new FakeSlackApi();
    api.downloadFile = async () => new Uint8Array([1, 2, 3, 4]);

    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      attachments: { maxBytes: 3, allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const callback = directMessage("files", {
      files: [
        // Disallowed mimetype: skipped before any download.
        { id: "F1", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/doc.pdf" },
        // Allowed mimetype but advertised size exceeds the cap: skipped.
        { id: "F2", name: "big.png", mimetype: "image/png", size: 9, url_private: "https://files.slack.test/big.png" },
      ],
    });

    await adapter.handleEventCallback(callback);

    expect(captured?.attachments ?? []).toHaveLength(0);
  });

  it("returns a deterministic no-usable-files response when a file-only message has all files skipped", async () => {
    const api = new FakeSlackApi();
    let responderCalled = false;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      attachments: { allowedMimeTypes: ["image/png"] },
      responder: responderFrom(async () => {
        responderCalled = true;
        return { text: "ok" };
      }),
    });

    // File-only (no caption) with a disallowed-MIME file → every file skipped.
    const result = await adapter.handleEventCallback(
      directMessage("", {
        files: [{ id: "F1", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/doc.pdf" }],
      }),
    );

    // The adapter answers deterministically instead of submitting an empty
    // request that the harness would reject.
    expect(result).toMatchObject({ kind: "ignored", reason: "no_usable_attachments" });
    expect(responderCalled).toBe(false);
    expect(api.postMessageCalls.at(-1)?.text).toContain("only handle Slack text messages");
  });

  it("works with a text-only SlackWebApi client that has no downloadFile (forwards metadata only)", async () => {
    const posts: SlackChatPostMessageParams[] = [];
    // A minimal client WITHOUT downloadFile / reactionsAdd — must typecheck and
    // not crash even on a file event.
    const textOnlyApi: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params: SlackChatPostMessageParams) {
        posts.push(params);
        return { ok: true as const, channel: params.channel, ts: "200.000001" };
      },
      async chatUpdate(params: SlackChatUpdateParams) {
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api: textOnlyApi,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request;
        return { text: "ok" };
      }),
    });

    const result = await adapter.handleEventCallback(
      directMessage("look at this", {
        files: [{ id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://files.slack.test/a.png" }],
      }),
    );

    expect(result).toMatchObject({ kind: "handled", action: "responded" });
    // No bytes were downloaded (the client has no downloadFile), so no attachments.
    expect(captured?.attachments ?? []).toHaveLength(0);
    expect(posts.some((p) => p.text === "ok")).toBe(true);
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
    // Final-only delivery: the failure copy is the single final post.
    expect(api.postMessageCalls.at(-1)?.text).toBe(
      "The agent failed while processing your Slack message.",
    );
    expect(api.updateCalls).toEqual([]);
  });

  it("finishes with cancelled text when the responder reports cancellation", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      stream: { editDebounceMs: 0 },
      responder: responderFrom(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    await expect(adapter.handleEventCallback(directMessage("please stop"))).resolves.toMatchObject({
      kind: "cancelled",
      channelId: "D123",
    });
    // Final-only delivery: the cancelled copy is the single final post.
    expect(api.postMessageCalls.at(-1)?.text).toBe("Cancelled.");
    expect(api.updateCalls).toEqual([]);
  });
});

describe("SlackAdapter.handleShortcut", () => {
  it("runs the bound prompt as a proactive turn in the shortcut's destination channel", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1" }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "synced 3 items" };
      }),
    });

    const result = await adapter.handleShortcut({
      type: "shortcut",
      callback_id: "sync_now",
      trigger_id: "T1",
      user: { id: "U1" },
    });

    expect(result).toMatchObject({
      kind: "triggered",
      id: "sync_now",
      channelId: "D1",
      delivered: true,
    });
    expect(captured?.text).toBe("Run the sync.");
    // A global shortcut has no thread → the run posts top-level in the destination.
    expect(captured?.conversationId).toBe("slack:D1");
    expect(api.postMessageCalls.at(-1)?.channel).toBe("D1");
    expect(api.postMessageCalls.at(-1)?.thread_ts).toBeUndefined();
    expect(api.postMessageCalls.at(-1)?.text).toContain("synced 3 items");
  });

  it("posts an instant ack before the run when ackText is set", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [
        { callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…" },
      ],
      responder: responderFrom(async () => ({ text: "No changes" })),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", delivered: true });
    // First post is the instant ack; the run's result follows as its own message.
    const ack = api.postMessageCalls[0];
    const summary = api.postMessageCalls[1];
    expect(ack?.text).toBe("🔄 Syncing…");
    expect(ack?.thread_ts).toBeUndefined();
    expect(summary?.text).toContain("No changes");
  });

  it("falls back to the first allowlisted channel when the binding omits channelId", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync." }],
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "ok" };
      }),
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toMatchObject({ kind: "triggered", channelId: "D1", delivered: true });
    expect(captured?.channelId).toBe("D1");
  });

  it("ignores an unbound shortcut without running anything", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D1" }],
      responder: { respond },
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "some_other" });

    expect(result).toEqual({ kind: "ignored", reason: "unbound", id: "some_other" });
    expect(respond).not.toHaveBeenCalled();
    expect(api.postMessageCalls).toEqual([]);
  });

  it("rejects a shortcut whose destination is outside the allowlist", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      shortcuts: [{ callbackId: "sync_now", prompt: "Run the sync.", channelId: "D-evil" }],
      responder: { respond },
    });

    const result = await adapter.handleShortcut({ type: "shortcut", callback_id: "sync_now" });

    expect(result).toEqual({ kind: "unauthorized", id: "sync_now", channelId: "D-evil" });
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("SlackAdapter App Home tab", () => {
  it("publishes a Home view with a button per configured Home button on app_home_opened", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: {
        enabled: true,
        headerText: "Controls",
        buttons: [{ actionId: "sync_now", label: "🔄 Sync", prompt: "Run the sync.", channelId: "D1" }],
      },
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    const result = await adapter.handleEventCallback(appHomeOpened("U1"));

    expect(result).toEqual({ kind: "home_published", eventId: "EvHome", userId: "U1" });
    const view = api.viewsPublishCalls.at(-1)?.view;
    expect(api.viewsPublishCalls.at(-1)?.userId).toBe("U1");
    expect(view?.type).toBe("home");
    // The view carries the header plus an actions block whose button matches the config.
    const json = JSON.stringify(view);
    expect(json).toContain("Controls");
    expect(json).toContain("🔄 Sync");
    expect(json).toContain("sync_now");
  });

  it("runs a Home button's prompt and replies in its channel on block_actions", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: {
        enabled: true,
        buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run the sync.", channelId: "D1", ackText: "🔄 Syncing…" }],
      },
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "No changes" };
      }),
    });

    // A Home-tab button click carries no channel — routing falls to the binding's channelId.
    const result = await adapter.handleBlockActions({
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "sync_now", value: "sync_now" }],
    });

    expect(result).toMatchObject({ kind: "triggered", id: "sync_now", channelId: "D1", delivered: true });
    expect(captured?.text).toBe("Run the sync.");
    expect(api.postMessageCalls[0]?.text).toBe("🔄 Syncing…"); // instant ack first
    expect(api.postMessageCalls.at(-1)?.text).toContain("No changes");
  });

  it("ignores a block_actions click on an unbound action", async () => {
    const api = new FakeSlackApi();
    const respond = vi.fn(async () => ({ text: "should not run" }));
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      homeTab: { enabled: true, buttons: [{ actionId: "sync_now", label: "Sync", prompt: "Run.", channelId: "D1" }] },
      responder: { respond },
    });

    const result = await adapter.handleBlockActions({
      type: "block_actions",
      actions: [{ action_id: "not_bound" }],
    });

    expect(result).toEqual({ kind: "ignored", reason: "unbound" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not publish a Home view when the Home tab is disabled", async () => {
    const api = new FakeSlackApi();
    const adapter = new SlackAdapter({
      api,
      allowedChannelIds: ["D1"],
      responder: responderFrom(async () => ({ text: "ok" })),
    });

    const result = await adapter.handleEventCallback(appHomeOpened("U1"));

    expect(result).toMatchObject({ kind: "ignored" });
    expect(api.viewsPublishCalls).toEqual([]);
  });
});

describe("SerialQueue", () => {
  it("rejects synchronously with SerialQueueFullError once depth >= maxDepth, then admits later tasks after decrements", async () => {
    const queue = new SerialQueue(2);
    const gateA = createDeferred<void>();
    const gateB = createDeferred<void>();

    // Two blocking tasks fill the queue to its cap (depth 2).
    let aStarted = false;
    const a = queue.run(async () => {
      aStarted = true;
      await gateA.promise;
      return "a";
    });
    const b = queue.run(async () => {
      await gateB.promise;
      return "b";
    });

    // The third task is rejected synchronously (before incrementing/chaining):
    // run() returns an already-rejected promise carrying the sentinel error.
    const overCap = queue.run(async () => "c");
    await expect(overCap).rejects.toBeInstanceOf(SerialQueueFullError);

    // A is running; B is queued behind it. The rejected task never ran.
    await vi.waitFor(() => expect(aStarted).toBe(true));

    // Draining A decrements depth (back to 1), so a later task is admitted.
    gateA.resolve();
    await expect(a).resolves.toBe("a");

    let dStarted = false;
    const d = queue.run(async () => {
      dStarted = true;
      return "d";
    });
    // d was admitted (not rejected) because the decrement freed a slot. It runs
    // serially after B settles.
    gateB.resolve();
    await expect(b).resolves.toBe("b");
    await expect(d).resolves.toBe("d");
    expect(dStarted).toBe(true);
    expect(queue.idle).toBe(true);
  });
});

describe("SlackAdapter posted-message linkage", () => {
  it("aliases an in-thread reply to the producing conversation while still posting to the thread", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex: async (channelId, ts) =>
        channelId === "D123" && ts === "171.000001" ? "scheduled-scan" : undefined,
    });

    await adapter.handleEventCallback(directMessage("that's a good idea", { ts: "171.000099", threadTs: "171.000001" }));

    // The run continues the producing conversation (so it loads that history)…
    expect(captured?.conversationId).toBe("scheduled-scan");
    // …but the answer still posts into the user's Slack thread.
    const post = api.postMessageCalls.at(-1);
    expect(post?.channel).toBe("D123");
    expect(post?.thread_ts).toBe("171.000001");
  });

  it("falls back to the default slack conversation id when the index has no match", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex: async () => undefined,
    });

    await adapter.handleEventCallback(directMessage("hello", { ts: "171.000099", threadTs: "171.000001" }));

    expect(captured?.conversationId).toBe("slack:D123:171.000001");
  });

  it("does not consult the index for a top-level message (no producing post to resume)", async () => {
    const api = new FakeSlackApi();
    let captured: AgentRequest | undefined;
    const resolvePostIndex = vi.fn(async () => "should-not-be-used");
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async (request) => {
        captured = request as AgentRequest;
        return { text: "done" };
      }),
      resolvePostIndex,
    });

    await adapter.handleEventCallback(directMessage("hello"));

    expect(resolvePostIndex).not.toHaveBeenCalled();
    expect(captured?.conversationId).toBe("slack:D123:171.000001");
  });

  it("/cancel cancels the resolved producing conversation", async () => {
    const api = new FakeSlackApi();
    const cancelCalls: string[] = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: {
        respond: async () => ({ text: "ok" }),
        cancel: (conversationId: string) => {
          cancelCalls.push(conversationId);
        },
      },
      resolvePostIndex: async (channelId, ts) =>
        channelId === "D123" && ts === "171.000001" ? "scheduled-scan" : undefined,
    });

    await adapter.handleEventCallback(directMessage("/cancel", { eventId: "Ev2", ts: "171.000002", threadTs: "171.000001" }));

    expect(cancelCalls).toEqual(["scheduled-scan"]);
  });

  it("records a top-level proactive post so a later reply can resume it; threaded posts are not recorded", async () => {
    const api = new FakeSlackApi();
    const recordCalls: Array<[string, string, string]> = [];
    const adapter = new SlackAdapter({
      api,
      allowAllChannels: true,
      responder: responderFrom(async () => ({ text: "brief" })),
      recordPostedMessage: (channelId, ts, conversationId) => {
        recordCalls.push([channelId, ts, conversationId]);
      },
    });

    // Top-level proactive post (no thread): the posted ts is recorded under slack:C1.
    await adapter.notify("C1", undefined, "ping");
    expect(recordCalls).toEqual([["C1", "200.000001", "slack:C1"]]);

    // A threaded proactive post already shares the thread's conversationId → not recorded.
    recordCalls.length = 0;
    await adapter.notify("C1", "171.5", "ping again");
    expect(recordCalls).toEqual([]);
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
    files?: readonly Record<string, unknown>[];
  } = {},
): SlackEventCallback {
  const event: Record<string, unknown> = {
    type: "message",
    channel: options.channel ?? "D123",
    user: options.user ?? "UUSER1",
    text,
    ts: options.ts ?? "171.000001",
    event_ts: options.ts ?? "171.000001",
    channel_type: "im",
  };
  if (options.threadTs !== undefined) {
    event.thread_ts = options.threadTs;
  }
  if (options.files !== undefined) {
    event.files = options.files;
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
      user: "UUSER1",
      text,
      ts: "172.000001",
      event_ts: "172.000001",
    },
  };
}

function appHomeOpened(userId: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "EvHome",
    event_time: 173,
    event: {
      type: "app_home_opened",
      user: userId,
      tab: "home",
      event_ts: "173.000001",
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
