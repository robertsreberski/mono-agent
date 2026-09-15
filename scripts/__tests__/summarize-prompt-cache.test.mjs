import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import { installPromptCacheDiagnostics } from "../../packages/agent-runtime/src/ai/providers/pi-native/prompt-cache-diagnostics.js";
import { summarizePromptCache, formatPromptCache } from "../summarize-prompt-cache.mjs";

const artifactsDir = resolve("scripts/__tests__/fixtures/prompt-cache");
const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(resolve(".prompt-cache-test-")); temporary.push(dir); return dir; }

describe("artifact prompt cache summary", () => {
  it("weights tokens, replaces snapshots, and compares requests and conversation runs", async () => {
    const report = await summarizePromptCache({ artifactsDir });
    expect(report.requestCount).toBe(3);
    expect(report.totals).toEqual({ input: 930, cacheRead: 260, cacheWrite: 10, output: 10, cacheHitRatio: 260 / 1200 });
    expect(report.runs[0].requests[0].toolsChangedWithinRun).toBeNull();
    expect(report.runs[0].requests[1]).toMatchObject({ toolsChangedWithinRun: true, systemChangedWithinRun: false, inputInterpretation: "delta" });
    expect(report.runs[1].requests[0]).toMatchObject({ toolsChangedFromPreviousRun: false, systemChangedFromPreviousRun: true, inputInterpretation: "unavailable" });
    expect(formatPromptCache(report)).toContain("weighted hit=21.67%");
  });

  it("filters by run start while retaining the previous run baseline", async () => {
    const report = await summarizePromptCache({ artifactsDir, conversation: "chat-a", since: "2026-09-08T10:30:00Z" });
    expect(report.runs.map((run) => run.runId)).toEqual(["second"]);
    expect(report.runs[0].requests[0].systemChangedFromPreviousRun).toBe(true);
    expect((await summarizePromptCache({ artifactsDir, conversation: "other" })).runs).toEqual([]);
    await expect(summarizePromptCache({ artifactsDir, since: "yesterday" })).rejects.toThrow("ISO");
  });

  it("prints JSON and rejects unknown or incomplete CLI options", () => {
    const script = resolve("scripts/summarize-prompt-cache.mjs");
    expect(JSON.parse(execFileSync(process.execPath, [script, "--artifacts-dir", artifactsDir, "--json"], { encoding: "utf8" })).requestCount).toBe(3);
    expect(() => execFileSync(process.execPath, [script, "--since"], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync(process.execPath, [script, "--unknown"], { stdio: "pipe" })).toThrow();
  });

  it("keeps missing usage unknown, isolates conversations, and reports missing/corrupt artifacts", async () => {
    const dir = await temp();
    for (const [id, conversationId] of [["a", "one"], ["b", "two"]]) {
      await writeFile(join(dir, `${id}.summary.json`), JSON.stringify({ runId: id, conversationId, startedAt: "2026-09-08T10:00:00Z" }));
      await writeFile(join(dir, `${id}.events.jsonl`), JSON.stringify({ type: "prompt_cache_diagnostic", supported: false }));
    }
    const report = await summarizePromptCache({ artifactsDir: dir });
    expect(report.totals.cacheHitRatio).toBeNull();
    expect(report.runs[1].requests[0].toolsChangedFromPreviousRun).toBeNull();
    await writeFile(join(dir, "orphan.events.jsonl"), "");
    expect((await summarizePromptCache({ artifactsDir: dir })).warnings).toHaveLength(1);
    await writeFile(join(dir, "a.events.jsonl"), "{PRIVATE-BROKEN");
    await expect(summarizePromptCache({ artifactsDir: dir })).rejects.toThrow("Invalid JSON in a.events.jsonl:1");
  });

  it("persists enabled runtime diagnostics unchanged and with only existing metadata fields", async () => {
    const dir = await temp();
    const recorder = createJsonlRunRecorder({ artifactDir: dir, runId: "privacy", conversationId: "chat", clock: () => 0 });
    let hook;
    let emitted;
    const dispose = installPromptCacheDiagnostics({ hooks: { on: (_name, handler) => { hook = handler; return () => {}; } } }, {
      promptCacheDiagnostics: true,
      onEvent: (event) => { emitted = event; recorder.onEvent(event); },
    });
    hook({ model: { provider: "openai", id: "gpt", api: "openai-responses" }, payload: {
      instructions: "PRIVATE-PROMPT", input: [{ arguments: "PRIVATE-ARGS" }], tools: [{ name: "Read", description: "PRIVATE-TOOL" }],
      prompt_cache_key: "PRIVATE-KEY", previous_response_id: "PRIVATE-RESPONSE-ID", endpoint: "PRIVATE-ENDPOINT", authorization: "PRIVATE-AUTH",
    } });
    dispose();
    const summary = await recorder.finish({});
    const line = (await readFile(summary.artifactPaths[0], "utf8")).trim();
    expect(JSON.parse(line)).toEqual({ ...emitted, timestamp: "1970-01-01T00:00:00.000Z" });
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      "type", "phase", "requestId", "requestOrdinal", "model", "api", "payloadFamily", "supported", "systemBytes", "systemFingerprint", "toolDefinitionCount",
      "toolDefinitionsFingerprint", "messageCount", "messageFingerprints", "messageFingerprintsTruncated", "cacheMode", "cacheKeyFingerprint",
      "logicalInputInterpretation", "inputInterpretation", "inputInterpretationSource", "timestamp", "requestedCacheRetention", "observedCacheTtls",
    ].sort());
    expect(line).not.toMatch(/PRIVATE-|arguments|authorization|endpoint|previous_response_id|prompt_cache_key/u);
  });
});

