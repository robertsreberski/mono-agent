import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startTuiAdapter, type CapabilityActionsSnapshot, type CapabilityActionPreview, type CapabilityActionSaved, type CapabilityActionInput, type CapabilityActionSaveInput } from "@mono-agent/channel-operator";
import { startWebServer } from "@mono-agent/web";
import { createCapabilityActionsService } from "../setup/capability-actions.js";

it("round-trips Undo browser proxy → real agent → guarded restore, then refuses a second Undo and a stale one", async () => {
  let root = await mkdtemp(join(tmpdir(), "undo-round-trip-"));
  const cleanup: Array<() => Promise<unknown> | void> = [];
  try {
    root = await realpath(root);
    const configPath = join(root, "mono-agent.config.json");
    const original = JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
    await writeFile(configPath, original); await writeFile(join(root, "IDENTITY.md"), "# Fictional Agent\n");
    const responder = { respond: async () => ({ text: "No model calls" }) };
    const adapter = await startTuiAdapter({ port: 0, responder, capabilityActions: createCapabilityActionsService({ cwd: root, configPath, env: {} }) });
    cleanup.push(() => adapter.stop());
    const web = await startWebServer({ port: 0, stateDir: join(root, "web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0,
      discoverImpl: async () => [adapter].map((server) => ({ baseUrl: server.baseUrl, source: { schema: "agent-runtime.trace-source.v1" as const, sourceId: "fictional", label: "Synthetic", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running" as const, health: "running" as const, startedAt: new Date(performance.timeOrigin).toISOString(), updatedAt: new Date().toISOString(), warnings: [] } })) });
    cleanup.push(() => web.stop());
    const url = `${web.url}api/v1/agents/fictional/capability-actions`;
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
    cleanup.push(() => { try { resetDataUsage(); } finally { vi.unstubAllGlobals(); } });
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => nativeFetch(new URL(String(url), web.url), init));
    const metadata = await browserApi.capabilityActions("fictional");
    expect(metadata.actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-unavailable" });
    const memory = { action: "memory-lite" as const, process: metadata.process };
    const memoryPreview = await browserApi.previewCapabilityAction("fictional", memory);
    expect((await browserApi.saveCapabilityAction("fictional", { ...memory, expectedVersion: memoryPreview.expectedVersion, confirmed: true })).changed).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ memory: { mode: "lite" } });
    const undoable = await browserApi.capabilityActions("fictional");
    expect(undoable.actions.find((action) => action.id === "config-undo")).toMatchObject({ available: true, reason: "eligible" });
    const undo = { action: "config-undo" as const, process: undoable.process };
    const undoPreview = await browserApi.previewCapabilityAction("fictional", undo);
    expect(undoPreview.changes).toHaveLength(1);
    expect(JSON.stringify(undoPreview)).not.toContain("fictional");
    expect((await browserApi.saveCapabilityAction("fictional", { ...undo, expectedVersion: undoPreview.expectedVersion, confirmed: true })).changed).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(readFile(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    const consumed = await browserApi.capabilityActions("fictional");
    expect(consumed.actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-unavailable" });
    await expect(browserApi.previewCapabilityAction("fictional", { action: "config-undo", process: consumed.process })).rejects.toMatchObject({ status: 409 });
    // A fresh save followed by a manual edit fences Undo instead of guessing.
    const again = await browserApi.previewCapabilityAction("fictional", memory);
    await browserApi.saveCapabilityAction("fictional", { ...memory, expectedVersion: again.expectedVersion, confirmed: true });
    await writeFile(configPath, `${(await readFile(configPath, "utf8")).trimEnd().slice(0, -1)},"manual": true }\n`);
    const stale = await browserApi.capabilityActions("fictional");
    expect(stale.actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-stale" });
    await expect(browserApi.previewCapabilityAction("fictional", { action: "config-undo", process: stale.process })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(configPath, "utf8")).toContain('"manual": true');
  } finally {
    const errors: unknown[] = [];
    for (const dispose of cleanup.reverse()) { try { await dispose(); } catch (error) { errors.push(error); } }
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Round-trip cleanup failed");
  }
}, 90_000);
