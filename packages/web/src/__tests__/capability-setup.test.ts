import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTuiAdapter, MAX_CAPABILITY_SETUP_BYTES, type CapabilitySetupSnapshot } from "@mono-agent/channel-operator";
import { OperatorClient } from "../operator-client.js";
import { startWebServer } from "../server.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";

const snapshot: CapabilitySetupSnapshot = { version: 1, observation: "durable-inputs", observedAt: "2026-08-01T10:00:00Z", process: { pid: process.pid, startedAt: "2026-08-01T09:00:00Z" }, cards: [] };
function capabilityAgent(overrides: Parameters<typeof fakeDiscoveredAgent>[0] = {}) {
  const discovered = fakeDiscoveredAgent(overrides);
  return { ...discovered, source: { ...discovered.source, pid: process.pid } };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("web capability proxy", () => {
  it("feature-detects older and malformed agents without a read claim", async () => {
    for (const capabilitySetup of [undefined, {}, { version: 2, read: true }, { version: 1, read: "true" }, { version: 1, read: true }]) {
      const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ schema: 1, capabilities: { capabilitySetup } }) });
      expect((await client.info()).supportsCapabilitySetup === true).toBe(capabilitySetup?.version === 1 && capabilitySetup?.read === true);
    }
    const invalid = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ ...snapshot, rawConfig: "synthetic" }) });
    await expect(invalid.capabilitySetup()).rejects.toMatchObject({ code: "operator_capabilities_invalid" });
  });
  it.each([[501, "capabilities_unsupported"], [503, "capabilities_unavailable"]] as const)("preserves the operator's %i capability error", async (status, code) => {
    const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ error: { code, message: "Capability unavailable." } }, { status }) });
    await expect(client.capabilitySetup()).rejects.toMatchObject({ code, status });
  });
  it("keeps oversized and aborted/timed-out body reads distinct from invalid JSON", async () => {
    const oversized = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => new Response("x".repeat(MAX_CAPABILITY_SETUP_BYTES + 1)) });
    await expect(oversized.capabilitySetup()).rejects.toMatchObject({ code: "operator_capabilities_too_large" });
    for (const name of ["AbortError", "TimeoutError"]) {
      const failure = new DOMException("Synthetic body read stopped", name);
      const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(failure); } })) });
      await expect(client.capabilitySetup()).rejects.toBe(failure);
    }
  });
  it.each([
    [process.pid, undefined, process.pid, false],
    [undefined, process.pid, process.pid, false],
    [process.pid, process.pid + 1, process.pid, false],
    [process.pid, process.pid, process.pid + 1, true],
  ] as const)("requires discovered/info/report identity agreement (%s/%s/%s)", async (discoveredPid, infoPid, reportPid, forwarded) => {
    const root = await temporaryRoot(); roots.push(root);
    const source = { ...capabilityAgent().source };
    // Deliberately malformed discovery input exercises the defensive missing-PID guard.
    if (discoveredPid === undefined) Reflect.deleteProperty(source, "pid"); else source.pid = discoveredPid;
    const read = vi.fn(async () => Response.json({ ...snapshot, process: { ...snapshot.process, pid: reportPid } }));
    const service = await WebService.create({ stateDir: join(root, "identity"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [{ ...capabilityAgent(), source }],
      fetchImpl: (async (url) => String(url).endsWith("/info") ? Response.json({ schema: 1, pid: infoPid, capabilities: { capabilitySetup: { version: 1, read: true } } }) : read()) as typeof fetch,
    });
    try {
      await expect(service.capabilitySetup("agent-one")).rejects.toMatchObject({ code: "agent_generation_changed" });
      expect(read).toHaveBeenCalledTimes(forwarded ? 1 : 0);
    } finally { await service.stop(); }
  });
  it("proxies the selected real operator over HTTP with no-store and no write route", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const adapter = await startTuiAdapter({ port: 0, apiKey: "fictional-test-key", responder: { respond: async () => ({ text: "unused" }) }, capabilitySetup: { read: async () => snapshot } });
    const server = await startWebServer({ port: 0, stateDir: join(root, "web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [capabilityAgent({ baseUrl: adapter.baseUrl, apiKey: "fictional-test-key" })] });
    try {
      const response = await fetch(`${server.url}api/v1/agents/agent-one/capabilities`, { headers: { Origin: new URL(server.url).origin } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual(snapshot);
      expect((await fetch(`${server.url}api/v1/agents/agent-one/capabilities?path=secret`, { headers: { Origin: new URL(server.url).origin } })).status).toBe(400);
      expect((await fetch(`${server.url}api/v1/agents/agent-one/capabilities`, { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
      expect((await fetch(`${server.url}api/v1/agents/agent-one/capabilities`, { method: "POST", headers: { "content-type": "application/json", Origin: new URL(server.url).origin }, body: "{}" })).status).toBe(404);
    } finally { await server.stop(); await adapter.stop(); }
  });
  it("serves the actual webapp API client over real HTTP, requiring its exact-origin header", async () => {
    // Dynamic module URLs keep the browser TS project (DOM/bundler resolution)
    // separate from the Node server project. This is the unmocked client source.
    const apiUrl = new URL("../../webapp/src/api.ts", import.meta.url).href;
    const meterUrl = new URL("../../webapp/src/data-usage.ts", import.meta.url).href;
    const { api: browserApi } = await import(apiUrl) as { api: { capabilitySetup: (sourceId: string, signal?: AbortSignal) => Promise<unknown> } };
    const { resetDataUsage } = await import(meterUrl) as { resetDataUsage: () => void };
    const root = await temporaryRoot(); roots.push(root);
    const adapter = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "unused" }) }, capabilitySetup: { read: async () => snapshot } });
    const server = await startWebServer({ port: 0, stateDir: join(root, "client-web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [capabilityAgent({ baseUrl: adapter.baseUrl })] });
    const nativeFetch = globalThis.fetch;
    const origin = new URL(server.url).origin;
    try {
      // Only resolve relative browser URLs. Do not synthesize Origin headers or
      // replace api.capabilitySetup, middleware or the server response.
      vi.stubGlobal("window", { location: { origin }, setTimeout, clearTimeout });
      vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => nativeFetch(new URL(String(url), server.url), init));
      const controller = new AbortController();
      await expect(browserApi.capabilitySetup("agent-one", controller.signal)).resolves.toEqual(snapshot);
      expect((await nativeFetch(`${server.url}api/v1/agents/agent-one/capabilities`)).status).toBe(403);
      controller.abort();
      await expect(browserApi.capabilitySetup("agent-one", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally { resetDataUsage(); vi.unstubAllGlobals(); await server.stop(); await adapter.stop(); }
  });
  it("rejects stale generation results and unsupported/offline sources", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let discovered = capabilityAgent();
    let support = true;
    let release!: (response: Response) => void;
    const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [discovered], fetchImpl: (async (url) => String(url).endsWith("/info")
        ? Response.json({ schema: 1, pid: process.pid, capabilities: support ? { capabilitySetup: { version: 1, read: true } } : {} })
        : new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch });
    try {
      const read = service.capabilitySetup("agent-one");
      await new Promise((resolve) => setTimeout(resolve, 0));
      discovered = { ...discovered, source: { ...discovered.source, pid: 900, startedAt: "2026-08-01T12:00:00Z" } };
      await service.refreshAgents();
      release(Response.json(snapshot));
      await expect(read).rejects.toMatchObject({ code: "agent_generation_changed" });
      support = false;
      await service.refreshAgents();
      await expect(service.capabilitySetup("agent-one")).rejects.toMatchObject({ code: "capabilities_unsupported" });
      await expect(service.capabilitySetup("missing")).rejects.toMatchObject({ code: "agent_not_found" });
      expect((await service.bootstrap()).agents[0]?.supportsCapabilitySetup).toBeUndefined();
      // An absent registry identity is removed, not an offline source. A terminal
      // manifest is the authoritative retained-offline path.
      discovered = { ...discovered, source: { ...discovered.source, status: "stopped", health: "failed" } };
      await service.refreshAgents();
      await expect(service.capabilitySetup("agent-one")).rejects.toMatchObject({ code: "agent_offline" });
    } finally { await service.stop(); }
  });
});
