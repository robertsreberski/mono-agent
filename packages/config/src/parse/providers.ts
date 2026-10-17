import { hasRetiredPiSessionsRoot } from "../retired-fields.js";
import { homedir } from "node:os";

import { resolve } from "node:path";

import { supportsPiContext1M } from "@mono-agent/turn/host/config";

import {
  isAutodiscoverableProviderId,
  isPiBuiltinProvider,
  modelReferenceKey,
  TurnHostError,
  validateLocalProviderDefinition,
  validateProviderDefinition,
} from "@mono-agent/turn/host/config";

import { PI_TRANSPORTS } from "@mono-agent/turn/host/types";

import type {
  LocalProviderDefinition,
  LocalProviderModelDefinition,
  PiTransport,
  ProviderDefinition,
  RuntimeModelReference,
} from "@mono-agent/turn/host/types";

import { normalizeOptionalString, readChoice } from "@mono-agent/contracts";

import type { MonoAgentConfigJson } from "../json-types.js";

import type {
  MonoAgentConfig,
  PiNativeProviderConfig,
  ResolvedProviders,
  RuntimeFallbackConfig,
} from "../types.js";

import { invalidJson, MonoAgentConfigError } from "../errors.js";

import { isRecord } from "./scalars.js";

import {
  jsonChoice,
  jsonOptionalBoolean,
  jsonOptionalInteger,
  jsonRecord,
  jsonString,
  readObjectBoolean,
  readObjectInteger,
  readObjectString,
  readPlainObject,
  requireJsonString,
} from "./scalars.js";

import { parseModel, readModelSelection } from "./model-reference.js";

export const DEFAULT_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");

/**
 * Normalize loaded/programmatic provider config into one deterministic view.
 * Loaded configs carry `entries`; the `local` fallback preserves compatibility
 * for embedders that still construct the pre-map shape by hand.
 */
export function resolveConfiguredProviders(
  config: Pick<MonoAgentConfig, "providers">,
): ResolvedProviders {
  const rawEntries = config.providers?.entries ?? config.providers?.local ?? [];
  const byId = new Map<string, ProviderDefinition>();
  for (const rawEntry of rawEntries) {
    const entry = validateProviderDefinition(rawEntry);
    if (byId.has(entry.id)) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `Provider id "${entry.id}" is configured more than once. Remove the duplicate definition.`,
        { providerId: entry.id },
      );
    }
    byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    piAuthPath: config.providers?.piAuthPath ?? DEFAULT_PI_AUTH_PATH,
    ...(config.providers?.piNative === undefined ? {} : { piNative: config.providers.piNative }),
  };
}

/** One authored model reference to validate, with the config path that owns it. */
interface ProviderCoverageRoute {
  readonly model: RuntimeModelReference;
  /** Config path used verbatim in the failure message, e.g. `runtime.model`. */
  readonly path: string;
}

/**
 * Every authored `subagents.definitions[].model` is a real route: the harness
 * builds a runtime for it exactly like a fallback, so it must pass the same
 * provider gate. Left unchecked, a typo'd provider id loaded fine and only blew
 * up mid-turn, inside a subagent, where the failure is hardest to attribute.
 */
export function subagentProviderRoutes(
  subagents: MonoAgentConfig["subagents"] | undefined,
): readonly ProviderCoverageRoute[] {
  return [...(subagents?.models ?? []).map((choice, index) => ({
    model: choice.model, path: `subagents.models[${index}].model`,
  })), ...(subagents?.definitions ?? []).flatMap((definition, index) =>
    definition.model === undefined
      ? []
      : [{ model: definition.model, path: `subagents.definitions[${index}].model` }],
  )];
}

/**
 * Fail early when a route names neither Pi's builtin catalog, an explicitly
 * configured provider, nor one of the two zero-config local discovery ids.
 * `additionalRoutes` carries model references authored outside
 * `runtime.model`/`runtime.fallbacks[]` (today: subagent profiles).
 */
