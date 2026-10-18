import { expect, expectTypeOf, it } from "vitest";
import { buildSuccessResult, emitUsageCostEvents, withSubagentUsage } from "../../execution/pi/result-builder.js";

it.each([null, 0])("retains known delegated spend when the parent's estimate is %s", (estimatedCost) => {
  const own = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const delegated = { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 2 };
  const usage = withSubagentUsage(own, delegated, estimatedCost);
  expect(usage).toEqual({ input: 10, output: 7, cacheRead: 0, cacheWrite: 0, cost: 2 });
  expect(own.cost).toBe(0);
  expect(delegated.costUsd).toBe(2);
  const events: unknown[] = [];
  emitUsageCostEvents({ onEvent: (event) => events.push(event), reference: "faux:fictional", usage, estimatedCost,
    start: Date.now(), externalAbort: false });
  expect(events).toContainEqual(expect.objectContaining({ type: "cost_accumulated", cumulativeUsd: 2 }));
  const result = buildSuccessResult({ finalText: "Fictional reply", finalThinking: "", events, usage, estimatedCost,
    start: Date.now(), turnCount: 1, runAssistantCount: 1, resolved: { provider: "faux", model: "fictional" }, options: {},
    externalAbort: false, errorMessage: null, errorDetails: null, diagnostics: {}, maxTurnsHit: false,
    providerSessionId: "fictional-session", runtimeWarnings: [], capabilitiesUsed: {}, structuredResult: undefined });
  expect(result.usage.cost_usd).toBe(2);
  expectTypeOf(result.failureKind).toEqualTypeOf<string | null>();
});

it("preserves reported, estimated and no-delegation arithmetic", () => {
  const own = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const delegated = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 2 };
  expect(withSubagentUsage({ ...own, cost: 3 }, delegated, 5).cost).toBe(5);
  expect(withSubagentUsage(own, delegated, 5).cost).toBe(7);
  expect(withSubagentUsage(own, { ...delegated, costUsd: 0 }, null).cost).toBe(0);
  // A null fallback was coerced to zero before addition; other numeric values are unchanged.
  expect(withSubagentUsage(own, delegated, Number.NaN).cost).toBeNaN();
});
