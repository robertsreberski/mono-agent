import {
  advertisedEffortLevels,
  effectiveModelForAgent,
  effortLevelsForModel,
  GLOBAL_EFFORT_LEVELS,
} from "../../../src/effort-ladder.js";
import type { AgentProvider, AgentSummary, CatalogModel } from "../types";

/**
 * Pure model-catalog derivation. No React, no singletons: everything in this
 * module is a function of its arguments so the ordering, grouping, and effort
 * rules are unit-testable without a DOM.
 *
 * The effort rule itself is NOT derived here. `@mono-agent/web`'s server side
 * decides the same question for the same models when it validates a turn, and
 * the two answers were written separately and drifted: the picker hid grades
 * `WebService.startTurn` accepts. Both ends now call `effort-ladder.ts`, the
 * one dependency-free module they can share across the workspace boundary.
 */

/**
 * Re-exported, not re-derived. `model-catalog.test.ts` asserts these are the
 * SAME bindings as `packages/web/src/effort-ladder.ts` exports, which is what
 * makes "one implementation" checkable: replacing the import above with a local
 * copy that returns identical values passed every value-level assertion in this
 * suite, and would have shipped the drift this module pair exists to prevent.
 */
export { advertisedEffortLevels, effectiveModelForAgent, effortLevelsForModel, GLOBAL_EFFORT_LEVELS };

export type ModelSelectorEffortOption = {
  readonly id: string;
  readonly name: string;
};

export type ModelSelectorOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly efforts: readonly ModelSelectorEffortOption[];
  /** Provider registry id this option groups under. Absent on the default row. */
  readonly provider?: string;
  /** Provider display label for group headings and filter chips. */
  readonly providerLabel?: string;
};

/** One provider's rows, bucketed in first-seen order. */
export type CatalogProviderGroup = {
  readonly provider: string;
  readonly label: string;
  readonly models: ModelSelectorOption[];
};

/** The row id of "let the agent pick", permanently reachable under any filter. */
export const AUTOMATIC_MODEL_ID = "";

export const effortName = (effort: string): string => ({
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}[effort] ?? effort);

export const defaultEffortName = (effort: string | undefined, toggle: boolean): string => {
  if (effort === undefined) return "Provider";
  if (toggle) return effort === "none" ? "Off" : "On";
  return effortName(effort);
};

/**
 * The efforts this agent accepts for this model. Thin by design: the decision
 * belongs to the shared rule, so the picker offers exactly what
 * `WebService.validateModelAndEffort` will accept for the same inputs.
 */
export const effortLevelsForAgentModel = (
  agent: AgentSummary | null,
  model: string,
  catalogModel?: CatalogModel | undefined,
): readonly string[] => {
  if (!agent) return [];
  return effortLevelsForModel(agent, model, advertisedEffortLevels(catalogModel));
};

/**
 * The provider a bare shortlist reference belongs to. Catalog rows carry their
 * provider explicitly; only shortlist rows that a catalog page has not widened
 * yet fall back to the `<provider>:model` / `provider/model` reference shape.
 */
export const providerOfModel = (model: string): string => {
  const colon = model.indexOf(":");
  const slash = model.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) return model.slice(0, colon);
  if (slash > 0) return model.slice(0, slash);
  return model;
};

/**
 * The canonical `<provider>:<model>` reference for a catalog row. `/v1/models`
 * emits provider-local ids (`{provider:"anthropic", id:"claude-opus-5"}`), but
 * every selection surface — the thread override, the turn API, the agent's own
 * validator — speaks canonical references. Building a row id from the bare
 * `id` records a model the agent cannot resolve, and it fails silently by
 * falling back to the default model.
 */
export const catalogModelReference = (model: CatalogModel): string =>
  model.provider ? `${model.provider}:${model.id}` : model.id;

/**
 * The catalog row a reference names, by canonical `<provider>:<model>` or by
 * the bare provider-local id the wire uses. Exported because every effort
 * decision in the console -- the picker rows, the stored-preference validator,
 * the ladder a model switch re-checks against -- has to consult the same
 * metadata, and a decision made without it silently discards the selection.
 */
export const findCatalogModel = (
  catalogByProvider: Readonly<Record<string, readonly CatalogModel[]>> | undefined,
  modelId: string,
): CatalogModel | undefined => {
  if (catalogByProvider === undefined) return undefined;
  for (const entry of Object.values(catalogByProvider)) {
    for (const model of entry) {
      if (catalogModelReference(model) === modelId || model.id === modelId) return model;
    }
  }
  return undefined;
};

const buildEffortOptions = (
  agent: AgentSummary,
  defaultEffort: string,
  modelOptions: readonly string[],
  reference: string,
  catalogModel?: CatalogModel | undefined,
): readonly ModelSelectorEffortOption[] => {
  const effectiveReference = effectiveModelForAgent(
    { ...agent, models: agent.models ?? modelOptions },
    reference,
  ) ?? "";
  const toggle =
    agent.modelOptions?.[effectiveReference]?.reasoningMode === "toggle" ||
    catalogModel?.reasoningMode === "toggle";
  const levels = effortLevelsForAgentModel(agent, effectiveReference, catalogModel);
  if (levels.length === 0) return [];
  return [
    { id: "", name: `Default · ${defaultEffortName(defaultEffort || undefined, toggle)}` },
    ...levels.map((level) => ({
      id: level,
      name: toggle ? (level === "none" ? "Off" : "On") : effortName(level),
    })),
  ];
};

