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

  it("re-applies the current provider definition to a warm cache entry without re-probing", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response({
      data: [{ id: "live-a" }, { id: "live-b" }],
    }))) as unknown as typeof fetch;
    const disabledLmStudio = { id: "lmstudio", enabled: false } as const;

    const first = await discoverLocalProviders({
      fetch: fetchImpl,
      configured: [{ id: "ollama" }, disabledLmStudio],
    });
    expect(first.find((provider) => provider.id === "ollama")?.models)
      .toEqual([{ name: "live-a" }, { name: "live-b" }]);

    // The operator edits the provider (allowlist + cap) and the channel
    // restarts inside the 60 s TTL. The cache holds only the probe's live
    // model ids, so the new definition applies immediately.
    const second = await discoverLocalProviders({
      fetch: fetchImpl,
      configured: [
        { id: "ollama", models: [{ name: "pinned" }, { name: "also-pinned" }], maxAdvertisedModels: 1 },
        disabledLmStudio,
      ],
    });
    expect(second.find((provider) => provider.id === "ollama")?.models)
      .toEqual([expect.objectContaining({ name: "pinned" })]);

    // A widened cap re-reads the same cached live list rather than the stale
    // advertised projection.
    const third = await discoverLocalProviders({
      fetch: fetchImpl,
      configured: [{ id: "ollama", maxAdvertisedModels: 1 }, disabledLmStudio],
    });
    expect(third.find((provider) => provider.id === "ollama")?.models).toEqual([{ name: "live-a" }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by the probed endpoint, so a type change re-probes", async () => {
    const fetchImpl = vi.fn((input: FetchInput) => Promise.resolve(response({
      data: [{ id: urlString(input) }],
    }))) as unknown as typeof fetch;
    const disabledLmStudio = { id: "lmstudio", enabled: false } as const;

    await discoverLocalProviders({
      fetch: fetchImpl,
      configured: [{ id: "ollama", baseUrl: "http://localhost:11434/api" }, disabledLmStudio],
    });
    const retyped = await discoverLocalProviders({
      fetch: fetchImpl,
      configured: [
        { id: "ollama", type: "openai_compat", baseUrl: "http://localhost:11434/api" },
        disabledLmStudio,
      ],
    });

    // ollama rewrites `/api` to its OpenAI-compat `/v1` root; openai_compat
    // appends `/v1` to the path as given. Different endpoints for the same
    // id+baseUrl, so the second definition must probe rather than read the
    // first one's cache entry.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retyped.find((provider) => provider.id === "ollama")?.models)
      .toEqual([{ name: "http://localhost:11434/api/v1/models" }]);
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

  it("does not let a slower earlier probe negative-cache over a newer live result", async () => {
    // `discoverLocalProviders` is exported publicly, so two callers can force a
    // refresh concurrently. Both then probe, and completion order is not start
    // order: the earlier probe answering last used to overwrite the later one,
    // caching "no models" over a live answer for the rest of the 60 s TTL.
    const deferred: { resolve: (value: Response) => void; reject: (reason: unknown) => void }[] = [];
    const racingFetch = vi.fn(() => new Promise<Response>((resolve, reject) => {
      deferred.push({ resolve, reject });
    })) as unknown as typeof fetch;
    const warmFetch = vi.fn(() => Promise.resolve(response({ data: [{ id: "warm" }] }))) as unknown as typeof fetch;
    const configured = [{ id: "lmstudio", enabled: false } as const];

    // Warm the entry so both forced refreshes take the probe path.
    await discoverLocalProviders({ fetch: warmFetch, configured });
    expect(warmFetch).toHaveBeenCalledTimes(1);

    const older = discoverLocalProviders({ fetch: racingFetch, configured, forceRefresh: true });
    const newer = discoverLocalProviders({ fetch: racingFetch, configured, forceRefresh: true });
    expect(deferred).toHaveLength(2);

    // The probe that STARTED SECOND answers first, and answers live.
    deferred[1]!.resolve(response({ data: [{ id: "live" }] }));
    await expect(newer).resolves.toEqual([
      expect.objectContaining({ id: "ollama", models: [{ name: "live" }] }),
    ]);
    // The probe that started FIRST then fails.
    deferred[0]!.reject(new Error("ECONNREFUSED"));

    // Its caller is handed the newer cached observation, not its own stale one.
    await expect(older).resolves.toEqual([
      expect.objectContaining({ id: "ollama", models: [{ name: "live" }] }),
    ]);

    // And the next warm read still serves the live model without re-probing.
    const afterwards = await discoverLocalProviders({ fetch: warmFetch, configured });
    expect(afterwards.find((provider) => provider.id === "ollama")?.models).toEqual([{ name: "live" }]);
    expect(warmFetch).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight probe's result when the cache is cleared beneath it", async () => {
    let settle: ((value: Response) => void) | undefined;
    const slowFetch = vi.fn(() => new Promise<Response>((resolve) => {
      settle = resolve;
    })) as unknown as typeof fetch;
    const configured = [{ id: "lmstudio", enabled: false } as const];

    const pending = discoverLocalProviders({ fetch: slowFetch, configured });
    clearLocalProviderDiscoveryCache();
    settle!(response({ data: [{ id: "retired" }] }));
    await pending;

    const nextFetch = vi.fn(() => Promise.resolve(response({ data: [{ id: "fresh" }] }))) as unknown as typeof fetch;
    const after = await discoverLocalProviders({ fetch: nextFetch, configured });

    expect(after.find((provider) => provider.id === "ollama")?.models).toEqual([{ name: "fresh" }]);
    expect(nextFetch).toHaveBeenCalledTimes(1);
  });
});
