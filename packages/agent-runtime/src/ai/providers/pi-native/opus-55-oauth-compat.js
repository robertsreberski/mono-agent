// @ts-check

// pi-ai 0.87.0 advertises claude-cli/2.1.251 on Anthropic OAuth requests.
// Opus 5.5 requires 2.1.280 (pi upstream fixed this in 3a624b82, not yet
// published). Keep this in the shipped runtime, not a workspace-only pnpm
// patch: consumers install pi-ai separately. Remove when the pinned pi-ai
// includes that commit; the regression test pins the old sibling identity.
const OPUS_ID = "claude-opus-5-5";
const USER_AGENT = "claude-cli/2.1.280";

/** @param {Record<string, string | null> | undefined} headers */
function hasUserAgent(headers) {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "user-agent");
}

/**
 * Pi resolves (and refreshes) auth before calling the provider stream, so this
 * boundary can distinguish OAuth from API-key requests without inspecting or
 * persisting credentials. Do not alter the upstream catalog or caller headers.
 * @param {import("@earendil-works/pi-ai").MutableModels} models
 */
export function withOpus55OAuthVersion(models) {
  const provider = models.getProvider("anthropic");
  if (!provider) return models;
  /** @param {import("@earendil-works/pi-ai").Model} model
   * @param {import("@earendil-works/pi-ai").ProviderRequestOptions | undefined} options
   */
  const scoped = (model, options) => {
    if (model.provider !== "anthropic" || model.id !== OPUS_ID ||
        !options?.apiKey?.includes("sk-ant-oat") ||
        hasUserAgent(model.headers) || hasUserAgent(options.headers)) return options;
    return { ...options, headers: { ...options.headers, "user-agent": USER_AGENT } };
  };
  models.setProvider({
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, /** @type {any} */ (scoped(model, options))),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, scoped(model, options)),
  });
  return models;
}
