import {
  advertisedEffortLevels,
  GLOBAL_EFFORT_LEVELS,
  effectiveModelForAgent,
  findCatalogModel,
  inheritedEffortForModel,
} from "./model-catalog";
import { runAttributionSummary } from "./RunAttribution";
import type {
  AgentSummary,
  CatalogModel,
  RunAttribution as RunAttributionValue,
  ThreadSummary,
  ToolCallStatus,
} from "../types";

/**
 * Compact model/effort labels for conversation rows and subagent activity.
 *
 * Pure derivation, no React and no store: every caller feeds the same inputs
 * (a thread plus ITS agent, or a delegation's own attribution) so the
 * dashboard rows, search hits and running cards share the same rules.
 *
 * Two different questions, deliberately separate:
 *
 * - a conversation row labels CURRENT settings: the thread's persisted
 *   overrides, falling back to the agent's resolved config defaults. It is
 *   not a claim about what the last turn executed with.
 * - a subagent badge labels one delegation's REPORTED route: executed, then
 *   attempted, then requested. Requested-only never reads as ran-with, and a
 *   fallback stays flagged even while folded.
 */

/** Tiny effort token for the badge's second half. Full meaning in `title`/`aria-label`. */
export const effortToken = (effort: string): string => {
  switch (effort) {
    case "none": return "off";
    case "xhigh": return "xhigh";
    default: return effort;
  }
};

/** Full effort wording for accessible names. Reuses the picker's vocabulary. */
export const effortFullName = (effort: string): string => {
  switch (effort) {
    case "none": return "Off";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra high";
    case "max": return "Max";
    case "ultra": return "Ultra";
    default: return effort;
  }
};

const MODEL_ID_LEAF = (model: string): string => {
  // Strip the provider, not the model tag (ollama:qwen3:8b -> qwen3:8b).
  const colon = model.indexOf(":");
  const slash = model.indexOf("/");
  const id = colon >= 0 && (slash < 0 || colon < slash) ? model.slice(colon + 1) : model;
  return id.slice(id.lastIndexOf("/") + 1);
};

