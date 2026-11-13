import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebService } from "../service.js";
import { OperatorClient } from "../operator-client.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity = { pid: process.pid, startedAt: "2026-08-01T09:00:00Z" };
const preview = { action: "memory-lite" as const, process: identity, expectedVersion: "a".repeat(64), changes: [], normalizesFormatting: true, noOp: true };
it("detects preview and save separately from read-only discovery, failing closed on older or malformed claims", async () => {
  for (const claim of [undefined, {}, { version: 1, preview: true }, { version: 2, preview: true, save: true }, { version: 1, preview: true, save: true }]) {
    const client = new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui", fetchImpl: async () => Response.json({ schema: 1, capabilities: { capabilityActions: claim, capabilitySetup: { version: 1, read: true } } }) });
    const info = await client.info();
    expect(info.supportsCapabilitySetup).toBe(true); expect(info.supportsCapabilityActions === true).toBe(claim?.version === 1 && claim?.preview === true && claim?.save === true);
  }
});
for (const operation of ["read", "preview", "save"] as const) it.each([false, true])(`${operation} compares generations, not connection object identity (restart=%s)`, async (restarted) => {
  const root = await temporaryRoot(); roots.push(root);
  const initial = fakeDiscoveredAgent(); let discovered = { ...initial, source: { ...initial.source, pid: process.pid } };
  let release!: (response: Response) => void;
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [discovered],
    fetchImpl: (async (url) => String(url).endsWith("/info") ? Response.json({ schema: 1, pid: discovered.source.pid, capabilities: { capabilityActions: { version: 1, preview: true, save: true } } }) : new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch });
  try {
    const work = service.capabilityActions("agent-one", operation, operation === "read" ? undefined : operation === "preview" ? { action: preview.action, process: identity } : { action: preview.action, process: identity, expectedVersion: preview.expectedVersion, confirmed: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    discovered = { ...discovered, source: { ...discovered.source, updatedAt: "2026-08-01T12:00:00Z", ...(restarted ? { pid: process.pid + 1, startedAt: "2026-08-01T12:00:00Z" } : {}) } };
    await service.refreshAgents();
    const result = operation === "read" ? { version: 1, process: identity, actions: [{ id: "memory-lite", available: true, active: false, reason: "eligible" }, { id: "cron-controls", available: false, active: false, reason: "no-valid-jobs" }] } : operation === "preview" ? preview : { action: preview.action, process: identity, version: preview.expectedVersion, changed: false };
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
