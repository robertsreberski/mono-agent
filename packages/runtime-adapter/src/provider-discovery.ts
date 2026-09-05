import { isPlainObject } from "./runtime-helpers.js";
import {
  localProviderDefinitionFor,
  discoverEmbeddingOnlyModelIds,
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

/**
 * Only the *live* half of a probe is cached: the model ids the endpoint
 * reported. The advertised projection (allowlist filter, `maxAdvertisedModels`
 * cap, and every other field of the definition) is recomputed from the caller's
 * current configuration on every read, so editing a provider takes effect on
 * the next channel restart instead of after the 60 s TTL expires. `liveModels`
 * absent means the last probe found nothing — the provider stays unadvertised
 * for the rest of the window without being re-probed.
 */
interface DiscoveryCacheEntry {
  readonly expiresAt: number;
  readonly liveModels?: readonly LocalProviderModelDefinition[];
  readonly forcedRefreshUsed: boolean;
  /**
   * Start ordinal of the probe that produced this entry. Concurrent probes are
   * deliberately NOT coalesced — each caller brings its own `fetch`, `timeoutMs`
   * and `signal`, so sharing one in-flight promise would let one caller's abort
   * cancel another caller's probe. Completion order is therefore not start
   * order, and this ordinal is what stops an older probe's answer from landing
   * on top of a newer one.
   */
  readonly probeSeq: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const DISCOVERY_CACHE_TTL_MS = 60_000;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
/** Monotonic across every key; only per-key ordering is ever compared. */
let probeSequence = 0;
/** Bumped by `clearLocalProviderDiscoveryCache`; retires in-flight probes. */
let cacheGeneration = 0;
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
  // Retire every probe already in flight along with the entries. Without this a
  // probe started before the clear still lands afterwards and repopulates the
  // map the caller just emptied — the cross-test bleed this function exists to
  // prevent, arriving one tick late.
  cacheGeneration += 1;
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
  // Key by the probed endpoint, not the raw baseUrl: `type` participates in the
  // URL, so `{id:"ollama", type:"openai_compat"}` addresses a different endpoint
  // than the same id and baseUrl with the inferred ollama type.
  const key = `${normalized.id}|${modelsEndpointForProvider(normalized)}`;
  const now = Date.now();
  const cached = discoveryCache.get(key);
  const cacheIsWarm = cached !== undefined && cached.expiresAt > now;
  if (cacheIsWarm && (!input.forceRefresh || cached.forcedRefreshUsed)) {
    return advertisedProvider(normalized, cached.liveModels);
  }

  // Claim the ordinal BEFORE awaiting: it records when this probe started, and
  // the whole point is that it can finish out of that order.
  const probeSeq = (probeSequence += 1);
  const generation = cacheGeneration;
  const liveModels = await probeProvider(normalized, input);

  if (cacheGeneration !== generation) {
    // The cache was cleared underneath us. This answer belongs to a retired
    // generation: serve it to our own caller, never store it.
    return advertisedProvider(normalized, liveModels);
  }
  const current = discoveryCache.get(key);
  if (current !== undefined && current.probeSeq > probeSeq) {
    // A probe that STARTED after ours already answered. Two concurrent forced
    // refreshes both probe, and the slower-but-earlier one used to overwrite the
    // newer result — negative-caching a failure over a live model, so every warm
    // read for the rest of the 60 s TTL returned `[]` without re-probing. Its
    // observation is the newer one, so keep it and report it rather than
    // handing this caller something staler than the cache already holds.
    return advertisedProvider(normalized, current.liveModels);
  }
  discoveryCache.set(key, {
    expiresAt: cacheIsWarm ? cached.expiresAt : now + DISCOVERY_CACHE_TTL_MS,
    ...(liveModels === undefined ? {} : { liveModels }),
    forcedRefreshUsed: cacheIsWarm && input.forceRefresh === true,
    probeSeq,
  });
  return advertisedProvider(normalized, liveModels);
}

/**
 * Project a probe result onto the provider definition as it is configured
 * *now*. A declared `models` allowlist replaces the live list entirely (the
 * probe then only proves liveness); everything else advertises what the
 * endpoint reported. Pure and total, preserving the caller's "never throws"
 * guarantee — `/v1/info` returns 500 for the whole response if this escapes.
 */
function advertisedProvider(
  provider: LocalProviderDefinition,
  liveModels: readonly LocalProviderModelDefinition[] | undefined,
): DiscoveredProvider | undefined {
  if (liveModels === undefined) {
    return undefined;
  }
  const advertised = provider.models === undefined
    ? liveModels
    : provider.models.filter((model) => model.enabled ?? true).map((model) => {
      const live = liveModels.find((entry) => entry.name === model.name);
      return live?.capabilities?.advertised_capabilities?.includes("embedding")
        ? { ...model, capabilities: { ...model.capabilities, ...live.capabilities } } : model;
    });
  return {
    ...provider,
    baseUrl: provider.baseUrl as string,
    models: advertised.slice(0, provider.maxAdvertisedModels ?? 100),
  };
}

/**
 * One liveness probe. Resolves the live model ids on success, or `undefined`
 * when the endpoint did not answer usefully (transport failure, timeout,
 * non-2xx, response-shape drift) — never throws.
 */
async function probeProvider(
  provider: LocalProviderDefinition,
  input: DiscoverLocalProvidersInput,
): Promise<readonly LocalProviderModelDefinition[] | undefined> {
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
      const models = modelsFromResponse(body.data);
      const embeddingIds = await discoverEmbeddingOnlyModelIds(
        provider, models.map((model) => model.name), input.fetch ?? fetch, controller.signal,
      );
      return models.map((model) => embeddingIds.has(model.name)
        ? { ...model, capabilities: { advertised_capabilities: ["embedding"] } } : model);
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
