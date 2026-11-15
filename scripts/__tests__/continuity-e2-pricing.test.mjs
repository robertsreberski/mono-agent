// Installed catalog metadata only: no Models, provider, registry or credentials are opened.
import { expect, it } from "vitest";
import { E2_USD_UNITS, E2_PAID_ROLES, E2_CENTRAL_CACHE, e2RateUnits, e2CatalogRates, e2RequestPrice, loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { SOL, LUNA } from "../lib/continuity-e2-protocol.mjs";
import { historicalPi12Catalog } from "./fixtures/pi-1.2-catalog.mjs";
const catalogs = historicalPi12Catalog();
it("pins integer units, role classification and explicit central-cache assumption", () => {
  expect(E2_USD_UNITS).toBe(1000000000n);
  expect(E2_PAID_ROLES).toEqual(["summary", "continuation", "probe"]);
  expect(E2_CENTRAL_CACHE).toEqual({ numerator: 1, denominator: 2 });
});
it("pins both installed pi-ai catalog rows and their common catalog-file digest", async () => {
  const installed = await loadE2Catalog();
  // Pi 1.5 corrects Sol's live window to 500K; historical fixture stays frozen.
  expect(installed).toEqual(catalogs.map(row => ({ ...row, fileSha256: installed[0].fileSha256,
    contextWindow: row.model === SOL ? 500000 : 272000 })));
  expect(installed[0].fileSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(installed[0].fileSha256).not.toBe(catalogs[0].fileSha256);
  expect(e2RequestPrice(installed[0], { inputTokens: 1, maxOutputTokens: 128000 }).reservationUnits).toBe("8840000000");
});
it("represents Luna cache reads exactly, rather than truncating to lookup units", () => {
  expect(e2RateUnits(0.01)).toBe(10n); expect(e2RateUnits(2)).toBe(2000n); expect(e2RateUnits(0)).toBe(0n);
  for (const rate of [-1, NaN, Infinity, "2", 0.0000001]) expect(() => e2RateUnits(rate)).toThrow("E2_CATALOG_INVALID");
});
it.each([[0, "3920000000", "205000000", "300000000"], [1, "196000000", "10500000", "15000000"]])("derives role output/input reservations and cache sensitivity for catalog %s", (index, reserve, central, noCache) => {
  expect(e2RequestPrice(catalogs[index], { inputTokens: 100000, maxOutputTokens: 128000, expectedOutputTokens: 10000, cachedInputTokens: 50000 })).toEqual({ reservationUnits: reserve, estimateUnits: central, noCacheEstimateUnits: noCache });
  expect(e2RequestPrice(catalogs[index], { inputTokens: 100000, maxOutputTokens: 128000 }).estimateUnits).toBe(noCache === "300000000" ? "1480000000" : "74000000");
  expect(e2RequestPrice(catalogs[index], { inputTokens: 1000, maxOutputTokens: 128000 }).reservationUnits).toBe(reserve);
});
it("reserves every applicable catalog tier and enforces model context/output limits", () => {
  const catalog = { ...catalogs[0], contextWindow: 500000 };
  expect(e2CatalogRates(catalog, 272000)).toMatchObject({ input: 2000n, output: 10000n });
  expect(e2CatalogRates(catalog, 272001)).toMatchObject({ input: 4000n, output: 15000n });
  expect(() => e2RequestPrice(catalogs[0], { inputTokens: 272001, maxOutputTokens: 128000 })).toThrow("E2_CATALOG_INVALID");
  expect(() => e2RequestPrice(catalogs[0], { inputTokens: 1, maxOutputTokens: 128001 })).toThrow("E2_PRICING_INVALID");
  expect(() => e2RequestPrice(catalogs[0], { inputTokens: 1, maxOutputTokens: 128000, cachedInputTokens: 2 })).toThrow("E2_PRICING_INVALID");
});

it("refuses smaller Codex output limits instead of trusting the ignored SDK maxTokens option", () => {
  for (const catalog of catalogs) {
    expect(() => e2RequestPrice(catalog, { inputTokens: 1000, maxOutputTokens: 4096 })).toThrow("E2_OUTPUT_LIMIT_UNENFORCED");
    expect(() => e2RequestPrice({ ...catalog, api: "unknown" }, { inputTokens: 1000, maxOutputTokens: 128000 })).toThrow("E2_ROUTE_CAPABILITY_UNKNOWN");
  }
});

it("funds the whole catalog input window independently of the heuristic measurement", () => {
  expect(e2RequestPrice(catalogs[0], { inputTokens: 1, maxOutputTokens: 128000 }).reservationUnits).toBe("3920000000");
  expect(e2RequestPrice(catalogs[0], { inputTokens: 272000, maxOutputTokens: 128000 }).reservationUnits).toBe("3920000000");
});

it("re-derives the envelope from catalog context/cache/tier ceilings, not a lookup dollar constant", () => {
  const changedWindow = { ...catalogs[0], contextWindow: 250000 };
  expect(e2RequestPrice(changedWindow, { inputTokens: 1000, maxOutputTokens: 128000 }).reservationUnits).toBe("3810000000");
  const doubled = { ...catalogs[0], cost: { ...catalogs[0].cost, input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } };
  expect(e2RequestPrice(doubled, { inputTokens: 1000, maxOutputTokens: 128000 }).reservationUnits).toBe("7840000000");
});
