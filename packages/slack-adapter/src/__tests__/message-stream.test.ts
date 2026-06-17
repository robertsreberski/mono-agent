import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifySlackError,
  SlackDeliveryError,
  SlackMessageStream,
} from "../message-stream.js";
import { SlackApiError } from "../slack-client.js";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  nextTs = 100;
  failPostWith: Error | undefined;
  failUpdateWith: Error | undefined;

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }

  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    this.postMessageCalls.push(params);
    if (this.failPostWith !== undefined) {
      throw this.failPostWith;
    }
    return { ok: true, channel: params.channel, ts: `${this.nextTs++}.000001` };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    if (this.failUpdateWith !== undefined) {
      throw this.failUpdateWith;
    }
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }
}

function slackApiError(
  options: {
    method?: string;
    kind?: SlackApiError["kind"];
    status?: number;
    slackError?: string;
    retryAfterMs?: number;
  } = {},
): SlackApiError {
  return new SlackApiError("Slack API rejected the request.", {
    kind: options.kind ?? "slack",
    method: options.method ?? "chat.update",
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.slackError === undefined ? {} : { slackError: options.slackError }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  });
}

describe("SlackMessageStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts a status message and debounces Slack update calls", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      initialStatusText: "Starting",
      editDebounceMs: 50,
    });

    await stream.append("Hel");
    await stream.append("lo");

    expect(api.postMessageCalls).toEqual([
      { channel: "C1", text: "Starting", thread_ts: "171.000001", mrkdwn: true },
    ]);
    expect(api.updateCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(api.updateCalls).toEqual([
      { channel: "C1", ts: "100.000001", text: "Hello", mrkdwn: true },
    ]);
  });

  it("flushes final output and sends overflow chunks as thread replies (no labels)", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "D1",
      threadTs: "172.000001",
      editDebounceMs: 10_000,
      maxMessageChars: 32,
    });
    const finalText = "a".repeat(70);

    await stream.append("draft");
    await stream.finish(finalText);

    expect(api.updateCalls).toHaveLength(1);
    expect(api.updateCalls[0]?.text).toHaveLength(32);
    expect(api.postMessageCalls).toHaveLength(3);
    expect(api.postMessageCalls[0]).toEqual({
      channel: "D1",
      text: "Thinking...",
      thread_ts: "172.000001",
      mrkdwn: true,
    });
    expect(api.postMessageCalls[1]?.text).toHaveLength(32);
    expect(api.postMessageCalls[1]?.thread_ts).toBe("172.000001");
    expect(api.postMessageCalls[1]?.mrkdwn).toBe(true);
    expect(api.postMessageCalls[2]?.text).toHaveLength(6);
    expect(api.postMessageCalls[2]?.mrkdwn).toBe(true);
  });

  it("translates Markdown output to Slack mrkdwn for posts and updates", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      editDebounceMs: 0,
    });

    await stream.status("Working on **the fix**");
    await stream.append("## Result\n\n**Done** [details](https://example.com?a=1&b=2)");
    await vi.runAllTimersAsync();
    await stream.finish("__Final__ ~~ready~~");

    expect(api.postMessageCalls[0]).toEqual({
      channel: "C1",
      text: "Working on *the fix*",
      thread_ts: "171.000001",
      mrkdwn: true,
    });
    expect(api.updateCalls).toEqual([
      {
        channel: "C1",
        ts: "100.000001",
        text: "*Result*\n\n*Done* <https://example.com?a=1&amp;b=2|details>",
        mrkdwn: true,
      },
      {
        channel: "C1",
        ts: "100.000001",
        text: "*Final* ~ready~",
        mrkdwn: true,
      },
    ]);
  });

  it("uses a bounded preview for long in-progress content", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      threadTs: "171.000001",
      editDebounceMs: 0,
      maxMessageChars: 32,
    });

    await stream.append("x".repeat(60));
    await vi.runAllTimersAsync();

    expect(api.updateCalls[0]?.text).toHaveLength(32);
    expect(api.updateCalls[0]?.text.startsWith("...\n")).toBe(true);
  });

  it("does not surface an interim update failure to the caller", async () => {
    const api = new FakeSlackApi();
    api.failUpdateWith = new Error("update failed");
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
    });

    // Interim edits are best-effort; a failed update never throws back into the
    // stream consumer.
    await expect(stream.append("hello")).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(api.updateCalls.length).toBeGreaterThan(0);
  });

  it("still rejects append when the initial placeholder post fails", async () => {
    const api = new FakeSlackApi();
    api.failPostWith = new Error("post failed");

    await expect(
      new SlackMessageStream({ api, channelId: "C1" }).append("hello"),
    ).rejects.toThrow("post failed");
  });

  it("recreates a vanished message target by posting a fresh message", async () => {
    const postCalls: SlackChatPostMessageParams[] = [];
    const updateFailures = [slackApiError({ slackError: "message_not_found" })];
    let nextTs = 200;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: `${nextTs++}.000001` };
      },
      async chatUpdate(params) {
        const failure = updateFailures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C7", editDebounceMs: 0 });
    await expect(stream.finish("recovered answer")).resolves.toBeUndefined();

    expect(postCalls.map((call) => call.text)).toEqual([
      "Thinking...",
      "recovered answer",
    ]);
  });

  it("waits for retry-after then retries a rate-limited final update", async () => {
    let updateCalls = 0;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "400.000001" };
      },
      async chatUpdate(params) {
        updateCalls += 1;
        if (updateCalls === 1) {
          throw slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 2000 });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    const finished = stream.finish("rate limited answer");
    await vi.advanceTimersByTimeAsync(2000);

    await expect(finished).resolves.toBeUndefined();
    expect(updateCalls).toBe(2);
  });

  it("swallows a rate-limited interim update without waiting or failing", async () => {
    let updateCalls = 0;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "500.000001" };
      },
      async chatUpdate(params) {
        updateCalls += 1;
        if (updateCalls === 1) {
          throw slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 5000 });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    await stream.append("partial");
    await expect(stream.finish("done")).resolves.toBeUndefined();
    expect(updateCalls).toBe(2);
  });

  it("retries the final update with mrkdwn disabled when Slack rejects the markup", async () => {
    const updateParams: SlackChatUpdateParams[] = [];
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        return { ok: true as const, channel: params.channel, ts: "600.000001" };
      },
      async chatUpdate(params) {
        updateParams.push(params);
        if (params.mrkdwn !== false) {
          throw slackApiError({ slackError: "invalid_blocks" });
        }
        return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
      },
    };

    const stream = new SlackMessageStream({ api, channelId: "C1", editDebounceMs: 0 });
    await expect(stream.finish("**bold** answer")).resolves.toBeUndefined();

    expect(updateParams).toHaveLength(2);
    expect(updateParams[0]?.mrkdwn).toBe(true);
    expect(updateParams[1]?.mrkdwn).toBe(false);
  });

  it("falls back to a fresh post when the final update cannot be edited or recreated", async () => {
    const postCalls: SlackChatPostMessageParams[] = [];
    let nextTs = 700;
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: `${nextTs++}.000001` };
      },
      async chatUpdate() {
        // Persistent transient failure on every edit; recreate not signalled, so
        // the stream must last-resort a fresh post to deliver the answer.
        throw slackApiError({ kind: "network", method: "chat.update" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      maxSendRetries: 1,
      retryBaseDelayMs: 0,
    });
    const finished = stream.finish("last resort answer");
    await vi.runAllTimersAsync();
    await expect(finished).resolves.toBeUndefined();

    expect(postCalls.map((call) => call.text)).toEqual([
      "Thinking...",
      "last resort answer",
    ]);
  });

  it("throws SlackDeliveryError when even the last-resort post fails", async () => {
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        if (params.text === "Thinking...") {
          return { ok: true as const, channel: params.channel, ts: "800.000001" };
        }
        throw slackApiError({ kind: "network", method: "chat.postMessage" });
      },
      async chatUpdate() {
        throw slackApiError({ kind: "network", method: "chat.update" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      maxSendRetries: 0,
    });
    await expect(stream.finish("doomed answer")).rejects.toBeInstanceOf(SlackDeliveryError);
  });

  it("does not post a fresh message with the answer once aborted", async () => {
    const controller = new AbortController();
    const postCalls: SlackChatPostMessageParams[] = [];
    const api: SlackWebApi = {
      async authTest() {
        return { ok: true as const };
      },
      async appsConnectionsOpen() {
        return { ok: true as const, url: "wss://slack.test/socket" };
      },
      async chatPostMessage(params) {
        postCalls.push(params);
        return { ok: true as const, channel: params.channel, ts: "950.000001" };
      },
      async chatUpdate() {
        // Edit target is gone — without the abort guard this would recreate or
        // last-resort a brand-new message carrying the now-unwanted answer.
        throw slackApiError({ slackError: "message_not_found" });
      },
    };

    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      editDebounceMs: 0,
      abortSignal: controller.signal,
    });
    controller.abort(new Error("cancelled by user"));

    await expect(stream.finish("unwanted answer")).resolves.toBeUndefined();
    expect(postCalls.map((call) => call.text)).toEqual(["Thinking..."]);
  });

  it("shows a friendly activity hint on tool_call_started while no answer text yet", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });
    await vi.runAllTimersAsync();

    expect(api.updateCalls.at(-1)?.text).toBe("Searching the web…");
  });

  it("does not render assistant_thought reasoning as message text", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.event({ type: "assistant_thought", text: "secret private reasoning" });
    await stream.append("answer");
    await stream.finish("answer");

    const allText = [
      ...api.postMessageCalls.map((call) => call.text),
      ...api.updateCalls.map((call) => call.text),
    ];
    expect(allText.some((text) => text.includes("secret private reasoning"))).toBe(false);
    expect(api.updateCalls.at(-1)?.text).toBe("answer");
  });

  it("stops refreshing the hint once answer text streams in", async () => {
    const api = new FakeSlackApi();
    const stream = new SlackMessageStream({
      api,
      channelId: "C1",
      initialStatusText: "Thinking...",
      editDebounceMs: 0,
    });

    await stream.status("Thinking...");
    await stream.append("partial answer");
    await stream.event({ type: "tool_call_started", id: "t2", name: "WebSearch" });
    await vi.runAllTimersAsync();

    // After answer text exists, a tool-start hint must not overwrite it.
    expect(api.updateCalls.at(-1)?.text).toBe("partial answer");
  });
});

