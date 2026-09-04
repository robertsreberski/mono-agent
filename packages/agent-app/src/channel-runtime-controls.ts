import { EFFORT_LEVELS, resolveConfiguredProviders } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { TuiCatalogModel, TuiModelOption } from "@mono-agent/operator-adapter";
import { modelReferenceKey } from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import { buildProviderModelCatalog } from "./provider-model-catalog.js";
import { configuredRuntimeModels } from "./runtime-routes.js";

export interface ChannelRuntimeEffortOption {
  readonly value: string;
  readonly label: string;
}

export interface ChannelRuntimeModelOption {
  readonly value: string;
  readonly label: string;
  readonly efforts: readonly ChannelRuntimeEffortOption[];
}

export interface ChannelRuntimeControls {
  readonly defaultModel: string;
  readonly defaultEffort?: string;
  readonly models: readonly ChannelRuntimeModelOption[];
}

/**
 * Slack/Telegram render inline model menus that cannot paginate. Keep the list
 * useful but bounded: the configured routes come first, then a deterministic
 * top-N slice per configured provider, capped at {@link SLACK_TELEGRAM_MAX_MODELS}
 * additional models overall.
 */
const SLACK_TELEGRAM_MAX_MODELS = 25;

/**
 * Build the display-ready runtime catalog shared by native channel controls.
 * Adapters still own their interaction/state behavior; the host owns which
 * configured routes are safe to expose and which effort values each route can
 * actually accept. Configured routes resolve precise Pi effort levels (via the
 * shared provider catalog) rather than degrading to the global ladder.
 */
export function buildChannelRuntimeControls(coreConfig: MonoAgentConfig): ChannelRuntimeControls {
  const refs: RuntimeModelReference[] = [];
  const seen = new Set<string>();
  for (const ref of configuredRuntimeModels(coreConfig.runtime)) {
    const value = modelReferenceKey(ref);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    refs.push(ref);
  }

  const catalog = buildProviderModelCatalog({
    providers: resolveConfiguredProviders(coreConfig).entries,
    ...(coreConfig.providers?.local === undefined
      ? {}
      : { localProviders: coreConfig.providers.local }),
    configuredRoutes: refs,
  });

  const described = catalog.describe(refs);
  const models: ChannelRuntimeModelOption[] = refs.map((ref) => {
    const value = modelReferenceKey(ref);
    return {
      value,
      label: value,
      efforts: channelEffortOptions(described[value]),
    };
  });

  // Deterministic top-N per supported provider: route providers first (matching
  // the shortlist order above), then any provider listed in `providers` purely
  // to widen selection. Skip anything already listed as a configured route, and
  // stop once the additional budget is exhausted.
  let additional = 0;
  const configuredProviderIds = [...new Set([
    ...refs.map((ref) => ref.provider),
    ...catalog.listProviders()
      .filter((provider) => provider.configured === true)
      .map((provider) => provider.id),
  ])];
  for (const providerId of configuredProviderIds) {
    if (additional >= SLACK_TELEGRAM_MAX_MODELS) break;
    const page = catalog.listModels(providerId, { limit: SLACK_TELEGRAM_MAX_MODELS });
    for (const model of page.models) {
      const value = modelReference(model);
      if (seen.has(value)) continue;
      seen.add(value);
      additional += 1;
      // Catalog rows for a custom/local provider carry NO capability metadata:
      // the allowlist branch has no Pi snapshot to resolve against, so
      // `reasoning` is absent and `channelEffortOptions` returned [] — a
      // provider-widened local model that declares graded reasoning offered no
      // effort choices at all in the Slack/Telegram menu. `describe` is the
      // capability-aware path (it consults `providers.local`), and it agrees
      // with the row for built-ins, so resolve through it for every row.
      const described = catalog.describe([{
        provider: model.provider,
        model: model.id,
        reference: value,
      }])[value];
      models.push({
        value,
        label: model.name,
        efforts: channelEffortOptions(described ?? model),
      });
      if (additional >= SLACK_TELEGRAM_MAX_MODELS) break;
    }
  }

  return {
    defaultModel: modelReferenceKey(coreConfig.runtime.model),
    ...(coreConfig.runtime.effort === undefined ? {} : { defaultEffort: coreConfig.runtime.effort }),
    models,
  };
}

function modelReference(model: TuiCatalogModel): string {
  return `${model.provider}:${model.id}`;
}

function channelEffortOptions(
  effort: TuiModelOption | TuiCatalogModel | undefined,
): readonly ChannelRuntimeEffortOption[] {
  if (effort === undefined || !effort.reasoning || effort.reasoningMode === "none") {
    return [];
  }
  if (effort.reasoningMode === "toggle") {
    return [
      { value: "high", label: "Thinking on" },
      { value: "none", label: "Thinking off" },
    ];
  }
  const allowed = new Set<string>(EFFORT_LEVELS);
  const values = effort.effortLevels ?? EFFORT_LEVELS;
  return [...new Set(values)]
    .filter((value) => allowed.has(value))
    .map((value) => ({ value, label: channelEffortLabel(value) }));
}

function channelEffortLabel(value: string): string {
  if (value === "xhigh") return "Extra high";
  if (value === "max") return "Maximum";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