/** Keep family AND version visible; unknown/custom names keep their identity. */
export function shortModelName(model: string, displayName?: string): string {
  const leaf = MODEL_ID_LEAF(model);
  // Only shorten recognised complete shapes, never a family word buried in a
  // custom model name. Preserve variant suffixes (e.g. Codex mini/max).
  const claude = leaf.match(/^(?:claude-)?(sonnet|opus|haiku|fable)-(\d+(?:[.-]\d{1,2})?)(?:-\d{8})?$/iu);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]!.replace(/-/gu, ".")}`;
  const gpt = leaf.match(/^gpt-(\d+(?:\.\d+)?)-(sol|astra|terra|codex)(-mini|-max|-spark)?$/iu);
  if (gpt) return `${gpt[2]![0]!.toUpperCase()}${gpt[2]!.slice(1)} ${gpt[1]}${gpt[3] ? ` ${gpt[3].slice(1)}` : ""}`;
  const muse = leaf.match(/^muse-spark-(\d+(?:\.\d+)*)(-contributor)?$/iu);
  if (muse) return `Muse ${muse[1]}${muse[2] ? " C" : ""}`;
  return displayName?.trim() || leaf.trim() || model.trim();
}

export interface EffortSignal {
  /** Ordered, currently advertised positive grades; off is the empty signal. */
  readonly levels: readonly string[];
  readonly filled: number;
}

/** Never invent a scale from an unknown effort or the global admission floor. */
export function effortSignalFor(effort: string, levels: readonly string[] | undefined): EffortSignal | undefined {
  if (levels === undefined || levels.length === 0 || !levels.includes(effort)) return undefined;
  if (levels.some((level) => !(GLOBAL_EFFORT_LEVELS as readonly string[]).includes(level))) return undefined;
  const ordered = GLOBAL_EFFORT_LEVELS.filter((level) => level !== "none" && levels.includes(level));
  if (ordered.length === 0) return undefined;
  return { levels: ordered, filled: effort === "none" ? 0 : ordered.indexOf(effort as typeof ordered[number]) + 1 };
}

/** Capability precedence matches the picker, but an unadvertised floor is unknown. */
export function knownEffortLevels(
  model: string,
  agent: AgentSummary | null,
  catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>,
): readonly string[] | undefined {
  const shortlist = advertisedEffortLevels(agent?.modelOptions?.[model]);
  if (shortlist !== undefined) return shortlist;
  const catalog = advertisedEffortLevels(findCatalogModel(catalogModels, model));
  if (catalog !== undefined) return catalog;
  return agent?.modelOptions === undefined ? agent?.efforts : undefined;
}

export type RouteProvenance = "override" | "inherited" | "unknown";

export interface ResolvedThreadRoute {
  /** Effective model id, or "" when no agent and no override names one. */
  readonly model: string;
  /** Effective effort id, or "" when nothing admits one. */
  readonly effort: string;
  readonly modelShort: string;
  readonly effortShort: string;
  readonly effortSignal?: EffortSignal;
  /** Accessible name: full provider/model, full effort, provenance. */
  readonly label: string;
  /** Mouse/long-press detail; mirrors the accessible name. */
  readonly title: string;
  readonly modelProvenance: RouteProvenance;
  readonly effortProvenance: RouteProvenance;
  /** The thread's agent is gone from discovery; the label says so. */
  readonly agentMissing: boolean;
}

const nonEmpty = (value: string | null | undefined): string =>
  value === null || value === undefined ? "" : value;

/**
 * A conversation's CURRENT settings: per-thread overrides, else the agent's
 * resolved config defaults -- never the web-new-thread draft defaults, which
 * are copied into new threads only, and never the last run's route.
 *
 * `agent` must be the thread's OWN sourceId match (fleet cards especially),
 * or null when discovery no longer lists it. `catalogModels` is the store's
 * already-fetched, owner-scoped projection. Without it the shared resolver
 * uses configured route metadata and defaults, just as settings does before
 * fetching a catalog. This describes settings, not proof of execution.
 */
export function resolveThreadRoute(
  thread: Pick<ThreadSummary, "runModel" | "runEffort" | "sourceId">,
  agent: AgentSummary | null,
  catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>,
): ResolvedThreadRoute {
  const overrideModel = nonEmpty(thread.runModel);
  const overrideEffort = nonEmpty(thread.runEffort);
  const configModel = agent ? effectiveModelForAgent(agent, "") ?? "" : "";
  const model = overrideModel || configModel;
  const modelProvenance: RouteProvenance = overrideModel
    ? "override"
    : configModel ? "inherited" : "unknown";
  const configEffort = agent?.defaultEffort ?? "";
  const catalogModel = model ? findCatalogModel(catalogModels, model) : undefined;
  const inherited = agent && model
    ? inheritedEffortForModel(agent, model, catalogModel, configEffort || undefined)
    : undefined;
  const effort = overrideEffort || inherited || "";
  const effortProvenance: RouteProvenance = overrideEffort
    ? "override"
    : inherited ? "inherited" : "unknown";
  const displayName = model
    ? agent?.modelOptions?.[model]?.label ?? catalogModel?.name ?? undefined
    : undefined;
  const agentMissing = agent === null;
  const fullModel = model === ""
    ? "model not reported"
    : displayName && displayName !== model ? `${displayName} (${model})` : model;
  const fullEffort = effort === "" ? "effort not reported" : effortFullName(effort);
  const provenance = modelProvenance === "override" || effortProvenance === "override"
    ? "conversation override"
    : modelProvenance === "inherited" || effortProvenance === "inherited"
      ? "inherited agent defaults"
      : "no route reported";
  const label = `Model ${fullModel}, effort ${fullEffort}, ${provenance}${
    agentMissing ? ", agent unavailable" : ""
  }`;
  return {
    model,
    effort,
    modelShort: model === "" ? "—" : shortModelName(model, displayName),
    effortShort: effort === "" ? "—" : effortToken(effort),
    effortSignal: effortSignalFor(effort, knownEffortLevels(model, agent, catalogModels)),
    label,
    title: label,
    modelProvenance,
    effortProvenance,
    agentMissing,
  };
}

/** Flatten the store's per-provider catalog states to what the helpers read. */
export function flattenCatalogModels(
  catalogByProvider: Readonly<Record<string, { readonly models: readonly CatalogModel[] }>> | undefined,
): Readonly<Record<string, readonly CatalogModel[]>> | undefined {
  if (catalogByProvider === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(catalogByProvider).map(([provider, state]) => [provider, state.models]),
  );
}

export type SubagentRouteKind = "executed" | "attempted" | "requested" | "none";

export interface ResolvedSubagentRoute {
  readonly kind: SubagentRouteKind;
  readonly modelShort: string;
  readonly effortShort: string;
  readonly effortSignal?: EffortSignal;
  /** Accessible name; requested-only and fallback never read as ran-with. */
  readonly label: string;
  readonly title: string;
  readonly isFallback: boolean;
  readonly isRequestedOnly: boolean;
}

/**
 * One delegation's OWN reported route: executed, then attempted, then
 * requested -- never the parent thread's settings and never a guessed
 * profile model. `effectiveEffort` wins over the target's effort when the
 * runtime reported one; the requested/effective distinction stays in the
 * accessible name. No attribution (old records) means no badge at all, so
 * callers render nothing rather than inventing a label.
 */
export function resolveSubagentRoute(
  attribution: RunAttributionValue | undefined,
  status: ToolCallStatus,
  agent: AgentSummary | null = null,
  catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>,
): ResolvedSubagentRoute | undefined {
  if (attribution === undefined) return undefined;
  const target = attribution.executed ?? attribution.attempted ?? attribution.requested;
  const kind: SubagentRouteKind = attribution.executed !== undefined
    ? "executed"
    : attribution.attempted !== undefined
      ? "attempted"
      : target.model !== undefined || target.effort !== undefined ||
          ("effectiveEffort" in target && target.effectiveEffort !== undefined)
        ? "requested"
        : "none";
  const effectiveEffort = (attribution.executed ?? attribution.attempted)?.effectiveEffort;
  const effort = effectiveEffort ?? target.effort ?? "";
  const model = target.model ?? "";
  const summary = kind === "requested" || kind === "attempted"
    ? `${kind === "requested" ? "Requested" : "Attempted"} ${model || "unreported model"}${target.effort ? ` · ${effortFullName(target.effort)}` : ""}${attribution.disposition === "fallback" ? " (fallback)" : ""}`
    : runAttributionSummary(attribution, status);
  const requestedEffort = attribution.requested.effort;
  const effortNote = effectiveEffort !== undefined && requestedEffort !== undefined &&
      effectiveEffort !== requestedEffort
    ? ` (requested ${effortFullName(requestedEffort)}, effective ${effortFullName(effectiveEffort)})`
    : effectiveEffort !== undefined && requestedEffort === undefined
      ? ` (effective ${effortFullName(effectiveEffort)})`
      : "";
  const isRequestedOnly = kind === "requested";
  const isFallback = attribution.disposition === "fallback";
  const label = isRequestedOnly
    ? `Subagent route: ${summary}${effortNote} — requested, not a confirmed run`
    : `Subagent route: ${summary}${effortNote}`;
  return {
    kind,
    modelShort: model === "" ? "—" : shortModelName(model),
    effortShort: effort === "" ? "—" : effortToken(effort),
    effortSignal: effortSignalFor(effort, knownEffortLevels(model, agent, catalogModels)),
    label,
    title: label,
    isFallback,
    isRequestedOnly,
  };
}
