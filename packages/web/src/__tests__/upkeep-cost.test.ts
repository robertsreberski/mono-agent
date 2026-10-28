import * as messageCosts from "../message-cost.js";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type AgentStreamWireFrame } from "@mono-agent/contracts";
import { messageUsageRollup, latestMessageCostUsd, upkeepSummaryParts, upkeepTelemetryData } from "../message-cost.js";
import { sumThreadUsage } from "../thread-usage.js";
import { runActivityFromParts } from "../run-activity.js";
import { browserCostWire, normalizeBrowserCosts } from "../cost-wire.js";
import { WebService } from "../service.js";
import { applyDeltaOps } from "../store.js";
import type { WebMessagePart } from "../contracts.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const dispatch = { version: 1, usageIncluded: false, operationId: "fictional-operation", runId: "run", conversationId: "conversation", model: "fictional:extractor-b", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null } as const;
const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 4, costUsd: 0.02 } as const;
const telemetry = (accounting: unknown): WebMessagePart => ({ type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting } } });
const usage: WebMessagePart = { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 1, model: "fictional:answer-a", tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 } } };

it("keeps legacy no-upkeep totals byte-identical and excludes upkeep from aggregates", () => {
  expect(JSON.stringify(messageUsageRollup({ parts: [usage] }))).toBe(JSON.stringify({ main: { model: "fictional:answer-a", tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 }, subagents: [] }));
  expect(latestMessageCostUsd([usage, { type: "telemetry", event: "usage_update", data: { kind: "continuity_upkeep", cumulativeUsd: 900 } }])).toBeNull();
});
it("counts one operation across phases, summaries, messages and model slices", () => {
  const rolled = messageUsageRollup({ parts: [usage, telemetry(dispatch), telemetry(result), telemetry(dispatch), ...upkeepSummaryParts({ runId: "run", conversationId: "conversation", upkeepAccounting: [result] })] });
  expect(rolled.main.costUsd).toBe(1.02);
  expect(rolled.upkeep).toMatchObject({ operations: 1, costUsd: 0.02 });
  const thread = sumThreadUsage([rolled, messageUsageRollup({ parts: [usage, telemetry(result)] })]);
  expect(thread.total.costUsd).toBe(2.02);
  expect(thread.upkeep?.operations).toBe(1);
  expect(thread.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ model: "fictional:answer-a", costUsd: 2 }), expect.objectContaining({ model: "fictional:extractor-b", costUsd: 0.02 })]));
});
it("preserves null evidence through the cost wire and uses known subtotal plus partial", () => {
  const parts = JSON.parse(JSON.stringify(browserCostWire([usage, telemetry(dispatch)]))) as WebMessagePart[];
  normalizeBrowserCosts(parts);
  const cost = messageUsageRollup({ parts });
  expect(cost.main).toMatchObject({ costUsd: null, knownCostUsd: 1, costPartial: true, tokensPartial: true });
  expect(runActivityFromParts(parts)).toMatchObject({ cumulativeUsd: null, knownCostUsd: 1, upkeep: { costUsd: null, models: [dispatch.model] } });
  expect(JSON.stringify(parts)).toContain('"costUsd":null');
});
it("rejects private fields, invalid counters, getters, foreign origins and conflicting results", () => {
  for (const accounting of [{ ...result, recorderNamespace: "/home/example" }, { ...result, outputTokens: -1 }, { ...result, extra: "fictional secret" }, Object.defineProperty({ ...result }, "model", { get() { throw new Error("must not evaluate"); } })]) expect(upkeepTelemetryData({ data: { accounting } })).toMatchObject({ data: { accountingPartial: true } });
  expect(messageUsageRollup({ parts: [usage, ...upkeepSummaryParts({ runId: "other", conversationId: "conversation", upkeepAccounting: [result] })] }).main).toMatchObject({ costUsd: null, knownCostUsd: 1, costPartial: true });
  expect(messageUsageRollup({ parts: [usage, telemetry(result), telemetry({ ...result, costUsd: 4 })] }).main).toMatchObject({ costUsd: null, knownCostUsd: 1.02, costPartial: true });
});
it.each([false, true])("reconciles production live → shaped reload → cost wire → delta replay, uncertain=%s", async uncertain => {
  const root = await temporaryRoot();
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: operatorFetch() });
  try {
    const thread = service.store.createThread("agent-one");
    const turn = service.store.beginTurn({ threadId: thread.id, text: "Morgan's fictional garden.", attachmentIds: [] });
    const parts: WebMessagePart[] = [usage, telemetry(dispatch), ...(uncertain ? [] : [telemetry(result), telemetry(dispatch)]),
      { type: "telemetry", event: "runtime_telemetry", data: { kind: "context_compaction", data: { accounting: { version: 2, usageIncluded: true, requests: [{ requestId: "compact", providerInvoked: true, model: "fictional:summary-c", input: 2, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0.1 }] } } } },
      { type: "subagent", toolCallId: "child", name: "Fictional child", status: "complete", calls: [], costUsd: 0.2, attribution: { requested: {}, executed: { model: "fictional:child-d" }, disposition: "unknown", transitions: [], retries: [] } }];
    const frames = parts.slice(0, -1).map(part => ({ kind: "event", event: part.type === "telemetry" && part.event === "usage_update" ? { type: "usage_update", ...(part.data as object) } : { type: "runtime_telemetry", ...((part as { data?: unknown }).data as object) } })) as AgentStreamWireFrame[];
    frames.push({ kind: "event", event: { type: "tool_call_completed", id: "child", name: "Agent", content: "Fictional child result.", metadata: { subagentLifecycle: true, subagent: { id: "child", name: "Fictional child", costUsd: 0.2, attribution: { requested: {}, executed: { model: "fictional:child-d" }, disposition: "unknown", transitions: [], retries: [] } } } } });
    const write = service.store.applyStreamFrames(turn.turnId, frames);
    const live = service.store.getMessage(turn.assistantMessageId)!;
    const shaped = service.message(thread.id, live.id);
    expect(messageUsageRollup(service.message(thread.id, live.id, { full: true }))).toEqual(messageUsageRollup(live));
    const replay = { ...live, parts: applyDeltaOps([], write.delta!.ops) };
    const wire = JSON.parse(JSON.stringify(browserCostWire(shaped))) as typeof shaped;
    normalizeBrowserCosts(wire);
    for (const view of [shaped, wire, replay]) {
      expect(messageUsageRollup(view)).toEqual(messageUsageRollup(live));
      expect(runActivityFromParts(view.parts)).toEqual(runActivityFromParts(live.parts));
      expect(sumThreadUsage([messageUsageRollup(view)], "fixed")).toEqual(sumThreadUsage([messageUsageRollup(live)], "fixed"));
    }
    service.store.applyStreamFrames(turn.turnId, [{ kind: "event", event: { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: { ...result, recorderNamespace: "/home/example", prompt: "Fictional private instructions" } } } }]);
    const rejected = service.message(thread.id, live.id);
    expect(JSON.stringify(rejected)).not.toContain("/home/example");
    expect(JSON.stringify(rejected)).not.toContain("recorderNamespace");
    expect(JSON.stringify(rejected)).not.toContain("Fictional private instructions");
    expect(messageUsageRollup(rejected).main).toMatchObject({ costUsd: null, costPartial: true });
    const settled = service.store.completeTurn(turn.turnId, "Fictional answer.", { summary: { runId: "run", conversationId: "conversation", upkeepAccounting: uncertain ? [dispatch] : [result] } });
    expect(messageUsageRollup(settled.messages.find(m => m.id === live.id)!).main).toEqual(messageUsageRollup(rejected).main);
    const withChild = sumThreadUsage([messageUsageRollup({ parts })], "fixed");
    expect(withChild.total.costUsd).toBe(uncertain ? null : 1.02);
    expect(withChild.compaction?.costUsd).toBe(0.1);
    expect(withChild.subagents?.costUsd).toBe(0.2);
    expect(withChild.byModel.reduce((n, row) => n + (row.costUsd ?? row.knownCostUsd ?? 0), 0)).toBeCloseTo(uncertain ? 1 : 1.02);
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});

