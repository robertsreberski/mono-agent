import { rm } from "node:fs/promises";
import { join } from "node:path";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";
import { OperatorClient } from "../operator-client.js";
import express from "express";
import { createServer, request } from "node:http";
import { expect, it, vi } from "vitest";
import { registerCredentialRoutes } from "../credential-routes.js";

it("parses credentials before the global parser, bounds chunked/encoded/malformed bodies and sanitizes proxy failures without logging", async () => {
  const plantedValue = ["fictional", "proxy", "literal"].join("-");
  const credentials = vi.fn(async () => { throw new Error(plantedValue); });
  const active = new Set<Promise<unknown>>(); const app = express(); const globalParser = vi.fn();
  registerCredentialRoutes(app, { credentials } as unknown as WebService, active, (req) => { if (req.headers.origin !== "https://console.invalid") throw new Error(plantedValue); });
  app.use(express.json({ limit: "256kb" }), globalParser);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}/api/v1/agents/fictional/credentials/save`;
  const body = JSON.stringify({ card: "openai-api", process: { pid: 42, startedAt: "2026-01-01T00:00:00.000Z" }, fence: "12345678-1234-1234-1234-123456789012", confirmed: true, fields: { bearer: plantedValue } });
  const headers = { "Content-Type": "application/json", Origin: "https://console.invalid" };
  try {
    for (const [data, extra, code] of [[body, {}, 502], [`{"fields":"${plantedValue}`, {}, 400], [" ".repeat(16385), {}, 413], [body, { "Content-Encoding": "br" }, 415], [body, { "Content-Type": "application/json; charset=utf-16" }, 400], [body, { Origin: "https://foreign.invalid" }, 403]] as const) {
      const response = await fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: data }); expect(response.status).toBe(code); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.text()).not.toContain(plantedValue);
    }
    const chunked = await new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" } }, (res) => { let text = ""; res.on("data", (part) => { text += part; }); res.on("end", () => resolve({ status: res.statusCode!, body: text, cache: res.headers["cache-control"] })); });
      req.on("error", reject); req.write(' {"fields":"'); req.write(plantedValue); req.end('"' + " ".repeat(17000));
    });
    expect(chunked.status).toBe(413); expect(chunked.cache).toContain("no-store"); expect(chunked.body).not.toContain(plantedValue);
    expect(globalParser).not.toHaveBeenCalled(); expect(credentials).toHaveBeenCalledTimes(1); expect(active.size).toBe(0);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

it("rejects credential-bearing upstream projections and strips diagnostics on transport and typed failures", async () => {
  const plantedValue = ["fictional", "upstream", "literal"].join("-");
  for (const response of [Response.json({ value: plantedValue }), Response.json({ error: { code: "credential_conflict", message: plantedValue, details: { reason: plantedValue } } }, { status: 409 })]) {
    const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => response });
    await expect(client.credentials("read")).rejects.toMatchObject({ message: expect.not.stringContaining(plantedValue) });
  }
  const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => { throw new Error(plantedValue); } });
  await expect(client.credentials("read")).rejects.toMatchObject({ code: "credential_outcome_unknown", message: expect.not.stringContaining(plantedValue) });
});

it("checks full identity before dispatch and treats a generation change during save as unknown, even with the same PID", async () => {
  const root = await temporaryRoot();
  const initial = fakeDiscoveredAgent(); const identity = { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
  let discovered = { ...initial, source: { ...initial.source, ...identity } };
  let release!: (response: Response) => void;
  const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/info") ? Response.json({ schema: 1, pid: process.pid, capabilities: { credentialSetup: { version: 1, save: true } } }) : new Promise<Response>((resolve) => { release = resolve; }));
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [discovered], fetchImpl: transport as typeof fetch });
  const input = { card: "openai-api" as const, process: identity, fence: "12345678-1234-1234-1234-123456789012", confirmed: true as const, fields: { bearer: ["fictional", "value"].join("-") } };
  try {
    const before = transport.mock.calls.length;
    await expect(service.credentials("agent-one", "save", { ...input, process: { ...identity, startedAt: "2025-01-01T00:00:00.000Z" } })).rejects.toMatchObject({ code: "credential_conflict" });
    expect(transport).toHaveBeenCalledTimes(before);
    const work = service.credentials("agent-one", "save", input);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    discovered = { ...discovered, source: { ...discovered.source, startedAt: "2026-01-02T00:00:00.000Z" } };
    await service.refreshAgents();
    release(Response.json({ card: input.card, process: identity, outcome: "saved" }));
    await expect(work).rejects.toMatchObject({ code: "credential_outcome_unknown" });
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});
