import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { startTuiAdapter } from "@mono-agent/channel-operator";
import { startWebServer } from "@mono-agent/web";
import type { ProviderUsageHistory, ProviderUsageOperator } from "@mono-agent/contracts";

/** Built producer → real operator HTTP → built web HTTP, with no vendor network. */
it("round-trips retained quota history and local usage through built boundaries", async () => {
  const { createProviderUsageService } = await import(new URL("../../dist/providers/provider-usage.js", import.meta.url).href) as typeof import("../providers/provider-usage.js");
  const { createProviderUsageHistoryStore } = await import(new URL("../../dist/providers/provider-usage-history.js", import.meta.url).href) as typeof import("../providers/provider-usage-history.js");
  const cache = new URL("../../node_modules/.cache/", import.meta.url).pathname;
  await mkdir(cache, { recursive: true }); const root = await mkdtemp(join(cache, "usage-roundtrip-"));
  const anchor = Date.now(), at = new Date(anchor).toISOString();
  let vendorRequests = 0;
  let owner = createProviderUsageHistoryStore({ cwd: root, now: () => anchor });
  function makeUsage() {
    const resolver = Object.assign(async () => "fictional-access", { readCredential: async (id: string) => id === "anthropic" ? { type: "oauth", access: "fictional-access", refresh: "fictional-refresh", expires: anchor + 86_400_000 } : undefined });
    return createProviderUsageService({ resolver: resolver as never, now: () => anchor, copilotCredential: async () => undefined,
      history: owner.forScope("fictional-auth-scope"), fetch: async () => { vendorRequests++; return Response.json({ five_hour: { utilization: 37 } }); } });
  }
  let usage = makeUsage();
  const proxy: ProviderUsageOperator = { snapshot: provider => usage.snapshot(provider), refresh: provider => usage.refresh(provider),
    history: query => usage.history!(query), clearHistory: provider => usage.clearHistory!(provider) };
  const operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, providerUsage: proxy, responder: { respond: async () => ({ text: "unused fictional response" }) }, info: { label: "Fictional smoke agent", model: "anthropic:fictional" } });
  let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    web = await startWebServer({ host: "127.0.0.1", port: 0, voice: false, stateDir: join(root, "web"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [{ baseUrl: operator.baseUrl, source: { schema: "agent-runtime.trace-source.v1", sourceId: "fictional-smoke", label: "Fictional smoke agent", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running", health: "running", startedAt: at, updatedAt: at, warnings: [] } }] });
    const base = web.url, origin = new URL(base).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const range = new URLSearchParams({ from: new Date(anchor - 3_600_000).toISOString(), to: new Date(anchor + 1000).toISOString(), bucket: "hour", provider: "anthropic" });
    const historyUrl = `${base}api/v1/agents/fictional-smoke/provider-usage/history?${range}`;
    const read = async (): Promise<ProviderUsageHistory> => {
      const response = await fetch(historyUrl, { headers });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); return response.json() as Promise<ProviderUsageHistory>;
    };
    expect((await read()).providers[0]?.samples).toEqual([]); expect(vendorRequests).toBe(0);
    const refreshed = await fetch(`${base}api/v1/agents/fictional-smoke/provider-usage/refresh?provider=anthropic`, { method: "POST", headers, body: "{}" });
    expect(refreshed.status).toBe(200); expect(vendorRequests).toBe(1);
    expect((await read()).providers[0]?.samples[0]?.windows[0]?.usedPercent).toBe(37);
    await read(); expect(vendorRequests).toBe(1);
    // Restart the producer's service/cache/store, keeping only its committed disk state.
    usage.stop(); await owner.close(); owner = createProviderUsageHistoryStore({ cwd: root, now: () => anchor }); usage = makeUsage();
    expect((await read()).providers[0]?.samples[0]?.windows[0]?.usedPercent).toBe(37); expect(vendorRequests).toBe(1);
    const created = await fetch(`${base}api/v1/threads`, { method: "POST", headers, body: JSON.stringify({ sourceId: "fictional-smoke" }) });
    expect(created.status).toBe(201);
    const { thread } = await created.json() as { thread: { id: string } };
    const db = new DatabaseSync(join(root, "web/state.sqlite"));
    try { db.prepare("INSERT INTO messages(id,thread_id,role,parts_json,created_at,updated_at,status) VALUES('fictional-message',?,'assistant',?,?,?,'complete')")
      .run(thread.id, JSON.stringify([{ type: "telemetry", event: "usage_update", data: { model: "fictional:swift", cumulativeUsd: 1.25, tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 } } }]), at, at); }
    finally { db.close(); }
    range.delete("provider");
    const analyticsResponse = await fetch(`${base}api/v1/agents/fictional-smoke/usage-analytics?${range}`, { headers });
    expect(analyticsResponse.status).toBe(200);
    const analytics = await analyticsResponse.json() as { total: { costUsd: number; tokens: { input: number } }; topConversations: unknown[] };
    expect(analytics.total).toMatchObject({ costUsd: 1.25, tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 } }); expect(analytics.topConversations).toHaveLength(1);
    const cleared = await fetch(`${base}api/v1/agents/fictional-smoke/provider-usage/history?provider=anthropic`, { method: "DELETE", headers, body: "{}" });
    expect(cleared.status).toBe(200); expect((await read()).providers.every(p => p.samples.length === 0)).toBe(true); expect(vendorRequests).toBe(1);
  } finally { await web?.stop(); await operator.stop(); usage.stop(); await owner.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