it("keeps detached child charges independent of once-only upkeep", () => {
  const parts = [usage, telemetry(result), { type: "process-job", job: { subagentProgress: { costUsd: 0.3, route: { executed: { model: "fictional:child-d" } } } } }];
  const total = sumThreadUsage([messageUsageRollup({ parts })]);
  expect(total.total.costUsd).toBe(1.32);
  expect(total.upkeep?.costUsd).toBe(0.02);
  expect(total.subagents?.costUsd).toBe(0.3);
  expect(total.byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBe(1.32);
});

it("does not claim complete inference tokens when only upkeep was observed", () => {
  const total = sumThreadUsage([messageUsageRollup({ parts: [telemetry(result)] })]);
  expect(total.total).toMatchObject({ costUsd: null, knownCostUsd: 0.02, tokensPartial: true });
});

it("smokes the real loopback operator transport through shaped console totals", async () => {
  const root = await temporaryRoot();
  const frames = [
    { kind: "event", event: { type: "usage_update", ...(usage.data as object) } },
    { kind: "event", event: { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: dispatch } } },
    { kind: "event", event: { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: result } } },
    { kind: "finish", finalText: "Fictional garden plan.", metadata: { summary: { runId: "run", conversationId: "conversation", upkeepAccounting: [result] } } },
  ];
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/x-ndjson" }); response.end(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, fixtureFetch = operatorFetch();
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: (input, init) => String(input).endsWith("/v1/turns") ? fetch(`http://127.0.0.1:${address.port}/v1/turns`, init) : fixtureFetch(input, init) });
  try {
    const thread = service.createThread("agent-one");
    const complete = new Promise<void>(resolve => service.subscribe(event => { if (event.type === "turn.changed" && service.store.getThread(thread.id)?.runState.status === "complete") resolve(); }));
    await service.startTurn(thread.id, { text: "A fictional garden request." });
    await complete;
    const served = service.thread(thread.id).messages.find(message => message.role === "assistant")!;
    expect(messageUsageRollup(served).main.costUsd).toBe(1.02);
    expect(await service.threadUsage(thread.id)).toMatchObject({ total: { costUsd: 1.02 }, upkeep: { operations: 1, costUsd: 0.02 } });
  } finally { await service.stop(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); }
});