export function assertConfiguredProviderCoverage(
  model: RuntimeModelReference,
  fallbacks: readonly RuntimeFallbackConfig[] | undefined,
  providers: ResolvedProviders,
  additionalRoutes: readonly ProviderCoverageRoute[] = [],
): void {
  const routes: readonly ProviderCoverageRoute[] = [
    { model, path: "runtime.model" },
    ...(fallbacks ?? []).map((fallback, index) => ({
      model: fallback.model,
      path: `runtime.fallbacks[${index}].model`,
    })),
    ...additionalRoutes,
  ];
  for (const route of routes) {
    const providerId = route.model.provider;
    const configured = providers.byId.get(providerId);
    // `enabled: false` is deliberately NOT a load error: for a local provider it
    // is a diagnosable state that `doctor` reports as waiting, and turning that
    // into a crash would break a working contract. What it must do is stop the
    // provider being advertised as selectable, which the catalog now enforces.
    if (isPiBuiltinProvider(providerId) || isAutodiscoverableProviderId(providerId)) {
      continue;
    }
    // A provider Pi does not know needs an endpoint to be reachable. Accepting a
    // bare `{}` here produced a config that validated, advertised an empty
    // catalog, and only failed at turn time with `pi model not found` -- and the
    // old repair text recommended exactly that bare entry.
    if (configured?.baseUrl !== undefined && configured.baseUrl.length > 0) {
      continue;
    }
    const repair = configured === undefined
      ? `add \"providers\": { \"${providerId}\": { \"type\": \"openai_compat\", \"baseUrl\": \"https://...\" } } to mono-agent.config.json`
      : `give providers.${providerId} a \"baseUrl\" (and \"type\"), because Pi has no built-in catalog for it`;
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `Provider "${providerId}" used by ${route.path} is not available; ${repair}.`,
      { providerId, path: route.path, reason: repair },
    );
  }
}

interface ConfiguredProviderEnvelope {
  readonly entries: readonly ProviderDefinition[];
  readonly piAuthPath?: string;
  readonly piNative?: Readonly<Record<string, unknown>>;
}

const RESERVED_PROVIDER_KEYS = new Set(["local", "piAuthPath", "piNative"]);

const PROVIDER_ENTRY_KEYS = new Set([
  "apiKey",
  "apiKeyEnv",
  "baseUrl",
  "enabled",
  "maxAdvertisedModels",
  "models",
  "trustPublicUrl",
  "type",
]);

export function readConfiguredProviders(value: unknown): ConfiguredProviderEnvelope {
  const parsed = jsonRecord(value, "providers") ?? {};

  const entries = new Map<string, { readonly provider: ProviderDefinition; readonly path: string }>();
  for (const id of Object.keys(parsed).filter((key) => !RESERVED_PROVIDER_KEYS.has(key)).sort()) {
    addConfiguredProvider(entries, normalizeProviderFromUnknown(id, parsed[id], `providers.${id}`, false), `providers.${id}`);
  }

  // The `local` array is the legacy single-shape form of the same provider map.
  const legacyFromMap = parsed.local;
  if (legacyFromMap !== undefined) {
    if (!Array.isArray(legacyFromMap)) {
      throw new MonoAgentConfigError("invalid_json", "providers.local must be an array.", { path: "providers.local" });
    }
    legacyFromMap.forEach((provider, index) => {
      const path = `providers.local[${index}]`;
      const normalized = normalizeLegacyProviderFromUnknown(provider, path);
      addConfiguredProvider(entries, normalized, path);
    });
  }

  const piAuthPath = parsed.piAuthPath === undefined
    ? undefined
    : readObjectString(parsed, "piAuthPath", "providers", false);
  const piNative = parsed.piNative === undefined
    ? undefined
    : readProviderPiNative(parsed.piNative);
  return {
    entries: [...entries.values()].map(({ provider }) => provider).sort((a, b) => a.id.localeCompare(b.id)),
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
    ...(piNative === undefined ? {} : { piNative }),
  };
}

function normalizeLegacyProviderFromUnknown(
  value: unknown,
  source: string,
): LocalProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  const id = readObjectString(value, "id", source, true) as string;
  const provider = normalizeProviderFromUnknown(id, value, source, true);
  return provider as LocalProviderDefinition;
}

