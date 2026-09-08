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
      "type", "requestOrdinal", "model", "api", "payloadFamily", "supported", "systemBytes", "systemFingerprint", "toolDefinitionCount",
      "toolDefinitionsFingerprint", "messageCount", "messageFingerprints", "messageFingerprintsTruncated", "cacheMode", "cacheKeyFingerprint",
      "logicalInputInterpretation", "inputInterpretation", "inputInterpretationSource", "timestamp",
    ].sort());
    expect(line).not.toMatch(/PRIVATE-|arguments|authorization|endpoint|previous_response_id|prompt_cache_key/u);
  });
});
