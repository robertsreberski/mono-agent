import { describe, expect, it, vi } from "vitest";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";

const url = "https://example.com/limited";
const ctx = { workspace: process.cwd(), sandbox: passthroughSandbox };

describe("terminal fetch refusals", () => {
  it.each([200, 503])("classifies binary login responses before retries or fallback (%i)", async (status) => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0, 0, 0]), { status, headers: { "content-type": "application/octet-stream" } }));
    const result = await performWebFetch({ url: "https://example.com/login" }, {
      ctx, fetchImpl, retryDelaysMs: [0, 0], fetchConfig: { provider: ["local", "parallel"] },
    });
    expect(result).toMatchObject({ error: true, outcome: { code: "authentication_required", attempts: 1, attemptedProviders: ["local"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not repeat a 429 or forward the URL to parallel", async () => {
    const fetchImpl = vi.fn(async () => new Response("Too many requests", { status: 429, headers: { "retry-after": "3600" } }));
    const result = await performWebFetch({ url }, {
      ctx, fetchImpl, retryDelaysMs: [0, 0], fetchConfig: { provider: ["local", "parallel"] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: true, outcome: {
      code: "http_429", status: "blocked", retryable: false, retryAfterMs: 3_600_000,
      attempts: 1, attemptedProviders: ["local"], fallbackUsed: false,
    } });
  });

  it.each([200, 503])("does not retry or change provider for a %i access challenge", async (status) => {
    const fetchImpl = vi.fn(async () => new Response('<html><body>Verify you are human <div id="cf-chl-widget">Challenge</div></body></html>', { status, headers: { "content-type": "text/html" } }));
    const result = await performWebFetch({ url }, {
      ctx, fetchImpl, retryDelaysMs: [0, 0], fetchConfig: { provider: ["local", "parallel"] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: true, outcome: { code: "access_challenge", attemptedProviders: ["local"], attempts: 1 } });
  });

  it.each([401, 403, 407])("keeps HTTP %i terminal for explicit provider chains", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("Forbidden", { status }));
    const result = await performWebFetch({ url }, { ctx, fetchImpl, fetchConfig: { provider: ["local", "parallel"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome.attemptedProviders).toEqual(["local"]);
  });

  it("still retries a genuine transient outage within the existing bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("Unavailable", { status: 503 })).mockResolvedValueOnce(new Response("Recovered source", { headers: { "content-type": "text/plain" } }));
    const result = await performWebFetch({ url }, { ctx, fetchImpl, retryDelaysMs: [0] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ error: false, outcome: { attempts: 2 } });
  });
});
