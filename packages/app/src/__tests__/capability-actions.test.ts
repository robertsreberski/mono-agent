import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCapabilityActionsService } from "../setup/capability-actions.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "capability-actions-"))); roots.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json");
  const config = { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] }, ...extra };
  await writeFile(join(cwd, "IDENTITY.md"), "# Fictional Agent\n"); await writeFile(configPath, JSON.stringify(config));
  const service = createCapabilityActionsService({ cwd, configPath, env });
  return { cwd, configPath, config, service, process: (await service.read()).process };
}
it("enables Lite only at a safe standard root, preserves unrelated config, and reports saved versus loaded truth", async () => {
  const f = await fixture(); const before = await readFile(f.configPath);
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  expect(await readFile(f.configPath)).toEqual(before);
  expect(preview.changes).toHaveLength(1); expect(preview.normalizesFormatting).toBe(true);
  const saved = await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(saved.changed).toBe(true);
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  expect(config.tools).toEqual(f.config.tools);
  expect(config.memory).toMatchObject({ mode: "lite", path: "./.mono-agent/memory", recallTool: { enabled: true }, rememberTool: { enabled: true } });
  expect((await f.service.read()).actions[0]).toMatchObject({ active: false, reason: "already-configured" });
  const noOp = await f.service.preview({ action: "memory-lite", process: f.process });
  const backup = await readFile(`${f.configPath}.bak`);
  const repeated = await f.service.save({ action: noOp.action, process: noOp.process, expectedVersion: noOp.expectedVersion, confirmed: true });
  expect(repeated.changed).toBe(false); expect(await readFile(`${f.configPath}.bak`)).toEqual(backup);
});
it("changes only existing cron operator controls, including disabled jobs", async () => {
  const cron = { jobs: [{ id: "fictional", expression: "0 9 * * *", timezone: "UTC", prompt: "Synthetic reminder", enabled: false }], operatorActions: { enabled: false } };
  const f = await fixture({ cron });
  const preview = await f.service.preview({ action: "cron-controls", process: f.process });
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  expect(saved.cron).toEqual({ ...cron, operatorActions: { enabled: true } });
  expect(saved.tools).toEqual(f.config.tools);
});
it("refuses unknown/semantic roots, configured non-Lite memory, invalid/no jobs, and env shadowing", async () => {
  for (const extra of [{}, { memory: { mode: "journal", path: ".mono-agent/memory" } }, { cron: { jobs: [{ id: "bad", expression: "not cron", prompt: "Synthetic" }] } }]) {
    const f = await fixture(extra);
    await mkdir(join(f.cwd, ".mono-agent/memory"), { recursive: true }); await writeFile(join(f.cwd, ".mono-agent/memory", "unknown.txt"), "Do not migrate or delete");
    expect((await f.service.read()).actions.every((action) => !action.available)).toBe(true);
    await expect(f.service.preview({ action: "memory-lite", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
    expect(await readFile(join(f.cwd, ".mono-agent/memory", "unknown.txt"), "utf8")).toBe("Do not migrate or delete");
  }
  const f = await fixture({}, { MONO_AGENT_MEMORY_MODE: "lite", MONO_AGENT_CRON_OPERATOR_ACTIONS_ENABLED: "false" });
  expect((await f.service.read()).actions.map((action) => action.reason)).toEqual(["env-shadowed", "env-shadowed"]);
});
it("rejects arbitrary inputs, stale identity/version, duplicate JSON, and invalid candidates without publication", async () => {
  const f = await fixture(); const before = await readFile(f.configPath);
  for (const input of [{ action: "read-tools", process: f.process }, { action: "memory-lite", process: f.process, patch: { tools: {} } }, { action: "memory-lite", process: { ...f.process, pid: f.process.pid + 1 } }]) await expect(f.service.preview(input as never)).rejects.toThrow();
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  await expect(f.service.save({ action: preview.action, process: preview.process, expectedVersion: "0".repeat(64), confirmed: true })).rejects.toMatchObject({ code: "capability_action_conflict" });
  await expect(f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: false } as never)).rejects.toThrow();
  expect(await readFile(f.configPath)).toEqual(before);
  await writeFile(f.configPath, '{"runtime":{"model":"one","model":"two"}}');
  await expect(f.service.preview({ action: "memory-lite", process: f.process })).rejects.toThrow();
  const invalid = await fixture({ tools: { inventedSetting: true } });
  const p = await invalid.service.preview({ action: "memory-lite", process: invalid.process });
  await expect(invalid.service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true })).rejects.toThrow();
  expect(JSON.parse(await readFile(invalid.configPath, "utf8"))).not.toHaveProperty("memory");
});
it("writes the durable path, never the managed worker's frozen input", async () => {
  const f = await fixture(); const frozen = join(f.cwd, "frozen.json"); await writeFile(frozen, await readFile(f.configPath)); const before = await readFile(frozen);
  const service = createCapabilityActionsService({ cwd: f.cwd, configPath: f.configPath, env: {} });
  const p = await service.preview({ action: "memory-lite", process: f.process });
  await service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true });
  expect(await readFile(frozen)).toEqual(before); expect((await service.read()).actions[0]?.active).toBe(false);
});

it("re-enables an existing verified Lite root without migrating or deleting its data", async () => {
  const f = await fixture(); const root = join(f.cwd, ".mono-agent/memory"); await mkdir(root, { recursive: true });
  const { safeRebuildMemoryIndex, serializeBullet } = await import("@mono-agent/memory/bujo");
  await mkdir(join(root, "daily"));
  const note = `# 2026-07-11\n\n${serializeBullet({ id: "B1", type: "note", status: "open", text: "A synthetic note.", salience: 0.5, isInsight: false, createdAt: "2026-07-11T09:00:00.000Z", refs: [] })}\n`;
  await writeFile(join(root, "daily/2026-07-11.md"), note);
  const result = await safeRebuildMemoryIndex({ root, tier: "lite" });
  const before = await readFile(result.active);
  expect((await f.service.read()).actions[0]).toMatchObject({ available: true, reason: "eligible" });
  const p = await f.service.preview({ action: "memory-lite", process: f.process });
  await f.service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true });
  expect(await readFile(result.active)).toEqual(before);
  expect(await readFile(join(root, "daily/2026-07-11.md"), "utf8")).toBe(note);
});

it("uses only host-owned loaded-state evidence and never loads candidate settings through a live driver", async () => {
  const f = await fixture(); const loadConfig = vi.fn(async () => { throw new Error("live driver must not be touched"); });
  const service = createCapabilityActionsService({ cwd: f.cwd, configPath: f.configPath, env: {}, drivers: [{ id: "synthetic", loadConfig } as never] }, { loadedState: () => ({ memory: false, cron: false }) });
  const p = await service.preview({ action: "memory-lite", process: f.process });
  await service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true });
  expect(loadConfig).not.toHaveBeenCalled(); expect((await service.read()).actions[0]?.active).toBe(false);
  const restarted = createCapabilityActionsService({ cwd: f.cwd, configPath: f.configPath, env: {} }, { loadedState: () => ({ memory: true, cron: false }) });
  expect((await restarted.read()).actions[0]?.active).toBe(true);
});
