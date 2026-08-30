import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLocalProviderDiscoveryCache,
  discoverLocalProviders,
} from "../provider-discovery.js";

type FetchInput = Parameters<typeof fetch>[0];

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function urlString(input: FetchInput): string {
  return typeof input === "string" ? input : input.toString();
}

describe("discoverLocalProviders", () => {
  beforeEach(() => clearLocalProviderDiscoveryCache());

  it("discovers both default endpoints in parallel", async () => {
    const fetchImpl = vi.fn((input: FetchInput) => {
      const url = urlString(input);
      return Promise.resolve(response({
        data: [{ id: url.includes("11434") ? "qwen3:8b" : "local-model" }],
      }));
    }) as unknown as typeof fetch;

    const providers = await discoverLocalProviders({ fetch: fetchImpl });

    expect(providers.map((provider) => provider.id)).toEqual(["ollama", "lmstudio"]);
    expect(providers[0]?.models).toEqual([{ name: "qwen3:8b" }]);
    expect(providers[1]?.models).toEqual([{ name: "local-model" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the answering provider when the other endpoint fails", async () => {
    const providers = await discoverLocalProviders({
      fetch: vi.fn((input: FetchInput) => urlString(input).includes("11434")
        ? Promise.resolve(response({ data: [{ id: "gemma3" }] }))
        : Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["ollama"]);
  });

  it("resolves empty when neither endpoint answers", async () => {
    const providers = await discoverLocalProviders({
      fetch: vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });

    expect(providers).toEqual([]);
  });

  it("times out both probes and resolves empty", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = vi.fn((_input: FetchInput, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;
      const pending = discoverLocalProviders({ fetch: hangingFetch, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fetches when both explicitly configured endpoints are disabled", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const providers = await discoverLocalProviders({
      configured: [
        { id: "ollama", enabled: false },
        { id: "lmstudio", enabled: false },
      ],
      fetch: fetchImpl,
    });

    expect(providers).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the 60 second cache without refetching warm endpoints", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response({ data: [{ id: "cached" }] }))) as unknown as typeof fetch;

    await discoverLocalProviders({ fetch: fetchImpl });
    await discoverLocalProviders({ fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("permits only one forced refresh during a warm TTL window", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response({ data: [{ id: "fresh" }] }))) as unknown as typeof fetch;

    await discoverLocalProviders({ fetch: fetchImpl });
    await discoverLocalProviders({ fetch: fetchImpl, forceRefresh: true });
    await discoverLocalProviders({ fetch: fetchImpl, forceRefresh: true });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats a 500 and a non-JSON body as independent empty results", async () => {
    const providers = await discoverLocalProviders({
      fetch: vi.fn((input: FetchInput) => urlString(input).includes("11434")
        ? Promise.resolve(response({ data: [{ id: "ignored" }] }, false))
        : Promise.resolve({
            ok: true,
            json: () => Promise.reject(new SyntaxError("not JSON")),
          } as unknown as Response)) as unknown as typeof fetch,
    });

    expect(providers).toEqual([]);
  });

  it("probes a declared provider for liveness but advertises only its listed models", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response({ data: [{ id: "live-but-hidden" }] }))) as unknown as typeof fetch;
    const providers = await discoverLocalProviders({
      configured: [{
        id: "ollama",
        models: [{ name: "configured-only" }],
        maxAdvertisedModels: 1,
      }],
      fetch: fetchImpl,
    });

    expect(providers.find((provider) => provider.id === "ollama")?.models).toEqual([
      expect.objectContaining({ name: "configured-only" }),
    ]);
  });
});
