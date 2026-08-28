import { EFFORT_LEVELS } from "@mono-agent/config";
import {
  curatedClaudeSdkModels,
  getPiBuiltinModel,
  reasoningLevelsForPiModel,
} from "@mono-agent/agent-runtime";
import type {
  LocalProviderDefinition,
  ModelEffortLevels,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import { resolveModelEffortLevels } from "@mono-agent/runtime-adapter";

import type { CodexCatalogModel } from "./codex-model-catalog.js";

const KNOWN_EFFORTS = new Set<string>(EFFORT_LEVELS);

export interface ClaudeEffortCatalogEntry {
  readonly model: string;
  readonly reference?: string;
  readonly supportedEfforts: readonly string[];
}

export interface AdvertisedModelEffortCatalog {
  readonly localProviders?: readonly LocalProviderDefinition[];
  readonly claudeCatalog?: readonly ClaudeEffortCatalogEntry[];
  readonly codexCatalog?: readonly CodexCatalogModel[];
  readonly suppressExplicitEffort?: boolean;
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

function claudeCatalogEntry(
  ref: RuntimeModelReference,
  catalog: readonly ClaudeEffortCatalogEntry[] | undefined,
): ClaudeEffortCatalogEntry | undefined {
  const reference = `claude:${ref.model}`;
  return catalog?.find((entry) => entry.model === ref.model || entry.reference === reference);
}

/**
 * Resolve the effort snapshot advertised for one configured or discovered
 * runtime model. Unknown metadata never expands to the global ladder.
 */
export function resolveAdvertisedModelEffort(
  ref: RuntimeModelReference,
  catalog: AdvertisedModelEffortCatalog = {},
): ModelEffortLevels {
  if (catalog.suppressExplicitEffort === true || ref.sdk === "opencode" || ref.sdk === "acp") {
    return noExplicitEffort(true);
  }

  if (ref.sdk === "pi") {
    const local = resolveModelEffortLevels(ref, catalog.localProviders);
    if (ref.provider !== undefined && catalog.localProviders?.some((provider) => provider.id === ref.provider)) {
      return local;
    }
    if (ref.provider === undefined) return noExplicitEffort(true);
    const builtin = getPiBuiltinModel(ref.provider, ref.model);
    if (builtin === undefined) return noExplicitEffort(true);
    if (builtin.reasoning !== true) return noExplicitEffort(false);
    return gradedEffort(reasoningLevelsForPiModel(builtin));
  }

  if (ref.sdk === "claude") {
    const discovered = claudeCatalogEntry(ref, catalog.claudeCatalog);
    if (discovered !== undefined) return gradedEffort(discovered.supportedEfforts);
    const pinned = claudeCatalogEntry(ref, curatedClaudeSdkModels());
    if (pinned !== undefined) return gradedEffort(pinned.supportedEfforts);
    return noExplicitEffort(true);
  }

  if (ref.sdk === "codex") {
    const match = catalog.codexCatalog?.find((entry) => entry.id === ref.model);
    if (match === undefined) return noExplicitEffort(true);
    return gradedEffort(match.supportedEfforts);
  }

  return noExplicitEffort(true);
}