describe("compaction economics", () => {
  it("separates summary spend, replaces snapshots, correlates assistant usage and reports boundaries", async () => {
    const dir = await temp();
    await writeFile(join(dir, "r.summary.json"), JSON.stringify({ runId: "r", conversationId: "c", startedAt: "2026-09-09T00:00:00Z" }));
    const diag = (id, fingerprints, inputInterpretation = "full") => ({ type: "prompt_cache_diagnostic", phase: "assistant", requestId: id, requestOrdinal: id === "a" ? 1 : 2, supported: true, inputInterpretation, messageFingerprints: fingerprints });
    const usage = (id, costUsd) => ({ type: "context_usage", phase: "assistant", requestId: id, costUsd, tokens: { input: 10, output: 1, cacheRead: 20, cacheCreation: 0 } });
    const operation = { type: "context_compaction", operationId: "op", status: "failed", trigger: "proactive", accounting: { version: 1, transcriptBefore: 1000, transcriptAfter: null, requests: [
      { requestId: "op:1", requestOrdinal: 1, input: 100, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.2, status: "succeeded" },
      { requestId: "op:2", requestOrdinal: 2, input: 50, output: 3, cacheRead: 0, cacheWrite: 0, costUsd: 0.1, status: "rejected" },
    ] } };
    await writeFile(join(dir, "r.events.jsonl"), [diag("a", ["one", "two"]), usage("a", 0.4), operation, operation, diag("b", ["one", "changed"]), usage("a", 0.4), usage("b", 0.5)].map(JSON.stringify).join("\n"));
    const report = await summarizePromptCache({ artifactsDir: dir });
    expect(report.assistantCostUsd).toBe(0.9);
    expect(report.summaryCostUsd).toBeCloseTo(0.3);
    expect(report.summaryTotals.input).toBe(150);
    expect(report.totals.input).toBe(20);
    expect(report.runs[0].compactions).toHaveLength(1);
    expect(report.runs[0].requests[1].firstChangedMessageIndex).toBe(1);
    expect(formatPromptCache(report)).toContain("compaction op: failed");
    expect(formatPromptCache(report)).toContain("not proof of a cache miss");
    await writeFile(join(dir, "r.events.jsonl"), [diag("a", ["one"]), diag("b", ["changed"], "delta")].map(JSON.stringify).join("\n"));
    const unknown = await summarizePromptCache({ artifactsDir: dir });
    expect(unknown.assistantCostUsd).toBeNull();
    expect(unknown.runs[0].requests[1].firstChangedMessageIndex).toBeNull();
    await writeFile(join(dir, "r.events.jsonl"), JSON.stringify({ type: "context_compaction", operationId: "legacy", status: "succeeded" }));
    expect((await summarizePromptCache({ artifactsDir: dir })).summaryCostUsd).toBeNull();
  });
});

