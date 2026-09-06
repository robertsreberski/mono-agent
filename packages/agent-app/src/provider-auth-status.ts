import type {
  ProviderAuthMethod,
  ProviderAuthProviderStatus,
  ProviderAuthStatusSnapshot,
  ProviderAuthUsage,
} from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  checkPiProviderAuth,
  describePiProviderAuth,
} from "@mono-agent/agent-runtime/ai";
import {
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  type RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ChannelDriver } from "./channels.js";
import { inspectPiAuthStore } from "./pi-auth-store-inspection.js";
import type { ProviderAuthObservationTracker } from "./provider-auth-observations.js";
import { configuredRuntimeModels } from "./runtime-routes.js";

export interface UsedProviderReference {
  readonly usage: ProviderAuthUsage;
  readonly ref: RuntimeModelReference;
}

export async function collectUsedProviderReferences(
  config: MonoAgentConfig,
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<readonly UsedProviderReference[]> {
  const refs: UsedProviderReference[] = configuredRuntimeModels(config.runtime).map((ref, index) => ({
    ref,
    usage: {
      kind: index === 0 ? "primary" : "fallback",
      model: modelReferenceKey(ref),
      label: index === 0 ? "Primary model" : `Fallback ${index}`,
    },
  }));
  if (config.memory?.llm?.provider === "agent-host") {
    try {
      const ref = parseMonoRuntimeModelReference(config.memory.llm.model);
      refs.push({ ref, usage: { kind: "memory_llm", model: modelReferenceKey(ref), label: "Memory LLM" } });
    } catch {
      // The existing memory validation owns malformed model-reference errors.
    }
  }
  for (const driver of drivers) {
    if (driver.id !== "cron" && driver.id !== "webhook") continue;
    let loaded: unknown;
    try {
      loaded = await driver.loadConfig(input);
    } catch {
      continue;
    }
    if (!record(loaded) || (driver.id === "webhook" && loaded.enabled === false)) continue;
    const entries = driver.id === "cron" ? loaded.jobs : loaded.endpoints;
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!record(entry) || entry.enabled === false || typeof entry.model !== "string") continue;
      try {
        const ref = parseMonoRuntimeModelReference(entry.model);
        refs.push({
          ref,
          usage: {
            kind: driver.id,
            model: modelReferenceKey(ref),
            label: `${driver.id}.${driver.id === "cron" ? "jobs" : "endpoints"}[${index}]`,
          },
        });
      } catch {
        // The channel config validation owns malformed model-reference errors.
      }
    }
  }
  const seen = new Set<string>();
  return refs.filter(({ usage }) => {
    const key = `${usage.kind}\0${usage.label}\0${usage.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ProviderAuthStatusOptions {
  readonly config: MonoAgentConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly drivers: readonly ChannelDriver[];
  readonly input: MonoAgentAppConfigInput;
  readonly observations: ProviderAuthObservationTracker;
}

export async function providerAuthStatusSnapshot(
  options: ProviderAuthStatusOptions,
): Promise<ProviderAuthStatusSnapshot> {
  const used = await collectUsedProviderReferences(options.config, options.drivers, options.input);
  const byProvider = new Map<string, { refs: RuntimeModelReference[]; usages: ProviderAuthUsage[] }>();
  for (const item of used) {
    const providerId = item.ref.provider as string;
    const current = byProvider.get(providerId) ?? { refs: [], usages: [] };
    current.refs.push(item.ref);
    current.usages.push(item.usage);
    byProvider.set(providerId, current);
  }
  options.observations.retainProviders([...byProvider.keys()]);
  const authPath = options.config.providers?.piAuthPath;
  const inspection = authPath === undefined ? { status: "missing" as const } : await inspectPiAuthStore(authPath);
  const localById = new Map((options.config.providers?.local ?? []).map((provider) => [provider.id, provider] as const));
  const providers: ProviderAuthProviderStatus[] = [];
  for (const [providerId, group] of byProvider) {
    const observation = options.observations.get(providerId);
    const local = localById.get(providerId);
    if (local !== undefined) {
      const keyInEnv = local.apiKeyEnv !== undefined && nonEmpty(options.env[local.apiKeyEnv]);
      const hasKey = keyInEnv || nonEmpty(local.apiKey);
      const keyless = local.apiKeyEnv === undefined && local.apiKey === undefined;
      providers.push({
        providerId,
        label: providerId,
        usages: group.usages,
        state: keyless ? "not_applicable" : hasKey ? "present" : "missing",
        ...(keyless ? {} : { credentialType: "api_key" as const }),
        ...(hasKey ? { source: keyInEnv ? "environment" as const : "config" as const } : {}),
        verification: keyless ? "not_applicable" : observation?.verifiedAt === undefined ? "not_verified" : "verified_by_live_request",
        ...(observation?.verifiedAt === undefined ? {} : { verifiedAt: observation.verifiedAt }),
        methods: [],
        ...(local.enabled === false
          ? { unavailableReason: "Provider is disabled in providers.local." }
          : keyless ? { unavailableReason: "Keyless local provider." }
          : !hasKey ? { unavailableReason: `Set ${local.apiKeyEnv ?? "the configured API key"} in agent configuration.` } : {}),
        ...(observation?.failure === undefined ? {} : { lastFailure: observation.failure }),
      });
      continue;
    }
    const description = describePiProviderAuth(providerId);
    const entry = inspection.status === "ok" ? inspection.auth[providerId] : undefined;
    let state: ProviderAuthProviderStatus["state"] = "missing";
    let credentialType: ProviderAuthProviderStatus["credentialType"];
    let source: ProviderAuthProviderStatus["source"];
    let expiresAt: string | undefined;
    let unavailableReason: string | undefined;
    if (description === undefined || description.methods.length === 0) {
      state = "not_applicable";
      unavailableReason = "This provider does not expose an authentication method through Pi.";
    } else {
      // An unsafe store must never be passed to Pi, but it does not invalidate
      // an independently resolved environment/ambient credential.
      const checked = await checkPiProviderAuth(
        providerId,
        inspection.status === "ok" ? entry : undefined,
        options.env,
      ).catch(() => undefined);
      if (checked !== undefined) {
        credentialType = checked.type;
        source = checked.source;
        state = "present";
      }
      const storedType = record(entry) && (entry.type === "oauth" || entry.type === "api_key")
        ? entry.type : undefined;
      if (storedType !== undefined && !description.methods.some((method) => method.type === storedType)) {
        state = "missing";
        credentialType = storedType;
        source = undefined;
        unavailableReason = "Stored credential type is not supported by this provider.";
      } else if (inspection.status === "unsafe" && checked === undefined) {
        unavailableReason = `Pi auth store is unsafe (${inspection.reason}).`;
      } else if (record(entry) && entry.type === "oauth") {
        credentialType = "oauth";
        source = "stored";
        if (!nonEmpty(entry.access) && !nonEmpty(entry.refresh)) {
          state = "missing";
          unavailableReason = "Stored OAuth credential is unusable.";
        } else if (entry.expires !== undefined && isoFromEpochMillis(entry.expires) === undefined) {
          state = "missing";
          unavailableReason = "Stored OAuth credential has an invalid expiry.";
        } else if (typeof entry.expires === "number") {
          expiresAt = isoFromEpochMillis(entry.expires) as string;
          state = entry.expires < Date.now() ? "expired" : "present";
        }
      } else if (record(entry) && entry.type === "api_key" && checked === undefined) {
        state = "missing";
        credentialType = "api_key";
        unavailableReason = "Stored API-key credential is unusable.";
      }
    }
    providers.push({
      providerId,
      label: description?.label ?? providerId,
      usages: group.usages,
      state,
      ...(credentialType === undefined ? {} : { credentialType }),
      ...(source === undefined ? {} : { source }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      verification: state === "not_applicable" ? "not_applicable"
        : observation?.verifiedAt === undefined ? "not_verified" : "verified_by_live_request",
      ...(observation?.verifiedAt === undefined ? {} : { verifiedAt: observation.verifiedAt }),
      methods: description === undefined ? [] : methodsFor(providerId, description.methods),
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(observation?.failure === undefined ? {} : { lastFailure: observation.failure }),
    });
  }
  return {
    schema: "mono-agent.provider-auth.v1",
    generatedAt: new Date().toISOString(),
    providers,
  };
}

function methodsFor(
  providerId: string,
  methods: readonly { type: "oauth" | "api_key"; label: string }[],
): ProviderAuthMethod[] {
  const result: ProviderAuthMethod[] = [];
  for (const method of methods) {
    if (method.type === "api_key") {
      result.push({ authType: method.type, strategy: "api_key_prompt", label: method.label, recommended: methods.length === 1 });
    } else if (providerId === "openai-codex") {
      result.push(
        { authType: method.type, strategy: "device_code", label: `${method.label} (device code)`, recommended: true },
        { authType: method.type, strategy: "paste_back", label: `${method.label} (paste redirect)`, recommended: false },
      );
    } else if (providerId === "github-copilot") {
      result.push({ authType: method.type, strategy: "device_code", label: method.label, recommended: true });
    } else if (providerId === "anthropic") {
      result.push({ authType: method.type, strategy: "paste_back", label: method.label, recommended: true });
    } else {
      result.push({ authType: method.type, strategy: "provider_prompt", label: method.label, recommended: methods.length === 1 });
    }
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 65_536 && !value.includes("\0");
}

function isoFromEpochMillis(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}
