import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createJsonlRunRecorder } from "../index.js";
import { redactJsonValue } from "../recorder.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "observability-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("JsonlRunRecorder", () => {
  it("persists the user prompt into the summary so backfill can show it as input", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "run:1",
      conversationId: "webhook:1",
      artifactDir: dir,
      userInput: "What is the capital of France?",
    });
    const summary = await recorder.finish({});
    expect(summary.userInput).toBe("What is the capital of France?");
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as { userInput?: string };
    expect(onDisk.userInput).toBe("What is the capital of France?");
  });

  it("persists the model (from the result) and system prompt (from the recorder option)", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "mem-capture-distill-1",
      conversationId: "memory:capture:distill",
      artifactDir: dir,
      systemPrompt: "You are the private memory maintenance LLM.",
    });
    const summary = await recorder.finish({ model: "pi:opencode-go:kimi-k2.6" });
    expect(summary.model).toBe("pi:opencode-go:kimi-k2.6");
    expect(summary.systemPrompt).toBe("You are the private memory maintenance LLM.");
    const onDisk = JSON.parse(await readFile(summary.artifactPaths[1]!, "utf8")) as {
      model?: string;
      systemPrompt?: string;
    };
    expect(onDisk.model).toBe("pi:opencode-go:kimi-k2.6");
    expect(onDisk.systemPrompt).toBe("You are the private memory maintenance LLM.");
  });

  it("prefers the result's system prompt and caps it beyond the per-event byte limit", async () => {
    const dir = await tempDir();
    // maxStringBytes (256) bounds event content, but the system prompt rides its
    // own larger cap, so a long compiled prompt survives well past 256 bytes.
    const longPrompt = "S".repeat(5_000);
    const recorder = createJsonlRunRecorder({
      runId: "run:sp",
      conversationId: "telegram:1",
      artifactDir: dir,
      maxStringBytes: 256,
      systemPrompt: "recorder-option-prompt",
    });
    const summary = await recorder.finish({ systemPrompt: longPrompt });
    // The result's prompt wins over the recorder option.
    expect(String(summary.systemPrompt).startsWith("SSSS")).toBe(true);
    expect(String(summary.systemPrompt).length).toBeGreaterThan(1_000);
  });

  it("captures events and writes redacted summary artifacts", async () => {
    const dir = await tempDir();
    let now = 1000;
    const recorder = createJsonlRunRecorder({ runId: "run:1", conversationId: "telegram:1", artifactDir: dir, clock: () => now });

    recorder.onEvent({ type: "request", apiKey: "redacted-value", nested: { token: "fixture-token-value" } });
    now = 1250;
    const summary = await recorder.finish({
      usage: { inputTokens: 3 },
      cost: { totalUsd: 0.01 },
      providerSessionId: "session-1",
      capabilitiesUsed: ["tools:read"],
    });

    expect(summary).toMatchObject({
      status: "succeeded",
      durationMs: 250,
      eventCount: 1,
      providerSessionId: "session-1",
      cost: { totalUsd: 0.01 },
      capabilitiesUsed: ["tools:read"],
    });
    const events = await readFile(summary.artifactPaths[0] ?? "", "utf8");
    expect(events).toContain('"apiKey":"[redacted]"');
    expect(events).toContain('"token":"[redacted]"');
    const summaryJson = await readFile(summary.artifactPaths[1] ?? "", "utf8");
    expect(summaryJson).toContain('"status": "succeeded"');
  });

  it("can write a running summary before the final result", async () => {
    const dir = await tempDir();
    let now = Date.parse("2026-05-16T08:00:00.000Z");
    const recorder = createJsonlRunRecorder({
      runId: "live-run",
      conversationId: "telegram:live",
      artifactDir: dir,
      clock: () => now,
    });

    if (recorder.start === undefined) {
      throw new Error("recorder must support start()");
    }
    const running = await recorder.start();

    expect(running).toMatchObject({
      runId: "live-run",
      status: "running",
      startedAt: "2026-05-16T08:00:00.000Z",
      updatedAt: "2026-05-16T08:00:00.000Z",
      durationMs: 0,
      eventCount: 0,
    });
    expect(await readFile(running.artifactPaths[1] ?? "", "utf8")).toContain('"status": "running"');

    recorder.onEvent({ type: "assistant", message: "visible" });
    now = Date.parse("2026-05-16T08:00:02.500Z");
    const final = await recorder.finish({});

    expect(final).toMatchObject({
      status: "succeeded",
      startedAt: "2026-05-16T08:00:00.000Z",
      endedAt: "2026-05-16T08:00:02.500Z",
      updatedAt: "2026-05-16T08:00:02.500Z",
      durationMs: 2500,
      eventCount: 1,
    });
    expect(await readFile(final.artifactPaths[1] ?? "", "utf8")).toContain('"status": "succeeded"');
  });

  it("marks runtime failures and cancellations honestly", async () => {
    const dir = await tempDir();
    const failed = createJsonlRunRecorder({ runId: "failed", conversationId: "c", artifactDir: dir });
    await expect(failed.finish({ error: "provider rejected request" })).resolves.toMatchObject({
      status: "failed",
      failureKind: "runtime_error",
    });

    const cancelled = createJsonlRunRecorder({ runId: "cancelled", conversationId: "c", artifactDir: dir });
    await expect(cancelled.finish({ cancelled: true })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("creates failure summaries from thrown errors", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "throw", conversationId: "c", artifactDir: dir });
    const summary = await recorder.fail(new TypeError("Bad runtime"));
    expect(summary).toMatchObject({ status: "failed", failureKind: "TypeError" });
    const summaryJson = await readFile(summary.artifactPaths[1] ?? "", "utf8");
    expect(summaryJson).toContain("Bad runtime");
  });
});

describe("redactJsonValue", () => {
  it("redacts sensitive keys and handles circular objects", () => {
    const value: Record<string, unknown> = { authorization: "Bearer token" };
    value.self = value;
    expect(redactJsonValue(value)).toEqual({ authorization: "[redacted]", self: "[circular]" });
  });
});
