import type {
  TuiCatalogModel,
  TuiModelOption,
  TuiProviderInfo,
} from "@mono-agent/operator-adapter";
import {
  getPiBuiltinModel,
  listPiBuiltinModels,
  listPiBuiltinProviders,
  type PiBuiltinModelSnapshot,
} from "@mono-agent/agent-runtime";
import { modelReferenceKey } from "@mono-agent/runtime-adapter";
import type {
  DiscoveredLocalModel,
  LocalProviderDefinition,
  ProviderDefinition,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

import {
  resolveAdvertisedModelEffort,
  resolveAdvertisedModelEffortForBuiltin,
} from "./model-effort-capabilities.js";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
/**
 * Producer-side length bounds for the CATALOG's own projections
 * (`listProviders`/`listModels`/`searchModels`/`resolve`). Provider ids, model
 * ids and display names are not length-bounded by config validation, and both
 * `/v1/info` and a `/v1/models` page have a body cap to respect: exceeding
 * `/v1/info`'s single 1 MiB cap fails `info()` wholesale and shows the agent
 * OFFLINE rather than degraded, and an over-cap page 500s instead of serving.
 * Oversized entries are skipped rather than truncated, because a truncated id
 * would not resolve anyway.
 *
 * These are display/paging bounds, NOT validity bounds: the runtime reference
 * parser imposes no length limit, so a 257-byte model id is genuinely runnable
 * and merely unpageable. `/v1/info.models` deliberately does not inherit them
 * (see `MAX_DISCOVERED_INFO_MODEL_BYTES` in `channel-drivers/tui.ts`) — reusing
 * them there deleted runnable models from schema-1 clients at a wire schema
 * that cannot be bumped.
 */
export const MAX_CATALOG_ID_BYTES = 256;
export const MAX_CATALOG_LABEL_BYTES = 256;

const withinBytes = (value: string, max: number): boolean =>
  Buffer.byteLength(value, "utf8") <= max;
export const DEFAULT_MAX_ADVERTISED_PER_PROVIDER = 100;
export const MAX_SEARCH_RESULTS = 100;

/**
 * Producer-side bounds on ONE `describe()` entry's effort ladder.
 *
 * The built-in path is already bounded — `resolveAdvertisedModelEffortForBuiltin`
 * runs every level through the `EFFORT_LEVELS` allowlist. The LOCAL path is not:
 * `resolveModelEffortLevels` returns `capabilities.reasoning_levels` verbatim
 * from `providers.local[].models[].capabilities`, which config validates for
 * neither element length nor count. A single authored megabyte-wide level
 * therefore reached `/v1/info` unmeasured and blew the shared 1 MiB body cap,
 * taking the agent offline rather than degrading it.
 *
 * An over-long level is DROPPED rather than truncated: a truncated effort name
 * would not be accepted by the runtime anyway, so publishing it offers a
 * selection whose next turn fails. When nothing survives, `effortLevels` is
 * omitted entirely and the client falls back to the global effort enum — the
 * same degrade path a cloud model with unknown metadata already takes.
 */
const MAX_ADVERTISED_EFFORT_LEVELS = 32;
const MAX_ADVERTISED_EFFORT_LEVEL_BYTES = 64;

function boundedEffortLevels(levels: readonly string[] | undefined): readonly string[] | undefined {
  if (levels === undefined) return undefined;
  const bounded = levels
    .filter((level) => withinBytes(level, MAX_ADVERTISED_EFFORT_LEVEL_BYTES))
    .slice(0, MAX_ADVERTISED_EFFORT_LEVELS);
  if (bounded.length === 0) return undefined;
  return bounded.length === levels.length ? levels : bounded;
}

export interface ProviderModelCatalogInput {
  /** Configured provider definitions (the canonical `providers.entries` map). */
  readonly providers?: readonly ProviderDefinition[];
  /** Local-provider projection used for precise effort/context resolution. */
  readonly localProviders?: readonly LocalProviderDefinition[];
  /** Configured runtime routes (primary + fallbacks). */
  readonly configuredRoutes?: readonly RuntimeModelReference[];
  /** Live-discovered local models (TUI path only; Slack/Telegram pass none). */
  readonly discoveredModels?: readonly DiscoveredLocalModel[];
  /** Test seam: replaces the Pi built-in model listing call. */
  readonly listBuiltinModels?: (providerId: string) => readonly PiBuiltinModelSnapshot[];
}

export interface ProviderModelCatalog {
  /** Eager, frozen, deterministic provider list. Never throws. */
  listProviders(): readonly TuiProviderInfo[];
  listModels(
    providerId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): {
    readonly models: readonly TuiCatalogModel[];
    readonly nextCursor?: string;
    readonly truncated: boolean;
  };
  searchModels(query: string, limit?: number): readonly TuiCatalogModel[];
  /** O(1) map read; never populates the per-provider page cache. */
  resolve(ref: string): TuiCatalogModel | undefined;
  /** Effort/context/provider metadata for the configured-route shortlist. */
  describe(refs: readonly RuntimeModelReference[]): Record<string, TuiModelOption>;
}

interface ProviderModelEntry {
  readonly info: TuiProviderInfo;
  /** Frozen, deterministic, capped. Sorted by `localeCompare` on id (or allowlist order). */
  readonly models: readonly TuiCatalogModel[];
}

function positiveContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

function compareModelId(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Build the provider-widened model catalog once at channel start. The catalog
 * is total by construction: an unknown provider yields an empty page, a
 * built-in listing that throws degrades to zero models, and no code path
 * propagates. Everything is precomputed here so `/v1/info` reads memory only
 * and never awaits network I/O, and the lazy `/v1/models` endpoint only slices
 * already-frozen pages.
 */
export function buildProviderModelCatalog(
  input: ProviderModelCatalogInput = {},
): ProviderModelCatalog {
  const listBuiltin = input.listBuiltinModels ?? listPiBuiltinModels;
  const providers = input.providers ?? [];
  const localProviders = input.localProviders;
  const configuredRoutes = input.configuredRoutes ?? [];

  const configuredById = new Map<string, ProviderDefinition>(
    providers.map((provider) => [provider.id, provider]),
  );
  const configuredRouteKeys = new Set(configuredRoutes.map((ref) => modelReferenceKey(ref)));
  // `providers` is the operator's explicit support list, and a route's own
  // provider is supported by construction — you cannot route through a provider
  // you did not mean to use. Either one marks the provider configured, so a
  // provider listed purely to widen selection is still flagged for the UI.
  const supportedProviderIds = new Set<string>([
    ...providers.map((provider) => provider.id),
    ...configuredRoutes.map((ref) => ref.provider),
  ]);

  // The authoritative 39-entry static catalog. The dynamic "radius" gateway is
  // already excluded by the facade.
  let builtinProviders: readonly { readonly id: string; readonly label: string }[] = [];
  try {
    builtinProviders = listPiBuiltinProviders();
  } catch {
    builtinProviders = [];
  }
  const builtinIds = new Set(builtinProviders.map((provider) => provider.id));

  const providerLabelById = new Map<string, string>();
  for (const provider of builtinProviders) {
    providerLabelById.set(provider.id, provider.label);
  }
  for (const provider of providers) {
    if (!providerLabelById.has(provider.id)) providerLabelById.set(provider.id, provider.id);
  }

  const discoveredByProvider = new Map<string, DiscoveredLocalModel[]>();
  for (const discovered of input.discoveredModels ?? []) {
    const list = discoveredByProvider.get(discovered.providerId) ?? [];
    list.push(discovered);
    discoveredByProvider.set(discovered.providerId, list);
  }
  for (const id of discoveredByProvider.keys()) {
    if (!providerLabelById.has(id)) providerLabelById.set(id, id);
  }

  // `providers` is a support gate, not a hint: an agent advertises exactly the
  // providers it declared, the providers its own routes use, and whatever local
  // discovery found. A Pi built-in nobody declared is NOT selectable — offering
  // all 39 would let an operator pick a provider the agent holds no credential
  // for, and the failure would only surface at turn time.
  //
  // Deterministic order: declared providers (config order, id-sorted at load),
  // then route providers not already declared (route order), then discovered
  // local providers (alphabetical).
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  // `enabled: false` disables the provider everywhere, not just at its endpoint:
  // advertising a disabled provider's models offers a route config validation
  // now rejects.
  const disabled = new Set(
    providers.filter((provider) => provider.enabled === false).map((provider) => provider.id),
  );
  for (const provider of providers) {
    if (seen.has(provider.id) || disabled.has(provider.id)) continue;
    seen.add(provider.id);
    orderedIds.push(provider.id);
  }
  for (const ref of configuredRoutes) {
    if (seen.has(ref.provider) || disabled.has(ref.provider)) continue;
    seen.add(ref.provider);
    orderedIds.push(ref.provider);
  }
  const remainingDiscovered = [...discoveredByProvider.keys()]
    .filter((id) => !seen.has(id))
    .sort(compareModelId);
  for (const id of remainingDiscovered) {
    seen.add(id);
    orderedIds.push(id);
  }

  // Drop oversized provider ids here rather than mid-loop: `orderedIds` drives
  // the final `listProviders()` projection, so an id skipped later would still
  // be dereferenced there.
  const boundedIds = orderedIds.filter((id) => withinBytes(id, MAX_CATALOG_ID_BYTES));
  orderedIds.length = 0;
  orderedIds.push(...boundedIds);

  const byProviderId = new Map<string, ProviderModelEntry>();
  const byRef = new Map<string, TuiCatalogModel>();

  const builtinCatalogModel = (
    snapshot: PiBuiltinModelSnapshot,
    providerLabel: string,
  ): TuiCatalogModel => {
    const effort = resolveAdvertisedModelEffortForBuiltin(snapshot);
    const contextWindow = positiveContextWindow(snapshot.contextWindow);
    return {
      id: snapshot.id,
      name: snapshot.name,
      provider: snapshot.provider,
      providerLabel,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      reasoning: effort.reasoning,
      ...(effort.reasoningMode === undefined ? {} : { reasoningMode: effort.reasoningMode }),
      ...(effort.effortLevels === undefined ? {} : { effortLevels: effort.effortLevels }),
    };
  };

  for (const id of orderedIds) {
    const rawLabel = providerLabelById.get(id) ?? id;
    const providerLabel = withinBytes(rawLabel, MAX_CATALOG_LABEL_BYTES) ? rawLabel : id;
    const configured = configuredById.get(id);
    // A configured provider that declares a local `type` OWNS the id, even when
    // Pi ships a built-in under the same name. `runtimeOptionsForLocalProvider`
    // matches on provider id ALONE, so every selection for this id executes
    // against the local endpoint; advertising Pi's built-in list would offer
    // models that endpoint does not serve — selectable in the picker, dead at
    // turn time. The local definition therefore wins the `source` decision and
    // every model-building branch below.
    const localTyped = configured?.type !== undefined;
    const treatAsBuiltin = builtinIds.has(id) && !localTyped;
    const source: TuiProviderInfo["source"] = treatAsBuiltin
      ? "builtin"
      : configured !== undefined
        ? "custom"
        : "discovered";

    // `enabled: false` on an allowlist entry withdraws the model, not just its
    // endpoint wiring: doctor reports a route to it as unresolvable, so
    // advertising it offers a selection whose next turn fails. Branch on the
    // DECLARED list, filter for the advertised one — an operator who disabled
    // every entry narrowed the provider to nothing, and must not fall through
    // to the un-narrowed built-in catalog.
    const declaredModels = configured?.models;
    const allowlist = declaredModels?.filter((model) => model.enabled !== false) ?? [];
    const maxAdvertised = configured?.maxAdvertisedModels ?? DEFAULT_MAX_ADVERTISED_PER_PROVIDER;

    let models: TuiCatalogModel[] = [];
    let totalModelCount: number | undefined;

    if (declaredModels !== undefined && declaredModels.length > 0) {
      // An explicit `models` allowlist bypasses the cap and preserves its
      // declared order — the operator narrowed the provider on purpose.
      //
      // For a Pi built-in the allowlist NARROWS the real catalog; it does not
      // replace it. Emitting the declared name verbatim advertised a model Pi
      // cannot resolve when the name was wrong (selectable, then `pi model not
      // found` at turn time) and dropped reasoning/effort metadata when it was
      // right. Resolve against the snapshot, keep the operator's ordering and
      // display overrides, and drop names the provider does not have.
      const builtinByName = new Map<string, PiBuiltinModelSnapshot>();
      if (treatAsBuiltin) {
        try {
          for (const snapshot of listBuiltin(id)) builtinByName.set(snapshot.id, snapshot);
        } catch {
          builtinByName.clear();
        }
      }
      models = allowlist.flatMap((model) => {
        const snapshot = builtinByName.get(model.name);
        // Fail closed on the SNAPSHOT, not on its size. Keying the drop off
        // `builtinByName.size > 0` meant a throwing or empty built-in listing
        // advertised every authored name unvalidated — precisely the `pi model
        // not found` outcome this branch exists to prevent. Pi's catalog is a
        // synchronous, version-pinned in-process constant, so "unavailable" is
        // never a transient network blip: an empty listing for a provider Pi
        // claims to own is a real answer, and a throw makes every name
        // unverifiable. The provider still appears with `modelCount: 0` rather
        // than vanishing from the picker.
        if (treatAsBuiltin && snapshot === undefined) return [];
        const contextWindow = positiveContextWindow(model.capabilities?.context_window)
          ?? positiveContextWindow(model.capabilities?.num_ctx)
          ?? (snapshot === undefined ? undefined : positiveContextWindow(snapshot.contextWindow));
        const effort = snapshot === undefined
          ? undefined
          : resolveAdvertisedModelEffortForBuiltin(snapshot);
        return [{
          id: model.name,
          name: model.displayName ?? model.alias ?? snapshot?.name ?? model.name,
          provider: id,
          providerLabel,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(effort === undefined ? {} : {
            reasoning: effort.reasoning,
            ...(effort.reasoningMode === undefined ? {} : { reasoningMode: effort.reasoningMode }),
            ...(effort.effortLevels === undefined ? {} : { effortLevels: effort.effortLevels }),
          }),
        }];
      });
      totalModelCount = undefined;
    } else if (treatAsBuiltin) {
      let snapshots: PiBuiltinModelSnapshot[] = [];
      try {
        snapshots = [...listBuiltin(id)];
      } catch {
        snapshots = [];
      }
      const full = snapshots.sort((left, right) => compareModelId(left.id, right.id));
      const capped = full.slice(0, maxAdvertised);
      models = capped.map((snapshot) => builtinCatalogModel(snapshot, providerLabel));
      // Report the pre-cap total only when a cap actually shrank the list.
      totalModelCount = full.length > capped.length ? full.length : undefined;
    } else if (discoveredByProvider.has(id)) {
      // Dedupe by canonical ref (last wins) before sorting/capping, so a noisy
      // live /v1/models response cannot double-list a model.
      const discovered = [...new Map(
        (discoveredByProvider.get(id) ?? []).map((model) => [model.ref, model]),
      ).values()].sort((left, right) => compareModelId(left.ref, right.ref));
      // The provider's own `maxAdvertisedModels`, not the default: a provider
      // that narrowed its contribution to 10 was still handed 100 live-discovered
      // rows, because only the built-in branch honoured the configured cap.
      const capped = discovered.slice(0, maxAdvertised);
      models = capped.map((discoveredModel) => ({
        id: discoveredModel.ref.slice(discoveredModel.providerId.length + 1),
        name: discoveredModel.label,
        provider: discoveredModel.providerId,
        providerLabel,
      }));
      totalModelCount = discovered.length > capped.length ? discovered.length : undefined;
    }

    // Ids must be unique per provider: the pagination cursor IS the last row's
    // id, and `pageStartIndex` resolves it with `findIndex`. A duplicate id
    // therefore resolves to the FIRST occurrence, the cursor never advances,
    // and the walk serves the same page forever. First declaration wins so an
    // operator's allowlist ordering is preserved.
    const byId = new Map<string, TuiCatalogModel>();
    for (const model of models) {
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
    const frozenModels = Object.freeze(
      [...byId.values()].filter((model) =>
        withinBytes(model.id, MAX_CATALOG_ID_BYTES)
        && withinBytes(model.name, MAX_CATALOG_LABEL_BYTES)),
    );
    const info: TuiProviderInfo = Object.freeze({
      id,
      label: providerLabel,
      modelCount: frozenModels.length,
      ...(totalModelCount === undefined ? {} : { totalModelCount }),
      source,
      ...(supportedProviderIds.has(id) ? { configured: true } : {}),
    });
    byProviderId.set(id, { info, models: frozenModels });
    for (const model of frozenModels) {
      byRef.set(`${model.provider}:${model.id}`, model);
    }
  }

  const frozenProviders = Object.freeze(
    orderedIds.map((id) => byProviderId.get(id)!.info),
  );

  const resolveContextWindow = (ref: RuntimeModelReference): number | undefined => {
    const configuredProvider = localProviders?.find(
      (provider) => provider.id === ref.provider,
    );
    if (configuredProvider !== undefined) {
      const configuredModel = configuredProvider.models?.find(
        (model) => model.name === ref.model || model.alias === ref.model,
      );
      return positiveContextWindow(configuredModel?.capabilities?.context_window)
        ?? positiveContextWindow(configuredModel?.capabilities?.num_ctx);
    }
    return positiveContextWindow(getPiBuiltinModel(ref.provider, ref.model)?.contextWindow);
  };

  const describeOne = (ref: RuntimeModelReference): TuiModelOption => {
    const effort = resolveAdvertisedModelEffort(ref, {
      ...(localProviders === undefined ? {} : { localProviders }),
    });
    const contextWindow = resolveContextWindow(ref);
    // `effortLevels` is the ONLY unbounded field in this projection.
    // `provider` and `providerLabel` need no clamp of their own: the label is
    // either a short Pi built-in label or the provider id verbatim, and the id
    // repeats the provider half of this entry's own key — so a pathological one
    // is charged, not hidden, by the caller's per-entry byte measurement.
    const effortLevels = boundedEffortLevels(effort.effortLevels);
    return {
      ...(effortLevels === undefined ? {} : { effortLevels }),
      reasoning: effort.reasoning,
      ...(effort.reasoningMode === undefined ? {} : { reasoningMode: effort.reasoningMode }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      provider: ref.provider,
      providerLabel: providerLabelById.get(ref.provider) ?? ref.provider,
    };
  };

  return {
    listProviders: () => frozenProviders,

    listModels(providerId, options = {}) {
      const entry = byProviderId.get(providerId);
      const pageSize = clampPageSize(options.limit);
      const models = entry?.models ?? [];
      const start = pageStartIndex(models, options.cursor);
      const page = models.slice(start, start + pageSize);
      const truncated = start + pageSize < models.length;
      const lastModel = page[page.length - 1];
      return {
        models: page,
        ...(truncated && lastModel !== undefined ? { nextCursor: lastModel.id } : {}),
        truncated,
      };
    },

    searchModels(query, limit) {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return [];
      const cap = Math.min(clampPageSize(limit), MAX_SEARCH_RESULTS);
      const results: TuiCatalogModel[] = [];
      for (const provider of frozenProviders) {
        const entry = byProviderId.get(provider.id);
        if (entry === undefined) continue;
        for (const model of entry.models) {
          if (!modelMatches(model, needle)) continue;
          results.push(model);
          if (results.length >= cap) return results;
        }
      }
      return results;
    },

    resolve(ref) {
      return byRef.get(ref);
    },

    describe(refs) {
      const result: Record<string, TuiModelOption> = {};
      for (const ref of refs) {
        const entry = describeOne(ref);
        if (Object.keys(entry).length > 0) {
          result[modelReferenceKey(ref)] = entry;
        }
      }
      return result;
    },
  };
}

function pageStartIndex(models: readonly TuiCatalogModel[], cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const index = models.findIndex((model) => model.id === cursor);
  // A stale/unknown cursor terminates the walk (empty page) rather than
  // silently re-serving an earlier slice.
  return index === -1 ? models.length : index + 1;
}

function modelMatches(model: TuiCatalogModel, needle: string): boolean {
  return model.id.toLowerCase().includes(needle)
    || model.name.toLowerCase().includes(needle)
    || model.provider.toLowerCase().includes(needle)
    || model.providerLabel.toLowerCase().includes(needle);
}
