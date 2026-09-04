import { EFFORT_LEVELS } from "@mono-agent/config";
import {
  getPiBuiltinModel,
  reasoningLevelsForPiModel,
  type PiBuiltinModelSnapshot,
} from "@mono-agent/agent-runtime";
import type {
  LocalProviderDefinition,
  ModelEffortLevels,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import { resolveModelEffortLevels } from "@mono-agent/runtime-adapter";

const KNOWN_EFFORTS = new Set<string>(EFFORT_LEVELS);

export interface AdvertisedModelEffortCatalog {
  readonly localProviders?: readonly LocalProviderDefinition[];
}

function knownEfforts(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => KNOWN_EFFORTS.has(value));
}

function noExplicitEffort(reasoning = true): ModelEffortLevels {
  return { reasoning };
}

function gradedEffort(levels: readonly string[]): ModelEffortLevels {
  const effortLevels = knownEfforts(levels);
  if (effortLevels.length === 0) return noExplicitEffort(true);
  return {
    reasoning: true,
    reasoningMode: "effort",
    effortLevels,
  };
}

/**
 * Resolve the effort snapshot for one already-cloned Pi built-in model. Kept
 * separate from {@link resolveAdvertisedModelEffort} so the provider catalog can
 * compute effort from a cached snapshot without paying a fresh
 * `getPiBuiltinModel` clone per model.
 */
export function resolveAdvertisedModelEffortForBuiltin(
  builtin: PiBuiltinModelSnapshot,
): ModelEffortLevels {
  if (builtin.reasoning !== true) return noExplicitEffort(false);
  return gradedEffort(reasoningLevelsForPiModel(builtin));
}

/**
 * Resolve the effort snapshot advertised for one configured or discovered
 * runtime model. Unknown metadata never expands to the global ladder.
 */
export function resolveAdvertisedModelEffort(
  ref: RuntimeModelReference,
  catalog: AdvertisedModelEffortCatalog = {},
): ModelEffortLevels {
  const local = resolveModelEffortLevels(ref, catalog.localProviders);
  if (catalog.localProviders?.some((provider) => provider.id === ref.provider)) {
    return local;
  }
  const builtin = getPiBuiltinModel(ref.provider, ref.model);
  if (builtin === undefined) return noExplicitEffort(true);
  return resolveAdvertisedModelEffortForBuiltin(builtin);
}
