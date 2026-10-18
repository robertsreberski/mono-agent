import { expect, it } from "vitest";
import { measurementCosts, assertMeasurementThreshold } from "../lib/prompt-cache-cost.mjs";

it("keeps priced arithmetic, unknown totals and separately known spend", () => {
  expect(measurementCosts([{ costUsd: 0 }, { costUsd: 2 }])).toEqual({ costUsd: 2 });
  expect(measurementCosts([{ costUsd: 3 }, { costUsd: null, knownCostUsd: 2 }])).toEqual({ costUsd: null, knownCostUsd: 5 });
  expect(measurementCosts([{ costUsd: null }])).toEqual({ costUsd: null });
});
it("stops an enabled threshold when observed spend becomes unevaluable", () => {
  expect(() => assertMeasurementThreshold({ costUsd: null, knownCostUsd: 2 }, 5)).toThrow(/unknown.*threshold cannot be evaluated/);
  expect(() => assertMeasurementThreshold({ costUsd: null }, undefined)).not.toThrow();
  expect(() => assertMeasurementThreshold({ costUsd: 3 }, 2)).toThrow(/exceeded/);
});
