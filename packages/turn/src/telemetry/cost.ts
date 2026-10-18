// @ts-check

// pi 0.80 moved the static catalog reads off the pi-ai root (`getModel` is now
// deprecated/compat-only). `getBuiltinModel(provider, id)` from `providers/all`
// is the non-deprecated replacement with the same signature and the same
// undefined-on-miss behavior the pricing lookup below relies on.
import { calculateCost as calculatePiCost } from "@earendil-works/pi-ai";
import { getBuiltinModel as getPiModel } from "@earendil-works/pi-ai/providers/all";

function finiteOrNull(value: any): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rate(value: any, fallback: number | undefined = 0): number {
  const n = finiteOrNull(value);
  return n == null ? fallback : n;
}

export function normalizePricing(pricing: PricingInputRow | null | undefined, { source, priced, missing }?: {
  source?: string;
  priced?: boolean;
  missing?: number;
}): NormalizedPricing | null;
export function normalizePricing(pricing: PricingInputRow | null | undefined, { source, priced = true, missing = 0 }: { source?: string | undefined; priced?: boolean | undefined; missing?: number | undefined; } | undefined = {}): NormalizedPricing | null {
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
  return { input, cacheRead, cacheWrite, output, source, priced } as NormalizedPricing;
}

/**
 * @coreScanRetained
 */
export function zeroPricing(source: string): NormalizedPricing {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, source, priced: true };
}

export function unknownPricing(): NormalizedPricing {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, source: "unknown", priced: false };
}

export function parseReference(reference: string): ParsedModelReference | null;
export function parseReference(reference: string | undefined): ParsedModelReference | null {
  if (typeof reference !== "string" || reference.length === 0 || reference.trim() !== reference) return null;
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) return null;
  const provider = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) || model.trim() !== model) return null;
  return { provider, model };
}

/**
 * @coreScanRetained
 */
export function isPrivateHost(baseUrl: string): boolean {
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
 * @coreScanRetained
 */
export function pricingHasRates(pricing: PricingInputRow | undefined = {}): boolean {
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
 */
function piCatalogModel(parsed: ParsedModelReference | null | undefined): import("@earendil-works/pi-ai").Model<any> | null {
  if (!parsed?.provider || !parsed.model) return null;
  try {
    // `provider` may be caller-supplied (including custom providers), wider
    // than pi-ai's built-in provider union; guard the catalog read below.
    return getPiModel(((parsed.provider) as any), parsed.model) || null;
  } catch {
    return null;
  }
}

function piCatalogPricing(parsed: ParsedModelReference | null | undefined): NormalizedPricing | null {
  const model = piCatalogModel(parsed);
  return model?.cost ? normalizePricing(model.cost, { source: "pi-catalog" }) : null;
}

// `resolveCustomPricing(parsed) -> NormalizedPricing | null` lets a host plug
// in user-defined pricing tables. A host can query its own model/provider store
// and pass the resolver to `resolvePricing({ model, resolveCustomPricing })`.
// The pricing helpers below (`normalizePricing`, `zeroPricing`, `unknownPricing`,
// `pricingHasRates`, `isPrivateHost`, `parseReference`) are exported so hosts
// can build their own resolvers without re-implementing the row-shape conversion.
export function resolvePricing({ resolveCustomPricing, model }?: {
  resolveCustomPricing?: (parsed: ParsedModelReference) => (NormalizedPricing | null);
  model?: string;
}): NormalizedPricing;
export function resolvePricing({ resolveCustomPricing, model }: { resolveCustomPricing?: ((parsed: ParsedModelReference) => (NormalizedPricing | null)) | undefined; model?: string | undefined; } | undefined = {}): NormalizedPricing {
  const parsed = parseReference(model as string);
  if (!parsed) return unknownPricing();
  const custom = typeof resolveCustomPricing === "function"
    ? resolveCustomPricing(parsed)
    : null;
  return custom
    || piCatalogPricing(parsed)
    || unknownPricing();
}

function estimatePiCatalogCost(model: any, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; }): number {
  return calculatePiCost(model, {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
}

export function estimateCost({ resolveCustomPricing, model, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheCreationTokens, }?: {
  resolveCustomPricing?: (parsed: ParsedModelReference) => (NormalizedPricing | null);
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheCreationTokens?: number;
}): number | null;
export function estimateCost({
  resolveCustomPricing,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheCreationTokens = 0,
}: { resolveCustomPricing?: ((parsed: ParsedModelReference) => (NormalizedPricing | null)) | undefined; model?: string | undefined; inputTokens?: number | undefined; outputTokens?: number | undefined; cachedTokens?: number | undefined; cacheWriteTokens?: number | undefined; cacheCreationTokens?: number | undefined; } | undefined = {}): number | null {
  const cacheRead = Math.max(0, Number(cachedTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens ?? cacheCreationTokens) || 0);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const parsed = parseReference(model as string);
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
  const parts: Array<[number, number | null]> = [
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

export type ParsedModelReference = {
  provider: string;
  model: string;
};

export type NormalizedPricing = {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  source: string;
  priced: boolean;
};

/**
 * Duck-typed pricing row a host (or the pi catalog) supplies: either
 * camelCase or the provider's `*_per_million` snake_case spelling.
 */
export type PricingInputRow = {
  input?: number | string;
  input_per_million?: number | string;
  cacheRead?: number | string;
  cachedInput?: number | string;
  cached_input_per_million?: number | string;
  cacheWrite?: number | string;
  cache_write_per_million?: number | string;
  cache_creation_per_million?: number | string;
  output?: number | string;
  output_per_million?: number | string;
};
