import { extraCredentialDefinition, extraCredentialPatch, extraCredentialPrerequisite, extraCredentialReady, isExtraCredentialCard, validateExtraCredential } from "./credential-extra-targets.js";
import { resolveCredentialEnvironmentName } from "./credential-names.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { parseEnv } from "node:util";
import { readSettingsJson, writeSettingsJson, type SettingsJson, type SettingsJsonValue, readBoolean } from "@mono-agent/contracts";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { loadTelegramAdapterConfig } from "@mono-agent/channel-telegram";
import { loadSlackAdapterConfig } from "@mono-agent/channel-slack";
import { loadOpenAIApiAdapterConfig } from "@mono-agent/channel-openai-api";
import { CREDENTIAL_CARDS, CredentialSetupError, parseCredentialRequest, parseCredentialSaveRequest, type CredentialCardId, type CredentialRequest, type CredentialSaveRequest, type CredentialSetupService, type CredentialSaved } from "@mono-agent/channel-operator";
import { readVerifiedFile } from "../durable-state/secure-file-replace.js";
import { mergeSecretEnvFile } from "./secret-env.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";

const channelDefinitions = {
  telegram: { section: "telegram", prefix: "MONO_AGENT_TELEGRAM_", keys: { bot: resolveCredentialEnvironmentName("telegram-bot") }, allow: "allowedChatIds", allowEnv: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", allowAll: "allowAllChats", allowAllEnv: "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS" },
  slack: { section: "slack", prefix: "MONO_AGENT_SLACK_", keys: { bot: resolveCredentialEnvironmentName("slack-bot"), app: resolveCredentialEnvironmentName("slack-app") }, allow: "allowedChannelIds", allowEnv: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS", allowAll: "allowAllChannels", allowAllEnv: "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS" },
  "openai-api": { section: "openaiApi", prefix: "MONO_AGENT_OPENAI_API_", keys: { bearer: resolveCredentialEnvironmentName("openai-client") }, allow: undefined, allowEnv: undefined, allowAll: undefined, allowAllEnv: undefined },
} as const;
const definition = (id: CredentialCardId, json: SettingsJson) => isExtraCredentialCard(id) ? extraCredentialDefinition(id, json) : channelDefinitions[id];
function fail(code: "credential_conflict" | "credential_unavailable" | "credential_invalid" = "credential_unavailable"): never { throw new CredentialSetupError(code, code === "credential_invalid" ? 400 : 409); }
const object = (value: unknown): Record<string, SettingsJsonValue> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, SettingsJsonValue> : {};
type Pending = { readonly card: CredentialCardId; readonly allowedIds?: string; readonly destination?: string };

/** App-owned, write-only two-file workflow. No values, paths or exception prose leave this service. */
export function createCredentialSetupService(input: {
  readonly cwd: string; readonly configPath: string; readonly dotenvPath?: string; readonly env: Record<string, string | undefined>;
}, dependencies: {
  readonly merge?: typeof mergeSecretEnvFile;
  readonly writeConfig?: typeof writeSettingsJson;
} = {}): CredentialSetupService {
  const dotenvPath = input.dotenvPath === undefined ? undefined : resolve(input.cwd, input.dotenvPath);
  const identity = { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() };
  const pending = new Map<CredentialCardId, Pending>();
  let issued: { signature: string; fence: string } | undefined;
  let busy = false;
  const shadowed = new Map<string, boolean>();
  const merge = dependencies.merge ?? mergeSecretEnvFile;
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { if (error instanceof CredentialSetupError) throw error; throw new CredentialSetupError("credential_unavailable", 409); }
  };
  const readSource = async () => {
    const config = await readSettingsJson(input.configPath);
    if (config.missing || config.duplicateKeyPaths.length > 0) fail();
    let bytes: Buffer | undefined;
    if (input.dotenvPath !== undefined) {
      const path = dotenvPath!;
      if (await realpath(dirname(path)) !== dirname(path)) fail();
      bytes = (await readVerifiedFile(path, {
        changedError: () => new CredentialSetupError("credential_conflict", 409),
        validate: (details) => {
          if (!details.isFile() || details.nlink !== 1n || details.size > 1024n * 1024n || (details.mode & 0o077n) !== 0n || (process.getuid !== undefined && details.uid !== BigInt(process.getuid()))) fail();
        },
      }))?.contents;
    }
    const env = parseEnv(bytes?.toString("utf8") ?? "");
    for (const id of CREDENTIAL_CARDS) for (const name of Object.values(definition(id, config.json).keys)) if (!shadowed.has(name)) shadowed.set(name, Boolean(input.env[name]?.trim()) && input.env[name] !== env[name]);
    // The digest is private, used solely to rotate an unrelated random fence.
    const signature = createHash("sha256").update(config.version).update(bytes ?? "missing").digest("hex");
    if (issued?.signature !== signature) issued = { signature, fence: randomUUID() };
    return { config, bytes, env, fence: issued.fence };
  };
  const reason = async (id: CredentialCardId, json: SettingsJson, env: Record<string, string | undefined>) => {
    if (input.dotenvPath === undefined) return "no-reloadable-source" as const;
    const d = definition(id, json);
    if (isExtraCredentialCard(id) && !extraCredentialDefinition(id, json).valid) return "invalid-destination" as const;
    const section = object(json[d.section]);
    if (["apiKey", "botToken", "appToken"].some((key) => section[key] !== undefined)) return "prerequisites" as const;
    const names: readonly string[] = Object.values(d.keys);
    if (names.some((name) => shadowed.get(name))) return "env-shadowed" as const;
    return isExtraCredentialCard(id) ? await extraCredentialPrerequisite(id, json, { ...input, env }) : "ready" as const;
  };
  const effectiveEnv = (dotenv: Record<string, string | undefined>, values: Record<string, string> = {}) => {
    const env = { ...dotenv, ...input.env };
    // Startup dotenv credentials must not shadow subsequent durable replacements.
    for (const [name, blocked] of shadowed) if (!blocked) env[name] = dotenv[name];
    return { ...env, ...values };
  };
  const overridden = (env: Record<string, string | undefined>, name: string) => Boolean(env[name]?.trim());
  const environmentOverrides = (id: CredentialCardId, json: SettingsJson, env: Record<string, string | undefined>) => {
    const d = definition(id, json), names: readonly string[] = Object.values(d.keys);
    return Object.entries(env).some(([name, value]) => value?.trim() && d.prefix !== undefined && name.startsWith(d.prefix) && !names.includes(name));
  };
  const patch = (intent: Pending, json: SettingsJson, env: Record<string, string | undefined>): SettingsJson => {
    if (isExtraCredentialCard(intent.card)) return extraCredentialPatch(intent.card, json, env);
    const d = channelDefinitions[intent.card];
    const section = object(json[d.section]);
    const changes: Record<string, SettingsJsonValue> = overridden(env, `${d.prefix}ENABLED`) ? {} : { enabled: true };
    if (d.allow !== undefined) {
      const ids = (overridden(env, d.allowEnv) ? env[d.allowEnv] : intent.allowedIds)?.split(",").map((id) => id.trim()).filter(Boolean) ?? (Array.isArray(section[d.allow]) ? section[d.allow] as string[] : []);
      const allowAll = readBoolean(env[d.allowAllEnv], d.allowAllEnv, section[d.allowAll] === true, () => new CredentialSetupError("credential_invalid", 400));
      if ((!allowAll && ids.length === 0) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !(intent.card === "telegram" ? /^-?[0-9]+$/u : /^[A-Za-z0-9]+$/u).test(id))) fail("credential_invalid");
      if (!overridden(env, d.allowEnv) && ids.length > 0) changes[d.allow] = ids;
    }
    // Never set allow-all flags or claim to replace environment-owned settings.
    return { [d.section]: changes };
  };
  const validate = async (id: CredentialCardId, json: SettingsJson, env: Record<string, string | undefined>, configPath = input.configPath) => {
    if (isExtraCredentialCard(id)) { await validateExtraCredential(id, json, { ...input, configPath, env }); if (Object.values(definition(id, json).keys).some((name) => !env[name]?.trim())) fail("credential_invalid"); return; }
    const options = { json, env: { ...env, [`${channelDefinitions[id].prefix}ENABLED`]: "true" } };
    const result = id === "telegram" ? await loadTelegramAdapterConfig(options) : id === "slack" ? await loadSlackAdapterConfig(options) : await loadOpenAIApiAdapterConfig(options);
    if (!result.enabled) fail();
    if (Object.values(channelDefinitions[id].keys).some((name) => !env[name]?.trim())) fail("credential_invalid");
  };
  const validateUnchangedPrerequisites = async (env: Record<string, string | undefined>): Promise<void> => {
    await loadMonoAgentConfig({ cwd: input.cwd, jsonPath: input.configPath, warnOnDeprecatedConfig: false, warnOnDuplicateConfig: false });
    const report = await validateMonoAgentFolder({ cwd: input.cwd, configPath: input.configPath, env, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
    if (!report.structurallyValid) fail();
  };
  const prevalidateExtra = async (source: Awaited<ReturnType<typeof readSource>>, changes: SettingsJson, id: CredentialCardId, env: Record<string, string | undefined>) => {
    const checked = new Error("Private credential preflight complete");
    try {
      await writeSettingsJson({ path: input.configPath, patch: changes, guarded: { expectedVersion: source.config.version,
        validate: async (candidate, candidatePath) => {
          await validate(id, candidate, env, candidatePath);
          const report = await validateMonoAgentFolder({ cwd: input.cwd, configPath: candidatePath, env, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
          if (!report.structurallyValid) fail();
          throw checked; // E1 owns private temp/ignore/lock cleanup. Never publish config or a backup in preflight.
        },
      } });
    } catch (error) { if (error !== checked) throw error; }
  };
  const configReady = (id: CredentialCardId, json: SettingsJson, env: Record<string, string | undefined>): boolean => {
    if (isExtraCredentialCard(id)) return extraCredentialReady(id, json, env);
    const d = channelDefinitions[id], section = object(json[d.section]);
    try { patch({ card: id }, json, env); return readBoolean(env[`${d.prefix}ENABLED`], `${d.prefix}ENABLED`, section.enabled === true, () => new CredentialSetupError("credential_invalid", 400)); } catch { return false; }
  };
  const assertRequest = async (request: CredentialRequest, source: Awaited<ReturnType<typeof readSource>>) => {
    if (request.process.pid !== identity.pid || request.process.startedAt !== identity.startedAt || request.fence !== source.fence) fail("credential_conflict");
    if (await reason(request.card, source.config.json, effectiveEnv(source.env)) !== "ready") fail();
  };
  const applyConfig = async (intent: Pending): Promise<CredentialSaved> => {
    try {
      const current = await readSource();
      if (await reason(intent.card, current.config.json, effectiveEnv(current.env)) !== "ready") fail();
      const changes = patch(intent, current.config.json, effectiveEnv(current.env));
      const d = definition(intent.card, current.config.json);
      if (intent.destination !== undefined && Object.values(d.keys)[0] !== intent.destination) fail();
      const next = { ...current.config.json, [d.section]: { ...object(current.config.json[d.section]), ...object(changes[d.section]) } };
      const env = effectiveEnv(current.env);
      if (isExtraCredentialCard(intent.card)) await prevalidateExtra(current, changes, intent.card, env);
      else await validateUnchangedPrerequisites(env);
      await validate(intent.card, next, env);
      if (JSON.stringify(next) !== JSON.stringify(current.config.json)) await (dependencies.writeConfig ?? writeSettingsJson)({ path: input.configPath, patch: changes, guarded: {
        expectedVersion: current.config.version,
        validate: async (candidate, candidatePath) => {
          const latest = await readSource();
          if (latest.fence !== current.fence) fail("credential_conflict");
          await validate(intent.card, candidate, effectiveEnv(latest.env), candidatePath);
          const report = await validateMonoAgentFolder({ cwd: input.cwd, configPath: candidatePath, env: effectiveEnv(latest.env), allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
          if (!report.structurallyValid) fail();
        },
      } });
      pending.delete(intent.card);
      return { card: intent.card, process: identity, outcome: "saved" };
    } catch { return { card: intent.card, process: identity, outcome: "saved-config-pending" }; }
  };
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => safe(async () => {
    if (busy) fail("credential_conflict");
    busy = true;
    try { return await work(); } finally { busy = false; }
  });
  return {
    read: () => safe(async () => {
      const source = await readSource();
      return { version: 1, process: identity, fence: source.fence, cards: await Promise.all(CREDENTIAL_CARDS.map(async (id) => {
        const why = await reason(id, source.config.json, effectiveEnv(source.env));
        return { id, available: why === "ready", reason: why, fields: Object.entries(definition(id, source.config.json).keys).map(([field, name]) => ({ id: field as "bot" | "app" | "bearer" | "credential", state: source.env[name]?.trim() ? "set" as const : "not-set" as const })), ...(environmentOverrides(id, source.config.json, effectiveEnv(source.env)) ? { environmentOverrides: true as const } : {}), configReady: (!isExtraCredentialCard(id) || why === "ready") && configReady(id, source.config.json, effectiveEnv(source.env)), configPending: pending.has(id) };
      })) };
    }),
    save: (raw) => exclusive(async () => {
      let request: CredentialSaveRequest;
      try { request = parseCredentialSaveRequest(raw); } catch { fail("credential_invalid"); }
      const source = await readSource(); await assertRequest(request, source);
      const intent: Pending = { card: request.card, ...(isExtraCredentialCard(request.card) ? { destination: Object.values(definition(request.card, source.config.json).keys)[0]! } : {}), ...(request.fields.allowedIds === undefined ? {} : { allowedIds: request.fields.allowedIds }) };
      const d = definition(request.card, source.config.json);
      const changes = patch(intent, source.config.json, effectiveEnv(source.env));
      const values: Record<string, string> = {};
      for (const [field, name] of Object.entries(d.keys)) { const value = request.fields[field as keyof typeof request.fields]; if (value !== undefined) values[name] = value; }
      if (Object.keys(values).length === 0) fail("credential_invalid");
      if (intent.destination !== undefined && Object.values(values).some((value) => value.trim() === intent.destination)) fail("credential_invalid");
      if (intent.allowedIds !== undefined && [...Object.values(values), ...Object.values(d.keys).map((name) => source.env[name])].some((value) => value && intent.allowedIds!.split(",").some((id) => id.trim() === value))) fail("credential_invalid");
      const candidate = { ...source.config.json, [d.section]: { ...object(source.config.json[d.section]), ...object(changes[d.section]) } };
      if (isExtraCredentialCard(request.card)) await prevalidateExtra(source, changes, request.card, effectiveEnv(source.env, values));
      else await validateUnchangedPrerequisites(effectiveEnv(source.env, values));
      await validate(request.card, candidate, effectiveEnv(source.env, values));
      const options = { replaceKeys: Object.keys(values), expectedEnvRevision: source.bytes === undefined ? { exists: false as const } : { exists: true as const, contents: source.bytes } };
      await merge(dotenvPath!, values, { ...options, dryRun: true });
      pending.delete(request.card); // An attempted replacement invalidates any earlier config-only intent.
      try { await merge(dotenvPath!, values, options); }
      catch { throw new CredentialSetupError("credential_outcome_unknown", 503); }
      pending.set(request.card, intent); // Retain only nonsecret config intent after confirmed dotenv completion.
      return await applyConfig(intent);
    }),
    retry: (raw) => exclusive(async () => {
      let request: CredentialRequest;
      try { request = parseCredentialRequest(raw); } catch { fail("credential_invalid"); }
      const source = await readSource(); await assertRequest(request, source);
      const intent = pending.get(request.card); if (intent === undefined) fail();
      return await applyConfig(intent);
    }),
  };
}