const diagnostic = (id, overrides = {}) => ({
  type: "prompt_cache_diagnostic", phase: "assistant", requestId: id, requestOrdinal: 1,
  supported: true, model: "anthropic:fixture", api: "anthropic-messages", toolDefinitionsFingerprint: "tools",
  systemFingerprint: "system", inputInterpretation: "full", logicalInputInterpretation: "full",
  inputInterpretationSource: "provider_payload", messageFingerprints: ["prefix"], messageCount: 1,
  messageFingerprintsTruncated: false, requestedCacheRetention: "short", observedCacheTtls: ["5m"], ...overrides,
});
const requestUsage = (id, input = 10, cacheRead = 90, overrides = {}) => ({
  type: "context_usage", phase: "assistant", requestId: id, providerCostUsd: 0.01,
  tokens: { input, cacheRead, cacheCreation: 0, output: 2 }, ...overrides,
});
async function artifact(dir, id, minute, events, overrides = {}) {
  await writeFile(join(dir, `${id}.summary.json`), JSON.stringify({
    runId: id, conversationId: "chat", providerSessionId: "session", startedAt: new Date(Date.UTC(2026, 8, 9, 0, minute)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 8, 9, 0, minute, 30)).toISOString(), ...overrides,
  }));
  await writeFile(join(dir, `${id}.events.jsonl`), events.map(JSON.stringify).join("\n"));
}

