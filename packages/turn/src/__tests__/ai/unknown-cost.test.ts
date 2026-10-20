import { expect, it } from "vitest";
import { createMetricsObserver } from "../../telemetry/observer.js";
import { createCompactionUsage, withCompactionUsage, compactionCostEvent } from "../../telemetry/compaction-usage.js";
import { withSubagentUsage } from "../../execution/pi/result-builder.js";
import { createAgentTool, subagentUsageForRun } from "../../tools/delegation/agent-tool.js";

it("replaces cumulative snapshots without coercing unknown or adding deltas", () => {
  const observer = createMetricsObserver();
  expect(observer.snapshot().cost.cumulativeUsd).toBe(0);
  observer.recordEvent({ type: "cost_accumulated", cumulativeUsd: 3 });
  observer.recordEvent({ type: "cost_accumulated", cumulativeUsd: null, knownCostUsd: 2 });
  expect(observer.snapshot().cost).toEqual({ cumulativeUsd: null, knownCostUsd: 2 });
  observer.recordEvent({ type: "cost_accumulated", tokens: { input: 4 } });
  expect(observer.snapshot().cost.cumulativeUsd).toBeNull();
  observer.recordEvent({ type: "cost_accumulated", cumulativeUsd: 5 });
  expect(observer.snapshot().cost).toEqual({ cumulativeUsd: 5 });
});

it.each([
  { own: null, known: 3, summary: 2, expected: 5 },
  { own: 3, known: undefined, summary: null, expected: 3 },
])("keeps unknown main or summary cost unknown, including repeated folds", ({ own, known, summary, expected }) => {
  const collector = createCompactionUsage();
  collector.add([{ requestId: "synthetic:summary", costUsd: summary, input: 5 }]);
  const result = withCompactionUsage({ usage: { cost_usd: own, ...(known === undefined ? {} : { known_cost_usd: known }) } }, collector);
  expect(result.usage).toMatchObject({ cost_usd: null, known_cost_usd: expected });
  expect(withCompactionUsage(result, collector).usage.known_cost_usd).toBe(expected);
  expect(compactionCostEvent(result)).toMatchObject({ cumulativeUsd: null, knownCostUsd: expected });
});

it("does not lose an unknown child's known descendants in the run budget", async () => {
  const options: Parameters<typeof createAgentTool>[0] = { definitions: [{ name: "helper", description: "Synthetic helper", systemPrompt: "Synthetic work" }],
    run: async ({ onEvent }) => { onEvent?.({ type: "cost_accumulated", cumulativeUsd: null, knownCostUsd: 2 });
      return { text: "Synthetic reply", usage: { cost_usd: null, known_cost_usd: 2 }, events: [] }; } };
  const tool = createAgentTool(options, { parentRunId: "synthetic-parent" });
  if (tool === null) throw new Error("Expected synthetic Agent tool");
  await tool.execute("synthetic-child", { name: "helper", prompt: "Synthetic task" });
  expect(subagentUsageForRun(options, "synthetic-parent")).toMatchObject({ costUsd: null, knownCostUsd: 2 });
});

it.each(["session_busy", "session_not_found"])("does not charge a never-dispatched %s child", async (failureKind) => {
  const options: Parameters<typeof createAgentTool>[0] = { definitions: [{ name: "helper", description: "Synthetic helper", systemPrompt: "Synthetic work" }],
    run: async () => ({ text: "", usage: {}, numTurns: 0, failureKind, events: [] }) };
  const tool = createAgentTool(options, { parentRunId: "synthetic-refused" });
  if (tool === null) throw new Error("Expected Agent tool");
  await tool.execute("synthetic-refused-child", { name: "helper", prompt: "Synthetic task" });
  expect(subagentUsageForRun(options, "synthetic-refused")).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

it.each([
  { first: 1, wrap: 2, total: 2, known: undefined },
  { first: 1, wrap: null, total: null, known: 1 },
  { first: null, wrap: 2, total: null, known: 2 },
])("retains event-sourced wrap-up budgets %j", async ({ first, wrap, total, known }) => {
  let calls = 0;
  const options: Parameters<typeof createAgentTool>[0] = { definitions: [{ name: "helper", description: "Synthetic helper", systemPrompt: "Synthetic work" }],
    run: async ({ onEvent }) => {
      calls += 1;
      const cost = calls === 1 ? first : wrap;
      onEvent?.({ type: "cost_accumulated", cumulativeUsd: cost, tokens: { input: calls, output: 0 } });
      return calls === 1 ? { text: "", diagnostics: { max_turns_hit: true }, numTurns: 1, usage: { cost_usd: cost }, events: [] }
        : { text: "Synthetic wrap-up", usage: { cost_usd: cost }, events: [] };
    } };
  const tool = createAgentTool(options, { parentRunId: "synthetic-wrap" });
  if (tool === null) throw new Error("Expected Agent tool");
  await tool.execute("synthetic-wrap-child", { name: "helper", prompt: "Synthetic task", maxTurns: 1 });
  expect(calls).toBe(2);
  const usage = subagentUsageForRun(options, "synthetic-wrap");
  expect(usage.costUsd).toBe(total);
  expect(usage.input).toBe(2);
  expect(usage.knownCostUsd).toBe(known);
});

it("preserves an observed child zero without inventing a zero for no observations", async () => {
  const options: Parameters<typeof createAgentTool>[0] = { definitions: [{ name: "helper", description: "Synthetic helper", systemPrompt: "Synthetic work" }],
    run: async ({ onEvent }) => { onEvent?.({ type: "cost_accumulated", cumulativeUsd: 0 }); return { text: "Synthetic reply", events: [] }; } };
  const tool = createAgentTool(options, { parentRunId: "synthetic-zero" });
  if (tool === null) throw new Error("Expected Agent tool");
  await tool.execute("synthetic-zero-child", { name: "helper", prompt: "Synthetic task" });
  const own = { cost: null, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(withSubagentUsage(own, subagentUsageForRun(options, "synthetic-zero"), null)).toMatchObject({ cost: null, knownCostUsd: 0 });
  expect(withSubagentUsage(own, subagentUsageForRun(options, "synthetic-empty"), null)).not.toHaveProperty("knownCostUsd");
});
