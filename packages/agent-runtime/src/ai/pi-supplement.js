// @ts-check

// Catalog supplement for pi-ai models that mono-agent needs before the pinned
// `@earendil-works/pi-ai` ships them. This module is the SINGLE source of truth
// for supplemented rows: every mono-agent-side view of the pi catalog consults
// it AFTER the upstream catalog, so a supplemented model behaves exactly like a
// pi builtin everywhere (resolve, list/get facade, run dispatch, pricing,
// doctor validation) without touching pi-ai itself.
//
// REMOVAL (tracked, one commit): when pi-ai ships `deepseek-v4.1-flash`
// upstream, delete this file and revert the call sites marked `pi-supplement`
// in `ai/providers/pi-models.js`, `ai/pi-interop.js`, `ai/cost.js`,
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
// The row mirrors pi-ai 0.85.1's `OPENCODE_GO_MODELS["deepseek-v4-flash"]` with
// `id`/`name` changed and `input` widened to `["text", "image"]` (v4.1 adds
// vision; v4 is text-only). `compat` and `thinkingLevelMap` are byte-identical
// to the v4 row, which yields effort levels low/high/max through
// `reasoningLevelsForPiModel`/`getSupportedThinkingLevels` (plus `none` for
// the always-available `off` level, exactly like v4).
//
// Cost diverges from the v4 template ON PURPOSE: cost fields describe THIS
// model, not the template. pi-ai's v4 row (0.22/0.66/0.007) prices a different
// model, and pi-ai's own `deepseek-v4-flash-vision-exp` copy of those same
// numbers suggests generated rows carry prices across related models rather
// than per-model truth. The numbers here are v4.1-flash's Zen list price from
// the models.dev catalog shipped with OpenCode CLI 1.18.30 (input 0.15 /
// output 0.6 / cache_read 0.003 per 1M, cacheWrite 0 as in every Zen row),
// confirmed present via `opencode models`. Copying v4's price would knowingly
// misstate spend estimates for a cheaper model.

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
  "opencode-go": {
    "deepseek-v4.1-flash": {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      contextWindow: 1000000,
      maxTokens: 384000,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
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
        // other pi boundary reads); the row is structurally the v4-flash row.
        getModels: () => [...baseGetModels(), /** @type {*} */ (snapshot)],
      });
      registered.push(`${providerId}:${row.id}`);
    }
  }
  return registered;
}
