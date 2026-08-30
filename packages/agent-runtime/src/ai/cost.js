// @ts-check

// pi 0.80 moved the static catalog reads off the pi-ai root (`getModel` is now
// deprecated/compat-only). `getBuiltinModel(provider, id)` from `providers/all`
// is the non-deprecated replacement with the same signature and the same
// undefined-on-miss behavior the pricing lookup below relies on.
import { calculateCost as calculatePiCost } from "@earendil-works/pi-ai";
import { getBuiltinModel as getPiModel } from "@earendil-works/pi-ai/providers/all";

/**
 * @typedef {Object} ParsedModelReference
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {Object} NormalizedPricing
 * @property {number|null} input
 * @property {number|null} cacheRead
 * @property {number|null} cacheWrite
 * @property {number|null} output
 * @property {string} source
 * @property {boolean} priced
 */

/**
 * @typedef {Object} PricingInputRow
 * Duck-typed pricing row a host (or the pi catalog) supplies: either
 * camelCase or the provider's `*_per_million` snake_case spelling.
 * @property {number|string} [input]
 * @property {number|string} [input_per_million]
 * @property {number|string} [cacheRead]
 * @property {number|string} [cachedInput]
 * @property {number|string} [cached_input_per_million]
 * @property {number|string} [cacheWrite]
 * @property {number|string} [cache_write_per_million]
 * @property {number|string} [cache_creation_per_million]
 * @property {number|string} [output]
 * @property {number|string} [output_per_million]
 */

/**
 * @param {*} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
function rate(value, fallback = 0) {
  const n = finiteOrNull(value);
  return n == null ? fallback : n;
}

/**
 * @param {PricingInputRow|null|undefined} pricing
 * @param {Object} [options]
 * @param {string} [options.source]
 * @param {boolean} [options.priced]
 * @param {number} [options.missing]
 * @returns {NormalizedPricing|null}
 */
function normalizePricing(pricing, { source, priced = true, missing = 0 } = {}) {
  if (!pricing || typeof pricing !== "object") return null;
  const input = rate(pricing.input ?? pricing.input_per_million, missing);
  const cacheRead = rate(
    pricing.cacheRead
      ?? pricing.cachedInput
      ?? pricing.cached_input_per_million,
    input,
  );
  const cacheWrite = rate(
    pricing.cacheWrite
      ?? pricing.cache_write_per_million
      ?? pricing.cache_creation_per_million,
    missing,
  );
  const output = rate(pricing.output ?? pricing.output_per_million, missing);
  return { input, cacheRead, cacheWrite, output, source, priced };
}

/**
 * @param {string} source
 * @returns {NormalizedPricing}
 */
function zeroPricing(source) {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, source, priced: true };
}

/**
 * @returns {NormalizedPricing}
 */
function unknownPricing() {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, source: "unknown", priced: false };
}

/**
 * @param {string} reference
 * @returns {ParsedModelReference|null}
 */
function parseReference(reference) {
  if (typeof reference !== "string" || reference.length === 0 || reference.trim() !== reference) return null;
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) return null;
  const provider = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) || model.trim() !== model) return null;
  return { provider, model };
}

/**
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isPrivateHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost"
      || host === "host.docker.internal"
      || host === "::1"
      || host.startsWith("127.")
      || host.startsWith("10.")
      || host.startsWith("192.168.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  } catch {
    return false;
  }
}

/**
 * @param {PricingInputRow} [pricing]
 * @returns {boolean}
 */
function pricingHasRates(pricing = {}) {
  return [
    pricing.input_per_million,
    pricing.cached_input_per_million,
    pricing.cache_write_per_million,
    pricing.output_per_million,
  ].some((value) => finiteOrNull(value) != null);
}