it.each(["failed", "cancelled", "interrupted", "restart"])("keeps retained upkeep partial after %s when the last event may be lost", async status => {
  const root = await temporaryRoot();
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: operatorFetch() });
  try {
    const thread = service.store.createThread("agent-one"), turn = service.store.beginTurn({ threadId: thread.id, text: "Fictional request", attachmentIds: [] });
    service.store.applyStreamFrames(turn.turnId, [{ kind: "event", event: { type: "usage_update", ...(usage.data as object) } }, { kind: "event", event: { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: result } } }]);
    if (status === "interrupted") service.store.interruptTurn(turn.turnId);
    else if (status === "restart") service.store.interruptTurnForRestart(turn.turnId);
    else service.store.failTurn(turn.turnId, { message: "Fictional interruption", cancelled: status === "cancelled" });
    expect(messageUsageRollup(service.message(thread.id, turn.assistantMessageId)).main).toMatchObject({ costUsd: null, knownCostUsd: 1.02, costPartial: true });
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});
it("marks malformed/skewed summary evidence partial and never invokes receipt getters", () => {
  let getters = 0;
  const bad = Object.defineProperty({}, "accounting", { get() { getters++; return result; } });
  expect(upkeepTelemetryData(bad)).toMatchObject({ data: { accountingPartial: true } });
  expect(getters).toBe(0);
  for (const candidate of [{ ...result, version: 2 }, { ...result, recorderNamespace: "/home/example" }]) {
    const parts = upkeepSummaryParts({ runId: "run", conversationId: "conversation", upkeepAccounting: [candidate] });
    expect(messageUsageRollup({ parts: [usage, ...parts] }).main).toMatchObject({ costUsd: null, knownCostUsd: 1, costPartial: true });
    expect(JSON.stringify(parts)).not.toContain("/home/example");
  }
});
it("reuses running upkeep rollups on prose flushes but invalidates changed accounting", () => {
  const observe = vi.spyOn(messageCosts, "messageUsageRollup");
  try {
    const first = { ...usage }, parts = [first, telemetry(dispatch)];
    runActivityFromParts(parts);
    runActivityFromParts([...parts, { type: "text", text: "Fictional prose" }]);
    expect(observe).toHaveBeenCalledTimes(1);
    runActivityFromParts([...parts, telemetry(result)]);
    expect(observe).toHaveBeenCalledTimes(2);
  } finally { observe.mockRestore(); }
});
