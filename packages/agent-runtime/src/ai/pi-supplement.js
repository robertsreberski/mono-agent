// @ts-check

// Catalog supplement for pi-ai models that mono-agent needs before the pinned
// `@earendil-works/pi-ai` ships them. This module is the SINGLE source of truth
// for supplemented rows: every mono-agent-side view of the pi catalog consults
// it AFTER the upstream catalog, so a supplemented model behaves exactly like a
// pi builtin everywhere (resolve, list/get facade, run dispatch, pricing,
// doctor validation) without touching pi-ai itself.
//
// REMOVAL (tracked, per row): each row leaves on its own, when pi-ai ships THAT
// id upstream — delete the row and its tests, nothing else. Upstream rows
// ALWAYS win on conflict (see below), so a row is already dead weight the
// moment its id exists upstream; removal is pure cleanup, never a behavior
// change. Each row's upstream gap is pinned by a precondition test that fails
// as soon as the pinned pi-ai starts shipping the id. When the LAST row goes,
// delete this file and revert the call sites marked `pi-supplement` in
// `ai/providers/pi-models.js`, `ai/pi-interop.js`, `ai/cost.js`,
// `ai/providers/pi-native.js`, `ai/index.js`, and
// `packages/agent-app/src/doctor.ts`.
//
// Precedence contract (upstream wins): this module is PURE — it never reads
// pi-ai itself. Every call site below checks the upstream catalog FIRST and
// only consults the supplement on a miss:
//   - `resolvePiRuntimeModel`: `getBuiltinModel(...) ?? getPiSupplementModel(...)`
//   - `listPiBuiltinModels`: appends supplement rows whose id is absent upstream
//   - `getPiBuiltinModel`: `getBuiltinModel(...) ?? getPiSupplementModel(...)`
//   - `piCatalogPricing` (cost.js): same miss-fallback ordering
//   - `registerPiSupplementModels`: skips ids the run's Models collection
//     already resolves
// A supplemented model therefore NEVER shadows a real pi builtin.
//
// ROW NOTES. Every row mirrors its closest pi-ai 0.87.0 sibling — same
// `api`/`provider`/`baseUrl`/`compat`/`inputLimits` family, so transport and
// request shaping are upstream's, not ours — with `id`/`name` changed and the
// capability/price fields set from the model's own published facts. Cost
// diverges from the template ON PURPOSE in every row: cost fields describe THIS
// model, never the template's ratios.
//
// `anthropic:claude-opus-5-5` mirrors `ANTHROPIC_MODELS["claude-opus-5"]` — the
// closest sibling by price tier and thinking family. `compat`, `promptCache`,
// and `inputLimits` are byte-identical to the opus-5 row; `thinkingLevelMap`
// additionally nulls `minimal`, which yields effort levels
// low/medium/high/xhigh/max through
// `reasoningLevelsForPiModel`/`getSupportedThinkingLevels` (and `none` is
// correctly absent because thinking is always on and cannot be disabled). The
// prices are Claude Opus 5.5's published list price (input 4 / output 20 /
// cache_read 0.2 / cache_write 5 per 1M); cacheRead 0.2 is this model's own
// rate (5% of base input), not a copy of the sibling rows' 10% ratio.
//
// Known upstream behavior the opus-5-5 row cannot express: pi-ai 0.87.0's
// `AnthropicMessagesCompat` has no flag for forced tool use (Opus 5.5 returns
// an error instead of thinking through it) or for the computer-use tool
// generation (the older `computer_20251124` tool is rejected on the Claude
// API), and nothing marks thinking blocks as tied to the producing model and
// conversation or text-between-tool-calls as arriving inside `thinking`
// blocks. Those ride along as API behavior once the row routes; they need no
// row field and must not block this backfill.
//
// `openai-codex:gpt-6-sol` and `openai-codex:gpt-6-luna` mirror the
// `openai-codex-responses` `gpt-5.6-sol` row — same api, baseUrl, `compat`
// (grammar tools, additional tools, tool search, mid-conversation system
// messages; both models document `tool_search` support) and image `resize`
// limits, and the same 128000 `maxTokens`. Each carries its own published
// prices per 1M — sol input 2 / cached 0.2 / cache write 2.5 / output 10, luna
// input 0.1 / cached 0.01 / cache write 0.125 / output 0.5 — plus the
// `contextWindow` 1050000 both models ship. The single `cost.tiers` entry is
// the published "prompts over 272K input tokens are billed at 2x input and
// cache rates and 1.5x output for the full request" rule in the shape pi-ai
// already uses for its sibling codex rows; pi's `calculateCost` applies it
// request-wide above the threshold.
//
// `thinkingLevelMap` mirrors the sibling exactly: `off` is NOT nulled, because
// both models support `reasoning.effort: none` (unlike `gpt-6-astra`, which
// nulls it), and `minimal` is deliberately kept as an alias onto the provider's
// `low` — the same choice upstream made for gpt-5.6-sol/luna — even though the
// docs' effort list has no `minimal`. That alias is intentional, not a
// transcription slip. The derived levels are therefore
// none/minimal/low/medium/high/xhigh/max.

