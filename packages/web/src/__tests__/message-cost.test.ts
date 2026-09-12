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
