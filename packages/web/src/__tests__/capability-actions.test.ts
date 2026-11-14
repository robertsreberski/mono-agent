import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebService } from "../service.js";
import { startWebServer } from "../server.js";
import { OperatorClient } from "../operator-client.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity = { pid: process.pid, startedAt: "2026-08-01T09:00:00Z" };
const preview = { action: "memory-lite" as const, process: identity, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, exactBytes: false, noOp: true };
it("detects preview and save separately from read-only discovery, failing closed on older or malformed claims", async () => {
  for (const claim of [undefined, {}, { version: 1, preview: true }, { version: 2, preview: true, save: true }, { version: 1, preview: true, save: true }]) {
    const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ schema: 1, capabilities: { capabilityActions: claim, capabilitySetup: { version: 1, read: true } } }) });
    const info = await client.info();
    expect(info.supportsCapabilitySetup).toBe(true); expect(info.supportsCapabilityActions === true).toBe(claim?.version === 1 && claim?.preview === true && claim?.save === true);
  }
});
for (const operation of ["read", "preview", "save"] as const) it.each([false, true])(`${operation} compares generations, not connection object identity (restart=%s)`, async (restarted) => {
  const root = await temporaryRoot(); roots.push(root);
  const initial = fakeDiscoveredAgent(); let discovered = { ...initial, source: { ...initial.source, pid: process.pid, startedAt: identity.startedAt } };
  let release!: (response: Response) => void;
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [discovered],
    fetchImpl: (async (url) => String(url).endsWith("/info") ? Response.json({ schema: 1, pid: discovered.source.pid, capabilities: { capabilityActions: { version: 1, preview: true, save: true } } }) : new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch });
  try {
    const work = service.capabilityActions("agent-one", operation, operation === "read" ? undefined : operation === "preview" ? { action: preview.action, process: identity } : { action: preview.action, process: identity, expectedVersion: preview.expectedVersion, confirmed: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    discovered = { ...discovered, source: { ...discovered.source, updatedAt: "2026-08-01T12:00:00Z", ...(restarted ? { pid: process.pid + 1, startedAt: "2026-08-01T12:00:00Z" } : {}) } };
    await service.refreshAgents();
    const result = operation === "read" ? { version: 1, process: identity, actions: [{ id: "memory-lite", available: true, active: false, reason: "eligible" }, { id: "cron-controls", available: false, active: false, reason: "no-valid-jobs" }, { id: "subagents-enable", available: true, active: false, reason: "eligible" }, { id: "config-undo", available: true, active: false, reason: "eligible" }] } : operation === "preview" ? preview : { action: preview.action, process: identity, version: preview.expectedVersion, changed: false };
    release(Response.json(result));
    if (restarted) await expect(work).rejects.toMatchObject({ code: "agent_generation_changed" }); else await expect(work).resolves.toEqual(result);
  } finally { await service.stop(); }
});

it("never forwards diagnostic prose from upstream action failures or transport errors", async () => {
  for (const [code, status] of [["capability_action_conflict", 409], ["capability_action_unavailable", 409], ["capability_action_failed", 503], ["capability_actions_unsupported", 501], ["unknown", 500]] as const) {
    const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ error: { code, message: "fictional-private-diagnostic" } }, { status }) });
    await expect(client.capabilityActions("read")).rejects.toMatchObject({ status: code === "unknown" ? 502 : status, message: expect.not.stringContaining("fictional-private-diagnostic") });
  }
  const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => { throw new Error("fictional-private-diagnostic"); } });
  await expect(client.capabilityActions("read")).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("fictional-private-diagnostic") });
});

