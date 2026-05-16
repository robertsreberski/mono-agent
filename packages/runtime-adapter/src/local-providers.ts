import net from "node:net";

import { RuntimeAdapterError } from "./runtime-adapter.js";
import type { RuntimeModelReference } from "./types.js";

export type LocalProviderType = "ollama" | "lmstudio" | "openai_compat";

export interface LocalProviderCapabilities {
  readonly tool_use?: boolean;
  readonly reasoning?: boolean;
  readonly reasoning_mode?: "none" | "toggle" | "effort" | string;
  readonly reasoning_levels?: readonly string[];
  readonly reasoning_disable_supported?: boolean;
  readonly vision?: boolean;
  readonly json_mode?: boolean;
  readonly context_window?: number;
  readonly num_ctx?: number;
  readonly max_tokens?: number;
  readonly family?: string;
  readonly advertised_capabilities?: readonly string[];
  readonly [key: string]: unknown;
}

export interface LocalProviderPricing {
  readonly input_per_million?: number;
  readonly cached_input_per_million?: number;
  readonly cache_write_per_million?: number;
  readonly output_per_million?: number;
  readonly [key: string]: unknown;
}

export interface LocalProviderModelDefinition {
  readonly name: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly capabilities?: LocalProviderCapabilities;
  readonly pricing?: LocalProviderPricing;
}

export interface LocalProviderDefinition {
  readonly id: string;
  readonly type: LocalProviderType;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly trustPublicUrl?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly models?: readonly LocalProviderModelDefinition[];
}

export interface AgentRuntimeCustomProvider {
  readonly id: string;
  readonly provider_type: LocalProviderType;
  readonly base_url: string;
  readonly enabled: boolean;
  readonly trust_public_url: boolean;
  readonly api_key?: string;
}

export interface AgentRuntimeCustomModel {
  readonly provider_id: string;
  readonly model_name: string;
  readonly alias?: string;
  readonly display_name: string;
  readonly capabilities: LocalProviderCapabilities;
  readonly pricing: LocalProviderPricing;
  readonly enabled: boolean;
}

export interface LocalProviderRuntimeOptions {
  readonly customProvider?: AgentRuntimeCustomProvider;
  readonly customModel?: AgentRuntimeCustomModel;
  readonly modelCapabilities?: LocalProviderCapabilities;
  readonly isPrivateProvider?: boolean;
  readonly [key: string]: unknown;
}

const LOCAL_PROVIDER_TYPES: readonly LocalProviderType[] = ["ollama", "lmstudio", "openai_compat"];
const PRIVATE_HOSTNAMES = new Set(["localhost", "host.docker.internal"]);
const PRIVATE_V4_CIDRS: readonly [string, number][] = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
];
const OLLAMA_EFFORT_REASONING_HINTS = ["gpt-oss"];
const OLLAMA_EFFORT_REASONING_LEVELS = ["low", "medium", "high"];
const OLLAMA_TOGGLE_REASONING_HINTS = ["deepseek", "qwen", "qwq", "thinking", "reasoning"];
const OPENAI_COMPAT_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh"];

export function runtimeOptionsForLocalProvider(
  model: RuntimeModelReference,
  providers: readonly LocalProviderDefinition[] | undefined,
): LocalProviderRuntimeOptions {
  if (model.sdk !== "pi" || model.provider === undefined || providers === undefined || providers.length === 0) {
    return {};
  }

  const provider = providers.find((candidate) => candidate.id === model.provider);
  if (provider === undefined) {
    return {};
  }

  const normalized = validateLocalProviderDefinition(provider);
  const customModel = customModelForProvider(normalized, model.model);
  return {
    customProvider: {
      id: normalized.id,
      provider_type: normalized.type,
      base_url: normalized.baseUrl as string,
      enabled: normalized.enabled ?? true,
      trust_public_url: normalized.trustPublicUrl === true,
      ...(normalized.apiKey === undefined ? {} : { api_key: normalized.apiKey }),
    },
    customModel,
    modelCapabilities: customModel.capabilities,
    isPrivateProvider: isPrivateBaseUrl(normalized.baseUrl as string),
  };
}

