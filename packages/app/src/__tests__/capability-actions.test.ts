import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile, symlink } from "node:fs/promises";
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
  expect((await f.service.read()).actions.map((action) => action.reason)).toEqual(["env-shadowed", "env-shadowed", "subagents-unconfigured", "undo-unavailable"]);
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
  const invalid = await fixture({ runtime: { model: 42 } });
  const p = await invalid.service.preview({ action: "memory-lite", process: invalid.process });
  await expect(invalid.service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true })).rejects.toThrow();
  expect(JSON.parse(await readFile(invalid.configPath, "utf8"))).not.toHaveProperty("memory");
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

it("treats an empty memory object as unconfigured and cron controls already enabled as a no-op", async () => {
  const f = await fixture({ memory: {}, cron: { jobs: [{ id: "synthetic", expression: "0 9 * * *", prompt: "Synthetic", enabled: false }], operatorActions: { enabled: true } } });
  expect((await f.service.read()).actions).toMatchObject([{ id: "memory-lite", available: true, reason: "eligible" }, { id: "cron-controls", available: true, reason: "already-configured" }, { id: "subagents-enable", available: false, reason: "subagents-unconfigured" }, { id: "config-undo", available: false, reason: "undo-unavailable" }]);
  expect(await f.service.preview({ action: "memory-lite", process: f.process })).toMatchObject({ noOp: false });
  const before = await readFile(f.configPath);
  const p = await f.service.preview({ action: "cron-controls", process: f.process });
  expect(p).toMatchObject({ noOp: true, changes: [] });
  expect(await f.service.save({ action: p.action, process: p.process, expectedVersion: p.expectedVersion, confirmed: true })).toMatchObject({ changed: false });
  expect(await readFile(f.configPath)).toEqual(before);
  await expect(readFile(`${f.configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["MONO_AGENT_CRON_JOBS_JSON", "MONO_AGENT_CRON_DIR", "MONO_AGENT_CRON_ENABLED", "MONO_AGENT_CRON_EXPRESSION", "MONO_AGENT_CRON_OPERATOR_ACTIONS_ENABLED"])("refuses cron controls shadowed by %s", async (key) => {
  const f = await fixture({ cron: { jobs: [{ id: "synthetic", expression: "0 9 * * *", prompt: "Synthetic" }] } }, { [key]: "synthetic-override" });
  expect((await f.service.read()).actions[1]).toMatchObject({ available: false, reason: "env-shadowed" });
  await expect(f.service.preview({ action: "cron-controls", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
});

it.each(["ancestor", "root"])("refuses a dangling %s symlink before approving the standard Lite root", async (kind) => {
  const f = await fixture();
  const target = join(f.cwd, "not-created-yet");
  if (kind === "root") await mkdir(join(f.cwd, ".mono-agent"));
  await symlink(target, join(f.cwd, kind === "ancestor" ? ".mono-agent" : ".mono-agent/memory"));
  expect((await f.service.read()).actions[0]).toMatchObject({ available: false, reason: "memory-root-unsafe" });
  await expect(f.service.preview({ action: "memory-lite", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  await mkdir(target);
  expect((await f.service.read()).actions[0]).toMatchObject({ available: false, reason: "memory-root-unsafe" });
});

const SUBAGENT_PROFILE = { name: "researcher", description: "A synthetic researcher.", prompt: "Synthetic instructions." };

async function undoable(f: { configPath: string; service: ReturnType<typeof createCapabilityActionsService>; process: { pid: number; startedAt: string } }, before: Buffer) {
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ available: true, reason: "eligible", active: false });
  const undoPreview = await f.service.preview({ action: "config-undo", process: f.process });
  expect(undoPreview).toMatchObject({ noOp: false, changes: [{ field: "config" }] });
  expect(JSON.stringify(undoPreview.changes)).not.toContain("fictional-inline-literal");
  const saved = await f.service.save({ action: "config-undo", process: f.process, expectedVersion: undoPreview.expectedVersion, confirmed: true });
  expect(saved.changed).toBe(true);
  expect(await readFile(f.configPath)).toEqual(before);
  return saved;
}

it("offers no Undo before a console save and consumes the slot after one Undo", async () => {
  const f = await fixture(); const before = await readFile(f.configPath);
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-unavailable" });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  await undoable(f, before);
  await expect(readFile(`${f.configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-unavailable" });
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  await expect(f.service.save({ action: "config-undo", process: f.process, expectedVersion: preview.expectedVersion, confirmed: true })).rejects.toMatchObject({ code: "capability_action_unavailable" });
});

it("restores exact prior bytes while leaving dotenv credentials and memory data untouched", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "capability-actions-"))); roots.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json");
  const original = `{\r\n  "runtime": { "model": "openai-codex:gpt-5.5" },\r\n  "context": { "identityPath": "IDENTITY.md" },\r\n  "tools": { "allowedTools": ["Read"], "disallowedTools": ["Bash"] }\r\n}\r\n`;
  await writeFile(join(cwd, "IDENTITY.md"), "# Fictional Agent\n"); await writeFile(configPath, original);
  const service = createCapabilityActionsService({ cwd, configPath, env: {} });
  const process = (await service.read()).process;
  const preview = await service.preview({ action: "memory-lite", process });
  await service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(await readFile(configPath, "utf8")).not.toBe(original);
  const memoryNote = join(cwd, ".mono-agent", "memory", "note.md");
  await mkdir(join(cwd, ".mono-agent", "memory"), { recursive: true });
  await writeFile(memoryNote, "A synthetic memory note.");
  await writeFile(join(cwd, ".env"), "FICTIONAL_RESEARCH_PLACEHOLDER=fictional-inline-literal\n");
  await undoable({ configPath, service, process }, Buffer.from(original));
  expect(await readFile(memoryNote, "utf8")).toBe("A synthetic memory note.");
  expect(await readFile(join(cwd, ".env"), "utf8")).toBe("FICTIONAL_RESEARCH_PLACEHOLDER=fictional-inline-literal\n");
});

