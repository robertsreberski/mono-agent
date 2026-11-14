import { resolveCredentialEnvironmentName } from "../setup/credential-names.js";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCredentialSetupService } from "../setup/credential-setup.js";
import { mergeSecretEnvFile } from "../setup/secret-env.js";
const roots: string[] = [];
const plantedValue = ["fictional", "credential", "alpha"].join("-");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(extra = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "credential-setup-"))); roots.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json"), dotenvPath = join(cwd, ".env");
  await writeFile(configPath, JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] }, ...extra }));
  await writeFile(join(cwd, "IDENTITY.md"), "# Fictional agent\n");
  return { cwd, configPath, dotenvPath, env: {} };
}
it.each(["telegram", "slack", "openai-api"] as const)("saves %s write-only credentials, owner-only dotenv and guarded config without mutating running env", async (card) => {
  const f = await fixture(); const log = vi.spyOn(console, "info");
  const service = createCredentialSetupService(f); const before = await service.read();
  const fields = card === "telegram" ? { bot: plantedValue, allowedIds: "123,-456" } : card === "slack" ? { bot: plantedValue, app: `${plantedValue}-app`, allowedIds: "C123" } : { bearer: plantedValue };
  const result = await service.save({ card, process: before.process, fence: before.fence, confirmed: true, fields });
  expect(result.outcome).toBe("saved");
  expect((await stat(f.dotenvPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(f.dotenvPath, "utf8")).toContain(plantedValue);
  const json = await readFile(f.configPath, "utf8");
  expect(json).not.toContain(plantedValue); expect(json).toContain('"Read"'); expect(f.env).toEqual({});
  const after = await service.read(); expect(JSON.stringify([result, after, log.mock.calls])).not.toContain(plantedValue);
  expect(after.cards.find((c) => c.id === card)).toMatchObject({ configReady: true, configPending: false, fields: card === "slack" ? [{ state: "set" }, { state: "set" }] : [{ state: "set" }] });
  expect(after.fence).not.toBe(before.fence);
  log.mockRestore();
});
it("rejects stale fences/process identity and racing replacements without overwriting the other writer", async () => {
  const f = await fixture(); const service = createCredentialSetupService(f); const before = await service.read();
  await writeFile(f.dotenvPath, "# external editor\n", { mode: 0o600 });
  const request = { card: "openai-api" as const, process: before.process, fence: before.fence, confirmed: true as const, fields: { bearer: plantedValue } };
  await expect(service.save(request)).rejects.toMatchObject({ code: "credential_conflict" });
  const now = await service.read();
  await expect(service.save({ ...request, fence: now.fence, process: { ...now.process, startedAt: "2020-01-01T00:00:00.000Z" } })).rejects.toMatchObject({ code: "credential_conflict" });
  const racing = createCredentialSetupService(f, { merge: async (path, values, options) => {
    if (!options?.dryRun) await writeFile(path, "# another writer won\n", { mode: 0o600 });
    return mergeSecretEnvFile(path, values, options);
  } });
  const view = await racing.read();
  await expect(racing.save({ ...request, process: view.process, fence: view.fence })).rejects.toMatchObject({ code: "credential_outcome_unknown" });
  expect(await readFile(f.dotenvPath, "utf8")).toBe("# another writer won\n");
});
it("retains only nonsecret pending intent and retries config from fresh durable prerequisites without writing credentials again", async () => {
  const f = await fixture(); const merge = vi.fn(mergeSecretEnvFile); let blocked = true;
  const { writeSettingsJson } = await import("@mono-agent/contracts");
  const service = createCredentialSetupService(f, { merge, writeConfig: async (input) => { if (blocked) throw new Error(plantedValue); return writeSettingsJson(input); } });
  const view = await service.read();
  const base = { card: "telegram" as const, process: view.process, fence: view.fence, confirmed: true as const };
  expect(await service.save({ ...base, fields: { bot: plantedValue, allowedIds: "123" } })).toMatchObject({ outcome: "saved-config-pending" });
  expect(merge).toHaveBeenCalledTimes(2); blocked = false;
  const after = await service.read(); expect(after.cards[0]?.configPending).toBe(true);
  expect(await service.retry({ ...base, fence: after.fence })).toMatchObject({ outcome: "saved" });
  expect(merge).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await service.read())).not.toContain(plantedValue);
  const reloaded = await createCredentialSetupService(f).read(); expect(reloaded.cards[0]).toMatchObject({ configPending: false, configReady: true });
});
it("unknown dotenv outcomes are distinct, sanitized and never create replayable config intent", async () => {
  const f = await fixture(); const service = createCredentialSetupService(f, { merge: async (path, values, options) => { const result = await mergeSecretEnvFile(path, values, options); if (!options?.dryRun) throw new Error(plantedValue); return result; } });
  const view = await service.read(), base = { card: "openai-api" as const, process: view.process, fence: view.fence, confirmed: true as const };
  await expect(service.save({ ...base, fields: { bearer: plantedValue } })).rejects.toMatchObject({ code: "credential_outcome_unknown", message: "credential_outcome_unknown" });
  const after = await service.read(); expect(after.cards[2]).toMatchObject({ configReady: false, configPending: false, fields: [{ state: "set" }] });
  await expect(service.retry({ ...base, fence: after.fence })).rejects.toMatchObject({ code: "credential_unavailable" });
});
it("prevalidates allowlists, missing fields and inline/shadowed settings before dotenv saving", async () => {
  const f = await fixture(); const service = createCredentialSetupService(f); const view = await service.read();
  for (const [card, fields] of [["telegram", { bot: plantedValue }], ["telegram", { bot: plantedValue, allowedIds: "everyone" }], ["slack", { bot: plantedValue, allowedIds: "C123" }]] as const) await expect(service.save({ card, fields, process: view.process, fence: view.fence, confirmed: true })).rejects.toThrow();
  await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  const unavailable = await createCredentialSetupService({ cwd: f.cwd, configPath: f.configPath, env: {} }).read();
  expect(unavailable.cards.every((card) => card.reason === "no-reloadable-source" && !card.available)).toBe(true);
  const shadowed = await createCredentialSetupService({ ...f, env: { MONO_AGENT_OPENAI_API_KEY: plantedValue } }).read(); expect(shadowed.cards[2]?.reason).toBe("env-shadowed");
  const inline = await fixture({ telegram: { botToken: plantedValue } }); expect((await createCredentialSetupService(inline).read()).cards[0]?.reason).toBe("prerequisites");
});

