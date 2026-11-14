import { resolveJsonMonoAgentConfig, type MonoAgentConfigJson } from "@mono-agent/config";
import { isPrivateBaseUrl } from "@mono-agent/turn/host/config";
import type { SettingsJson, SettingsJsonValue } from "@mono-agent/contracts";
import type { CredentialCardId, CredentialCardStatus } from "@mono-agent/channel-operator";
import { ChannelPluginConfigError, resolveConfiguredChannelPlugins } from "../channels/channel-plugins.js";
import { memorySection } from "../doctor/memory.js";
import { resolveCredentialEnvironmentName } from "./credential-names.js";

const record = (value: unknown): Record<string, SettingsJsonValue> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, SettingsJsonValue> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value.trim() || undefined : undefined;
type ExtraCredentialCard = Exclude<CredentialCardId, "telegram" | "slack" | "openai-api">;
export function isExtraCredentialCard(id: CredentialCardId): id is ExtraCredentialCard { return !["telegram", "slack", "openai-api"].includes(id); }
function a2aEntry(json: SettingsJson) {
  const plugins = record(json.channels).plugins;
  const matches = Array.isArray(plugins) ? plugins.map(record).filter((entry) => entry.package === "@mono-agent/channel-a2a") : [];
  return matches.length === 1 ? matches[0] : undefined;
}
function section(id: ExtraCredentialCard, json: SettingsJson) {
  if (id === "a2a") { const entry = a2aEntry(json); return entry?.config === undefined ? record(json.a2a) : record(entry.config); }
  if (id === "embeddings") return record(record(json.memory).embeddings);
  const direction = id === "parallel-fetch" ? "fetch" : "search";
  return record(record(record(record(json.tools).web)[direction])[id === "ollama-search" ? "ollama" : "parallel"]);
}
export function extraCredentialDefinition(id: ExtraCredentialCard, json: SettingsJson) {
  const settings = section(id, json);
  const kind = id === "a2a" ? "a2a-bearer" : id === "embeddings" ? "embeddings" : id === "ollama-search" ? "ollama-hosted" : "parallel";
  let valid = true, name: string;
  try {
    if (settings.apiKeyEnv !== undefined && (typeof settings.apiKeyEnv !== "string" || !settings.apiKeyEnv.trim())) throw new Error("Invalid destination");
    name = resolveCredentialEnvironmentName(kind, id === "a2a" ? undefined : text(settings.apiKeyEnv));
  } catch { valid = false; name = resolveCredentialEnvironmentName(kind); }
  return {
    section: id === "a2a" ? (a2aEntry(json)?.config === undefined ? "a2a" : "channels") : id === "embeddings" ? "memory" : "tools",
    prefix: id === "a2a" ? "MONO_AGENT_A2A_" : undefined,
    keys: id === "a2a" ? { bearer: name } : { credential: name },
    valid, allow: undefined, allowEnv: undefined, allowAll: undefined, allowAllEnv: undefined,
  };
}
export function extraCredentialPatch(id: ExtraCredentialCard, json: SettingsJson, env: Record<string, string | undefined>): SettingsJson {
  const settings = section(id, json), name = Object.values(extraCredentialDefinition(id, json).keys)[0]!;
  if (id === "a2a") {
    const next = { ...settings, provider: { ...record(settings.provider), ...(env.MONO_AGENT_A2A_REQUIRE_BEARER?.trim() ? {} : { requireBearer: true }) } };
    const entry = a2aEntry(json);
    if (entry?.config === undefined) return { a2a: next };
    const channels = record(json.channels), plugins = channels.plugins as SettingsJsonValue[];
    return { channels: { ...channels, plugins: plugins.map((item) => item === entry ? { ...entry, config: next } : item) } };
  }
  if (id === "embeddings") return { memory: { ...record(json.memory), embeddings: { ...settings, apiKeyEnv: name } } };
  const tools = record(json.tools), web = record(tools.web), direction = id === "parallel-fetch" ? "fetch" : "search", provider = id === "ollama-search" ? "ollama" : "parallel";
  return { tools: { ...tools, web: { ...web, [direction]: { ...record(web[direction]), [provider]: { ...settings, apiKeyEnv: name } } } } };
}
export function extraCredentialReady(id: ExtraCredentialCard, json: SettingsJson, env: Record<string, string | undefined>): boolean {
  const settings = section(id, json);
  return id === "a2a" ? (env.MONO_AGENT_A2A_REQUIRE_BEARER?.trim() ?? String(record(settings.provider).requireBearer)) === "true"
    : settings.apiKeyEnv === Object.values(extraCredentialDefinition(id, json).keys)[0];
}
async function a2aDriver(json: SettingsJson, input: { cwd: string; configPath: string; env: Record<string, string | undefined> }) {
  const entry = a2aEntry(json);
  if (!entry) return undefined;
  return (await resolveConfiguredChannelPlugins(input)).find((driver) => driver.id === (text(entry.id) ?? "a2a"));
}
/** Read-only, offline prerequisites. Never install a plugin, probe a vendor, or create a memory root. */
export async function extraCredentialPrerequisite(id: ExtraCredentialCard, json: SettingsJson, input: { cwd: string; configPath: string; env: Record<string, string | undefined> }): Promise<CredentialCardStatus["reason"]> {
  if (!extraCredentialDefinition(id, json).valid) return "invalid-destination";
  const settings = section(id, json);
  if (settings.apiKey !== undefined || (id === "a2a" && record(settings.provider).bearerToken !== undefined)) return "prerequisites";
  if (id === "a2a") {
    if (!a2aEntry(json)) return "plugin-required";
    try {
      const driver = await a2aDriver(json, input);
      if (!driver) return "plugin-required";
      // Credential absence must not hide endpoint/Agent Card prerequisites. This is a loader-only check.
      const config = record(await driver.loadConfig({ ...input, env: { ...input.env, MONO_AGENT_A2A_REQUIRE_BEARER: "false" } }));
      if (record(config.provider).enabled !== true || !config.agent || !config.skill) return "endpoint-required";
    } catch (error) { return error instanceof ChannelPluginConfigError && error.code === "plugin_import_failed" ? "plugin-required" : "endpoint-required"; }
    return "ready";
  }
  try {
    const candidate = { ...json, ...extraCredentialPatch(id, json, input.env) } as MonoAgentConfigJson;
    const config = resolveJsonMonoAgentConfig({ cwd: input.cwd, json: candidate });
    if (id === "embeddings") {
      const memory = config.memory;
      if (!memory || !["journal", "bujo"].includes(memory.mode) || !memory.embeddings) return "memory-required";
      // An omitted key on a local/keyless service is not an implicit request to add authentication.
      const endpoint = memory.embeddings.endpoint ?? (memory.embeddings.provider === "openai" ? "https://api.openai.com" : "http://127.0.0.1");
      if (settings.apiKeyEnv === undefined && isPrivateBaseUrl(endpoint)) return "keyless";
      if ((await memorySection(config, input.cwd, input.env, false, false)).status === "error") return "memory-required";
    } else {
      const fetch = id === "parallel-fetch", tool = fetch ? "WebFetch" : "WebSearch";
      if ((!config.tools.allowedTools.includes("*") && !config.tools.allowedTools.includes(tool)) || config.tools.disallowedTools.includes("*") || config.tools.disallowedTools.includes(tool)) return "tool-policy";
      const selection = fetch ? config.tools.web!.fetch.provider : config.tools.web!.search.backend;
      const provider = id === "ollama-search" ? "ollama" : "parallel";
      if (!(typeof selection === "string" ? selection === provider : selection?.includes(provider))) return "tool-policy";
      if (id === "ollama-search" && config.tools.web!.search.ollama?.baseUrl !== "https://ollama.com") return "endpoint-required";
    }
    return "ready";
  } catch { return id === "embeddings" ? "memory-required" : "endpoint-required"; }
}
export async function validateExtraCredential(id: ExtraCredentialCard, json: SettingsJson, input: { cwd: string; configPath: string; env: Record<string, string | undefined> }): Promise<void> {
  if (await extraCredentialPrerequisite(id, json, input) !== "ready") throw new Error("Credential prerequisites unavailable");
  if (id === "a2a") {
    const driver = await a2aDriver(json, input);
    if (!driver) throw new Error("Provider unavailable");
    await driver.loadConfig(input);
  }
}