it("refuses Undo after a manual edit and for missing or corrupt backups", async () => {
  const f = await fixture(); const before = await readFile(f.configPath);
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  const trimmed = (await readFile(f.configPath, "utf8")).trimEnd();
  expect(trimmed.endsWith("}")).toBe(true);
  await writeFile(f.configPath, `${trimmed.slice(0, -1)},"manual": true }\n`);
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-stale" });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_conflict" });
  const stale = (await f.service.read()).actions.find((action) => action.id === "config-undo");
  expect(stale).toBeDefined();
  await expect(f.service.save({ action: "config-undo", process: f.process, expectedVersion: (await readSettingsVersion(f.configPath)), confirmed: true })).rejects.toMatchObject({ code: "capability_action_conflict" });
  expect(await readFile(f.configPath, "utf8")).toContain('"manual": true');
  await unlink(`${f.configPath}.bak`);
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ reason: "undo-unavailable" });
  await writeFile(`${f.configPath}.bak`, "not a backup envelope");
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ reason: "undo-unavailable" });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  expect(before.length).toBeGreaterThan(0);
});

async function readSettingsVersion(configPath: string): Promise<string> {
  const { readSettingsJson } = await import("@mono-agent/contracts");
  return (await readSettingsJson(configPath)).version;
}

it("refuses subagent delegation when denied or when no subagents block is configured", async () => {
  const denied = await fixture({ subagents: { definitions: [SUBAGENT_PROFILE] }, tools: { allowedTools: ["Read"], disallowedTools: ["Agent"] } });
  expect((await denied.service.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: false, reason: "subagents-denied" });
  await expect(denied.service.preview({ action: "subagents-enable", process: denied.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  const f = await fixture({ tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  expect((await f.service.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: false, reason: "subagents-unconfigured" });
  await expect(f.service.preview({ action: "subagents-enable", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
});

it("accepts zero subagent definitions since general-purpose delegation is usable", async () => {
  for (const extra of [{ subagents: {} }, { subagents: { enabled: false } }, { subagents: { definitions: [] } }] as const) {
    const f = await fixture({ ...extra, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
    expect((await f.service.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: true, reason: "eligible" });
    const preview = await f.service.preview({ action: "subagents-enable", process: f.process });
    expect(preview.changes).toEqual([{ field: "subagents.enabled", value: "true" }, { field: "tools.allowedTools", value: "Append \"Agent\"; existing entries and deny rules are unchanged." }]);
    await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
    expect(JSON.parse(await readFile(f.configPath, "utf8")).subagents).toMatchObject({ enabled: true });
  }
});

it("appends Agent to a chat-only allowlist without touching denies", async () => {
  const f = await fixture({ subagents: {}, tools: { allowedTools: [], disallowedTools: ["Bash"] } });
  const preview = await f.service.preview({ action: "subagents-enable", process: f.process });
  expect(preview.changes).toEqual([{ field: "subagents.enabled", value: "true" }, { field: "tools.allowedTools", value: "Append \"Agent\"; existing entries and deny rules are unchanged." }]);
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(JSON.parse(await readFile(f.configPath, "utf8")).tools).toEqual({ allowedTools: ["Agent"], disallowedTools: ["Bash"] });
});

it("marks an unvalidatable Undo or subagents candidate invalid instead of offering it", async () => {
  const f = await fixture({ tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  const version = (await readSettingsVersion(f.configPath));
  const invalidPrior = JSON.stringify({ runtime: { model: 42 }, context: { identityPath: "IDENTITY.md" } });
  await writeFile(`${f.configPath}.bak`, JSON.stringify({ version: 1, previousMissing: false, previousBase64: Buffer.from(invalidPrior).toString("base64"), intendedSha256: version }));
  expect((await f.service.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "candidate-invalid" });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_invalid" });
  await expect(f.service.save({ action: "config-undo", process: f.process, expectedVersion: version, confirmed: true })).rejects.toMatchObject({ code: "capability_action_invalid" });
  const stale = await fixture({ subagents: { definitions: [{ name: "researcher", description: "A synthetic researcher.", promptPath: "missing-prompt.md" }] }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  expect((await stale.service.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: false, reason: "candidate-invalid" });
  await expect(stale.service.preview({ action: "subagents-enable", process: stale.process })).rejects.toMatchObject({ code: "capability_action_invalid" });
});

it("keeps Enable actions available when the backup slot is unreadable", async () => {
  const f = await fixture({ tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  await mkdir(join(f.cwd, ".mono-agent"));
  await symlink(join(f.cwd, "IDENTITY.md"), `${f.configPath}.bak`);
  const actions = (await f.service.read()).actions;
  expect(actions.find((action) => action.id === "config-undo")).toMatchObject({ available: false, reason: "undo-unavailable" });
  expect(actions.find((action) => action.id === "memory-lite")).toMatchObject({ available: true, reason: "eligible" });
  await expect(f.service.preview({ action: "config-undo", process: f.process })).rejects.toMatchObject({ code: "capability_action_unavailable" });
  const preview = await f.service.preview({ action: "memory-lite", process: f.process });
  expect(preview.noOp).toBe(false);
});

it("appends Agent only to a restrictive allowlist, preserving denies and profiles", async () => {
  const f = await fixture({ subagents: { definitions: [SUBAGENT_PROFILE], inline: { enabled: false } }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });
  const preview = await f.service.preview({ action: "subagents-enable", process: f.process });
  expect(preview).toMatchObject({ noOp: false, changes: [{ field: "subagents.enabled", value: "true" }, { field: "tools.allowedTools" }] });
  const saved = await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(saved.changed).toBe(true);
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  expect(config.subagents).toMatchObject({ enabled: true, definitions: [SUBAGENT_PROFILE], inline: { enabled: false } });
  expect(config.tools).toEqual({ allowedTools: ["Read", "Agent"], disallowedTools: ["Bash"] });
  expect((await f.service.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: true, reason: "already-configured", active: false });
});

it.each([undefined, ["*"]])("preserves an omitted or wildcard tool policy when enabling subagents (%s)", async (allowedTools) => {
  const f = await fixture({ subagents: { definitions: [SUBAGENT_PROFILE] }, ...(allowedTools === undefined ? { tools: { disallowedTools: ["Bash"] } } : { tools: { allowedTools, disallowedTools: ["Bash"] } }) });
  const preview = await f.service.preview({ action: "subagents-enable", process: f.process });
  expect(preview.changes).toEqual([{ field: "subagents.enabled", value: "true" }]);
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  expect(config.subagents.enabled).toBe(true);
  if (allowedTools === undefined) expect(config.tools.allowedTools).toBeUndefined();
  else expect(config.tools.allowedTools).toEqual(["*"]);
  expect(config.tools.disallowedTools).toEqual(["Bash"]);
});

it("enables only the flag when the allowlist already contains Agent, then reports host activation", async () => {
  const f = await fixture({ subagents: { definitions: [SUBAGENT_PROFILE] }, tools: { allowedTools: ["Read", "Agent"], disallowedTools: ["Bash"] } });
  const preview = await f.service.preview({ action: "subagents-enable", process: f.process });
  expect(preview.changes).toEqual([{ field: "subagents.enabled", value: "true" }]);
  await f.service.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
  expect(JSON.parse(await readFile(f.configPath, "utf8")).tools.allowedTools).toEqual(["Read", "Agent"]);
  const active = createCapabilityActionsService({ cwd: f.cwd, configPath: f.configPath, env: {} }, { loadedState: () => ({ memory: false, cron: false, subagents: true }) });
  expect((await active.read()).actions.find((action) => action.id === "subagents-enable")).toMatchObject({ available: true, reason: "already-configured", active: true });
  const noOp = await active.preview({ action: "subagents-enable", process: (await active.read()).process });
  expect(noOp).toMatchObject({ noOp: true, changes: [] });
  expect(await active.save({ action: noOp.action, process: noOp.process, expectedVersion: noOp.expectedVersion, confirmed: true })).toMatchObject({ changed: false });
});
