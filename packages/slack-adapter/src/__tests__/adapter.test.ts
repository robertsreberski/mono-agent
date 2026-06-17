import { describe, expect, it, vi } from "vitest";

import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

import {
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
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  readonly reactionsAddCalls: SlackReactionsAddParams[] = [];
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

  async reactionsAdd(params: SlackReactionsAddParams): Promise<void> {
    this.reactionsAddCalls.push(params);
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
