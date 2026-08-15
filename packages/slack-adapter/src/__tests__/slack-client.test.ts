import { describe, expect, it, vi } from "vitest";

import {
  SlackApiError,
  SlackWebApiClient,
} from "../slack-client.js";

const BOT_TOKEN = "test-bot-token";
const APP_TOKEN = "test-app-token";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("SlackWebApiClient", () => {
  it("performs Slack's modern external file upload flow without sending auth to the capability URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/files.getUploadURLExternal")) {
        return jsonResponse({
          ok: true,
          upload_url: "https://uploads.slack.test/opaque-capability",
          file_id: "F123",
        });
      }
      if (url === "https://uploads.slack.test/opaque-capability") return new Response("OK", { status: 200 });
      return jsonResponse({ ok: true, files: [{ id: "F123" }] });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      apiBaseUrl: "https://slack.example/api",
      fetchImpl,
      requestTimeoutMs: 0,
    });
    const bytes = new TextEncoder().encode("hello");

    const pending = await client.filesGetUploadURLExternal({ filename: "report.txt", length: bytes.byteLength });
    await client.filesUploadExternal({ uploadUrl: pending.upload_url, data: bytes });
    await client.filesCompleteUploadExternal({
      files: [{ id: pending.file_id, title: "report.txt" }],
      channel_id: "C1",
      thread_ts: "100.1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [getUrl, getInit] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(getUrl)).toBe("https://slack.example/api/files.getUploadURLExternal");
    expect(JSON.parse(String(getInit?.body))).toEqual({ filename: "report.txt", length: 5 });
    const [uploadUrl, uploadInit] = vi.mocked(fetchImpl).mock.calls[1] ?? [];
    expect(String(uploadUrl)).toBe("https://uploads.slack.test/opaque-capability");
    expect(uploadInit?.headers).toEqual({
      "content-type": "application/octet-stream",
      "content-length": "5",
    });
    expect(JSON.stringify(uploadInit?.headers)).not.toContain(BOT_TOKEN);
    const [completeUrl, completeInit] = vi.mocked(fetchImpl).mock.calls[2] ?? [];
    expect(String(completeUrl)).toBe("https://slack.example/api/files.completeUploadExternal");
    expect(JSON.parse(String(completeInit?.body))).toEqual({
      files: [{ id: "F123", title: "report.txt" }],
      channel_id: "C1",
      thread_ts: "100.1",
    });
  });

  it("sends Slack write requests with bearer auth and JSON bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1", message: { text: "hello" } }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      apiBaseUrl: "https://slack.example/api/",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const result = await client.chatPostMessage({ channel: "C1", text: "hello" });

    expect(result).toMatchObject({ ok: true, channel: "C1", ts: "171.1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.example/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: `Bearer ${BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", text: "hello" });
  });

  it("reads a thread anchored at a known message through conversations.replies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, messages: [{ ts: "170.1", text: "root" }], has_more: false }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      apiBaseUrl: "https://slack.example/api",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(
      client.conversationsReplies({
        channelId: "C1",
        threadTs: "170.1",
        latest: "172.5",
        inclusive: true,
        limit: 15,
      }),
    ).resolves.toMatchObject({ ok: true, messages: [{ ts: "170.1" }] });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://slack.example/api/conversations.replies?channel=C1&ts=170.1&latest=172.5&inclusive=true&limit=15",
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${BOT_TOKEN}` },
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
    expect(init?.body).toBeUndefined();
  });

  it("omits unset window arguments from conversations.history", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, messages: [] })) as unknown as typeof fetch;
    const client = new SlackWebApiClient({ botToken: BOT_TOKEN, fetchImpl, requestTimeoutMs: 0 });

    await client.conversationsHistory({ channelId: "C1", limit: 15 });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://slack.com/api/conversations.history?channel=C1&limit=15",
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${BOT_TOKEN}` },
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
    expect(init?.body).toBeUndefined();
  });

  it("resolves a member profile through users.info", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, user: { name: "alice", profile: { display_name: "Alice Chen" } } }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      apiBaseUrl: "https://slack.example/api",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.usersInfo({ userId: "U1" })).resolves.toMatchObject({
      ok: true,
      user: { name: "alice" },
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.example/api/users.info?user=U1");
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${BOT_TOKEN}` },
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
    expect(init?.body).toBeUndefined();
  });

  it("describes a channel through conversations.info", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: { name: "general", is_channel: true } }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      apiBaseUrl: "https://slack.example/api",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.conversationsInfo({ channelId: "C1" })).resolves.toMatchObject({
      ok: true,
      channel: { name: "general", is_channel: true },
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.example/api/conversations.info?channel=C1");
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${BOT_TOKEN}` },
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
    expect(init?.body).toBeUndefined();
  });

  it("carries Retry-After off a rate-limited ok:false envelope, not just an HTTP 429", async () => {
    // Slack can rate-limit with an HTTP 200 envelope; dropping the hint there
    // would leave a caller's cooldown with nothing to latch onto.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "42" } }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({ botToken: BOT_TOKEN, fetchImpl, requestTimeoutMs: 0 });

    await expect(client.usersInfo({ userId: "U1" })).rejects.toMatchObject({
      kind: "slack",
      slackError: "ratelimited",
      retryAfterMs: 42_000,
    });
  });

  it("surfaces the needed scope from a missing_scope envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "missing_scope", needed: "users:read", provided: "chat:write" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({ botToken: BOT_TOKEN, fetchImpl, requestTimeoutMs: 0 });

    await expect(client.usersInfo({ userId: "U1" })).rejects.toMatchObject({
      kind: "slack",
      slackError: "missing_scope",
      needed: "users:read",
      provided: "chat:write",
    });
  });

  it("uses the app token for Socket Mode connection URLs", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, url: "wss://wss.slack.com/link/?ticket=abc" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.appsConnectionsOpen()).resolves.toEqual({
      ok: true,
      url: "wss://wss.slack.com/link/?ticket=abc",
    });

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${APP_TOKEN}` });
  });

  it("deletes a transient message through chat.delete", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.chatDelete({ channel: "C1", ts: "171.1" })).resolves.toMatchObject({
      ok: true,
      channel: "C1",
      ts: "171.1",
    });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.com/api/chat.delete");
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", ts: "171.1" });
  });

  it("allows send-only clients without an app token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.chatPostMessage({ channel: "C1", text: "hello" })).resolves.toMatchObject({
      ok: true,
      channel: "C1",
      ts: "171.1",
    });
    await expect(client.appsConnectionsOpen()).rejects.toThrow(/app token is required/u);
  });

  it("throws sanitized errors for Slack ok=false envelopes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "invalid_auth", needed: BOT_TOKEN }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.chatUpdate({ channel: "C1", ts: "171.1", text: "updated" }),
    );

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ kind: "slack", slackError: "invalid_auth" });
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it("throws sanitized HTTP, network, abort, and malformed errors", async () => {
    const http = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => new Response(`body ${BOT_TOKEN}`, { status: 502 })) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const network = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new Error(`network ${BOT_TOKEN}`);
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const aborted = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const malformed = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => new Response("not json")) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });

    await expect(http.authTest()).rejects.toMatchObject({ kind: "http", status: 502 });
    await expect(network.authTest()).rejects.toMatchObject({ kind: "network" });
    await expect(aborted.usersInfo({ userId: "U1" })).rejects.toMatchObject({
      kind: "aborted",
      method: "users.info",
    });
    await expect(malformed.authTest()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("downloads a private file with bot bearer auth via GET", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const result = await client.downloadFile({ url: "https://files.slack.test/p.png" });

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://files.slack.test/p.png");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
  });

  it("rejects a download that exceeds the configured byte cap", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetchImpl = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(
      client.downloadFile({ url: "https://files.slack.test/big.bin", maxBytes: 4 }),
    ).rejects.toBeInstanceOf(SlackApiError);
  });

  it("surfaces a sanitized HTTP error for a failed download", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`body ${BOT_TOKEN}`, { status: 403 }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.downloadFile({ url: "https://files.slack.test/forbidden.png" }),
    );
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ kind: "http", status: 403 });
    expect(error.message).not.toContain(BOT_TOKEN);
  });
});

async function captureError(action: () => Promise<unknown>): Promise<SlackApiError> {
  try {
    await action();
  } catch (error) {
    return error as SlackApiError;
  }
  throw new Error("Expected action to throw.");
}