/**
 * Live pricing from pi-ai's builtin catalog (getBuiltinModel). The parsed
 * provider is already the Pi catalog provider id; the model remains opaque and
 * may contain additional colons or slashes.
 * @param {ParsedModelReference|null|undefined} parsed
 * @returns {import("@earendil-works/pi-ai").Model<any>|null}
 */
function piCatalogModel(parsed) {
  if (!parsed?.provider || !parsed.model) return null;
  try {
    // `provider` may be a caller-supplied id (custom providers included), wider
    // than pi-ai's built-in KnownProvider catalog union; the catalog lookup
    // itself is the runtime check, guarded by the catch below.
    return getPiModel(/** @type {*} */ (parsed.provider), parsed.model) || null;
  } catch {
    return null;
  }
}

/**
 * @param {ParsedModelReference|null|undefined} parsed
 * @returns {NormalizedPricing|null}
 */
function piCatalogPricing(parsed) {
  const model = piCatalogModel(parsed);
  return model?.cost ? normalizePricing(model.cost, { source: "pi-catalog" }) : null;
}

// `resolveCustomPricing(parsed) -> NormalizedPricing | null` lets a host plug
// in user-defined pricing tables. Hosts query custom model/provider stores
// in src/core/custom-pricing.js and passes the closure in via `generateResponse`.
// The pricing helpers below (`normalizePricing`, `zeroPricing`, `unknownPricing`,
// `pricingHasRates`, `isPrivateHost`, `parseReference`) are exported so hosts
// can build their own resolvers without re-implementing the row-shape conversion.
/**
 * @param {Object} [options]
 * @param {(parsed: ParsedModelReference) => (NormalizedPricing|null)} [options.resolveCustomPricing]
 * @param {string} [options.model]
 * @returns {NormalizedPricing}
 */
export function resolvePricing({ resolveCustomPricing, model } = {}) {
  const parsed = parseReference(model);
  if (!parsed) return unknownPricing();
  const custom = typeof resolveCustomPricing === "function"
    ? resolveCustomPricing(parsed)
    : null;
  return custom
    || piCatalogPricing(parsed)
    || unknownPricing();
}

/**
 * @param {any} model
 * @param {{input: number, output: number, cacheRead: number, cacheWrite: number}} usage
 * @returns {number}
 */
function estimatePiCatalogCost(model, usage) {
  return calculatePiCost(model, {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
}

export { normalizePricing, zeroPricing, unknownPricing, pricingHasRates, isPrivateHost, parseReference };

/**
 * @param {Object} [options]
 * @param {(parsed: ParsedModelReference) => (NormalizedPricing|null)} [options.resolveCustomPricing]
 * @param {string} [options.model]
 * @param {number} [options.inputTokens]
 * @param {number} [options.outputTokens]
 * @param {number} [options.cachedTokens]
 * @param {number} [options.cacheWriteTokens]
 * @param {number} [options.cacheCreationTokens]
 * @returns {number|null}
 */
export function estimateCost({
  resolveCustomPricing,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  const cacheRead = Math.max(0, Number(cachedTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens ?? cacheCreationTokens) || 0);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const parsed = parseReference(model);
  const customPricing = parsed && typeof resolveCustomPricing === "function"
    ? resolveCustomPricing(parsed)
    : null;
  const piModel = customPricing ? null : piCatalogModel(parsed);
  if (piModel?.cost) {
    return estimatePiCatalogCost(piModel, { input, output, cacheRead, cacheWrite });
  }
  const pricing = customPricing
    || unknownPricing();
  if (!pricing?.priced) return null;
  const parts = [
    [input, pricing.input],
    [cacheRead, pricing.cacheRead],
    [cacheWrite, pricing.cacheWrite],
    [output, pricing.output],
  ];
  let total = 0;
  for (const [tokens, price] of parts) {
    if (tokens <= 0) continue;
    const priceNumber = finiteOrNull(price);
    if (priceNumber == null) return null;
    total += (tokens / 1_000_000) * priceNumber;
  }
  return total;
}