function normalizeProviderFromUnknown(
  id: string,
  value: unknown,
  source: string,
  requireType: boolean,
): ProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  const unknownKeys = Object.keys(value).filter((key) =>
    !(requireType && key === "id") && !PROVIDER_ENTRY_KEYS.has(key),
  ).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
      { path: source, unknownKeys },
    );
  }
  const type = readObjectString(value, "type", source, requireType) as ProviderDefinition["type"];
  const baseUrl = readObjectString(value, "baseUrl", source, false);
  const apiKeyEnv = readObjectString(value, "apiKeyEnv", source, false);
  // Credential names stay unresolved at load: the runtime resolves them against
  // the effective environment when the provider is used. Only an inline literal
  // lands in `apiKey` here, so secrets never flow through the loader.
  const apiKey = readObjectString(value, "apiKey", source, false);
  const models = readLocalProviderModels(value.models, source);
  const maxAdvertisedModels = readObjectInteger(value, "maxAdvertisedModels", source, { min: 1, max: 200 });
  const provider: ProviderDefinition = {
    id,
    ...(type === undefined ? {} : { type }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: readObjectBoolean(value, "enabled", true, source),
    trustPublicUrl: readObjectBoolean(value, "trustPublicUrl", false, source),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(models.length === 0 ? {} : { models }),
    ...(maxAdvertisedModels === undefined ? {} : { maxAdvertisedModels }),
  };
  try {
    return requireType
      ? validateLocalProviderDefinition(provider as LocalProviderDefinition)
      : validateProviderDefinition(provider);
  } catch (error) {
    if (error instanceof TurnHostError) {
      throw new MonoAgentConfigError("invalid_json", error.message, {
        path: source,
        reason: error.message,
      });
    }
    throw error;
  }
}

function addConfiguredProvider(
  entries: Map<string, { readonly provider: ProviderDefinition; readonly path: string }>,
  provider: ProviderDefinition,
  path: string,
): void {
  const existing = entries.get(provider.id);
  if (existing !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `Provider id "${provider.id}" is configured twice at ${existing.path} and ${path}. Remove one definition.`,
      { path, providerId: provider.id, paths: [existing.path, path] },
    );
  }
  entries.set(provider.id, { provider, path });
}