describe("classifySlackError", () => {
  it("classifies ratelimited / 429 as retry with the honored retry-after", () => {
    expect(
      classifySlackError(slackApiError({ slackError: "ratelimited", status: 429, retryAfterMs: 3000 })),
    ).toEqual({ kind: "retry", retryAfterMs: 3000 });
    expect(classifySlackError(slackApiError({ status: 429 }))).toEqual({ kind: "retry" });
  });

  it("classifies missing/non-editable messages as recreate", () => {
    expect(classifySlackError(slackApiError({ slackError: "message_not_found" }))).toEqual({
      kind: "recreate",
    });
    expect(classifySlackError(slackApiError({ slackError: "cant_update_message" }))).toEqual({
      kind: "recreate",
    });
    expect(classifySlackError(slackApiError({ slackError: "edit_window_closed" }))).toEqual({
      kind: "recreate",
    });
  });

  it("classifies markup errors as reformat-plain", () => {
    expect(classifySlackError(slackApiError({ slackError: "invalid_blocks" }))).toEqual({
      kind: "reformat_plain",
    });
  });

  it("classifies network/5xx/aborted appropriately", () => {
    expect(classifySlackError(slackApiError({ kind: "network" }))).toEqual({ kind: "retry" });
    expect(classifySlackError(slackApiError({ kind: "http", status: 503 }))).toEqual({
      kind: "retry",
    });
    expect(classifySlackError(slackApiError({ kind: "aborted" }))).toEqual({ kind: "fatal" });
  });

  it("retries unknown non-SlackApiError failures conservatively", () => {
    expect(classifySlackError(new Error("boom"))).toEqual({ kind: "retry" });
  });
});