it("shares credential defaults, preserves custom names and rejects reserved operational destinations", () => {
  expect(resolveCredentialEnvironmentName("embeddings")).toBe("MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY");
  expect(resolveCredentialEnvironmentName("parallel")).toBe("PARALLEL_API_KEY");
  expect(resolveCredentialEnvironmentName("embeddings", "CUSTOM_EMBEDDING_AUTH")).toBe("CUSTOM_EMBEDDING_AUTH");
  for (const name of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "MONO_AGENT_TUI_API_KEY", "MONO_AGENT_MANAGED_WORKER", "XDG_RUNTIME_DIR"]) expect(() => resolveCredentialEnvironmentName("embeddings", name)).toThrow();
});

it("replaces only the submitted credential, preserves comments/unrelated values, and refuses credential text in nonsecret config", async () => {
  const f = await fixture();
  await writeFile(f.dotenvPath, "# Preserve comment\nUNRELATED_SETTING=fictional\nMONO_AGENT_OPENAI_API_KEY=old-fictional-value\n", { mode: 0o600 });
  const service = createCredentialSetupService(f), before = await service.read();
  const request = { card: "openai-api" as const, process: before.process, fence: before.fence, confirmed: true as const, fields: { bearer: plantedValue } };
  expect(await service.save(request)).toMatchObject({ outcome: "saved" });
  const saved = await readFile(f.dotenvPath, "utf8"); expect(saved).toContain("# Preserve comment\nUNRELATED_SETTING=fictional\n"); expect(saved).not.toContain("old-fictional-value");
  await expect(service.save(request)).rejects.toMatchObject({ code: "credential_conflict" });
  const current = await service.read();
  await expect(service.save({ card: "slack", process: current.process, fence: current.fence, confirmed: true, fields: { bot: "C123", app: plantedValue, allowedIds: "C123" } })).rejects.toMatchObject({ code: "credential_invalid" });
  expect(await readFile(f.dotenvPath, "utf8")).toBe(saved);
});