export type BuildSelectorModelsInput = {
  readonly agent: AgentSummary | null;
  readonly modelOptions: readonly string[];
  readonly defaultEffort: string;
  readonly catalogByProvider?: Readonly<Record<string, readonly CatalogModel[]>>;
  /** Current nonblank override, retained while its lazy catalog row is unavailable. */
  readonly selectedModel?: string;
};

/**
 * The ordered flat option list the selector renders: the automatic row first,
 * then every configured shortlist route (in `agent.models` order, catalog
 * widened when a fetched page proves its provider), then catalog-only rows in
 * first-fetched order. Providers are derived in the same pass so the selector
 * can bucket groups without re-deriving anything.
 */
export const buildSelectorModels = ({
  agent,
  modelOptions,
  defaultEffort,
  catalogByProvider,
  selectedModel,
}: BuildSelectorModelsInput): readonly ModelSelectorOption[] => {
  if (!agent) return [];
  const shortlistIds = new Set(modelOptions);
  const displayNameForReference = (reference: string | undefined): string | undefined => {
    if (!reference) return undefined;
    return agent.modelOptions?.[reference]?.label
      ?? findCatalogModel(catalogByProvider, reference)?.name
      ?? reference;
  };
  const providerOf = (reference: string): { readonly provider: string; readonly label: string } => {
    const catalogModel = findCatalogModel(catalogByProvider, reference);
    if (catalogModel && catalogModel.provider) {
      return { provider: catalogModel.provider, label: catalogModel.providerLabel || catalogModel.provider };
    }
    const provider = providerOfModel(reference);
    return { provider, label: provider };
  };

  const rows: ModelSelectorOption[] = [
    {
      id: AUTOMATIC_MODEL_ID,
      name: `Default · ${displayNameForReference(agent.defaultModel) ?? "agent"}`,
      description: agent.defaultModel
        ? `Agent default · ${agent.defaultModel}`
        : "Use the agent default",
      efforts: buildEffortOptions(
        agent,
        defaultEffort,
        modelOptions,
        AUTOMATIC_MODEL_ID,
        findCatalogModel(catalogByProvider, agent.defaultModel ?? ""),
      ),
    },
  ];

  for (const reference of modelOptions) {
    const { provider, label } = providerOf(reference);
    rows.push({
      id: reference,
      name: displayNameForReference(reference) ?? reference,
      description: reference,
      efforts: buildEffortOptions(
        agent,
        defaultEffort,
        modelOptions,
        reference,
        findCatalogModel(catalogByProvider, reference),
      ),
      provider,
      providerLabel: label,
    });
  }

  for (const entry of Object.values(catalogByProvider ?? {})) {
    for (const catalogModel of entry) {
      const reference = catalogModelReference(catalogModel);
      if (reference === AUTOMATIC_MODEL_ID || shortlistIds.has(reference)) continue;
      const provider = catalogModel.provider || providerOfModel(reference);
      rows.push({
        id: reference,
        name: catalogModel.name,
        description: reference,
        efforts: buildEffortOptions(
          agent,
          defaultEffort,
          modelOptions,
          reference,
          catalogModel,
        ),
        provider,
        providerLabel: catalogModel.providerLabel || provider,
      });
    }
  }

  // A thread override is server-owned and can outlive this tab's lazy catalog
  // cache. Never let the selector substitute the automatic row during that
  // gap. The canonical reference is truthful; effort choices wait for exact
  // model metadata instead of borrowing the global ladder.
  if (
    selectedModel
    && !rows.some((row) => row.id === selectedModel)
  ) {
    const provider = providerOfModel(selectedModel);
    rows.push({
      id: selectedModel,
      name: displayNameForReference(selectedModel) ?? selectedModel,
      description: selectedModel,
      efforts: [],
      provider,
      providerLabel: agent.providers?.find((entry) => entry.id === provider)?.label ?? provider,
    });
  }
  return rows;
};

/** Bucket rows into per-provider groups, preserving first-seen order. */
export const groupSelectorModels = (
  models: readonly ModelSelectorOption[],
): readonly CatalogProviderGroup[] => {
  const groups: CatalogProviderGroup[] = [];
  const byProvider = new Map<string, CatalogProviderGroup>();
  for (const model of models) {
    if (!model.provider) continue;
    let group = byProvider.get(model.provider);
    if (!group) {
      group = { provider: model.provider, label: model.providerLabel ?? model.provider, models: [] };
      byProvider.set(model.provider, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
};

/** The provider chips in first-seen order, deduped. */
/**
 * The provider chip row. Groups alone are not enough: a group only exists once
 * a catalog page has been fetched, and a page is only fetched when its chip is
 * clicked — so a provider declared purely to widen selection would never get a
 * chip and could never be reached. Union the agent's advertised providers in so
 * the first click is possible.
 */
export const selectorProvides = (
  groups: readonly CatalogProviderGroup[],
  agentProviders: readonly AgentProvider[] = [],
): readonly { readonly provider: string; readonly label: string }[] => {
  const advertisedLabels = new Map(
    agentProviders.map((provider) => [provider.id, provider.label]),
  );
  const provides = groups.map((group) => ({
    provider: group.provider,
    label: advertisedLabels.get(group.provider) ?? group.label,
  }));
  const seen = new Set(provides.map((entry) => entry.provider));
  for (const provider of agentProviders) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    provides.push({ provider: provider.id, label: provider.label });
  }
  return provides;
};
