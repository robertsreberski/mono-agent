import { expect, it } from "vitest";
import type { InstanceUsage } from "../subagents/types.js";
import { addInstanceUsage, isInstanceUsage } from "../subagents/usage.js";
import { subagentProgressUsage } from "../process-jobs/process-job-subagent-progress.js";

it("accepts legacy and nullable durable usage without weakening validation", () => {
  const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  expect(isInstanceUsage(usage)).toBe(true);
  expect(isInstanceUsage({ ...usage, costUsd: null, knownCostUsd: 2 })).toBe(true);
  for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0", undefined]) {
    expect(isInstanceUsage({ ...usage, costUsd })).toBe(false);
  }
  expect(isInstanceUsage({ ...usage, costUsd: 1, knownCostUsd: 2 })).toBe(false);
  expect(isInstanceUsage({ ...usage, costUsd: null, knownCostUsd: null })).toBe(false);
  expect(isInstanceUsage({ ...usage, extra: true })).toBe(false);
});

it("does not invent a known-zero observation for an unmeasured first turn", () => {
  const usage: InstanceUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  addInstanceUsage(usage, { costUsd: null }, 0);
  expect(usage).not.toHaveProperty("knownCostUsd");
  expect(usage.costUsd).toBeNull();
  addInstanceUsage(usage, { costUsd: 0 }, 1);
  expect(usage).toMatchObject({ costUsd: null, knownCostUsd: 0 });
});

it("projects this turn's unknown price and known descendants into job progress", () => {
  expect(subagentProgressUsage({ costUsd: null, knownCostUsd: 2, input: 4 }))
    .toMatchObject({ costUsd: null, knownCostUsd: 2 });
  expect(subagentProgressUsage({ costUsd: 2, knownCostUsd: 2 })).toEqual({ costUsd: 2 });
});

it.each([-1, NaN, "invalid"])("turns malformed cost %j into unknown without accepting a malformed subtotal", (costUsd) => {
  const usage: InstanceUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const source: Partial<InstanceUsage> = { costUsd: null, knownCostUsd: -1 };
  Object.defineProperty(source, "costUsd", { value: costUsd, enumerable: true });
  addInstanceUsage(usage, source, 0);
  expect(usage.costUsd).toBeNull();
  expect(usage).not.toHaveProperty("knownCostUsd");
});
it("does not charge an absent observation", () => {
  const usage: InstanceUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 3 };
  addInstanceUsage(usage, {}, 1);
  expect(usage.costUsd).toBe(3);
});
