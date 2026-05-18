import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackMessageStream, splitSlackText } from "../message-stream.js";
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
      { channel: "C1", text: "Starting", thread_ts: "171.000001" },
    ]);
    expect(api.updateCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(api.updateCalls).toEqual([
      { channel: "C1", ts: "100.000001", text: "Hello" },
    ]);
  });

  it("flushes final output and sends overflow chunks as thread replies", async () => {
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
    });
    expect(api.postMessageCalls[1]?.text).toHaveLength(32);
    expect(api.postMessageCalls[1]?.thread_ts).toBe("172.000001");
    expect(api.postMessageCalls[2]?.text).toHaveLength(6);
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

  it("propagates send and update failures", async () => {
    const postApi = new FakeSlackApi();
    postApi.failPostWith = new Error("post failed");
    const updateApi = new FakeSlackApi();
    updateApi.failUpdateWith = new Error("update failed");

    await expect(
      new SlackMessageStream({ api: postApi, channelId: "C1" }).append("hello"),
    ).rejects.toThrow("post failed");

    await expect(
      new SlackMessageStream({ api: updateApi, channelId: "C1" }).finish("done"),
    ).rejects.toThrow("update failed");
  });
});

describe("splitSlackText", () => {
  it("splits text without dropping characters", () => {
    expect(splitSlackText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(splitSlackText("abc", 10)).toEqual(["abc"]);
  });
});
