import { describe, expect, it } from "vitest";

import {
  latestMessageCostUsd,
  messageUsageRollup,
  normalizeUsage,
  sumMessageCosts,
  type CostTelemetryPart,
} from "../message-cost.js";
import { sumThreadUsage } from "../thread-usage.js";

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
  it("drops the total lower bound once every detached job reports tokens", () => {
    const card = { type: "process-job", job: { subagentProgress: { costUsd: 0.25,
      usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 } } } } as unknown as CostTelemetryPart;
    const accounted = sumThreadUsage([messageUsageRollup({ parts: [usage(1), card] })]);
    expect(accounted.total).toMatchObject({ tokens: { input: 54, output: 11 }, costUsd: 1.25 });
    expect(accounted.total.tokensPartial).toBeUndefined();
    expect(accounted.subagents).toMatchObject({ runs: 1, runsWithTokens: 1, tokens: { input: 4 } });
    const oldCard = { type: "process-job", job: { subagentProgress: { costUsd: 0.25 } } } as unknown as CostTelemetryPart;
    expect(sumThreadUsage([messageUsageRollup({ parts: [usage(1), oldCard] })]).total.tokensPartial).toBe(true);
  });
  it("drops malformed token samples without disabling the conversation aggregate", () => {
    const bad = messageUsageRollup({ parts: [telemetry("usage_update", {
      model: "atlas/standard", cumulativeUsd: 0.25, tokens: { input: -1, output: 3.2 },
    })] });
    const good = messageUsageRollup({ parts: [telemetry("usage_update", {
      model: "atlas/standard", cumulativeUsd: 0.5, tokens: { input: 4, output: 1 },
    })] });
    expect(bad.main.tokens).toBeUndefined();
    expect(sumThreadUsage([bad, good]).total).toMatchObject({
      costUsd: 0.75, tokens: { input: 4, output: 1 }, tokensPartial: true,
    });
    const huge = { main: { tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 } }, subagents: [] };
    expect(sumThreadUsage([huge, good]).total).toMatchObject({ tokens: { input: Number.MAX_SAFE_INTEGER }, tokensPartial: true });
  });
  it("marks partial when a later malformed sample supersedes an earlier valid one", () => {
    const rolled = messageUsageRollup({ parts: [usage(0.25), telemetry("usage_update", {
      cumulativeUsd: 0.5, tokens: { input: -2, output: 1 },
    })] });
    expect(rolled.main.tokens?.input).toBe(50);
    expect(rolled.main.tokensPartial).toBe(true);
    expect(sumThreadUsage([rolled]).total).toMatchObject({ tokensPartial: true, costUsd: 0.5 });
    const unpriced = messageUsageRollup({ parts: [usage(0.25), telemetry("usage_update", { tokens: { input: -2 } })] });
    expect(unpriced.main.tokensPartial).toBe(true);
    const recovered = messageUsageRollup({ parts: [telemetry("usage_update", {
      cumulativeUsd: 0.1, tokens: { input: -2 },
    }), usage(0.5)] });
    expect(recovered.main.tokens).toMatchObject({ input: 50 });
    expect(recovered.main.tokensPartial).toBeUndefined();
  });
  it("counts reported child tokens, retains mixed gaps and keeps sync tokens out of model rows", () => {
    const sample = { input: 8, output: 2, cacheRead: 3, cacheWrite: 1 };
    const rolled = messageUsageRollup({ parts: [usage(2),
      { ...subagent(0.5), usage: sample, attribution: { executed: { model: "grove/fast" } } },
      subagent(0.25),
    ] });
    const total = sumThreadUsage([rolled]);
    expect(total.subagents).toMatchObject({ runs: 2, runsWithTokens: 1, tokens: sample, tokensPartial: true });
    expect(total.total.tokens).toMatchObject({ input: 50 });
    expect(total.byModel.find((row) => row.model === "grove/fast")?.tokens).toBeUndefined();
    const complete = sumThreadUsage([messageUsageRollup({ parts: [usage(2), { ...subagent(0.5), usage: sample }] })]);
    expect(complete.subagents).toMatchObject({ runs: 1, runsWithTokens: 1 });
    expect(complete.subagents?.tokensPartial).toBeUndefined();
  });
  it("guards the main token total against late synchronous child reports per field", () => {
    const child = { ...subagent(0.25), usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 2 } };
    const underreported = messageUsageRollup({ parts: [telemetry("usage_update", {
      cumulativeUsd: 0.5, tokens: { input: 5, output: 9, cacheRead: 1, cacheWrite: 0 },
    }), child] });
    expect(underreported.main.tokens).toEqual({ input: 12, output: 9, cacheRead: 3, cacheWrite: 2 });
    expect(underreported.main.tokensPartial).toBe(true);
    const onlyChild = messageUsageRollup({ parts: [child] });
    expect(onlyChild.main.tokens).toEqual(child.usage);
    expect(onlyChild.main.tokensPartial).toBe(true);
    expect(sumThreadUsage([onlyChild]).total).toMatchObject({ tokens: child.usage, tokensPartial: true });
    const complete = messageUsageRollup({ parts: [usage(0.5), child] });
    expect(complete.main.tokensPartial).toBeUndefined();
  });
  it("marks cost partial only for token telemetry without a cost observation", async () => {
    const { messageUsageRollup } = await import("../message-cost.js");
    expect(messageUsageRollup({ parts: [usage(undefined)] }).main.costPartial).toBe(true);
    expect(messageUsageRollup({ parts: [telemetry("context_usage", { tokens: { input: 5 } })] }).main.costPartial).toBeUndefined();
    expect(messageUsageRollup({ parts: [usage(0)] }).main.costPartial).toBeUndefined();
    expect(messageUsageRollup({ parts: [usage(2, "" )], attribution: { executed: { model: "grove/fast" } } }).main.model).toBe("grove/fast");
  });
});

describe("model token attribution", () => {
  it("does not add synchronous child tokens twice when future children report them", async () => {
    const { sumThreadUsage } = await import("../thread-usage.js");
    const tokens = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
    const result = sumThreadUsage([{ main: { model: "provider:parent", tokens: tokens(100), costUsd: 2 },
      subagents: [
        { detached: false, model: "provider:child", tokens: tokens(5), costUsd: 1 },
        { detached: true, model: "provider:child", tokens: tokens(10), costUsd: 1 },
      ] }]);
    expect(result.total.tokens?.input).toBe(110);
    expect(result.subagents?.tokens?.input).toBe(15);
    expect(result.byModel.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0)).toBe(110);
    expect(result.byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBe(3);
  });
});

describe("model-reference attribution", () => {
  it("groups Pi's usage, synchronous result and detached route under one reference", () => {
    const model = "openai-codex:gpt-5.6-sol";
    const rollup = messageUsageRollup({ parts: [
      { type: "telemetry", event: "usage_update", data: { model, cumulativeUsd: 2 } },
      { type: "subagent", attribution: { executed: { model } }, costUsd: 1 } as unknown as CostTelemetryPart,
      { type: "process-job", job: { subagentProgress: { route: { executed: { model } }, costUsd: 1 } } } as unknown as CostTelemetryPart,
    ] });
    const usage = sumThreadUsage([rollup]);
    expect(usage.byModel).toEqual([{ model, costUsd: 3 }]);
    expect(usage.total.costUsd).toBe(3);
    const failed = messageUsageRollup({
      parts: [telemetry("usage_update", { cumulativeUsd: 0.5 })],
      attribution: { attempted: { model } },
    });
    expect(sumThreadUsage([failed]).byModel).toEqual([{ model, costUsd: 0.5 }]);
  });
});
