import { describe, expect, it } from "vitest";

import {
  isProcessJobErrorCode,
  isProcessJobState,
  parseProcessJobProjection,
  parseProcessJobProjections,
  type ProcessJobProjection,
} from "../process-jobs.js";

function projection(): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "pj_01JTEST",
    tool: "Exec",
    state: "running",
    summary: "node worker.js [arguments redacted]",
    origin: {
      conversationId: "web:thread-1:bucket-2",
      channel: "web",
      runId: "run-1",
      historyBoundary: "run-1",
      bucket: "bucket-2",
    },
    timestamps: {
      admittedAt: "2026-08-14T10:00:00.000Z",
      queueDeadlineAt: "2026-08-14T10:05:00.000Z",
      startedAt: "2026-08-14T10:00:01.000Z",
      runtimeDeadlineAt: "2026-08-14T10:30:01.000Z",
      completedAt: null,
    },
    limits: {
      maxRuntimeMs: 1_800_000,
      maxOutputBytes: 1_048_576,
      previewChars: 2_000,
      chainDepth: 0,
    },
    output: {
      stdoutBytes: 12,
      stderrBytes: 0,
      truncated: false,
      preview: "working\n",
      stdoutRef: "artifacts/pj_01JTEST/stdout.log",
      stderrRef: null,
    },
    wake: {
      state: "pending",
      attempts: 0,
      deliveryKey: "process-job:pj_01JTEST",
      lastAttemptAt: null,
    },
    exitCode: null,
    signal: null,
    durationMs: null,
    cancelRequested: false,
    lastError: null,
  };
}

describe("process-job contracts", () => {
  it("parses the exact projection and a bounded list", () => {
    const value = projection();
    expect(parseProcessJobProjection(value)).toEqual(value);
    expect(parseProcessJobProjections([value])).toEqual([value]);
  });

  it("accepts the configured retention plus transient active-record boundary", () => {
    const value = projection();
    const atCap = Array.from({ length: 10_096 }, (_, index) => ({
      ...value,
      jobId: `pj_${String(index)}`,
    }));

    expect(parseProcessJobProjections(atCap)).toHaveLength(10_096);
    expect(() => parseProcessJobProjections([...atCap, value])).toThrow(TypeError);
  });

  it.each([
    ["top level", (value: any) => { value.extra = true; }],
    ["origin", (value: any) => { value.origin.replyTarget = "secret"; }],
    ["timestamps", (value: any) => { value.timestamps.clock = 1; }],
    ["limits", (value: any) => { value.limits.cap = 1; }],
    ["output", (value: any) => { value.output.path = "/tmp/secret"; }],
    ["wake", (value: any) => { value.wake.token = "secret"; }],
    ["error", (value: any) => { value.lastError = { code: "process_job_invalid", message: "bad", raw: "secret" }; }],
  ])("rejects unknown keys at %s", (_label, mutate) => {
    const value: any = structuredClone(projection());
    mutate(value);
    expect(() => parseProcessJobProjection(value)).toThrow(TypeError);
  });

  it("rejects unsafe artifact references and malformed clocks", () => {
    const unsafe: any = projection();
    unsafe.output.stdoutRef = "../outside";
    expect(() => parseProcessJobProjection(unsafe)).toThrow(/output/u);

    const clock: any = projection();
    clock.timestamps.admittedAt = "yesterday";
    expect(() => parseProcessJobProjection(clock)).toThrow(/timestamps/u);
  });

  it("applies compiled caps while treating previewChars as characters", () => {
    const unicode: any = projection();
    unicode.limits.previewChars = 8_000;
    unicode.output.preview = "😀".repeat(4_000);
    expect(parseProcessJobProjection(unicode).output.preview).toBe(unicode.output.preview);

    const tooLong = structuredClone(unicode);
    tooLong.output.preview += "x";
    expect(() => parseProcessJobProjection(tooLong)).toThrow(/output/u);

    const excessiveRuntime: any = projection();
    excessiveRuntime.limits.maxRuntimeMs = 86_400_001;
    expect(() => parseProcessJobProjection(excessiveRuntime)).toThrow(/limits/u);
  });

  it("exports exact state and error-code guards", () => {
    expect(isProcessJobState("interrupted")).toBe(true);
    expect(isProcessJobState("active")).toBe(false);
    expect(isProcessJobErrorCode("background_unsupported_channel")).toBe(true);
    expect(isProcessJobErrorCode("unknown")).toBe(false);
  });
});
