// @ts-check

// Catalog supplement for pi-ai models that mono-agent needs before the pinned
// `@earendil-works/pi-ai` ships them. This module is the SINGLE source of truth
// for supplemented rows: every mono-agent-side view of the pi catalog consults
// it AFTER the upstream catalog, so a supplemented model behaves exactly like a
// pi builtin everywhere (resolve, list/get facade, run dispatch, pricing,
// doctor validation) without touching pi-ai itself.
//
// REMOVAL (tracked, one commit): when pi-ai ships `claude-opus-5-5` upstream,
// delete this file and revert the call sites marked `pi-supplement` in
// `ai/providers/pi-models.js`, `ai/pi-interop.js`, `ai/cost.js`,
// `ai/providers/pi-native.js`, `ai/index.js`, and
// `packages/agent-app/src/doctor.ts`. Upstream rows ALWAYS win on conflict (see
// below), so the supplement is already dead weight the moment the id exists
// upstream — removal is pure cleanup, never a behavior change.
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
// The row mirrors pi-ai 0.87.0's `ANTHROPIC_MODELS["claude-opus-5"]` — the
// closest sibling by price tier and thinking family — with `id`/`name` changed
// and `cost` replaced by this model's own published rates (see below).
// `compat`, `promptCache`, and `inputLimits` are byte-identical to the opus-5
// row; `thinkingLevelMap` additionally nulls `minimal`, which yields effort
// levels low/medium/high/xhigh/max through
// `reasoningLevelsForPiModel`/`getSupportedThinkingLevels` (and `none` is
// correctly absent because thinking is always on and cannot be disabled).
//
// Cost diverges from the opus-5 template ON PURPOSE: cost fields describe THIS
// model, not the template. The numbers here are Claude Opus 5.5's published
// list price (input 4 / output 20 / cache_read 0.2 / cache_write 5 per 1M).
// Note cacheRead 0.2 is this model's own rate (5% of base input), not a copy of
// the sibling rows' 10% ratio — per-model prices, not template ratios.
//
// Known upstream behavior the row cannot express: pi-ai 0.87.0's
// `AnthropicMessagesCompat` has no flag for forced tool use (Opus 5.5 returns
// an error instead of thinking through it) or for the computer-use tool
// generation (the older `computer_20251124` tool is rejected on the Claude
// API), and nothing marks thinking blocks as tied to the producing model and
// conversation or text-between-tool-calls as arriving inside `thinking`
// blocks. Those ride along as API behavior once the row routes; they need no
// row field and must not block this backfill.

/**
 * @typedef {import("./pi-interop.js").PiBuiltinModelSnapshot} PiSupplementSnapshot
 * Snapshot-shaped supplemented model row. Reuses the interop facade's snapshot
 * typedef so supplemented rows are structurally identical to upstream ones.
 * (Type-position import only — no runtime dependency on pi-interop.js.)
 */

/**
 * The supplemented rows, keyed by provider then id. Exactly one model per the
 * task scope; add nothing here without a matching upstream-gap justification.
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
    for (const row of Object.values(group)) {
      if (models.getModel(providerId, row.id) !== undefined) continue;
      const baseGetModels = provider.getModels.bind(provider);
      const snapshot = structuredClone(row);
      models.setProvider({
        ...provider,
        // Pi's `Model` generic pins `api`/`provider`/`compat` narrowly while the
        // facade snapshot keeps them wide (same pattern as the `*` casts at the
        // other pi boundary reads); the row is structurally the opus-5 row.
        getModels: () => [...baseGetModels(), /** @type {*} */ (snapshot)],
      });
      registered.push(`${providerId}:${row.id}`);
    }
  }
  return registered;
}
