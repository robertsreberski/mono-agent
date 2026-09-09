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
      "logicalInputInterpretation", "inputInterpretation", "inputInterpretationSource", "timestamp",
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
