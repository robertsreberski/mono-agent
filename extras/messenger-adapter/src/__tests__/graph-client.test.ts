import { describe, expect, it, vi } from "vitest";

import {
  MessengerAmbiguousDeliveryError,
  MessengerGraphClient,
  MessengerGraphError,
  retryAfterMsFromHeader,
} from "../graph-client.js";

const TOKEN = "EAAG-secret-page-token-0123456789";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof fetch, options: { timeoutMs?: number } = {}): MessengerGraphClient {
  return new MessengerGraphClient({
    pageAccessToken: TOKEN,
    apiVersion: "v21.0",
    fetch: fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function networkError(name: "TypeError" | "AbortError"): Error {
  const error = new Error(name === "AbortError" ? "aborted" : "fetch failed");
  error.name = name;
  return error;
}

describe("Send API retry safety", () => {
  it("does not replay a message POST whose outcome is unknown after a 5xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: { message: "unavailable" } }));

    await expect(client(fetchImpl as unknown as typeof fetch).sendText("42", "hello"))
      .rejects.toBeInstanceOf(MessengerAmbiguousDeliveryError);
    // Exactly one attempt: a replay could deliver the message twice.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([["TypeError"], ["AbortError"]] as const)(
    "does not replay a message POST after a %s transport failure",
    async (name) => {
      const fetchImpl = vi.fn(async () => {
        throw networkError(name);
      });

      await expect(client(fetchImpl as unknown as typeof fetch).sendText("42", "hello"))
        .rejects.toBeInstanceOf(MessengerAmbiguousDeliveryError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a message POST once after a 429, which the server refused before acting", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "0.02" })
        : jsonResponse(200, { message_id: "mid.1" });
    });

    const result = await client(fetchImpl as unknown as typeof fetch).sendText("42", "hello");

    expect(result.messageIds).toEqual(["mid.1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces an ambiguous outcome on the 429 retry rather than replaying again", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "0.02" })
        : jsonResponse(500, { error: { message: "boom" } });
    });

    await expect(client(fetchImpl as unknown as typeof fetch).sendText("42", "hello"))
      .rejects.toBeInstanceOf(MessengerAmbiguousDeliveryError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a clean 4xx rejection and keeps it a MessengerGraphError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { message: "bad recipient", code: 100 } }));

    await expect(client(fetchImpl as unknown as typeof fetch).sendText("42", "hello"))
      .rejects.toBeInstanceOf(MessengerGraphError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the chunks already delivered before an ambiguous one", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { message_id: "mid.1" })
        : jsonResponse(502, { error: { message: "gateway" } });
    });
    const text = `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`;

    const error = await client(fetchImpl as unknown as typeof fetch).sendText("42", text).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MessengerAmbiguousDeliveryError);
    expect((error as MessengerAmbiguousDeliveryError).deliveredMessageIds).toEqual(["mid.1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still retries a replay-safe sender action", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse(503, { error: { message: "unavailable" } }, { "retry-after": "0.02" })
        : jsonResponse(200, {});
    });

    await client(fetchImpl as unknown as typeof fetch).senderAction("42", "typing_on");

    // A duplicate `typing_on` is a no-op, so replaying it is safe.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("retryAfterMsFromHeader", () => {
  it("parses delta-seconds, clamps, and rejects unusable values", () => {
    expect(retryAfterMsFromHeader("2")).toBe(2_000);
    expect(retryAfterMsFromHeader(" 0.5 ")).toBe(500);
    expect(retryAfterMsFromHeader("3600")).toBe(10_000); // clamped to MAX_RETRY_AFTER_MS
    expect(retryAfterMsFromHeader("0")).toBeUndefined();
    expect(retryAfterMsFromHeader("-5")).toBeUndefined();
    expect(retryAfterMsFromHeader("later")).toBeUndefined();
    expect(retryAfterMsFromHeader(null)).toBeUndefined();
    expect(retryAfterMsFromHeader(new Date(Date.now() + 60_000).toUTCString())).toBe(10_000);
  });
});

describe("Graph error redaction", () => {
  it("removes a reflected page token from a structured error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {
      error: {
        message: `Invalid OAuth access token: ${TOKEN} was rejected`,
        type: "OAuthException",
        code: 190,
        error_subcode: 460,
        fbtrace_id: "Axb12",
      },
    }));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .senderAction("42", "mark_seen")
      .catch((e: unknown) => e) as MessengerGraphError;

    const detail = JSON.stringify(error.detail);
    expect(detail).not.toContain(TOKEN);
    expect(detail).toContain("<redacted>");
    expect(error.detail).toMatchObject({ type: "OAuthException", code: 190, fbtrace_id: "Axb12" });
  });

  it("removes a reflected token, bearer header, and query form from a text body", async () => {
    const body = [
      `raw token ${TOKEN}`,
      `authorization: Bearer ${TOKEN}`,
      `https://graph.facebook.com/me?access_token=${TOKEN}&x=1`,
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500, headers: { "content-type": "text/plain", "retry-after": "0.01" } }));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .senderAction("42", "mark_seen")
      .catch((e: unknown) => e) as MessengerGraphError;

    expect(String(error.detail)).not.toContain(TOKEN);
    expect(String(error.detail)).toContain("<redacted>");
    // The non-secret part of the body stays inspectable.
    expect(String(error.detail)).toContain("graph.facebook.com");
  });

  it("redacts a bearer credential that is not the configured token", async () => {
    const other = "EAAG-some-other-credential-9876";
    const fetchImpl = vi.fn(async () => new Response(`authorization: Bearer ${other}`, { status: 500, headers: { "retry-after": "0.01" } }));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .senderAction("42", "mark_seen")
      .catch((e: unknown) => e) as MessengerGraphError;

    expect(String(error.detail)).not.toContain(other);
  });

  it("drops structured fields outside the retained allowlist", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {
      error: {
        message: "nope",
        code: 100,
        // A field we do not model must not be copied through blindly.
        debug_payload: { authorization: `Bearer ${TOKEN}` },
      },
    }));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .senderAction("42", "mark_seen")
      .catch((e: unknown) => e) as MessengerGraphError;

    expect(JSON.stringify(error.detail)).not.toContain(TOKEN);
    expect(error.detail).toEqual({ message: "nope", code: 100 });
  });

  it("bounds a very long error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(10_000), { status: 500, headers: { "retry-after": "0.01" } }));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .senderAction("42", "mark_seen")
      .catch((e: unknown) => e) as MessengerGraphError;

    expect(String(error.detail)).toHaveLength(2_000);
  });
});
