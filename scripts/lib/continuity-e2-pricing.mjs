// Exact, offline catalog arithmetic. No authorization, credential or registry access.
import { offlineCatalog } from "../continuity-lookup-estimate.mjs";
import { LUNA, SOL } from "./continuity-e2-protocol.mjs";
export const E2_USD_UNITS = 1000000000n;
export const E2_PAID_ROLES = Object.freeze(["summary", "continuation", "probe"]);
export const E2_CENTRAL_CACHE = Object.freeze({ numerator: 1, denominator: 2 });
const need = (ok, code = "E2_PRICING_INVALID") => { if (!ok) throw Object.assign(Error(code), { code }); };
const count = n => Number.isSafeInteger(n) && n >= 0;
export function e2RateUnits(rate) {
  need(typeof rate === "number" && Number.isFinite(rate) && rate >= 0, "E2_CATALOG_INVALID");
  const [mantissa, exponent = "0"] = String(rate).toLowerCase().split("e"), [whole, fraction = ""] = mantissa.split(".");
  const shift = Number(exponent) - fraction.length;
  let n = BigInt(whole + fraction) * E2_USD_UNITS, d = 1000000n;
  if (shift >= 0) n *= 10n ** BigInt(shift); else d *= 10n ** BigInt(-shift);
  need(n % d === 0n, "E2_CATALOG_INVALID"); return n / d;
}
export function e2CatalogRates(catalog, inputTokens) {
  need([SOL, LUNA].includes(catalog?.model) && /^[a-f0-9]{64}$/u.test(catalog.fileSha256 ?? "")
    && count(catalog.contextWindow) && count(catalog.maxTokens) && count(inputTokens) && inputTokens <= catalog.contextWindow, "E2_CATALOG_INVALID");
  const cost = catalog.cost, tiers = cost?.tiers ?? [];
  need(Array.isArray(tiers) && tiers.every(t => count(t.inputTokensAbove)) && new Set(tiers.map(t => t.inputTokensAbove)).size === tiers.length, "E2_CATALOG_INVALID");
  const applicable = [cost, ...tiers.filter(t => inputTokens > t.inputTokensAbove)];
  const rows = applicable.map(row => Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, e2RateUnits(row?.[key])])));
  // A registered envelope may cross a catalog tier: reserve every applicable rate conservatively.
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, rows.reduce((max, row) => row[key] > max ? row[key] : max, 0n)]));
}
export function e2RequestPrice(catalog, { inputTokens, maxOutputTokens, cachedInputTokens = 0 }) {
  need(count(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= catalog?.maxTokens
    && count(cachedInputTokens) && cachedInputTokens <= inputTokens);
  const rates = e2CatalogRates(catalog, inputTokens);
  const reservationUnits = BigInt(inputTokens) * rates.input + BigInt(maxOutputTokens) * rates.output;
  const estimateUnits = BigInt(inputTokens - cachedInputTokens) * rates.input + BigInt(cachedInputTokens) * rates.cacheRead + BigInt(maxOutputTokens) * rates.output;
  return { reservationUnits: reservationUnits.toString(), estimateUnits: estimateUnits.toString() };
}
export async function loadE2Catalog() { return Promise.all([SOL, LUNA].map(model => offlineCatalog(model))); }
