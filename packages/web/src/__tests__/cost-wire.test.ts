import { expect, it } from "vitest";
import { browserCostWire, normalizeBrowserCosts } from "../cost-wire.js";
import { latestMessageCostUsd, messageUsageRollup } from "../message-cost.js";
import { sumThreadUsage } from "../thread-usage.js";
import type { WebMessagePart } from "../contracts.js";
import { runActivityFromParts } from "../run-activity.js";

it("never emits null money across browser HTTP, SSE and persisted snapshot envelopes", () => {
  const payload = { usage: { total: { costUsd: null, knownCostUsd: 2 }, byModel: [{ costUsd: null }] },
    message: { parts: [{ type: "telemetry", event: "usage_update", data: { type: "usage_update", cumulativeUsd: null, knownCostUsd: 2 } },
      { type: "subagent", costUsd: null, knownCostUsd: 1 }, { type: "process-job", job: { subagentProgress: { costUsd: null, knownCostUsd: 2 } } }] },
    activity: { cumulativeUsd: null }, project: { monthUsd: null, monthKnownUsd: 2 } };
  const wire = browserCostWire(payload);
  const json = JSON.stringify(wire);
  expect(json).not.toMatch(/"(?:costUsd|cost_usd|cumulativeUsd|monthUsd)":null/);
  expect(wire).toMatchObject({ usage: { total: { costUnknown: true, knownCostUsd: 2 } },
    activity: { costUnknown: true }, project: { monthCostUnknown: true, monthKnownUsd: 2 },
    message: { parts: [{ data: { costUnknown: true } }, { costUnknown: true }, { job: { subagentProgress: { costUnknown: true } } }] } });
  normalizeBrowserCosts(wire);
  expect(wire).toMatchObject({ usage: { total: { costUsd: null } }, project: { monthUsd: null } });
  expect(payload.activity.cumulativeUsd).toBeNull();
});

it("does not rewrite opaque tool arguments and results", () => {
  const opaque = { args: { costUsd: null }, arguments: { costUsd: null }, structuredContent: { costUsd: null }, result: { costUsd: null } };
  expect(browserCostWire(opaque)).toEqual(opaque);
});

it("explicit unknown replaces stale numeric aggregates and activity", () => {
  const parts: WebMessagePart[] = [
    { type: "telemetry", event: "usage_update", data: { type: "usage_update", cumulativeUsd: 9 } },
    { type: "telemetry", event: "usage_update", data: { type: "usage_update", costUnknown: true, knownCostUsd: 2 } },
  ];
  expect(latestMessageCostUsd(parts)).toBeNull();
  expect(messageUsageRollup({ parts }).main).toMatchObject({ costUsd: null, knownCostUsd: 2 });
  expect(runActivityFromParts(parts)).toMatchObject({ cumulativeUsd: null, knownCostUsd: 2 });
});

it.each([
  { parent: null, known: 2, child: 2, expected: 2 },
  { parent: null, known: 3, child: null, expected: 3 },
  { parent: null, known: 5, child: null, expected: 5 },
])("retains separately known spend without promoting a child price to total", ({ parent, known, child, expected }) => {
  const parts = [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: parent, knownCostUsd: known } },
    { type: "subagent", costUsd: child }];
  expect(sumThreadUsage([messageUsageRollup({ parts })]).total).toMatchObject({ costUsd: null, knownCostUsd: expected });
});

it("adds detached spend once while leaving its initiating run priced", () => {
  const rollup = messageUsageRollup({ parts: [
    { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 3 } },
    { type: "process-job", job: { subagentProgress: { costUnknown: true, knownCostUsd: 2 } } },
  ] });
  expect(rollup.main.costUsd).toBe(3);
  expect(sumThreadUsage([rollup]).total).toMatchObject({ costUsd: null, knownCostUsd: 5 });
});

it("does not turn malformed numeric prices into explicit unknown on JSON serialization", () => {
  expect(JSON.parse(JSON.stringify(browserCostWire({ cumulativeUsd: NaN, costUsd: Infinity, monthUsd: -1,
    knownCostUsd: NaN, knownUsd: null })))).toEqual({});
});

it("leaves historical complete and partial numeric prices untouched", () => {
  const value = { priced: { costUsd: 3 }, partial: { costUsd: 2, costPartial: true }, unobserved: {} };
  normalizeBrowserCosts(value);
  expect(value).toEqual({ priced: { costUsd: 3 }, partial: { costUsd: 2, costPartial: true }, unobserved: {} });
});

it.each(["cumulative_usd", "total_usd", "cost"])("projects the %s money alias without null", (key) => {
  expect(browserCostWire({ [key]: null })).toEqual({ costUnknown: true });
});
it.each([
  { parts: [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: 3 } }, { type: "subagent", name: "helper", calls: [], status: "complete" }] },
  { parts: [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: 3 } }, { type: "process-job", job: { kind: "internal", state: "succeeded", subagentProgress: { revision: 1, profile: "helper", toolCalls: 0, failedCalls: 0, recent: [] } } }] },
])("keeps priced totals with real omitted-zero child producer shapes", ({ parts }) => {
  expect(sumThreadUsage([messageUsageRollup({ parts })]).total.costUsd).toBe(3);
});
it("ignores never-dispatched and historical zero omissions but propagates unpriced usage", () => {
  const priced = messageUsageRollup({ parts: [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: 3 } }] });
  const failed = messageUsageRollup({ turnId: "synthetic-not-dispatched", parts: [] });
  const legacyParts = [{ type: "subagent", name: "helper", status: "complete", calls: [] }];
  const legacy = messageUsageRollup({ parts: legacyParts });
  expect(sumThreadUsage([priced, failed, legacy]).total.costUsd).toBe(3);
  const unpriced = messageUsageRollup({ parts: [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: null } }] });
  expect(sumThreadUsage([priced, unpriced]).total).toMatchObject({ costUsd: null, knownCostUsd: 3 });
});

it("retains measured-zero known spend under an explicitly unknown total", () => {
  const parts = [{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: null } }, { type: "subagent", costUsd: 0 }];
  expect(sumThreadUsage([messageUsageRollup({ parts })]).total).toMatchObject({ costUsd: null, knownCostUsd: 0 });
});