it.each(["no-reloadable-source", "env-shadowed", "prerequisites"] as const)("refuses %s at save time before any dotenv write", async (reason) => {
  const f = await fixture(reason === "prerequisites" ? { openaiApi: { apiKey: plantedValue } } : {});
  const merge = vi.fn(mergeSecretEnvFile);
  const service = createCredentialSetupService({ cwd: f.cwd, configPath: f.configPath, env: reason === "env-shadowed" ? { MONO_AGENT_OPENAI_API_KEY: plantedValue } : {}, ...(reason === "no-reloadable-source" ? {} : { dotenvPath: f.dotenvPath }) }, { merge });
  const view = await service.read(); expect(view.cards[2]).toMatchObject({ available: false, reason });
  await expect(service.save({ card: "openai-api", process: view.process, fence: view.fence, confirmed: true, fields: { bearer: plantedValue } })).rejects.toMatchObject({ code: "credential_unavailable" });
  expect(merge).not.toHaveBeenCalled(); await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["telegram", "slack"] as const)("respects existing explicit %s allow-all without setting or clearing it", async (card) => {
  const flag = card === "telegram" ? "allowAllChats" : "allowAllChannels";
  const f = await fixture({ [card]: { enabled: true, [flag]: true } });
  const service = createCredentialSetupService(f); const view = await service.read();
  expect(view.cards.find((item) => item.id === card)).toMatchObject({ available: true, configReady: true });
  expect(await service.save({ card, process: view.process, fence: view.fence, confirmed: true, fields: card === "telegram" ? { bot: plantedValue } : { bot: plantedValue, app: `${plantedValue}-app` } })).toMatchObject({ outcome: "saved" });
  const json = JSON.parse(await readFile(f.configPath, "utf8")); expect(json[card]).toEqual({ enabled: true, [flag]: true });
});
it.each([
  ["telegram", { MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "123" }],
  ["slack", { MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS: "true" }],
  ["openai-api", { MONO_AGENT_OPENAI_API_ENABLED: "false" }],
] as const)("allows %s entry under noncredential environment overrides without changing those settings", async (card, env) => {
  const f = await fixture(); const service = createCredentialSetupService({ ...f, env }); const view = await service.read();
  expect(view.cards.find((item) => item.id === card)).toMatchObject({ available: true, reason: "ready", environmentOverrides: true });
  const fields = card === "telegram" ? { bot: plantedValue, allowedIds: "456" } : card === "slack" ? { bot: plantedValue, app: `${plantedValue}-app` } : { bearer: plantedValue };
  expect(await service.save({ card, process: view.process, fence: view.fence, confirmed: true, fields })).toMatchObject({ outcome: "saved" });
  const json = JSON.parse(await readFile(f.configPath, "utf8"));
  if (card === "telegram") expect(json.telegram).toEqual({ enabled: true });
  if (card === "slack") expect(json.slack).toEqual({ enabled: true });
  if (card === "openai-api") expect(json.openaiApi).toEqual({});
  expect(await readFile(f.dotenvPath, "utf8")).toContain(plantedValue);
});
it.each(["telegram", "slack"] as const)("checks %s allowlist syntax/count boundaries and never synthesizes allow-all", async (card) => {
  const f = await fixture(); const service = createCredentialSetupService(f); const view = await service.read();
  const fields = card === "telegram" ? { bot: plantedValue } : { bot: plantedValue, app: `${plantedValue}-app` };
  const base = { card, process: view.process, fence: view.fence, confirmed: true as const };
  for (const ids of [undefined, card === "telegram" ? "12x" : "C-123", Array.from({ length: 101 }, (_, i) => card === "telegram" ? String(i + 1) : `C${i}`).join(",")]) await expect(service.save({ ...base, fields: { ...fields, ...(ids === undefined ? {} : { allowedIds: ids }) } })).rejects.toMatchObject({ code: "credential_invalid" });
  await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  const ids = Array.from({ length: 100 }, (_, i) => card === "telegram" ? String(-i) : `C${i}`).join(",");
  expect(await service.save({ ...base, fields: { ...fields, allowedIds: ids } })).toMatchObject({ outcome: "saved" });
  const json = JSON.parse(await readFile(f.configPath, "utf8")); expect(json[card][card === "telegram" ? "allowedChatIds" : "allowedChannelIds"]).toHaveLength(100); expect(json[card][card === "telegram" ? "allowAllChats" : "allowAllChannels"]).toBeUndefined();
});
it("compares whole allowlist tokens, not credential substrings", async () => {
  const f = await fixture(); const service = createCredentialSetupService(f); const view = await service.read();
  expect(await service.save({ card: "telegram", process: view.process, fence: view.fence, confirmed: true, fields: { bot: "123", allowedIds: "1234,-1235" } })).toMatchObject({ outcome: "saved" });
  const after = await service.read();
  await expect(service.save({ card: "telegram", process: after.process, fence: after.fence, confirmed: true, fields: { bot: plantedValue, allowedIds: "123" } })).rejects.toMatchObject({ code: "credential_invalid" });
});
it("refuses config-only retry without a pending intent", async () => {
  const f = await fixture(), merge = vi.fn(mergeSecretEnvFile), service = createCredentialSetupService(f, { merge }); const view = await service.read();
  await expect(service.retry({ card: "telegram", process: view.process, fence: view.fence, confirmed: true })).rejects.toMatchObject({ code: "credential_unavailable" }); expect(merge).not.toHaveBeenCalled();
});
it.each(["validation", "writer-conflict"] as const)("keeps confirmed dotenv saves pending after %s and retries only config", async (failure) => {
  const f = await fixture(), original = await readFile(f.configPath, "utf8"); let inject = true;
  const { writeSettingsJson } = await import("@mono-agent/contracts");
  const merge = vi.fn(async (...args: Parameters<typeof mergeSecretEnvFile>) => {
    const result = await mergeSecretEnvFile(...args);
    if (!args[2]?.dryRun && failure === "validation" && inject) await writeFile(f.configPath, JSON.stringify({ ...JSON.parse(original), runtime: { model: "" } }));
    return result;
  });
  const service = createCredentialSetupService(f, { merge, writeConfig: async (input) => {
    if (failure === "writer-conflict" && inject) { inject = false; await writeFile(f.configPath, original + "\n"); }
    return writeSettingsJson(input);
  } }); const view = await service.read();
  const base = { card: "openai-api" as const, process: view.process, fence: view.fence, confirmed: true as const };
  expect(await service.save({ ...base, fields: { bearer: plantedValue } })).toMatchObject({ outcome: "saved-config-pending" });
  expect(merge).toHaveBeenCalledTimes(2); expect(await readFile(f.dotenvPath, "utf8")).toContain(plantedValue);
  if (failure === "validation") { inject = false; await writeFile(f.configPath, original); }
  const after = await service.read(); expect(after.cards[2]?.configPending).toBe(true);
  expect(await service.retry({ ...base, fence: after.fence })).toMatchObject({ outcome: "saved" }); expect(merge).toHaveBeenCalledTimes(2);
});
