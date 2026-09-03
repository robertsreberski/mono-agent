/**
 * The one effort rule, shared verbatim by both ends of the console.
 *
 * The server decides what a turn may carry; the browser decides what the
 * picker offers and what a stored preference survives as. Written twice, those
 * two decisions drift, and the drift is invisible: the UI hides or clears a
 * grade the agent would have accepted, or offers one it rejects with a 400.
 * This module is imported by `service.ts` and by
 * `webapp/src/components/model-catalog.ts` (relatively, the way
 * `mcp-app-document.ts` already is), so there is exactly one implementation.
 *
 * It must therefore stay dependency-free: the webapp is its own pnpm workspace
 * and cannot resolve `@mono-agent/config` or anything else from the monorepo.
 * `GLOBAL_EFFORT_LEVELS` duplicates `EFFORT_LEVELS` for that reason, and
 * `packages/web/src/__tests__/effort-ladder.test.ts` pins the two equal.
 */

/**
 * The canonical ladder, used wherever nothing narrower is known. Mirrors
 * `EFFORT_LEVELS` from `@mono-agent/config`.
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

/** What a `reasoningMode: "toggle"` model offers: thinking on, or off. */
export const TOGGLE_EFFORT_LEVELS = ["high", "none"] as const;

/**
 * What one route says about its own reasoning. A `modelOptions` entry (the
 * configured shortlist) and a `/v1/models` catalog row are built from the same
 * `resolveAdvertisedModelEffort` shape in `@mono-agent/agent-app`, so one rule
 * reads both.
 */
export interface EffortAdvertisement {
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly effortLevels?: readonly string[];
}

/** The `modelOptions`/`efforts` pair an agent advertises on `/v1/info`. */
export interface EffortAgentContext {
  readonly modelOptions?: Readonly<Record<string, EffortAdvertisement>> | undefined;
  readonly efforts?: readonly string[] | undefined;
  /** The configured shortlist, in the order the agent advertised it. */
  readonly models?: readonly string[] | undefined;
  /** The route a turn carrying no explicit model runs on. */
  readonly defaultModel?: string | undefined;
}

/**
 * The model an effort decision is actually about when the selection is blank.
 *
 * Blank means "let the agent pick", and what the agent picks is its default
 * route, or -- for a payload that advertises a shortlist but no default -- the
 * first route on that shortlist. Both ends have to answer this the same way or
 * the shared rule below is fed different models and drifts anyway: the browser
 * fell back to `models[0]` while the server stopped at `defaultModel`, so for
 * any `/v1/info` omitting `model` the picker offered the first route's ladder
 * while `startTurn` judged against the global one.
 *
 * `undefined` means the caller knows of no route at all, which is the one case
 * where {@link effortLevelsForModel} legitimately has nothing to look up.
 */
export function effectiveModelForAgent(
  agent: EffortAgentContext,
  model: string | undefined,
): string | undefined {
  return model || agent.defaultModel || agent.models?.[0] || undefined;
}

/**
 * The ladder one advertisement resolves to, or `undefined` when it said
 * nothing at all and the caller's floor applies.
 *
 * Read the producer's vocabulary (`agent-app/src/model-effort-capabilities.ts`,
 * `runtime-adapter/src/local-providers.ts`) rather than the field names:
 *
 *   - `reasoning: false` / `reasoningMode: "none"` — takes no grade at all.
 *   - `reasoningMode: "toggle"` — binary thinking; graded levels would lie.
 *   - an `effortLevels` list, empty included — exactly those grades.
 *   - `reasoningMode: "effort"` with no list — the operator's own local-provider
 *     config declared this model graded and enumerated nothing (a real Ollama
 *     `reasoning_mode: "effort"` produces exactly this). It is an affirmative
 *     claim that grades apply, so it gets the canonical ladder, the same one
 *     `channelEffortOptions` and the TUI picker offer it. Reading it as an
 *     empty ladder inverts its meaning and 400s every effort.
 *   - `reasoning: true` alone — "we looked and could not determine the grades"
 *     for a cloud model. Deliberately narrow (80a6df14): unspecified cloud
 *     grades stay hidden rather than guessed at.
 *   - nothing whatsoever — silence, not a claim. The caller's floor decides.
 */
export function advertisedEffortLevels(
  advertisement: EffortAdvertisement | undefined,
): readonly string[] | undefined {
  if (advertisement === undefined) return undefined;
  if (advertisement.reasoning === false || advertisement.reasoningMode === "none") return [];
  // An explicitly empty list narrows hardest: it outranks even a mode.
  if (advertisement.effortLevels?.length === 0) return [];
  if (advertisement.reasoningMode === "toggle") return TOGGLE_EFFORT_LEVELS;
  if (advertisement.effortLevels !== undefined) return advertisement.effortLevels;
  if (advertisement.reasoningMode === "effort") return GLOBAL_EFFORT_LEVELS;
  if (advertisement.reasoning !== undefined) return [];
  return undefined;
}

/**
 * The efforts a selection may carry, in the one precedence order both ends
 * apply: the configured shortlist entry for this exact route, then whatever
 * the `/v1/models` page said about this exact model, then the floor.
 *
 * `catalogLevels` is an already-resolved ladder — run the catalog row through
 * {@link advertisedEffortLevels} first — because the server caches the resolved
 * value rather than the row.
 *
 * The floor is the global ladder. An agent that predates per-model metadata
 * describes one ladder for everything in `efforts`, so that wins for it. An
 * agent that does carry `modelOptions` has said nothing about a model reached
 * only through the catalog, and there the agent itself is the real gate at turn
 * time — narrowing here would hide grades the server accepts.
 */
export function effortLevelsForModel(
  agent: EffortAgentContext,
  model: string | undefined,
  catalogLevels: readonly string[] | undefined,
): readonly string[] {
  const advertised = advertisedEffortLevels(
    model === undefined ? undefined : agent.modelOptions?.[model],
  );
  if (advertised !== undefined) return advertised;
  if (catalogLevels !== undefined) return catalogLevels;
  if (agent.modelOptions === undefined) return agent.efforts ?? GLOBAL_EFFORT_LEVELS;
  return GLOBAL_EFFORT_LEVELS;
}
