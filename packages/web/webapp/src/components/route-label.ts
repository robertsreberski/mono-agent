import {
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
 * dashboard rows, the search hits and the running cards can never disagree
 * about what a conversation runs on. See issue #861.
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
    case "none": return "Off";
    case "minimal": return "Min";
    case "low": return "L";
    case "medium": return "M";
    case "high": return "H";
    case "xhigh": return "XH";
    case "max": return "Max";
    case "ultra": return "Ultra";
    default: return effort.length <= 8 ? effort : `${effort.slice(0, 7)}…`;
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
  const colon = model.lastIndexOf(":");
  const slash = model.lastIndexOf("/");
  const cut = Math.max(colon, slash);
  return cut === -1 ? model : model.slice(cut + 1);
};

/**
 * Short recognisable model name for the badge's first half.
 *
 * A small ordered family match over the display name AND the id leaf, so a
 * known family reads as one word (`Sol`, `Sonnet`) while materially distinct
 * ids keep their full identity in the accessible name and `title` -- two
 * versions share the short word but never the same badge name. Anything
 * unrecognised keeps its own text, ellipsized, rather than a guessed family.
 */
export function shortModelName(model: string, displayName?: string): string {
  const haystack = `${displayName ?? ""} ${MODEL_ID_LEAF(model)}`;
  if (/\bastra\b/iu.test(haystack)) return "Astra";
  if (/\bsol\b/iu.test(haystack)) return "Sol";
  if (/fable/iu.test(haystack)) return "Fable";
  if (/sonnet/iu.test(haystack)) return "Sonnet";
  if (/\bopus\b/iu.test(haystack)) return "Opus";
  if (/haiku/iu.test(haystack)) return "Haiku";
  const muse = haystack.match(/muse[-\s]?spark[-\s]?(\d+(?:\.\d+)*)/iu);
  if (muse) return `Muse ${muse[1]}`;
  if (/muse/iu.test(haystack)) return "Muse";
  if (/codex/iu.test(haystack)) return "Codex";
  const fallback = (displayName ?? "").trim() || MODEL_ID_LEAF(model).trim() || model.trim();
  return fallback.length <= 14 ? fallback : `${fallback.slice(0, 13)}…`;
}

export type RouteProvenance = "override" | "inherited" | "unknown";

export interface ResolvedThreadRoute {
  /** Effective model id, or "" when no agent and no override names one. */
  readonly model: string;
  /** Effective effort id, or "" when nothing admits one. */
  readonly effort: string;
  readonly modelShort: string;
  readonly effortShort: string;
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
 * already-fetched projection; absent catalog data falls back honestly to "—"
 * rather than a guessed effort. No fetching here, so rows stay cheap.
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
  const summary = runAttributionSummary(attribution, status);
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
    ? `Subagent route requested ${summary}${effortNote} -- requested, not a confirmed run`
    : `Subagent route: ${summary}${effortNote}`;
  return {
    kind,
    modelShort: model === "" ? "—" : shortModelName(model),
    effortShort: effort === "" ? "—" : effortToken(effort),
    label,
    title: label,
    isFallback,
    isRequestedOnly,
  };
}
