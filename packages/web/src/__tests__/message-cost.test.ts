import { describe, expect, it } from "vitest";

import {
  latestMessageCostUsd,
  normalizeUsage,
  sumMessageCosts,
  type CostTelemetryPart,
} from "../message-cost.js";

const telemetry = (event: string, data: unknown): CostTelemetryPart => ({ type: "telemetry", event, data });
const text = (value: string): CostTelemetryPart => ({ type: "text", text: value }) as CostTelemetryPart;
const subagent = (costUsd: number): CostTelemetryPart => ({
  type: "subagent",
  toolCallId: "call-1",
  name: "researcher",
  status: "complete",
  costUsd,
  calls: [],
}) as unknown as CostTelemetryPart;

describe("latestMessageCostUsd", () => {
  it("reads the latest aggregate cost observation in a message", () => {
    expect(latestMessageCostUsd([
      text("hello"),
      telemetry("usage_update", { type: "usage_update", cumulativeUsd: 0.5 }),
      telemetry("usage_update", { type: "usage_update", cumulativeUsd: 1.25 }),
    ])).toBe(1.25);
  });

  it("excludes context-occupancy observations from pricing", () => {
    expect(latestMessageCostUsd([
      telemetry("context_usage", {
        type: "runtime_telemetry",
        kind: "context_usage",
        data: { contextWindow: 100_000, tokens: { total: 5_000 }, cost: 99 },
      }),
    ])).toBeUndefined();
  });

  it("reads nested provider payload layers with inner precedence", () => {
    expect(normalizeUsage({
      cost: 3,
      data: { data: { cumulativeUsd: 0.75 } },
    })?.cost).toBe(0.75);
    expect(latestMessageCostUsd([
      telemetry("cost_report", { data: { total_usd: 2.5 } }),
    ])).toBe(2.5);
  });

  it("never adds subagent delegation costs on top of the aggregate", () => {
    expect(latestMessageCostUsd([
      subagent(4),
      telemetry("usage_update", { type: "usage_update", cumulativeUsd: 1 }),
    ])).toBe(1);
    expect(latestMessageCostUsd([subagent(4)])).toBeUndefined();
  });

  it("ignores unpriced and malformed telemetry", () => {
    expect(latestMessageCostUsd([])).toBeUndefined();
    expect(latestMessageCostUsd([text("x")])).toBeUndefined();
    expect(latestMessageCostUsd([
      telemetry("usage_update", { type: "usage_update", cumulativeUsd: Number.NaN }),
      telemetry("usage_update", { type: "usage_update" }),
    ])).toBeUndefined();
  });
});

describe("sumMessageCosts", () => {
  it("omits the total when nothing was priced and keeps a measured zero", () => {
    expect(sumMessageCosts([])).toBeUndefined();
    expect(sumMessageCosts([undefined, undefined])).toBeUndefined();
    expect(sumMessageCosts([undefined, 0])).toBe(0);
    expect(sumMessageCosts([1.5, undefined, 0.25])).toBeCloseTo(1.75, 10);
  });
});

describe("messageUsageRollup", () => {
  const usage = (cost: number | undefined, model = "atlas/standard") => telemetry("usage_update", {
    model, ...(cost === undefined ? {} : { cumulativeUsd: cost }),
    tokens: { input: 50, cacheRead: 20, cacheWrite: 5, output: 10 },
  });
  it("uses the latest aggregate, ignores context and compaction, and retains zero", async () => {
    const { messageUsageRollup } = await import("../message-cost.js");
    expect(messageUsageRollup({ parts: [usage(2), telemetry("context_usage", { cost: 100 }),
      telemetry("context_compaction", { cost: 100 }), usage(0)] }).main).toMatchObject({
      model: "atlas/standard", costUsd: 0,
      tokens: { input: 50, cacheRead: 20, cacheWrite: 5, output: 10 },
    });
  });
  it("treats synchronous cost as a subset and detached cost as additional", async () => {
    const { messageUsageRollup } = await import("../message-cost.js");
    const { sumThreadUsage } = await import("../thread-usage.js");
    const child = { ...subagent(4), attribution: { executed: { model: "grove/fast" } } };
    const card = { type: "process-job", job: { subagentProgress: { costUsd: 3, route: { executed: { model: "grove/fast" } } } } };
    const rolled = messageUsageRollup({ parts: [child, usage(1), card] });
    const total = sumThreadUsage([rolled]);
    expect(rolled.main.costUsd).toBe(4);
    expect(total.total.costUsd).toBe(7);
    expect(total.subagents).toMatchObject({ costUsd: 7, runs: 2, tokensPartial: true });
    expect(total.total.tokensPartial).toBe(true);
    expect(total.byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBe(7);
    expect(sumThreadUsage([messageUsageRollup({ parts: [subagent(0), usage(0)] })]).total.costUsd).toBe(0);
    expect(sumThreadUsage([messageUsageRollup({ parts: [subagent(0)] })]).total.costUsd).toBe(0);
  });
  it("marks cost partial only for token telemetry without a cost observation", async () => {
    const { messageUsageRollup } = await import("../message-cost.js");
    expect(messageUsageRollup({ parts: [usage(undefined)] }).main.costPartial).toBe(true);
    expect(messageUsageRollup({ parts: [telemetry("context_usage", { tokens: { input: 5 } })] }).main.costPartial).toBeUndefined();
    expect(messageUsageRollup({ parts: [usage(0)] }).main.costPartial).toBeUndefined();
    expect(messageUsageRollup({ parts: [usage(2, "" )], attribution: { executed: { model: "grove/fast" } } }).main.model).toBe("grove/fast");
  });
});