it("preserves fixed action failures without forwarding upstream prose or details to bodies or diagnostics", async () => {
  const root = await temporaryRoot(); roots.push(root);
  const discovered = fakeDiscoveredAgent();
  const diagnostic = "fictional-upstream-prose";
  const plantedValue = "sk-fictional-capability-test-123456789";
  let failure: { code: string; status: number } | undefined;
  const log = vi.fn();
  const web = await startWebServer({ port: 0, voice: false, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    logger: { info: log, warn: log, error: log, debug: log },
    discoverImpl: async () => [{ ...discovered, source: { ...discovered.source, pid: process.pid } }],
    fetchImpl: (async (url) => {
      if (String(url).endsWith("/info")) return Response.json({ schema: 1, pid: process.pid, capabilities: { capabilityActions: { version: 1, preview: true, save: true } } });
      if (failure === undefined) throw new Error(`${diagnostic} ${plantedValue}`);
      return Response.json({ error: { code: failure.code, message: `${diagnostic} ${plantedValue}`, reason: plantedValue, details: { reason: plantedValue, raw: diagnostic } } }, { status: failure.status });
    }) as typeof fetch });
  const base = `${web.url}api/v1/agents/agent-one/capability-actions`;
  const headers = { Origin: new URL(web.url).origin, "Content-Type": "application/json" };
  try {
    for (const [code, status] of [["capability_action_conflict", 409], ["capability_action_unavailable", 409], ["capability_action_failed", 503], ["capability_actions_unsupported", 501], ["unknown", 500]] as const) {
      failure = { code, status };
      for (const operation of ["read", "preview", "save"] as const) {
        const body = { action: preview.action, process: identity, ...(operation === "save" ? { expectedVersion: preview.expectedVersion, confirmed: true } : {}) };
        const response = await fetch(`${base}${operation === "read" ? "" : `/${operation}`}`, { headers, ...(operation === "read" ? {} : { method: "POST", body: JSON.stringify(body) }) });
        expect(response.status).toBe(code === "unknown" ? 502 : status);
        const value = await response.json() as { error: { code: string; message: string; details?: unknown } };
        expect(value.error.code).toBe(code === "unknown" ? "capability_action_failed" : code);
        expect(value.error.details).toBeUndefined();
        expect(JSON.stringify(value)).not.toContain(diagnostic);
        expect(JSON.stringify(value)).not.toContain(plantedValue);
      }
    }
    failure = undefined;
    const transport = await fetch(base, { headers });
    expect(transport.status).toBe(502);
    expect(await transport.json()).toEqual({ error: { code: "capability_action_failed", message: "Capability action outcome could not be confirmed; refresh and inspect settings before retrying." } });
    for (const operation of ["preview", "save"]) {
      const malformed = await fetch(`${base}/${operation}`, { method: "POST", headers, body: `{"credential":"${plantedValue}"` });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: { code: "invalid_json", message: "The request body is not valid JSON." } });
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(diagnostic);
    expect(JSON.stringify(log.mock.calls)).not.toContain(plantedValue);
  } finally { await web.stop(); }
});

it("rejects a read snapshot from a different start even when the PID is unchanged", async () => {
  const root = await temporaryRoot(); roots.push(root);
  const initial = fakeDiscoveredAgent();
  let discovered = { ...initial, source: { ...initial.source, ...identity } };
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [discovered],
    fetchImpl: (async (url) => String(url).endsWith("/info") ? Response.json({ schema: 1, pid: identity.pid, capabilities: { capabilityActions: { version: 1, preview: true, save: true } } }) : Response.json({ version: 1, process: { ...identity, startedAt: "2026-08-01T10:00:00Z" }, actions: [{ id: "memory-lite", available: true, active: false, reason: "eligible" }, { id: "cron-controls", available: false, active: false, reason: "no-valid-jobs" }, { id: "subagents-enable", available: true, active: false, reason: "eligible" }, { id: "config-undo", available: true, active: false, reason: "eligible" }] })) as typeof fetch });
  try {
    await expect(service.capabilityActions("agent-one", "read")).rejects.toMatchObject({ code: "agent_generation_changed" });
    discovered = { ...discovered, source: { ...discovered.source, startedAt: "2026-08-01T10:00:00Z" } };
    await service.refreshAgents();
    await expect(service.capabilityActions("agent-one", "read")).resolves.toMatchObject({ process: { ...identity, startedAt: discovered.source.startedAt } });
  }
  finally { await service.stop(); }
});
it("bounds capability action agent IDs before calling discovery or the service", async () => {
  const root = await temporaryRoot(); roots.push(root);
  const web = await startWebServer({ port: 0, voice: false, stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [] });
  try {
    const response = await fetch(`${web.url}api/v1/agents/${"x".repeat(513)}/capability-actions`, { headers: { Origin: new URL(web.url).origin } });
    expect(response.status).toBe(400);
  } finally { await web.stop(); }
});
// These type-only contracts are checked by the web package's typecheck lane.
function invalidCapabilityActionCalls(client: OperatorClient) {
  // @ts-expect-error A read never accepts a body.
  void client.capabilityActions("read", { action: preview.action, process: identity });
  // @ts-expect-error Save requires confirmed input.
  void client.capabilityActions("save");
  // @ts-expect-error A preview input is not a confirmed Save.
  void client.capabilityActions("save", { action: preview.action, process: identity });
}
void invalidCapabilityActionCalls;
