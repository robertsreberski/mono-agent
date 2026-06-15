import { describe, expect, it, vi } from "vitest";

import {
  TelegramApiError,
  TelegramBotApiClient,
} from "../telegram-client.js";

const TOKEN = "123456:test-token";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("TelegramBotApiClient", () => {
  it("sends Bot API requests to the configured endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: 10, chat: { id: 42 }, text: "hello" },
      }),
    ) as unknown as typeof fetch;

    const client = new TelegramBotApiClient({
      token: TOKEN,
      apiBaseUrl: "https://telegram.example/",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const result = await client.sendMessage({ chat_id: 42, text: "hello" });

    expect(result).toEqual({ message_id: 10, chat: { id: 42 }, text: "hello" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://telegram.example/bot123456:test-token/sendMessage",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: 42,
      text: "hello",
    });
  });

  it("parses successful Telegram result envelopes", async () => {
    const updates = [{ update_id: 1 }, { update_id: 2 }];
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: updates }),
    ) as unknown as typeof fetch;
    const client = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.getUpdates({ offset: 100 })).resolves.toEqual(updates);
  });

  it("allows the default request timeout to cover Telegram 30s long polls", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve(jsonResponse({ ok: true, result: [] }));
          }, 30_100);
          signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }) as unknown as typeof fetch;
      const client = new TelegramBotApiClient({
        token: TOKEN,
        fetchImpl,
      });

      const updates = client.getUpdates({ timeout: 30 });
      await vi.advanceTimersByTimeAsync(30_100);

      await expect(updates).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws sanitized errors for HTTP failures", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(`body mentions ${TOKEN}`, { status: 502 }),
    ) as unknown as typeof fetch;
    const client = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.sendMessage({ chat_id: 1, text: "hello" }),
    );

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ kind: "http", status: 502 });
    expect(error.message).not.toContain(TOKEN);
  });

  it("throws Telegram API errors for ok=false envelopes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    ) as unknown as typeof fetch;
    const client = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.sendMessage({ chat_id: 1, text: "hello" }),
    );

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      kind: "telegram",
      errorCode: 403,
      telegramDescription: "Forbidden: bot was blocked by the user",
    });
    expect(error.message).not.toContain(TOKEN);
  });

  it("lifts retry_after from an ok=false rate-limit envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 7",
        parameters: { retry_after: 7 },
      }),
    ) as unknown as typeof fetch;
    const client = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.sendMessage({ chat_id: 1, text: "hello" }),
    );

    expect(error).toMatchObject({ kind: "telegram", errorCode: 429, retryAfterMs: 7000 });
    expect(error.message).not.toContain(TOKEN);
  });

  it("lifts retry_after from an HTTP 429 response body and header", async () => {
    const bodyClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), {
          status: 429,
        }),
      ) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const headerClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () =>
        new Response(`rate limited ${TOKEN}`, {
          status: 429,
          headers: { "retry-after": "5" },
        }),
      ) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });

    const bodyError = await captureError(() =>
      bodyClient.sendMessage({ chat_id: 1, text: "hello" }),
    );
    const headerError = await captureError(() =>
      headerClient.sendMessage({ chat_id: 1, text: "hello" }),
    );

    expect(bodyError).toMatchObject({ kind: "http", status: 429, retryAfterMs: 3000 });
    expect(headerError).toMatchObject({ kind: "http", status: 429, retryAfterMs: 5000 });
    expect(headerError.message).not.toContain(TOKEN);
  });

  it("throws malformed errors for invalid JSON and response shapes", async () => {
    const invalidJsonClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () =>
        new Response("not-json", { status: 200 }),
      ) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const invalidShapeClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ ok: true }),
      ) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });

    await expect(
      invalidJsonClient.sendMessage({ chat_id: 1, text: "hello" }),
    ).rejects.toMatchObject({ kind: "malformed" });
    await expect(
      invalidShapeClient.sendMessage({ chat_id: 1, text: "hello" }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("throws sanitized network and abort errors", async () => {
    const networkClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new Error(`network error includes ${TOKEN}`);
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const abortClient = new TelegramBotApiClient({
      token: TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });

    const networkError = await captureError(() =>
      networkClient.sendMessage({ chat_id: 1, text: "hello" }),
    );
    const abortError = await captureError(() =>
      abortClient.sendMessage({ chat_id: 1, text: "hello" }),
    );

    expect(networkError).toMatchObject({ kind: "network" });
    expect(abortError).toMatchObject({ kind: "aborted" });
    expect(networkError.message).not.toContain(TOKEN);
    expect(abortError.message).not.toContain(TOKEN);
  });
});

async function captureError(action: () => Promise<unknown>): Promise<TelegramApiError> {
  try {
    await action();
  } catch (error) {
    return error as TelegramApiError;
  }

  throw new Error("Expected action to throw.");
}
