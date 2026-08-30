import { isPlainObject } from "./runtime-helpers.js";
import {
  localProviderDefinitionFor,
  modelsEndpointForProvider,
  validateLocalProviderDefinition,
} from "./local-providers.js";
import type {
  LocalProviderDefinition,
  LocalProviderModelDefinition,
  LocalProviderType,
  ProviderDefinition,
} from "./local-providers.js";

export interface DiscoveredProvider extends LocalProviderDefinition {
  readonly baseUrl: string;
  readonly models: readonly LocalProviderModelDefinition[];
}

export interface DiscoverLocalProvidersInput {
  readonly configured?: readonly ProviderDefinition[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Bypass one warm cache entry once during its current TTL window. */
  readonly forceRefresh?: boolean;
}

interface DiscoveryCacheEntry {
  readonly expiresAt: number;
  readonly provider?: DiscoveredProvider;
  readonly forcedRefreshUsed: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const DISCOVERY_CACHE_TTL_MS = 60_000;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const DEFAULT_LOCAL_PROVIDERS: readonly {
  readonly id: string;
  readonly type: LocalProviderType;
  readonly baseUrl: string;
}[] = [
  // Keep localhost: Pi hands the configured URL to the runtime verbatim. Some
  // machines resolve it IPv6-first, but substituting 127.0.0.1 would silently
  // change the effective endpoint of every existing local-provider config.
  { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434" },
  { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234" },
];

/** Clear process-local probe state, primarily for deterministic host tests. */
export function clearLocalProviderDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Best-effort zero-config discovery for the two supported local endpoints.
 * Provider probes run concurrently and fail independently; malformed config,
 * transport failures, timeouts, and response-shape drift all resolve to an
 * empty/partial list instead of escaping into config load or host startup.
 */
export async function discoverLocalProviders(
  input: DiscoverLocalProvidersInput = {},
): Promise<readonly DiscoveredProvider[]> {
  try {
    const configuredById = new Map(input.configured?.map((provider) => [provider.id, provider]) ?? []);
    const probes = DEFAULT_LOCAL_PROVIDERS.map(async (defaults) => {
      try {
        const configured = configuredById.get(defaults.id);
        if (configured?.enabled === false) {
          return undefined;
        }
        const provider = localProviderDefinitionFor(configured ?? defaults);
        if (provider === undefined) {
          return undefined;
        }
        return await discoverCachedProvider(provider, input);
      } catch {
        return undefined;
      }
    });
    const discovered = await Promise.all(probes);
    return discovered.filter((provider): provider is DiscoveredProvider => provider !== undefined);
  } catch {
    return [];
  }
}

async function discoverCachedProvider(
  provider: LocalProviderDefinition,
  input: DiscoverLocalProvidersInput,
): Promise<DiscoveredProvider | undefined> {
  const normalized = validateLocalProviderDefinition(provider);
  const key = `${normalized.id}|${normalized.baseUrl as string}`;
  const now = Date.now();
  const cached = discoveryCache.get(key);
  const cacheIsWarm = cached !== undefined && cached.expiresAt > now;
  if (cacheIsWarm && (!input.forceRefresh || cached.forcedRefreshUsed)) {
    return cached.provider;
  }

  const discovered = await probeProvider(normalized, input);
  discoveryCache.set(key, {
    expiresAt: cacheIsWarm ? cached.expiresAt : now + DISCOVERY_CACHE_TTL_MS,
    ...(discovered === undefined ? {} : { provider: discovered }),
    forcedRefreshUsed: cacheIsWarm && input.forceRefresh === true,
  });
  return discovered;
}

async function probeProvider(
  provider: LocalProviderDefinition,
  input: DiscoverLocalProvidersInput,
): Promise<DiscoveredProvider | undefined> {
  try {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted === true) {
      forwardAbort();
    } else {
      input.signal?.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeoutMs = validTimeout(input.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (input.fetch ?? fetch)(modelsEndpointForProvider(provider), {
        signal: controller.signal,
      });
      if (!response.ok) {
        return undefined;
      }
      const body: unknown = await response.json();
      if (!isPlainObject(body) || !Array.isArray(body.data)) {
        return undefined;
      }
      const liveModels = modelsFromResponse(body.data);
      const advertised = provider.models === undefined
        ? liveModels
        : provider.models.filter((model) => model.enabled ?? true);
      const maxAdvertisedModels = provider.maxAdvertisedModels ?? 100;
      return {
        ...provider,
        baseUrl: provider.baseUrl as string,
        models: advertised.slice(0, maxAdvertisedModels),
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  } catch {
    return undefined;
  }
}

function modelsFromResponse(data: readonly unknown[]): readonly LocalProviderModelDefinition[] {
  const models: LocalProviderModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    models.push({ name: entry.id });
  }
  return models;
}

function validTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}