/**
 * @typedef {import("./pi-interop.js").PiBuiltinModelSnapshot} PiSupplementSnapshot
 * Snapshot-shaped supplemented model row. Reuses the interop facade's snapshot
 * typedef so supplemented rows are structurally identical to upstream ones.
 * (Type-position import only — no runtime dependency on pi-interop.js.)
 */

/**
 * The supplemented rows, keyed by provider then id. Add nothing here without a
 * matching upstream-gap justification for THAT row — a model the pinned pi-ai
 * genuinely does not ship, pinned by its own precondition test. This is a
 * backfill list, not a place to override or reshape models pi-ai already
 * carries.
 * @type {Record<string, Record<string, PiSupplementSnapshot>>}
 */
const SUPPLEMENT_BY_PROVIDER = {
  "anthropic": {
    "claude-opus-5-5": {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: {
        supportsMidConvoEffort: true,
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      },
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
      promptCache: { short: 300, long: 3600 },
      inputLimits: {
        maxRequestBytes: 33554432,
        images: {
          maxPerRequest: 600,
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
        },
      },
    },
  },
  "openai-codex": {
    "gpt-6-sol": {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
      },
      contextWindow: 1050000,
      maxTokens: 128000,
      compat: {
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsMidConvoSystemMessages: true,
      },
      // `minimal` aliases the provider's `low` exactly as upstream's
      // gpt-5.6-sol/luna rows do; `off` stays unmapped because these models
      // support `reasoning.effort: none`.
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      inputLimits: {
        images: {
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
        },
      },
    },
    "gpt-6-luna": {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [{
          inputTokensAbove: 272000,
          input: 0.2,
          output: 0.75,
          cacheRead: 0.02,
          cacheWrite: 0.25,
        }],
      },
      contextWindow: 1050000,
      maxTokens: 128000,
      compat: {
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsMidConvoSystemMessages: true,
      },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      inputLimits: {
        images: {
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
        },
      },
    },
  },
};

/**
 * List supplemented rows for one provider (or every provider when omitted).
 * Returns fresh `structuredClone` snapshots — callers may append or reshape
 * freely; the module's source rows are never shared.
 * @param {string} [providerId]
 * @returns {PiSupplementSnapshot[]}
 */
export function listPiSupplementModels(providerId) {
  const groups = providerId === undefined
    ? Object.values(SUPPLEMENT_BY_PROVIDER)
    : [SUPPLEMENT_BY_PROVIDER[providerId] ?? {}];
  return groups.flatMap((group) =>
    Object.values(group).map((row) => /** @type {PiSupplementSnapshot} */ (structuredClone(row)))
  );
}

/**
 * Read one supplemented row by provider + id. Pure list lookup — the caller
 * MUST check the upstream pi-ai catalog first so real builtins always win
 * (see the precedence contract above).
 * @param {string} providerId
 * @param {string} modelId
 * @returns {PiSupplementSnapshot|undefined}
 */
export function getPiSupplementModel(providerId, modelId) {
  const row = SUPPLEMENT_BY_PROVIDER[providerId]?.[modelId];
  return row === undefined
    ? undefined
    : /** @type {PiSupplementSnapshot} */ (structuredClone(row));
}

/**
 * Register supplemented rows into a pi-ai `Models` collection so the
 * pi-agent-core drive path (`lane.models.getModel(provider, modelId)`) can
 * resolve them at dispatch time. A row is registered ONLY when the collection
 * does not already resolve that id (upstream wins) and the provider exists —
 * custom-provider and `piResolvedModels` test-seam collections pass through
 * untouched. Returns the registered `provider:id` refs.
 * @param {import("@earendil-works/pi-ai").MutableModels} models
 * @returns {string[]}
 */
export function registerPiSupplementModels(models) {
  const registered = [];
  for (const [providerId, group] of Object.entries(SUPPLEMENT_BY_PROVIDER)) {
    const provider = models.getProvider(providerId);
    if (provider === undefined) continue;
    const missing = Object.values(group)
      .filter((row) => models.getModel(providerId, row.id) === undefined);
    if (missing.length === 0) continue;
    // One `setProvider` per provider, carrying ALL of that provider's missing
    // rows. Registering row-by-row would re-wrap a provider snapshot captured
    // before the previous row landed, so the later call would drop the earlier
    // row's registration.
    const baseGetModels = provider.getModels.bind(provider);
    const snapshots = missing.map((row) => structuredClone(row));
    models.setProvider({
      ...provider,
      // Pi's `Model` generic pins `api`/`provider`/`compat` narrowly while the
      // facade snapshot keeps them wide (same pattern as the `*` casts at the
      // other pi boundary reads); each row is structurally its upstream
      // sibling.
      getModels: () => [...baseGetModels(), .../** @type {*} */ (snapshots)],
    });
    for (const row of missing) registered.push(`${providerId}:${row.id}`);
  }
  return registered;
}
