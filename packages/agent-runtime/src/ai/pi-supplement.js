// @ts-check

// Catalog supplement for Pi models that mono-agent needs before the pinned
// `@earendil-works/pi-ai` ships them. Every caller checks upstream first, so a
// real Pi row always wins and this file can be deleted when the last gap closes.
//
// `anthropic:claude-sonnet-5-5` mirrors Pi 0.87.1's `claude-sonnet-5` transport
// and capability shape. Anthropic publishes the same 1M context, 128K maximum
// output, text/image input and $2/$10 base pricing for Sonnet 5.5. Its 5-minute
// cache write/read prices are $2.50/$0.20 per MTok. Pi has no row for the new id
// yet, but its existing Anthropic Messages transport already supports the model's
// adaptive-thinking family. Sonnet 5.5 rejects `thinking.type: "disabled"`;
// Pi 0.87.1 cannot emit the replacement `between_tools` mode, so `off` and
// `minimal` are deliberately unavailable instead of advertising settings that
// fail at request time. Low through max continue through adaptive thinking.

/**
 * @typedef {import("./pi-interop.js").PiBuiltinModelSnapshot} PiSupplementSnapshot
 */

/** @type {Record<string, Record<string, PiSupplementSnapshot>>} */
const SUPPLEMENT_BY_PROVIDER = {
  anthropic: {
    "claude-sonnet-5-5": {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
      compat: {
        supportsMidConvoEffort: true,
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      },
      promptCache: { short: 300, long: 3600 },
      inputLimits: {
        maxRequestBytes: 33_554_432,
        images: {
          maxPerRequest: 600,
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
        },
      },
    },
  },
};

/**
 * Return fresh supplemented snapshots for one provider, or all providers when
 * omitted. Callers may mutate the snapshots without changing shared state.
 * @param {string} [providerId]
 * @returns {PiSupplementSnapshot[]}
 */
export function listPiSupplementModels(providerId) {
  const groups = providerId === undefined
    ? Object.values(SUPPLEMENT_BY_PROVIDER)
    : [SUPPLEMENT_BY_PROVIDER[providerId] ?? {}];
  return groups.flatMap((group) => Object.values(group).map((row) => structuredClone(row)));
}

/**
 * Read one supplemented row. The caller must check Pi's upstream catalog first.
 * @param {string} providerId
 * @param {string} modelId
 * @returns {PiSupplementSnapshot|undefined}
 */
export function getPiSupplementModel(providerId, modelId) {
  const row = SUPPLEMENT_BY_PROVIDER[providerId]?.[modelId];
  return row === undefined ? undefined : structuredClone(row);
}

/**
 * Register missing supplement rows in the mutable run collection used by Pi's
 * harness. Existing collection rows always win.
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
    const baseGetModels = provider.getModels.bind(provider);
    const snapshots = missing.map((row) => structuredClone(row));
    models.setProvider({
      ...provider,
      getModels: () => [...baseGetModels(), .../** @type {*} */ (snapshots)],
    });
    for (const row of missing) registered.push(`${providerId}:${row.id}`);
  }
  return registered;
}
