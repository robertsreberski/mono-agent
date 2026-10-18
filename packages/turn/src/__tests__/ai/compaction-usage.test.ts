import { expect, it } from "vitest";
import { createCompactionUsage, withCompactionUsage, compactionCostEvent, manualCompactionAccounting } from "../../telemetry/compaction-usage.js";
const request = (requestId: string, costUsd: number | null, status = "rejected") => ({ requestId, model: "faux:summary", status,
  input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd });
it("dedupes lifecycle snapshots and bills rejected and failed summaries exactly once", () => {
  const usage = createCompactionUsage();
  const event = { type: "context_compaction", accounting: { requests: [request("summary:1", 1.25)] } };
  usage.observe(event); usage.observe(event);
  usage.add([request("summary:2", 0.25, "failed")]);
  const result = withCompactionUsage({ usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.5 } }, usage);
  expect(result.usage).toMatchObject({ input_tokens: 210, output_tokens: 42, cost_usd: 2, compaction: { cost_usd: 1.5 } });
  expect(result.usage.compaction.requests).toHaveLength(2);
  expect(withCompactionUsage(result, usage).usage.cost_usd).toBe(2);
  expect(compactionCostEvent(result)).toMatchObject({ cumulativeUsd: 2, contextTokens: 12, tokens: { input: 210, output: 42 } });
});
it("keeps missing costs unknown, a measured zero zero and mixed prices partial", () => {
  const unknown = createCompactionUsage();
  unknown.add([request("unknown:1", null)]);
  expect(withCompactionUsage({ usage: {} }, unknown).usage).toMatchObject({ cost_usd: null, cost_partial: true, compaction: { cost_usd: null } });
  expect(compactionCostEvent(withCompactionUsage({ usage: {} }, unknown))).toMatchObject({ cumulativeUsd: null });
  unknown.add([request("zero:1", 0)]);
  expect(unknown.slice()).toMatchObject({ cost_usd: null, known_cost_usd: 0, cost_partial: true });
  const measured = createCompactionUsage(); measured.add([request("zero:2", 0, "succeeded")]);
  expect(measured.slice()).toMatchObject({ cost_usd: 0 });
  expect(measured.slice()).not.toHaveProperty("cost_partial");
});

it("preserves non-dispatch evidence in accounting and bounded manual receipts", () => {
  const collector = createCompactionUsage();
  collector.add([{ ...request("local:1", 0), providerInvoked: false, input: 0, output: 0 }]);
  expect(collector.slice()!.requests![0]!.providerInvoked).toBe(false);
  expect(manualCompactionAccounting(collector.slice())!.requests![0]!.providerInvoked).toBe(false);
});

it("excludes never-dispatched summaries from costs and known subtotals", () => {
  const collector = createCompactionUsage();
  collector.add([{ ...request("synthetic:not-dispatched", null, "failed"), providerInvoked: false }]);
  expect(collector.slice()).toMatchObject({ cost_usd: 0 });
  expect(collector.slice()).not.toHaveProperty("known_cost_usd");
  expect(withCompactionUsage({ usage: { cost_usd: 3 } }, collector).usage.cost_usd).toBe(3);
  expect(withCompactionUsage({ usage: { cost_usd: null, input_tokens: 10 } }, collector).usage).not.toHaveProperty("known_cost_usd");
  collector.add([{ ...request("synthetic:not-dispatched", 99, "failed"), providerInvoked: false },
    { ...request("synthetic:priced", 2), providerInvoked: true }]);
  expect(collector.slice()).toMatchObject({ cost_usd: 2 });
  collector.add([{ ...request("synthetic:unpriced", null), providerInvoked: true }]);
  expect(collector.slice()).toMatchObject({ cost_usd: null, known_cost_usd: 2 });
});
