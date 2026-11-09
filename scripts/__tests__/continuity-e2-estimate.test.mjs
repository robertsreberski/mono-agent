import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { estimateE2Reservations, validateE2Sizing } from "../lib/continuity-e2-estimate.mjs";
import { e2PaidRole } from "../lib/continuity-e2-roles.mjs";
import { loadE2Catalog, e2UsageUnits } from "../lib/continuity-e2-pricing.mjs";
async function fixture() {
  const f = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url)));
  const requests = f.sizing.variants.flatMap((v, checkpoint) => v.requests.map(({ ordinal: _ordinal, ...row }) => ({ checkpoint, ...row })));
  return { roles: f.roles, requests, catalog: await loadE2Catalog() };
}
it("pins the C2-shaped fictional sizing cap, by public checkpoint/role and integer units", async () => {
  const f = await fixture(), report = estimateE2Reservations(f);
  expect(report.schema).toBe("continuity-e2-cap-estimate-v1");
  expect(report.unitsPerUSD).toBe("1000000000"); expect(report.scriptedRequests).toBe(1);
  expect(report.forecastMinimumCapUnits).toBe("4105809000");
  expect(report.totals).toEqual({ requests: 4, retainedRequests: 0, maximumUnits: "11956000000", centralUnits: "185809000", noCacheUnits: "304284000" });
  expect(report.assumptions).toEqual({ centralCache: { numerator: 1, denominator: 2 }, output: "registered-forecast-not-enforced", input: "heuristic-admission-and-forecast-only", maximum: "catalog-context-output-and-conservative-cache-tier-ceilings", forecastMinimumCap: "accumulated-forecast-liability-plus-largest-ceiling-reservation", worstCaseCap: "sum-of-funded-request-ceilings", forecastCompletionGuaranteed: false, worstCaseBudgetCompletionGuaranteed: true });
  expect(report.checkpoints).toHaveLength(4);
  expect(report.checkpoints.find(row => row.role === "probe")).toMatchObject({ requests: 1, maxReservationUnits: "3920000000", maxOutputTokens: 128000, expectedOutputTokens: 256 });
});
it("counts every request while keeping scripted setup outside paid reservations", async () => {
  const f = await fixture(), paid = f.requests.filter(row => row.role !== "setup-scripted");
  const report = estimateE2Reservations({ ...f, requests: [...paid, ...paid] });
  expect(report.totals.requests).toBe(8); expect(report.forecastMinimumCapUnits).toBe("4291618000");
  expect(estimateE2Reservations({ ...f, requests: f.requests.filter(row => row.role !== "setup-scripted") }).totals).toEqual(estimateE2Reservations(f).totals);
});
it("refuses an observed context beyond its registered role envelope, before pricing", async () => {
  const f = await fixture(); f.roles[0].maxInputTokens = 1000;
  expect(() => estimateE2Reservations(f)).toThrow("E2_ESTIMATE_INVALID");
});
it("refuses unknown roles, unregistered models, duplicate roles and content-bearing fields", async () => {
  for (const mutate of [
    f => { f.roles[0].model = "fictional:unknown"; },
    f => { f.roles.push(f.roles[0]); },
    f => { f.requests[1].text = "FICTIONAL-REPORT-CANARY"; },
  ]) { const f = await fixture(); mutate(f); expect(() => estimateE2Reservations(f)).toThrow("E2_ESTIMATE_INVALID"); }
});
it("checks the two independent sizing measurements rather than trusting an input maximum", async () => {
  const f = await fixture(), size = structuredClone(f.requests[1].size); size.maximum--;
  expect(() => validateE2Sizing(size)).toThrow("E2_ESTIMATE_INVALID");
});
it("emits no input labels, paths, digests, or context text", async () => {
  const f = await fixture(), report = JSON.stringify(estimateE2Reservations(f));
  for (const value of ["/Users/example", "FICTIONAL-REPORT-CANARY", "fileSha256", f.catalog[0].fileSha256, "serializedBytes"]) expect(report).not.toContain(value);
  expect(report).toContain("registered-forecast-not-enforced");
});

it("prices cancel-forwarded as a continuation without rewriting its legacy setup role", async () => {
  const f = await fixture(), forwarded = structuredClone(f.requests.find(r => r.role === "continuation"));
  forwarded.role = "setup-scripted"; forwarded.paidRole = e2PaidRole("cancel-forwarded");
  f.requests.push(forwarded);
  const report = estimateE2Reservations(f);
  expect(forwarded.role).toBe("setup-scripted"); expect(forwarded.paidRole).toBe("continuation");
  expect(report.scriptedRequests).toBe(1); expect(report.totals.requests).toBe(5);
  expect(report.forecastMinimumCapUnits).toBe("8025809000");
  expect(report.checkpoints.find(r => r.role === "continuation").requests).toBe(2);
});
it("refuses every legacy sizing record lacking explicit paidRole, never guessing free setup", async () => {
  for (let i = 0; i < 5; i++) {
    const f = await fixture(); delete f.requests[i].paidRole;
    expect(() => estimateE2Reservations(f)).toThrow("E2_SIZING_PAID_ROLE_REQUIRED");
  }
});
it("refuses free-role substitution and unknown role/method metadata", async () => {
  const f = await fixture(); f.requests[1].paidRole = null;
  expect(() => estimateE2Reservations(f)).toThrow("E2_COST_ROLE_INVALID");
  expect(() => e2PaidRole("continuation", "alternateStream")).toThrow("E2_COST_ROLE_INVALID");
  expect(() => e2PaidRole("unregistered")).toThrow("E2_COST_ROLE_INVALID");
  expect(e2PaidRole("setup-scripted")).toBeNull(); expect(e2PaidRole("setup-scripted", "completeSimple")).toBe("summary");
});

it("separates the forecast floor from a budget that completes every registered ceiling-funded request", async () => {
  const f = await fixture(), catalog = f.catalog;
  const report = estimateE2Reservations(f);
  expect(report.forecastMinimumCapUnits).toBe("4105809000"); expect(report.worstCaseCapUnits).toBe("11956000000");
  expect(report).not.toHaveProperty("minimumCapUnits");
  let settled = 0n;
  for (const row of report.checkpoints) for (let i = 0; i < row.requests; i++) {
    const reserve = BigInt(row.maxReservationUnits), model = catalog.find(c => c.model === row.model);
    expect(settled + reserve <= BigInt(report.worstCaseCapUnits)).toBe(true);
    const cost = e2UsageUnits({ input_tokens: model.contextWindow, output_tokens: row.maxOutputTokens, input_tokens_details: { cache_write_tokens: model.contextWindow } }, "priority", model);
    expect(cost).toBe(reserve); settled += cost;
  }
  expect(settled.toString()).toBe(report.worstCaseCapUnits);
});
