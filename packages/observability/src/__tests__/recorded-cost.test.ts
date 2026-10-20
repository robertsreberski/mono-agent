import { expect, it } from "vitest";
import { recordedCost } from "../recorded-cost.js";

it.each([
  { summary: { usage: { cost_usd: 3 } }, expected: { total: 3 } },
  { summary: { usage: { cost_usd: 0 } }, expected: { total: 0 } },
  { summary: { usage: { cost_usd: null } }, expected: { total: null } },
  { summary: { usage: { cost_usd: null, known_cost_usd: 2 } }, expected: { total: null, known: 2 } },
  { summary: { cost: { cumulativeUsd: null, knownCostUsd: 2 }, usage: { cost_usd: 8 } }, expected: { total: null, known: 2 } },
  { summary: { cost: { cumulativeUsd: 2 }, usage: { cost_usd: 2, cost_partial: true } }, expected: { total: 2 } },
  { summary: {}, expected: { total: undefined } },
])("reads complete, unknown and legacy partial recorded costs: $summary", ({ summary, expected }) => {
  expect(recordedCost(summary)).toEqual(expected);
});

it.each([
  { name: "failed-before-provider", summary: { status: "failed", error: "Synthetic pre-provider failure", usage: {} } },
  { name: "running", summary: { status: "running", cost: {} } },
  { name: "legacy", summary: { usage: { input_tokens: 0, output_tokens: 0 } } },
])("keeps omitted $name prices unobserved", ({ summary }) => {
  expect(recordedCost(summary)).toEqual({ total: undefined });
});
