import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createJsonlRunRecorder, redactJsonValue } from "./index.js";

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
  it("captures events and writes redacted summary artifacts", async () => {
    const dir = await tempDir();
    let now = 1000;
    const recorder = createJsonlRunRecorder({ runId: "run:1", conversationId: "telegram:1", artifactDir: dir, clock: () => now });

    recorder.onEvent({ type: "request", apiKey: "secret-value", nested: { token: "abc" } });
    now = 1250;
    const summary = await recorder.finish({ usage: { inputTokens: 3 }, providerSessionId: "session-1" });

    expect(summary).toMatchObject({ status: "succeeded", durationMs: 250, eventCount: 1, providerSessionId: "session-1" });
    const events = await readFile(summary.artifactPaths[0] ?? "", "utf8");
    expect(events).toContain('"apiKey":"[redacted]"');
    expect(events).toContain('"token":"[redacted]"');
    const summaryJson = await readFile(summary.artifactPaths[1] ?? "", "utf8");
    expect(summaryJson).toContain('"status": "succeeded"');
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
