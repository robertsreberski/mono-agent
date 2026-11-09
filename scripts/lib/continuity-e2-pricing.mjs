// Exact, offline catalog arithmetic. No authorization, credential or registry access.
import { readFile } from "node:fs/promises";
import { digest } from "./continuity-recorded-schema.mjs";
import { E2_MODEL_APIS, assertE2OutputLimit } from "./continuity-e2-routes.mjs";
import { LUNA, SOL } from "./continuity-e2-protocol.mjs";
import { E2_USD_UNITS } from "./continuity-e2-roles.mjs";
export { E2_USD_UNITS, E2_PAID_ROLES } from "./continuity-e2-roles.mjs";
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
    && catalog.api === E2_MODEL_APIS[catalog.model] && count(catalog.contextWindow) && count(catalog.maxTokens) && count(inputTokens) && inputTokens <= catalog.contextWindow, "E2_CATALOG_INVALID");
  const cost = catalog.cost, tiers = cost?.tiers ?? [];
  need(Array.isArray(tiers) && tiers.every(t => count(t.inputTokensAbove)) && new Set(tiers.map(t => t.inputTokensAbove)).size === tiers.length, "E2_CATALOG_INVALID");
  const applicable = [cost, ...tiers.filter(t => inputTokens > t.inputTokensAbove)];
  const rows = applicable.map(row => Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, e2RateUnits(row?.[key])])));
  // A registered envelope may cross a catalog tier: reserve every applicable rate conservatively.
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, rows.reduce((max, row) => row[key] > max ? row[key] : max, 0n)]));
}
export function e2RequestPrice(catalog, { inputTokens, maxOutputTokens, expectedOutputTokens = maxOutputTokens, cachedInputTokens = 0 }) {
  need(count(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= catalog?.maxTokens
    && count(cachedInputTokens) && cachedInputTokens <= inputTokens);
  need(count(expectedOutputTokens) && expectedOutputTokens <= maxOutputTokens);
  assertE2OutputLimit(catalog, maxOutputTokens);
  const rates = e2CatalogRates(catalog, inputTokens);
  const reservationUnits = BigInt(inputTokens) * rates.input + BigInt(maxOutputTokens) * rates.output;
  const estimateUnits = BigInt(inputTokens - cachedInputTokens) * rates.input + BigInt(cachedInputTokens) * rates.cacheRead + BigInt(expectedOutputTokens) * rates.output;
  const noCacheEstimateUnits = BigInt(inputTokens) * rates.input + BigInt(expectedOutputTokens) * rates.output;
  return { reservationUnits: reservationUnits.toString(), estimateUnits: estimateUnits.toString(), noCacheEstimateUnits: noCacheEstimateUnits.toString() };
}
export async function loadE2Catalog() {
  const bytes = await readFile(new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json", import.meta.url));
  const all = Object.values(JSON.parse(bytes)).flatMap(models => Object.values(models));
  return [SOL, LUNA].map(model => {
    const entry = all.find(row => row?.id === model.slice(model.indexOf(":") + 1));
    need(entry?.api === E2_MODEL_APIS[model], "E2_CATALOG_INVALID");
    return { model, api: entry.api, fileSha256: digest(bytes), contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, cost: entry.cost };
  });
}