function readProviderPiNative(value: unknown): Readonly<Record<string, unknown>> {
  const source = "providers.piNative";
  const record = readPlainObject(value, source);
  if (record.promptCacheDiagnostics !== undefined && typeof record.promptCacheDiagnostics !== "boolean") {
    throw new MonoAgentConfigError("invalid_json", "providers.piNative.promptCacheDiagnostics must be a boolean.", {
      path: "providers.piNative.promptCacheDiagnostics",
    });
  }
  if (record.cacheRetention !== undefined && !["short", "long"].includes(record.cacheRetention as string)) {
    throw new MonoAgentConfigError("invalid_json", "providers.piNative.cacheRetention must be short or long.", {
      path: "providers.piNative.cacheRetention",
    });
  }
  if (hasRetiredPiSessionsRoot(record)) throw new MonoAgentConfigError(
    "invalid_json", "providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there",
    { path: "providers.piNative.piSessionsRoot" });
  const allowed = new Set(["transport", "cacheRetention", "promptCacheDiagnostics", "piMaxRetries", "maxRetryDelayMs"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError("invalid_json", `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`, {
      path: source,
      unknownKeys,
    });
  }
  return record;
}

function readLocalProviderModels(value: unknown, source: string): readonly LocalProviderModelDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source}.models must be an array.`, { path: source });
  }
  return value.map((model, index) => {
    const modelSource = `${source}.models[${index}]`;
    if (!isRecord(model) || Array.isArray(model)) {
      throw new MonoAgentConfigError("invalid_json", `${modelSource} must be an object.`, { path: modelSource });
    }
    const name = readObjectString(model, "name", modelSource, true) as string;
    const alias = readObjectString(model, "alias", modelSource, false);
    const displayName = readObjectString(model, "displayName", modelSource, false);
    return {
      name,
      ...(alias === undefined ? {} : { alias }),
      ...(displayName === undefined ? {} : { displayName }),
      enabled: readObjectBoolean(model, "enabled", true, modelSource),
      ...(model.capabilities === undefined ? {} : { capabilities: readPlainObject(model.capabilities, `${modelSource}.capabilities`) }),
      ...(model.pricing === undefined ? {} : { pricing: readPlainObject(model.pricing, `${modelSource}.pricing`) }),
    };
  });
}

export function readPiNativeProviderConfig(
  value: Readonly<Record<string, unknown>> | undefined,
): PiNativeProviderConfig {
  const piNative = value ?? {};
  const transport = normalizeOptionalString(jsonString(piNative.transport, "providers.piNative.transport")) === undefined
    ? undefined
    : readChoice<PiTransport>(
        jsonString(piNative.transport, "providers.piNative.transport"),
        "providers.piNative.transport",
        PI_TRANSPORTS,
        "auto",
        invalidJson,
      );
  const promptCacheDiagnostics = jsonOptionalBoolean(piNative.promptCacheDiagnostics, "providers.piNative.promptCacheDiagnostics");
  const cacheRetention = jsonChoice<"short" | "long">(
    piNative.cacheRetention, "providers.piNative.cacheRetention", ["short", "long"], "long",
  );
  const piMaxRetriesValue = normalizeOptionalString(jsonString(piNative.piMaxRetries, "providers.piNative.piMaxRetries"));
  const piMaxRetries = jsonOptionalInteger(piMaxRetriesValue, "providers.piNative.piMaxRetries", { min: 0, max: 8 });
  const maxRetryDelayMs = jsonOptionalInteger(piNative.maxRetryDelayMs, "providers.piNative.maxRetryDelayMs", { min: 100, max: 3_600_000 });
  return {
    ...(transport === undefined ? {} : { transport }),
    ...(promptCacheDiagnostics === undefined ? {} : { promptCacheDiagnostics }),
    cacheRetention,
    ...(piMaxRetries === undefined ? {} : { piMaxRetries }),
    ...(maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs }),
  };
}

export function collectContext1MDeclarations(json: MonoAgentConfigJson, providers: ResolvedProviders): Record<string, boolean> {
  const declarations: Array<{ model: unknown; value: unknown; path: string }> = [];
  const objectDeclaration = (value: unknown, path: string) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      readModelSelection(value, path);
      declarations.push({ model: record.model, value: record.context1M, path: `${path}.context1M` });
    }
  };
  objectDeclaration(json.runtime?.model, "runtime.model");
  json.runtime?.fallbacks?.forEach((route, index) => declarations.push({ model: route.model, value: route.context1M, path: `runtime.fallbacks[${index}].context1M` }));
  json.subagents?.definitions?.forEach((definition, index) => objectDeclaration(definition.model, `subagents.definitions[${index}].model`));
  json.subagents?.models?.forEach((choice, index) => { if (typeof choice !== "string") declarations.push({ model: choice.model, value: choice.context1M, path: `subagents.models[${index}].context1M` }); });
  const result: Record<string, boolean> = {};
  const paths: Record<string, string> = {};
  for (const declaration of declarations) {
    if (declaration.value === undefined) continue;
    const ref = parseModel(requireJsonString(declaration.model, declaration.path), declaration.path);
    const key = modelReferenceKey(ref);
    if (typeof declaration.value !== "boolean" || !supportsPiContext1M(key) || providers.byId.get(ref.provider)?.type !== undefined) {
      throw new MonoAgentConfigError("invalid_json", `${declaration.path} requires a boolean on an eligible built-in GPT model, not a configured provider shadow.`, { path: declaration.path });
    }
    if (Object.hasOwn(result, key) && result[key] !== declaration.value) {
      throw new MonoAgentConfigError("invalid_json", `${declaration.path} conflicts with ${paths[key]} for the same model.`, { path: declaration.path });
    }
    result[key] = declaration.value;
    paths[key] = declaration.path;
  }
  return result;
}