export function validateLocalProviderDefinition(provider: LocalProviderDefinition): LocalProviderDefinition {
  const id = normalizeProviderId(provider.id);
  const type = normalizeProviderType(provider.type);
  const baseUrl = normalizeBaseUrl(provider.baseUrl ?? defaultBaseUrlForType(type));
  const trustPublicUrl = provider.trustPublicUrl === true;
  validateProviderBaseUrl(baseUrl, { trustPublicUrl });

  return {
    id,
    type,
    baseUrl,
    enabled: provider.enabled ?? true,
    trustPublicUrl,
    ...(normalizeOptionalString(provider.apiKey) === undefined ? {} : { apiKey: normalizeOptionalString(provider.apiKey) as string }),
    ...(normalizeOptionalString(provider.apiKeyEnv) === undefined ? {} : { apiKeyEnv: normalizeOptionalString(provider.apiKeyEnv) as string }),
    ...(provider.models === undefined ? {} : { models: provider.models.map((model) => validateLocalProviderModelDefinition(model)) }),
  };
}

export function isPrivateBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (PRIVATE_HOSTNAMES.has(host)) {
    return true;
  }

  const family = net.isIP(host);
  if (family === 4) {
    return PRIVATE_V4_CIDRS.some(([cidr, bits]) => inCidrV4(host, cidr, bits));
  }
  if (family === 6) {
    const normalized = host.replace(/%.*$/u, "");
    if (normalized === "::1") {
      return true;
    }
    const first = Number.parseInt(normalized.split(":")[0] ?? "0", 16);
    if (Number.isNaN(first)) {
      return false;
    }
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function customModelForProvider(
  provider: LocalProviderDefinition,
  modelName: string,
): AgentRuntimeCustomModel {
  const model = provider.models?.find((candidate) => candidate.name === modelName || candidate.alias === modelName);
  const rawCapabilities = model?.capabilities ?? {};
  const capabilities = resolveLocalProviderCapabilities(provider.type, modelName, rawCapabilities);
  return {
    provider_id: provider.id,
    model_name: model?.name ?? modelName,
    ...(model?.alias === undefined ? {} : { alias: model.alias }),
    display_name: model?.displayName ?? model?.alias ?? model?.name ?? modelName,
    capabilities,
    pricing: normalizePricing(model?.pricing),
    enabled: model?.enabled ?? true,
  };
}

function resolveLocalProviderCapabilities(
  providerType: LocalProviderType,
  modelName: string,
  capabilities: LocalProviderCapabilities,
): LocalProviderCapabilities {
  const base: LocalProviderCapabilities = {
    tool_use: true,
    json_mode: true,
    ...capabilities,
  };
  if (providerType === "ollama") {
    return {
      ...base,
      ...resolveOllamaReasoning(modelName, base),
    };
  }
  return {
    ...base,
    ...resolveOpenAICompatibleReasoning(base),
  };
}

function resolveOllamaReasoning(
  modelName: string,
  capabilities: LocalProviderCapabilities,
): LocalProviderCapabilities {
  const haystack = `${modelName} ${capabilities.family ?? ""}`.toLowerCase();
  if (capabilities.reasoning_mode !== undefined) {
    return {
      reasoning: capabilities.reasoning ?? capabilities.reasoning_mode !== "none",
      reasoning_mode: capabilities.reasoning_mode,
      ...(capabilities.reasoning_levels === undefined ? {} : { reasoning_levels: capabilities.reasoning_levels }),
      ...(capabilities.reasoning_disable_supported === undefined ? {} : { reasoning_disable_supported: capabilities.reasoning_disable_supported }),
    };
  }
  if (capabilities.reasoning === false) {
    return { reasoning: false, reasoning_mode: "none" };
  }
  if (OLLAMA_EFFORT_REASONING_HINTS.some((hint) => haystack.includes(hint))) {
    return {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: [...OLLAMA_EFFORT_REASONING_LEVELS],
      reasoning_disable_supported: false,
    };
  }

  const advertised = new Set(
    Array.isArray(capabilities.advertised_capabilities) ? capabilities.advertised_capabilities : [],
  );
  const hasThinkingHint = advertised.has("thinking") ||
    advertised.has("reasoning") ||
    OLLAMA_TOGGLE_REASONING_HINTS.some((hint) => haystack.includes(hint));
  if (capabilities.reasoning === true || hasThinkingHint) {
    return {
      reasoning: true,
      reasoning_mode: "toggle",
      reasoning_disable_supported: capabilities.reasoning_disable_supported ?? true,
    };
  }
  return { reasoning: false, reasoning_mode: "none" };
}

function resolveOpenAICompatibleReasoning(capabilities: LocalProviderCapabilities): LocalProviderCapabilities {
  if (capabilities.reasoning !== true) {
    return { reasoning: false, reasoning_mode: "none" };
  }
  return {
    reasoning: true,
    reasoning_mode: capabilities.reasoning_mode ?? "effort",
    reasoning_levels: capabilities.reasoning_levels ?? [...OPENAI_COMPAT_REASONING_LEVELS],
    reasoning_disable_supported: capabilities.reasoning_disable_supported ?? true,
  };
}

function validateLocalProviderModelDefinition(model: LocalProviderModelDefinition): LocalProviderModelDefinition {
  const name = normalizeModelName(model.name);
  const alias = normalizeOptionalString(model.alias);
  const displayName = normalizeOptionalString(model.displayName);
  return {
    name,
    ...(alias === undefined ? {} : { alias }),
    ...(displayName === undefined ? {} : { displayName }),
    enabled: model.enabled ?? true,
    ...(model.capabilities === undefined ? {} : { capabilities: { ...model.capabilities } }),
    ...(model.pricing === undefined ? {} : { pricing: normalizePricing(model.pricing) }),
  };
}

function validateProviderBaseUrl(
  baseUrl: string,
  options: { readonly trustPublicUrl: boolean },
): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RuntimeAdapterError("invalid_local_provider", "Local provider baseUrl must be a valid URL.", {
      baseUrl,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RuntimeAdapterError("invalid_local_provider", "Local provider baseUrl must use http(s)://.", {
      baseUrl,
    });
  }
  if (isPrivateBaseUrl(baseUrl)) {
    return;
  }
  if (!options.trustPublicUrl) {
    throw new RuntimeAdapterError(
      "invalid_local_provider",
      "Local provider baseUrl points to a public host; set trustPublicUrl=true to allow it.",
      { baseUrl },
    );
  }
  if (parsed.protocol !== "https:") {
    throw new RuntimeAdapterError(
      "invalid_local_provider",
      "Public local provider baseUrl must use https://.",
      { baseUrl },
    );
  }
}

function normalizeProviderId(value: string): string {
  const normalized = normalizeRequiredString(value, "Local provider id");
  if (/[:/\s]/u.test(normalized)) {
    throw new RuntimeAdapterError("invalid_local_provider", "Local provider id must not contain whitespace, slash, or colon.", {
      providerId: normalized,
    });
  }
  return normalized;
}

function normalizeProviderType(value: string): LocalProviderType {
  if ((LOCAL_PROVIDER_TYPES as readonly string[]).includes(value)) {
    return value as LocalProviderType;
  }
  throw new RuntimeAdapterError("invalid_local_provider", "Local provider type is not supported.", {
    providerType: value,
  });
}

function normalizeModelName(value: string): string {
  return normalizeRequiredString(value, "Local provider model name");
}

function normalizeRequiredString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_local_provider", `${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    throw new RuntimeAdapterError("invalid_local_provider", "Local provider baseUrl is required.");
  }
  return normalized.replace(/\/+$/u, "");
}

function defaultBaseUrlForType(type: LocalProviderType): string | undefined {
  if (type === "ollama") {
    return "http://localhost:11434";
  }
  if (type === "lmstudio") {
    return "http://localhost:1234";
  }
  return undefined;
}

function normalizePricing(pricing: LocalProviderPricing | undefined): LocalProviderPricing {
  if (pricing === undefined) {
    return {};
  }
  return { ...pricing };
}

function ipToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let accumulator = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    accumulator = (accumulator << 8) + value;
  }
  return accumulator >>> 0;
}

function inCidrV4(ip: string, cidr: string, bits: number): boolean {
  const ipLong = ipToLong(ip);
  const cidrLong = ipToLong(cidr);
  if (ipLong === null || cidrLong === null) {
    return false;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipLong & mask) === (cidrLong & mask);
}
