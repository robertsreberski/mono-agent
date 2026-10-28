import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMonoRuntime } from "@mono-agent/turn/host";
import type { MonoRuntimeLike, RuntimeResult } from "@mono-agent/turn/host/types";
import type { AgentUpkeepAccounting } from "@mono-agent/contracts";
import { createConversationHarness } from "../index.js";
import { streamEventFromRuntimeEvent } from "../responder.js";
import { externalResponseSummary, forwardedUpkeepAccounting } from "../harness/external-summary.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model = { provider: "fictional", model: "answer", reference: "fictional:answer" };
const other = { provider: "fictional", model: "backup", reference: "fictional:backup" };
const result: RuntimeResult = { text: "Fictional answer.", numTurns: 1, durationMs: 1, model: model.reference, usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 }, cost: { cumulativeUsd: 0.1 } };
function accounting(namespace = "/home/example"): AgentUpkeepAccounting { return { version: 1, usageIncluded: false, operationId: "op", databaseId: "db", incarnation: "inc", runId: "origin", conversationId: "fictional", logicalConversationId: "fictional", recorderNamespace: namespace, model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }; }
it.each(["throw", "failed", "cancelled", "failover", "retry"])("retains host accounting through %s without relying on an attempt result", async mode => {
  const root = await mkdtemp(join(tmpdir(), "harness-upkeep-accounting-")); roots.push(root);
  const identityPath = join(root, "IDENTITY.md"); await writeFile(identityPath, "Fictional test agent.");
  const controller = new AbortController(); let calls = 0;
  const dispatch = accounting(root);
  const paid: AgentUpkeepAccounting = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 4, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: 0.2 };
  const attempt: MonoRuntimeLike = { configureTools() {}, run: async (_system, options) => {
    calls++;
    if (calls === 1) {
      options.onEvent?.({ type: "continuity_upkeep_dispatch", accounting: dispatch });
      if (mode === "throw") throw new Error("fictional failure after dispatch");
      options.onEvent?.({ type: "continuity_upkeep", accounting: paid });
      options.onEvent?.({ type: "continuity_upkeep", accounting: paid });
      if (mode === "cancelled") { controller.abort("fictional cancellation"); return { ...result, cancelled: true }; }
      return { ...result, text: null, error: "503 Service Unavailable", failureKind: "provider_unavailable", retryable: true };
    }
    // Actual router failover/retry returns no upkeep receipts at all.
    return { ...result, model: options.model.reference };
  } };
  const runtime = ["failover", "retry"].includes(mode) ? createMonoRuntime({ workspace: root,
    fallbackChain: mode === "retry" ? [{ model, attempts: 2 }] : [{ model }, { model: other }],
    retry: { backoffMs: 0, maxBackoffMs: 0 }, resolveAttempt: () => ({ runtime: attempt }) }) : attempt;
  const harness = createConversationHarness({ identityPath, cwd: root, runtime, model, createRunId: () => "origin" });
  try {
    const response = await harness.run({ conversationId: "fictional", userMessage: "Current input.", abortSignal: controller.signal });
    const summary = response.metadata.summary!;
    if (["failover", "retry"].includes(mode)) expect(calls, JSON.stringify(response.failure)).toBe(2);
    expect(summary.upkeepAccounting).toEqual([forwardedUpkeepAccounting(mode === "throw" ? dispatch : paid)]);
    expect(summary.inclusiveCost?.knownCostUsd).toBeCloseTo(mode === "throw" ? 0 : mode === "cancelled" ? 0.2 : 0.3);
    if (mode === "throw") expect(summary.inclusiveCost?.totalUsd).toBeNull();
    if (["failover", "retry"].includes(mode)) { expect(calls).toBe(2); expect(response.failure).toBeUndefined(); expect(summary.inclusiveCost?.totalUsd).toBeCloseTo(0.3); }
    else { expect(calls).toBe(1); expect(response.failure).toBeDefined(); }
  } finally { await harness.dispose?.(); await runtime.disposeAllSessions?.(); }
});

it("allowlists only validated, content-free upkeep telemetry and summary fields", () => {
  const a = accounting();
  const event = streamEventFromRuntimeEvent({ type: "continuity_upkeep_dispatch", accounting: a, prompt: "Fictional private text", text: "Fictional body" });
  expect(event).toEqual({ type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: forwardedUpkeepAccounting(a) } });
  expect(streamEventFromRuntimeEvent({ type: "continuity_upkeep", accounting: { ...a, prompt: "Fictional private text" } })).toBeUndefined();
  const summary = { runId: "origin", conversationId: "fictional", status: "failed" as const, durationMs: 1, eventCount: 1, artifactPaths: [], upkeepAccounting: [a], inclusiveCost: { totalUsd: null, knownCostUsd: 0, partial: true }, systemPrompt: "Fictional private instructions" };
  expect(externalResponseSummary(summary)).toMatchObject({ upkeepAccounting: [forwardedUpkeepAccounting(a)], inclusiveCost: summary.inclusiveCost });
  expect(externalResponseSummary(summary)).not.toHaveProperty("systemPrompt");
  const foreign = externalResponseSummary({ ...summary, upkeepAccounting: [{ ...a, runId: "other" }] });
  expect(foreign?.upkeepAccounting).toBeUndefined();
  expect(foreign?.upkeepAccountingPartial).toBe(true);
  const accessor = Object.defineProperty({ ...summary }, "upkeepAccounting", { get() { throw new Error("must not invoke"); } });
  expect(externalResponseSummary(accessor)?.upkeepAccountingPartial).toBe(true);
  expect(externalResponseSummary({ ...summary, inclusiveCost: { ...summary.inclusiveCost, prompt: "Fictional body" } } as typeof summary)?.inclusiveCost).toBeUndefined();
});

it("omits local paths and storage identifiers from both forwarded phases, retaining dedup keys", () => {
  const dispatch = accounting("/home/example/private-artifacts");
  const result: AgentUpkeepAccounting = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 };
  for (const a of [dispatch, result]) {
    const event = streamEventFromRuntimeEvent({ type: "continuity_upkeep", accounting: a });
    const summary = externalResponseSummary({ runId: "origin", conversationId: "fictional", status: "succeeded", durationMs: 1, eventCount: 1, artifactPaths: [], upkeepAccounting: [a] });
    for (const value of [event, summary]) {
      const wire = JSON.stringify(value);
      for (const key of ["recorderNamespace", "databaseId", "incarnation", "logicalConversationId", dispatch.recorderNamespace]) expect(wire).not.toContain(key);
      expect(wire).toContain('"operationId":"op"'); expect(wire).toContain(`"phase":"${a.phase}"`);
    }
  }
});
