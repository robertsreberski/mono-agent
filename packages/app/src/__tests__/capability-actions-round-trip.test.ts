import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startTuiAdapter, type CapabilityActionsSnapshot, type CapabilityActionPreview, type CapabilityActionSaved, type CapabilityActionInput, type CapabilityActionSaveInput } from "@mono-agent/channel-operator";
import { startWebServer } from "@mono-agent/web";
import { createCapabilityActionsService } from "../setup/capability-actions.js";

it("round-trips browser proxy → real agent → durable guarded write, rejects foreign origins and retains older-agent guidance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enable-round-trip-")));
  const configPath = join(root, "mono-agent.config.json"); const frozen = join(root, "frozen.json");
  const original = JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  await writeFile(configPath, original); await writeFile(frozen, original); await writeFile(join(root, "IDENTITY.md"), "# Fictional Agent\n");
  const responder = { respond: async () => ({ text: "No model calls" }) };
  const adapter = await startTuiAdapter({ port: 0, responder, capabilityActions: createCapabilityActionsService({ cwd: root, configPath, env: {} }) });
  const older = await startTuiAdapter({ port: 0, responder });
  const web = await startWebServer({ port: 0, stateDir: join(root, "web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [adapter, older].map((server, index) => ({ baseUrl: server.baseUrl, source: { schema: "agent-runtime.trace-source.v1" as const, sourceId: index === 0 ? "fictional" : "older", label: "Synthetic", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running" as const, health: "running" as const, startedAt: new Date(performance.timeOrigin).toISOString(), updatedAt: new Date().toISOString(), warnings: [] } })) });
  const url = `${web.url}api/v1/agents/fictional/capability-actions`;
  const headers = { Origin: new URL(web.url).origin, "Content-Type": "application/json" };
  const nativeFetch = globalThis.fetch;
  const apiUrl = new URL("../../../web/webapp/src/api.ts", import.meta.url).href;
  const meterUrl = new URL("../../../web/webapp/src/data-usage.ts", import.meta.url).href;
  const { api: browserApi } = await import(apiUrl) as { api: {
    capabilityActions(sourceId: string): Promise<CapabilityActionsSnapshot>;
    previewCapabilityAction(sourceId: string, input: CapabilityActionInput): Promise<CapabilityActionPreview>;
    saveCapabilityAction(sourceId: string, input: CapabilityActionSaveInput): Promise<CapabilityActionSaved>;
  } };
  const { resetDataUsage } = await import(meterUrl) as { resetDataUsage(): void };
  vi.stubGlobal("window", { location: { origin: new URL(web.url).origin }, setTimeout, clearTimeout });
  // Only resolve relative browser URLs: the real client supplies its own claimed-origin header.
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => nativeFetch(new URL(String(url), web.url), init));
  try {
    const info = await (await fetch(adapter.infoUrl)).json() as { capabilities: Record<string, unknown> }; expect(info.capabilities.capabilityActions).toEqual({ version: 1, preview: true, save: true });
    expect((await fetch(url, { headers: { Origin: "https://foreign.invalid" } })).status).toBe(403);
    const metadata = await browserApi.capabilityActions("fictional");
    expect(metadata.actions[0]).toMatchObject({ id: "memory-lite", available: true, active: false });
    const body = { action: "memory-lite" as const, process: metadata.process };
    expect((await fetch(`${url}/save`, { method: "POST", headers: { ...headers, Origin: "https://foreign.invalid" }, body: JSON.stringify({ ...body, expectedVersion: "0".repeat(64), confirmed: true }) })).status).toBe(403);
    const preview = await browserApi.previewCapabilityAction("fictional", body);
    expect(await readFile(configPath, "utf8")).toBe(original);
    const save = { ...body, expectedVersion: preview.expectedVersion, confirmed: true as const };
    expect((await browserApi.saveCapabilityAction("fictional", save)).changed).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ memory: { mode: "lite" }, tools: { disallowedTools: ["Bash"] } });
    expect(await readFile(frozen, "utf8")).toBe(original);
    expect(Buffer.from(JSON.parse(await readFile(`${configPath}.bak`, "utf8")).previousBase64, "base64").toString()).toBe(original);
    expect((await fetch(`${url}/save`, { method: "POST", headers, body: JSON.stringify(save) })).status).toBe(409);
    expect((await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify({ ...body, process: { ...metadata.process, startedAt: "2000-01-01T00:00:00.000Z" } }) })).status).toBe(409);
    expect((await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify({ ...body, patch: { tools: {} } }) })).status).toBe(400);
    const unsupported = await fetch(`${web.url}api/v1/agents/older/capability-actions`, { headers });
    expect(unsupported.status).toBe(409); expect(await unsupported.text()).toContain("capability_actions_unsupported");
  } finally { resetDataUsage(); vi.unstubAllGlobals(); await web.stop(); await older.stop(); await adapter.stop(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
