import type { AgentProvider, AgentSummary, CatalogModel, ModelOption } from "../types";

/**
 * Pure model-catalog derivation. No React, no singletons: everything in this
 * module is a function of its arguments so the ordering, grouping, and effort
 * rules are unit-testable without a DOM.
 */

export const GLOBAL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

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

/** The ladder a configured shortlist route advertises. Authoritative when present. */
const effortLevelsForOption = (option: ModelOption): readonly string[] => {
  if (
    option.reasoning === false ||
    option.reasoningMode === "none" ||
    option.effortLevels?.length === 0
  ) {
    return [];
  }
  if (option.reasoningMode === "toggle") return ["high", "none"];
  return option.effortLevels ?? [];
};

/**
 * The effort ladder a catalog row advertises for itself, or `undefined` when
 * the `/v1/models` page said nothing about reasoning at all.
 *
 * Silence is not "no efforts": narrowing on it would hide every grade the agent
 * would in fact accept, which is the failure this whole path already had once.
 * Only an explicit signal -- `reasoning:false`, `reasoningMode`, or an
 * `effortLevels` list (including an empty one) -- narrows.
 */
export const effortLevelsForCatalogModel = (
  catalogModel: CatalogModel | undefined,
): readonly string[] | undefined => {
  if (catalogModel === undefined) return undefined;
  if (catalogModel.reasoning === false || catalogModel.reasoningMode === "none") return [];
  if (catalogModel.reasoningMode === "toggle") return ["high", "none"];
  return catalogModel.effortLevels;
};

export const effortLevelsForAgentModel = (
  agent: AgentSummary | null,
  model: string,
  catalogModel?: CatalogModel | undefined,
): readonly string[] => {
  if (!agent) return [];
  // The configured shortlist stays authoritative for the routes it names.
  const option = agent.modelOptions?.[model];
  if (option !== undefined) return effortLevelsForOption(option);
  // A catalog row's own metadata outranks the legacy global ladder. Without
  // this a non-reasoning catalog model rendered Thinking controls and let an
  // unsupported grade be picked, which the server then rejected (or dropped).
  const catalogLevels = effortLevelsForCatalogModel(catalogModel);
  if (catalogLevels !== undefined) return catalogLevels;
  // Agents that predate per-model metadata describe one ladder for everything.
  if (agent.modelOptions === undefined) return agent.efforts ?? GLOBAL_EFFORT_LEVELS;
  return [];
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
  const effectiveReference = reference || agent.defaultModel || modelOptions[0] || "";
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
}: BuildSelectorModelsInput): readonly ModelSelectorOption[] => {
  if (!agent) return [];
  const shortlistIds = new Set(modelOptions);
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
      name: `Default · ${(agent.modelOptions?.[agent.defaultModel ?? ""]?.label ?? agent.defaultModel) || "agent"}`,
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
      name: agent.modelOptions?.[reference]?.label ?? reference,
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
  const provides = groups.map((group) => ({ provider: group.provider, label: group.label }));
  const seen = new Set(provides.map((entry) => entry.provider));
  for (const provider of agentProviders) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    provides.push({ provider: provider.id, label: provider.label });
  }
  return provides;
};