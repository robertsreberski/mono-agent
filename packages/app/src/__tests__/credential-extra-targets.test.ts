import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeSettingsJson } from "@mono-agent/contracts";
import type { CredentialCardId } from "@mono-agent/channel-operator";
import { createCredentialSetupService } from "../setup/credential-setup.js";
import { mergeSecretEnvFile } from "../setup/secret-env.js";
import { resolveCredentialEnvironmentName } from "../setup/credential-names.js";
const roots: string[] = [];
const plantedValue = ["fictional", "extra", "credential"].join("-");
const cards = ["a2a", "embeddings", "parallel-search", "parallel-fetch", "ollama-search"] as const;
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(card: CredentialCardId, name?: string, mode: "journal" | "bujo" = "journal") {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "credential-extras-"))); roots.push(cwd);
  const embeddings = { provider: "lmstudio" as const, model: "fictional-embedding", dim: 4, endpoint: "https://embedding.invalid", ...(name ? { apiKeyEnv: name } : {}) };
  const extra = card === "a2a" ? { channels: { plugins: [{ package: "@mono-agent/channel-a2a", config: { enabled: true, provider: { host: "127.0.0.1", port: 0 }, agent: { name: "Fictional agent", description: "Synthetic provider", version: "1" }, skill: { id: "default", name: "Fictional skill", description: "Synthetic skill" } } }] } }
    : card === "embeddings" ? { memory: { mode, path: "memory", embeddings, ...(mode === "bujo" ? { llm: { provider: "ollama", model: "fictional-model" } } : {}) } }
    : { tools: { allowedTools: ["Read", "WebSearch", "WebFetch"], disallowedTools: ["Bash"], web: { search: { backend: card === "ollama-search" ? "ollama" : "parallel", ...(card === "ollama-search" ? { ollama: { baseUrl: "https://ollama.com", ...(name ? { apiKeyEnv: name } : {}) } } : { parallel: { ...(name ? { apiKeyEnv: name } : {}) } }) }, fetch: { provider: "parallel", parallel: { ...(name ? { apiKeyEnv: name } : {}) } } } } };
  const configPath = join(cwd, "mono-agent.config.json"), dotenvPath = join(cwd, ".env");
  await writeFile(configPath, JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] }, ...extra }));
  await writeFile(join(cwd, "IDENTITY.md"), "# Fictional identity\n");
  if (card === "embeddings") {
    const { safeRebuildMemoryIndex } = await import("@mono-agent/memory/bujo");
    const { effectiveEmbeddingIdentity } = await import("@mono-agent/memory/search");
    const root = join(cwd, "memory"); await mkdir(root);
    await safeRebuildMemoryIndex({ root, tier: mode, dim: 4, embeddings: { id: effectiveEmbeddingIdentity(embeddings, undefined), embed: async (texts) => texts.map(() => [0, 0, 0, 1]) } });
  }
  return { cwd, configPath, dotenvPath, env: {} };
}
async function request(service: ReturnType<typeof createCredentialSetupService>, card: typeof cards[number]) {
  const view = await service.read();
  return { card, process: view.process, fence: view.fence, confirmed: true as const, fields: card === "a2a" ? { bearer: plantedValue } : { credential: plantedValue } };
}
it.each(cards)("saves prepared %s with offline prevalidation and no literal in status, config or logs", async (card) => {
  const f = await fixture(card), initial = await readFile(f.configPath, "utf8");
  const service = createCredentialSetupService(f, { merge: async (...args) => {
    // Candidate preflight must abort publication: dotenv always precedes config/backup.
    expect(await readFile(f.configPath, "utf8")).toBe(initial);
    await expect(readFile(`${f.configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    return mergeSecretEnvFile(...args);
  } });
  const logs = [vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  const beforeMemory = card === "embeddings" ? await readdir(join(f.cwd, "memory", ".index", "generations")) : undefined;
  expect((await service.read()).cards.find((item) => item.id === card)).toMatchObject({ available: true, reason: "ready", fields: [{ state: "not-set" }] });
  const result = await service.save(await request(service, card)); expect(result.outcome).toBe("saved");
  const view = await service.read(); expect(view.cards.find((item) => item.id === card)).toMatchObject({ configReady: true, configPending: false, fields: [{ state: "set" }] });
  const json = await readFile(f.configPath, "utf8"); expect(JSON.stringify([result, view, json, logs.map((log) => log.mock.calls)])).not.toContain(plantedValue);
  expect(await readFile(f.dotenvPath, "utf8")).toContain(plantedValue); expect(f.env).toEqual({});
  if (card === "a2a") expect(JSON.parse(json).channels.plugins[0].config.provider).toMatchObject({ requireBearer: true, host: "127.0.0.1", port: 0 });
  else expect(json).toContain(card === "embeddings" ? "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY" : card === "ollama-search" ? "OLLAMA_API_KEY" : "PARALLEL_API_KEY");
  if (beforeMemory) expect(await readdir(join(f.cwd, "memory", ".index", "generations"))).toEqual(beforeMemory);
  expect(initial).toContain("Bash"); expect(json).toContain("Bash");
});
it.each(cards)("retries %s configuration only after confirmed dotenv completion and refuses retry without pending", async (card) => {
  const f = await fixture(card), merge = vi.fn(mergeSecretEnvFile); let fail = true;
  const service = createCredentialSetupService(f, { merge, writeConfig: async (input) => { if (fail) throw new Error(plantedValue); return writeSettingsJson(input); } });
  const input = await request(service, card);
  await expect(service.retry({ card, process: input.process, fence: input.fence, confirmed: true })).rejects.toMatchObject({ code: "credential_unavailable" });
  expect(await service.save(input)).toMatchObject({ outcome: "saved-config-pending" }); expect(merge).toHaveBeenCalledTimes(2);
  const after = await service.read(); fail = false;
  expect(await service.retry({ card, process: after.process, fence: after.fence, confirmed: true })).toMatchObject({ outcome: "saved" }); expect(merge).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await service.read())).not.toContain(plantedValue);
});
it.each(["embeddings", "parallel-search", "parallel-fetch", "ollama-search"] as const)("preserves a valid custom %s destination and rejects reserved/cross-credential destinations", async (card) => {
  const f = await fixture(card, "CUSTOM_SERVICE_AUTH"), service = createCredentialSetupService(f);
  expect(await service.save(await request(service, card))).toMatchObject({ outcome: "saved" });
  expect(await readFile(f.dotenvPath, "utf8")).toContain("CUSTOM_SERVICE_AUTH="); expect(await readFile(f.configPath, "utf8")).toContain("CUSTOM_SERVICE_AUTH");
  const invalid = await fixture(card, "PATH"), blocked = createCredentialSetupService(invalid);
  expect((await blocked.read()).cards.find((item) => item.id === card)).toMatchObject({ available: false, reason: "invalid-destination" });
  await expect(blocked.save(await request(blocked, card))).rejects.toMatchObject({ code: "credential_unavailable" }); await expect(readFile(invalid.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => resolveCredentialEnvironmentName(card === "embeddings" ? "embeddings" : card === "ollama-search" ? "ollama-hosted" : "parallel", "MONO_AGENT_TELEGRAM_BOT_TOKEN")).toThrow();
});
it("preserves anonymous Parallel, local embeddings/Ollama, tool policy and unprepared roots without writes", async () => {
  const f = await fixture("parallel-search"), initial = await readFile(f.configPath, "utf8"), service = createCredentialSetupService(f);
  await service.read(); expect(await readFile(f.configPath, "utf8")).toBe(initial); await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  const json = JSON.parse(initial); json.tools.disallowedTools.push("WebSearch"); await writeFile(f.configPath, JSON.stringify(json));
  expect((await service.read()).cards.find((item) => item.id === "parallel-search")).toMatchObject({ available: false, reason: "tool-policy" });
  const m = await fixture("embeddings"); const memory = JSON.parse(await readFile(m.configPath, "utf8")); memory.memory.embeddings.endpoint = "http://127.0.0.1:1234"; await writeFile(m.configPath, JSON.stringify(memory));
  const local = createCredentialSetupService(m); expect((await local.read()).cards.find((item) => item.id === "embeddings")).toMatchObject({ available: false, reason: "keyless" });
  memory.memory.embeddings.endpoint = "https://embedding.invalid"; memory.memory.path = "missing-memory"; await writeFile(m.configPath, JSON.stringify(memory));
  expect((await local.read()).cards.find((item) => item.id === "embeddings")).toMatchObject({ available: false, reason: "memory-required" }); await expect(readdir(join(m.cwd, "missing-memory"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["http://127.0.0.1:11434", "https://ollama.com.evil.invalid", "http://ollama.com", "https://ollama.com/path", "https://ollama.com?private=1"])("does not offer hosted Ollama credentials for %s", async (baseUrl) => {
  const f = await fixture("ollama-search"), json = JSON.parse(await readFile(f.configPath, "utf8")); json.tools.web.search.ollama.baseUrl = baseUrl;
  await writeFile(f.configPath, JSON.stringify(json)); const service = createCredentialSetupService(f);
  expect((await service.read()).cards.find((item) => item.id === "ollama-search")).toMatchObject({ available: false, reason: "endpoint-required" });
  await expect(service.save(await request(service, "ollama-search"))).rejects.toMatchObject({ code: "credential_unavailable" }); await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("requires prepared A2A plugins and endpoint identity, and does not enable a disabled provider", async () => {
  const f = await fixture("a2a"), json = JSON.parse(await readFile(f.configPath, "utf8")), service = createCredentialSetupService(f);
  json.channels.plugins[0].config.enabled = false; await writeFile(f.configPath, JSON.stringify(json));
  expect((await service.read()).cards.find((item) => item.id === "a2a")).toMatchObject({ available: false, reason: "endpoint-required" });
  json.channels.plugins = []; await writeFile(f.configPath, JSON.stringify(json)); expect((await service.read()).cards.find((item) => item.id === "a2a")).toMatchObject({ available: false, reason: "plugin-required" });
  await expect(service.save(await request(service, "a2a"))).rejects.toMatchObject({ code: "credential_unavailable" });
});
it("only exact custom credential keys shadow entry, and pending retry never retargets a saved value", async () => {
  const f = await fixture("parallel-search", "CUSTOM_SERVICE_AUTH");
  const shadowed = createCredentialSetupService({ ...f, env: { CUSTOM_SERVICE_AUTH: plantedValue } }); expect((await shadowed.read()).cards.find((item) => item.id === "parallel-search")?.reason).toBe("env-shadowed");
  const pendingFixture = await fixture("parallel-search");
  const merge = vi.fn(mergeSecretEnvFile), service = createCredentialSetupService(pendingFixture, { merge, writeConfig: async () => { throw new Error(plantedValue); } });
  expect(await service.save(await request(service, "parallel-search"))).toMatchObject({ outcome: "saved-config-pending" });
  const json = JSON.parse(await readFile(pendingFixture.configPath, "utf8")); json.tools.web.search.parallel.apiKeyEnv = "DIFFERENT_SERVICE_AUTH"; await writeFile(pendingFixture.configPath, JSON.stringify(json)); const after = await service.read();
  expect(await service.retry({ card: "parallel-search", process: after.process, fence: after.fence, confirmed: true })).toMatchObject({ outcome: "saved-config-pending" }); expect(merge).toHaveBeenCalledTimes(2);
});

it.each(cards)("refuses exact %s credential shadows and missing reloadable sources at save time", async (card) => {
  const f = await fixture(card), baseline = createCredentialSetupService(f), view = await baseline.read();
  const name = card === "a2a" ? "MONO_AGENT_A2A_BEARER_TOKEN" : card === "embeddings" ? "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY" : card === "ollama-search" ? "OLLAMA_API_KEY" : "PARALLEL_API_KEY";
  const shadowed = createCredentialSetupService({ ...f, env: { [name]: plantedValue } });
  expect((await shadowed.read()).cards.find((item) => item.id === card)?.reason).toBe("env-shadowed");
  await expect(shadowed.save(await request(shadowed, card))).rejects.toMatchObject({ code: "credential_unavailable" });
  const absent = createCredentialSetupService({ cwd: f.cwd, configPath: f.configPath, env: {} });
  expect((await absent.read()).cards.find((item) => item.id === card)?.reason).toBe("no-reloadable-source");
  await expect(absent.save({ card, process: view.process, fence: (await absent.read()).fence, confirmed: true, fields: card === "a2a" ? { bearer: plantedValue } : { credential: plantedValue } })).rejects.toMatchObject({ code: "credential_unavailable" });
  await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(cards)("never replays an uncertain %s dotenv outcome", async (card) => {
  const f = await fixture(card), service = createCredentialSetupService(f, { merge: async (...args) => { const result = await mergeSecretEnvFile(...args); if (!args[2]?.dryRun) throw new Error(plantedValue); return result; } });
  await expect(service.save(await request(service, card))).rejects.toMatchObject({ code: "credential_outcome_unknown", message: "credential_outcome_unknown" });
  const after = await service.read(); expect(after.cards.find((item) => item.id === card)).toMatchObject({ configPending: false, fields: [{ state: "set" }] });
  expect(JSON.stringify(after)).not.toContain(plantedValue);
  await expect(service.retry({ card, process: after.process, fence: after.fence, confirmed: true })).rejects.toMatchObject({ code: "credential_unavailable" });
});

it("updates a prepared BuJo reference without touching its managed generation or root contents", async () => {
  const f = await fixture("embeddings", undefined, "bujo");
  const { resolveActiveMemoryDbPath } = await import("@mono-agent/memory/bujo");
  const root = join(f.cwd, "memory"), dbPath = resolveActiveMemoryDbPath(root), manifest = join(root, ".index", "manifest.json");
  const before = [await readFile(dbPath), await readFile(manifest)];
  const service = createCredentialSetupService(f); expect(await service.save(await request(service, "embeddings"))).toMatchObject({ outcome: "saved" });
  expect([await readFile(dbPath), await readFile(manifest)]).toEqual(before); expect(JSON.parse(await readFile(f.configPath, "utf8")).memory.mode).toBe("bujo");
});
it("keeps explicit A2A environment control without claiming to require a bearer", async () => {
  const f = await fixture("a2a"), service = createCredentialSetupService({ ...f, env: { MONO_AGENT_A2A_REQUIRE_BEARER: "false" } });
  expect((await service.read()).cards.find((item) => item.id === "a2a")).toMatchObject({ available: true, environmentOverrides: true });
  expect(await service.save(await request(service, "a2a"))).toMatchObject({ outcome: "saved" });
  expect(JSON.parse(await readFile(f.configPath, "utf8")).channels.plugins[0].config.provider.requireBearer).toBeUndefined();
  expect((await service.read()).cards.find((item) => item.id === "a2a")?.configReady).toBe(false);
});

it("rejects whole-token collisions with the nonsecret environment reference, not substrings", async () => {
  const f = await fixture("parallel-search"), service = createCredentialSetupService(f), base = await request(service, "parallel-search");
  await expect(service.save({ ...base, fields: { credential: "PARALLEL_API_KEY" } })).rejects.toMatchObject({ code: "credential_invalid" });
  await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await service.save({ ...base, fields: { credential: "PARALLEL_API_KEY-with-fictional-suffix" } })).toMatchObject({ outcome: "saved" });
});

it.each((["embeddings", "parallel-search", "parallel-fetch", "ollama-search"] as const).flatMap((card) => [
  "MONO_AGENT_A2A_ENABLED", "MONO_AGENT_A2A_REQUIRE_BEARER",
  "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS",
  "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN", "MONO_AGENT_SLACK_APP_TOKEN", "MONO_AGENT_FUTURE_SETTING",
].map((name) => ({ card, name }))))("refuses $card entry/save into $name before any persistence", async ({ card, name }) => {
  const f = await fixture(card, name), initial = await readFile(f.configPath, "utf8");
  const merge = vi.fn(mergeSecretEnvFile), writeConfig = vi.fn(writeSettingsJson);
  const service = createCredentialSetupService(f, { merge, writeConfig }), view = await service.read();
  expect(view.cards.find((item) => item.id === card)).toMatchObject({ available: false, reason: "invalid-destination", configReady: false });
  await expect(service.save(await request(service, card))).rejects.toMatchObject({ code: "credential_unavailable", message: "credential_unavailable" });
  expect(merge).not.toHaveBeenCalled(); expect(writeConfig).not.toHaveBeenCalled();
  expect(await readFile(f.configPath, "utf8")).toBe(initial);
  await expect(readFile(f.dotenvPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(`${f.configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(view)).not.toContain(plantedValue);
});