describe("consecutiveFirstRequests", () => {
  it("compares only first current vs last immediately preceding request and retains since baselines", async () => {
    const dir = await temp();
    await artifact(dir, "a", 0, [diagnostic("a1", { toolDefinitionsFingerprint: "old" }), diagnostic("a2"), requestUsage("a2")]);
    await artifact(dir, "b", 10, [diagnostic("b1"), requestUsage("b1"), diagnostic("b2", { toolDefinitionsFingerprint: "new" }), requestUsage("b2")]);
    const report = await summarizePromptCache({ artifactsDir: dir, since: "2026-09-09T00:05:00Z" });
    const analysis = report.consecutiveFirstRequests;
    expect(analysis.pairs).toHaveLength(1);
    expect(analysis.pairs[0]).toMatchObject({ previousRunId: "a", previousLastRequestId: "a2", firstRequestId: "b1", comparable: true, tools: "stable", idleGapMs: 570000, idleGap: "5–60m" });
    expect(analysis.cohorts[0].pairCount).toBe(1);
    expect(report.requestCount).toBe(2); // legacy every-request output retained
  });

  it("does not cross model/API or provider-session boundaries or skip an intervening reset", async () => {
    const dir = await temp();
    await artifact(dir, "a", 0, [diagnostic("a")]);
    await artifact(dir, "b", 1, [diagnostic("b", { model: "anthropic:other" })]);
    await artifact(dir, "c", 2, [diagnostic("c")]);
    await artifact(dir, "d", 3, [diagnostic("d", { api: "openai-responses" })]);
    await artifact(dir, "e", 4, [diagnostic("e", { api: "openai-responses" })], { providerSessionId: "new-session" });
    await artifact(dir, "f", 5, [diagnostic("f", { api: "openai-responses" })], { providerSessionId: null });
    const analysis = (await summarizePromptCache({ artifactsDir: dir })).consecutiveFirstRequests;
    expect(analysis.excluded).toMatchObject({ missing_baseline: 1, model_api_changed: 3, provider_session_changed: 1, missing_provider_session: 1 });
    expect(analysis.cohorts).toEqual([]);
    expect(analysis.pairs[2].previousRunId).toBe("b");
    expect(analysis.pairs.every((pair) => pair.cacheHitRatio === null)).toBe(true);
  });

  it.each([[0, "<5m"], [299999, "<5m"], [300000, "5–60m"], [3599999, "5–60m"], [3600000, ">=60m"], [-1, "overlap"], [null, "unknown"]])("buckets idle gap %s as %s and never treats overlap as a miss", async (gap, bucket) => {
    const dir = await temp();
    const start = Date.UTC(2026, 8, 9, 0, 10);
    await artifact(dir, "a", 0, [diagnostic("a")], { endedAt: gap === null ? undefined : new Date(start - gap).toISOString() });
    await artifact(dir, "b", 10, [diagnostic("b"), requestUsage("b")]);
    const pair = (await summarizePromptCache({ artifactsDir: dir })).consecutiveFirstRequests.pairs[1];
    expect(pair.idleGap).toBe(bucket); expect(pair.idleGapMs).toBe(gap);
    expect(pair.comparable).toBe(bucket !== "overlap");
    if (bucket === "overlap") expect(pair.cacheHitRatio).toBeNull();
  });

  it("uses token-weighted complete-usage coverage, latest request snapshots, and independent cumulative run costs", async () => {
    const dir = await temp();
    await artifact(dir, "a", 0, [diagnostic("a")]);
    await artifact(dir, "b", 2, [diagnostic("b"), requestUsage("b", 999, 1), requestUsage("b", 10, 90), { type: "cost_accumulated", cumulativeUsd: 2 }, { type: "cost_accumulated", cumulativeUsd: 3 }]);
    await artifact(dir, "c", 4, [requestUsage("c", 810, 90, { providerCostUsd: 0.04 }), diagnostic("c"), { type: "cost_accumulated", cumulativeUsd: 4 }]);
    await artifact(dir, "d", 6, [diagnostic("d"), requestUsage("d", 20, 0, { providerCostUsd: null, tokens: { input: 20, output: 1 } })]);
    const analysis = (await summarizePromptCache({ artifactsDir: dir })).consecutiveFirstRequests;
    expect(analysis.cohorts).toHaveLength(1);
    const cohort = analysis.cohorts[0];
    expect(cohort).toMatchObject({ pairCount: 3, cacheHitRatio: 180 / 1000, cacheHitRatioAvailableCount: 2,
      tokens: { input: 840, cacheRead: 180, cacheWrite: 0 }, tokenCoverage: { input: 3, cacheRead: 2, cacheWrite: 2 },
      firstRequestCostUsd: 0.05, firstRequestCostAvailableCount: 2, runCostUsd: 7, runCostAvailableCount: 2 });
    expect(analysis.pairs[3].firstRequestCostUsd).toBeNull();
    expect(formatPromptCache({ ...(await summarizePromptCache({ artifactsDir: dir })) })).toContain("Consecutive first requests:");
  });

  it("preserves missing diagnostics, unknown tools, truncation and delta uncertainty without treating absent observations as zero", async () => {
    const dir = await temp();
    await artifact(dir, "a", 0, [diagnostic("a", { messageCount: 200, messageFingerprintsTruncated: true })]);
    await artifact(dir, "b", 1, [diagnostic("b", { toolDefinitionsFingerprint: null, inputInterpretation: "delta", messageFingerprints: ["changed"] })]);
    await artifact(dir, "c", 2, [requestUsage("missing-diagnostic")]);
    await artifact(dir, "d", 3, []);
    const analysis = (await summarizePromptCache({ artifactsDir: dir })).consecutiveFirstRequests;
    expect(analysis.pairs[1]).toMatchObject({ comparable: true, tools: "unknown", firstChangedMessageIndex: null, messageEvidence: { previous: { truncated: true, messageCount: 200 }, current: { inputInterpretation: "delta" } } });
    expect(analysis.cohorts[0]).toMatchObject({ tokens: { input: null, cacheRead: null }, cacheHitRatio: null, cacheHitRatioAvailableCount: 0, firstRequestCostUsd: null });
    expect(analysis.pairs[2]).toMatchObject({ firstRequestId: "missing-diagnostic", comparable: false, tokens: { input: 10 }, exclusionReasons: ["missing_model_api"] });
    expect(analysis.excluded.missing_first_request).toBe(1);
  });

  it("separates stable/changed tools, retention treatments and conversations", async () => {
    const dir = await temp();
    await artifact(dir, "a", 0, [diagnostic("a")]);
    await artifact(dir, "b", 1, [diagnostic("b", { requestedCacheRetention: "long", observedCacheTtls: ["1h"] }), requestUsage("b")]);
    await artifact(dir, "c", 2, [diagnostic("c", { toolDefinitionsFingerprint: "changed" }), requestUsage("c")]);
    await artifact(dir, "other", 3, [diagnostic("other"), requestUsage("other")], { conversationId: "other" });
    const analysis = (await summarizePromptCache({ artifactsDir: dir })).consecutiveFirstRequests;
    expect(analysis.cohorts.map(({ tools, retention }) => [tools, retention])).toEqual([
      ["changed", "requested=short;observed=5m"], ["stable", "requested=long;observed=1h"],
    ]);
    expect(analysis.pairs.at(-1).previousRunId).toBeNull();
  });
});
