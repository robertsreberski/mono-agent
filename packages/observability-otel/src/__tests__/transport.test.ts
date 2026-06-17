import { describe, expect, it, vi } from "vitest";

import { postOtlpJson } from "../transport.js";

describe("postOtlpJson", () => {
  it("posts application/json to the endpoint and returns ok/status", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    });

    const result = await postOtlpJson({
      endpoint: "http://127.0.0.1:6006/v1/traces",
      headers: { authorization: "Bearer secret" },
      body: { resourceSpans: [] },
      timeoutMs: 5000,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:6006/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer secret");
    expect(calls[0]!.init.method).toBe("POST");
    expect(typeof calls[0]!.init.body).toBe("string");
  });

  it("clears the timeout on success (no dangling timer aborts)", async () => {
    vi.useFakeTimers();
    try {
      const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }));
      const promise = postOtlpJson({
        endpoint: "http://127.0.0.1:6006/v1/traces",
        body: {},
        timeoutMs: 5000,
        fetchImpl: fakeFetch as unknown as typeof fetch,
      });
      await promise;
      // Advancing past the timeout must not throw or abort anything after success.
      vi.advanceTimersByTime(10_000);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the request after timeoutMs via AbortController", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fakeFetch = vi.fn((_url: string | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });

      const promise = postOtlpJson({
        endpoint: "http://127.0.0.1:6006/v1/traces",
        body: {},
        timeoutMs: 1000,
        fetchImpl: fakeFetch as unknown as typeof fetch,
      });
      const settled = promise.then(
        () => "resolved",
        () => "rejected",
      );
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(capturedSignal?.aborted).toBe(true);
      expect(await settled).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});
