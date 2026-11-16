import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startTuiAdapter } from "@mono-agent/channel-operator";
import { startWebServer } from "../server.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const cache = new URL("../../node_modules/.cache/", import.meta.url).pathname; await mkdir(cache, { recursive: true }); const path = await mkdtemp(join(cache, "analytics-routes-")); roots.push(path); return path; }
const range = { from: "2026-10-24T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", bucket: "day" as const, timeZone: "Europe/Berlin" };
const history = { schema: "mono-agent.provider-usage-history.v1" as const, ...range, retentionDays: 90 as const, storage: "ready" as const, providers: [] };
function discovered(baseUrl: string) { const agent = fakeDiscoveredAgent({ baseUrl }); return { ...agent, source: { ...agent.source, pid: process.pid } }; }

describe("console analytics routes", () => {
  it("proxies explicit local history/clear and enforces no-store, strict inputs and exact origin", async () => {
    const path = await root(), reads = vi.fn(async () => history), clear = vi.fn(async () => undefined), snapshot = vi.fn(async () => ({ schema: "mono-agent.provider-usage.v1" as const, providers: [] }));
    const operator = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "unused" }) }, providerUsage: { snapshot, history: reads, clearHistory: clear } });
    const server = await startWebServer({ port: 0, host: "127.0.0.1", voice: false, stateDir: join(path, "web"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [discovered(operator.baseUrl)] });
    try {
      const base = `${server.url}api/v1/agents/agent-one`, headers = { Origin: new URL(server.url).origin, "Content-Type": "application/json" };
      const url = `${base}/provider-usage/history?${new URLSearchParams(range)}`;
      const response = await fetch(url, { headers }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.json()).toEqual(history);
      expect(reads).toHaveBeenCalledWith(range); expect(snapshot).not.toHaveBeenCalled();
      expect((await fetch(url, { headers: { Origin: "https://foreign.invalid" } })).status).toBe(403);
      expect((await fetch(url)).status).toBe(403);
      expect((await fetch(url, { headers: { "X-Mono-Agent-Web-Origin": headers.Origin } })).status).toBe(200);
      for (const patch of [{ timeZone: "fictional/zone" }, { path: "fictional-private" }, { provider: "other" }]) {
        expect((await fetch(`${base}/provider-usage/history?${new URLSearchParams({ ...range, ...patch })}`, { headers })).status).toBe(400);
      }
      expect((await fetch(`${base}/provider-usage/history`, { method: "DELETE", headers, body: '{"account":"fictional"}' })).status).toBe(400);
      expect((await fetch(`${base}/provider-usage/history?provider=anthropic`, { method: "DELETE", headers, body: "{}" })).status).toBe(200); expect(clear).toHaveBeenCalledWith("anthropic");
      const local = await fetch(`${base}/usage-analytics?${new URLSearchParams(range)}`, { headers }); expect(local.status).toBe(200); expect(local.headers.get("cache-control")).toContain("no-store"); expect(await local.json()).toMatchObject({ timeZone: "Europe/Berlin", total: {}, scope: "retained-conversations" });
      expect((await fetch(`${base}/usage-analytics?${new URLSearchParams({ ...range, extra: "invalid" })}`, { headers })).status).toBe(400);
      expect(snapshot).not.toHaveBeenCalled();
    } finally { await server.stop(); await operator.stop(); }
  });
  it("keeps local analytics available for an old agent while rejecting unsupported history", async () => {
    const path = await root();
    const service = await WebService.create({ stateDir: join(path, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: async () => Response.json({ schema: 1 }) });
    try {
      expect((await service.usageAnalytics("agent-one", range)).total).toEqual({});
      await expect(service.providerUsageHistory("agent-one", range)).rejects.toMatchObject({ code: "provider_usage_history_unavailable" });
      await expect(service.clearProviderUsageHistory("agent-one")).rejects.toMatchObject({ code: "provider_usage_history_clear_unavailable" });
    } finally { await service.stop(); }
  });
  it.each(["read", "clear"])("fences a %s response across process-generation replacement", async method => {
    const path = await root(); let agent = fakeDiscoveredAgent();
    let finish!: (response: Response) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const service = await WebService.create({ stateDir: join(path, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [agent], fetchImpl: async url => {
      if (String(url).includes("/provider-usage/history")) { started(); return new Promise<Response>(resolve => { finish = resolve; }); }
      return Response.json({ schema: 1, capabilities: { providerUsage: { version: 1, history: { version: 1, clear: true } } } });
    } });
    try {
      expect((await service.bootstrap()).agents[0]?.supportsProviderUsageHistory).toBe(true);
      const pending = method === "read" ? service.providerUsageHistory("agent-one", range) : service.clearProviderUsageHistory("agent-one");
      await began;
      agent = { ...agent, source: { ...agent.source, startedAt: "2026-07-17T09:30:00.000Z" } }; await service.refreshAgents();
      finish(Response.json(method === "read" ? history : {}));
      await expect(pending).rejects.toMatchObject({ code: "agent_generation_changed" });
    } finally { await service.stop(); }
  });
});
