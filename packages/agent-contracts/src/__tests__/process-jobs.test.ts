import { describe, expect, it } from "vitest";

import {
  isProcessJobErrorCode,
  isProcessJobState,
  isProcessJobSubagentProgress,
  isProcessJobSubagentRoute,
  parseProcessJobProjection,
  parseProcessJobProjections,
  processJobPublicError,
  type ProcessJobProjection,
} from "../process-jobs.js";

function projection(): Extract<ProcessJobProjection, { tool: "Exec" | "Bash" }> {
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

  it("discriminates private subagent projections and bounds structured questions", () => {
    const internal = { ...projection(), kind: "internal", tool: "AgentManage", instanceId: "helper", childStillBusy: true,
      subagentQuestion: { question: "Which branch?", options: ["one", "two"] } };
    expect(parseProcessJobProjection(internal)).toEqual(internal);
    for (const invalid of [
      { ...internal, kind: undefined }, { ...internal, tool: "Exec" },
      { ...internal, childStillBusy: undefined }, { ...internal, instanceId: "../helper" },
      { ...internal, subagentQuestion: { question: "x".repeat(2001) } },
      { ...internal, subagentQuestion: { question: "q", options: ["same", "same"] } },
      { ...projection(), childStillBusy: false },
    ]) expect(() => parseProcessJobProjection(invalid)).toThrow(TypeError);
  });

  it("parses a PeerAgent job without classifying it as a managed subagent", () => {
    const peer = { ...projection(), kind: "internal", tool: "PeerAgent", instanceId: "finance", childStillBusy: false };
    expect(parseProcessJobProjection(peer)).toEqual(peer);
    const peerQuestion = { state: "awaiting_answer", questionId: "11111111-1111-4111-8111-111111111111",
      peer: "finance", thread: "portfolio", message: "Proceed?", expiresAt: "2026-09-23T22:00:00.000Z",
      requestedSchema: { type: "object", properties: { question_1: { type: "string" } } } };
    expect(parseProcessJobProjection({ ...peer, peerQuestion })).toMatchObject({ peerQuestion });
    expect(() => parseProcessJobProjection({ ...peer, peerQuestion: { ...peerQuestion, message: "x".repeat(2_001) } })).toThrow(TypeError);
    expect(() => parseProcessJobProjection({ ...projection(), peerQuestion })).toThrow(TypeError);
    expect(() => parseProcessJobProjection({ ...peer, subagentQuestion: { question: "Owner approval?" } })).toThrow(TypeError);
    expect(() => parseProcessJobProjection({ ...peer, subagentProgress: {} })).toThrow(TypeError);
  });

  it("still parses a stored projection carrying the legacy AgentSend tool name", () => {
    // `AgentSend` was renamed to `AgentManage` with no alias. Jobs persisted
    // before the rename must keep loading; nothing emits the old name again.
    const legacy = { ...projection(), kind: "internal", tool: "AgentSend", instanceId: "helper", childStillBusy: false };
    expect(parseProcessJobProjection(legacy)).toEqual(legacy);
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

  it("accepts terminal unknown/suppressed receipts and depth 64, rejecting 65", () => {
    const value = projection();
    for (const state of ["unknown", "suppressed"] as const) {
      expect(parseProcessJobProjection({ ...value, limits: { ...value.limits, chainDepth: 64 },
        wake: { ...value.wake, state } }).wake.state).toBe(state);
    }
    expect(() => parseProcessJobProjection({ ...value, limits: { ...value.limits, chainDepth: 65 } })).toThrow(/limits/u);
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

  it("keeps the v1 output shape while a running preview grows to its exact bound", () => {
    const running: any = projection();
    running.limits.previewChars = 8_000;
    running.output.preview = "x".repeat(8_000);
    expect(parseProcessJobProjection(running)).toEqual(running);

    const invented: any = structuredClone(running);
    invented.output.tail = "new wire field";
    expect(() => parseProcessJobProjection(invented)).toThrow(/output/u);
  });

  it("exports exact state and error-code guards", () => {
    expect(isProcessJobState("interrupted")).toBe(true);
    expect(isProcessJobState("active")).toBe(false);
    expect(isProcessJobErrorCode("background_unsupported_channel")).toBe(true);
    expect(isProcessJobErrorCode("unknown")).toBe(false);
  });

  it("maps every public error code to one stable generic message", () => {
    expect(processJobPublicError("process_job_store_error")).toEqual({
      code: "process_job_store_error",
      message: "Process-job storage failed.",
    });
    expect(processJobPublicError("process_job_spawn_failed")).toEqual({
      code: "process_job_spawn_failed",
      message: "The process job could not be launched.",
    });
    expect(processJobPublicError("process_job_cleanup_incomplete")).toEqual({
      code: "process_job_cleanup_incomplete",
      message: "Process-job cleanup could not be confirmed.",
    });
    const raw: any = projection();
    raw.lastError = {
      code: "process_job_store_error",
      message: "arbitrary-secret at /private/absolute/path",
    };
    expect(parseProcessJobProjection(raw).lastError)
      .toEqual(processJobPublicError("process_job_store_error"));
  });
});

it("requires internal identity in the public TypeScript discriminated union", () => {
  // @ts-expect-error Internal tools cannot omit their required identity.
  const missing: ProcessJobProjection = { ...projection(), tool: "Agent" };
  // @ts-expect-error External tools cannot carry internal identity.
  const external: ProcessJobProjection = { ...projection(), tool: "Exec", kind: "internal", instanceId: "helper", childStillBusy: false };
  expect(() => parseProcessJobProjection(missing)).toThrow(TypeError);
  expect(() => parseProcessJobProjection(external)).toThrow(TypeError);
  const internal: ProcessJobProjection = { ...projection(), tool: "Agent", kind: "internal", instanceId: "helper", childStillBusy: false };
  const id: string = internal.instanceId;
  expect(id).toBe("helper");
});


describe("internal subagent progress projection", () => {
  const progress = { revision: 2, profile: "helper", toolCalls: 1, failedCalls: 0, costUsd: 0.0123,
    recent: [{ id: "call", toolName: "Read", status: "complete", argsSummary: "src/file.ts", executionMs: 12 }],
    route: { requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" } },
    answerHead: "Report", answerTruncated: false };
  const internal = () => ({ ...projection(), kind: "internal", tool: "Agent", instanceId: "helper", childStillBusy: false });
  it("round trips new progress and still accepts legacy internal jobs and progress", () => {
    expect(parseProcessJobProjection(internal())).toEqual(internal());
    const value = { ...internal(), subagentProgress: progress };
    expect(parseProcessJobProjection(value)).toEqual(value);
    const { route: _route, costUsd: _costUsd, ...legacyProgress } = progress;
    expect(isProcessJobSubagentProgress(legacyProgress)).toBe(true);
    const parsedLegacy = parseProcessJobProjection({ ...internal(), subagentProgress: legacyProgress });
    expect(parsedLegacy.kind === "internal" ? parsedLegacy.subagentProgress : undefined).toEqual(legacyProgress);
    expect(() => parseProcessJobProjection({ ...projection(), subagentProgress: progress })).toThrow();
  });

  it("accepts a bounded optional command directory and rejects malformed locations", () => {
    const withDirectory = { ...progress, recent: [{ ...progress.recent[0], workdir: "~/worktrees/project" }] };
    expect(parseProcessJobProjection({ ...internal(), subagentProgress: withDirectory }))
      .toEqual({ ...internal(), subagentProgress: withDirectory });
    for (const workdir of ["😀".repeat(65), 17, null]) {
      expect(isProcessJobSubagentProgress({ ...withDirectory, recent: [{ ...withDirectory.recent[0], workdir }] })).toBe(false);
    }
  });

  it("accepts absent and non-negative bounded cost while rejecting malformed prices", () => {
    const { costUsd: _costUsd, ...withoutCost } = progress;
    expect(isProcessJobSubagentProgress(withoutCost)).toBe(true);
    expect(isProcessJobSubagentProgress({ ...withoutCost, costUsd: 0 })).toBe(true);
    for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "0.01"]) {
      expect(isProcessJobSubagentProgress({ ...withoutCost, costUsd })).toBe(false);
      expect(() => parseProcessJobProjection({ ...internal(), subagentProgress: { ...withoutCost, costUsd } })).toThrow(TypeError);
    }
  });

  it.each([
    { recent: Array.from({ length: 51 }, (_, i) => ({ id: String(i), toolName: "Read", status: "running" })), toolCalls: 51 },
    { answerHead: "😀".repeat(2_001) }, { profile: "😀".repeat(33) }, { failedCalls: 2 },
    { prompt: "not allowed" }, { revision: -1 },
    { recent: [{ id: "c", toolName: "Read", status: "unknown" }] },
    { recent: [{ id: "c", toolName: "Read", status: "complete", result: "private" }] },
    { recent: [{ id: "c", toolName: "Read", status: "running", argsSummary: "😀".repeat(65) }] },
  ])("rejects malformed or overlarge progress %j", (patch) => {
    expect(() => parseProcessJobProjection({ ...internal(), subagentProgress: { ...progress, ...patch } })).toThrow();
  });

  it.each([
    { requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" } },
    { requested: {}, executed: { model: "openai-codex:gpt-5.6-sol", effectiveEffort: "xhigh" } },
    { requested: { model: "anthropic:claude-sonnet-4.5" }, executed: { model: "openai-codex:gpt-5.6-sol", effort: "high" }, disposition: "fallback" },
  ])("accepts bounded subagent route identifiers %#", (route) => {
    expect(isProcessJobSubagentRoute(route)).toBe(true);
  });

  it.each([
    {},
    { requested: {} },
    { requested: { model: "valid:model" }, extra: true },
    { requested: { model: "valid:model", extra: true } },
    { requested: { model: "Bearer abc" } },
    { requested: { model: `m${"x".repeat(256)}` } },
    { requested: { effort: `e${"x".repeat(64)}` } },
    { requested: { model: "valid:model" }, disposition: "ran" },
    { requested: { model: "valid:model" }, executed: "not-an-object" },
  ])("rejects malformed subagent routes %#", (route) => {
    expect(isProcessJobSubagentRoute(route)).toBe(false);
  });

  it.each([
    ["array", ["fallback"]],
    ["object", { toString: null }],
    ["number", 1],
    ["null", null],
  ])("rejects a non-string %s disposition without throwing", (_case, disposition) => {
    const route = { requested: { model: "valid:model" }, disposition };
    expect(() => isProcessJobSubagentRoute(route)).not.toThrow();
    expect(isProcessJobSubagentRoute(route)).toBe(false);
    expect(isProcessJobSubagentProgress({ ...progress, route })).toBe(false);
    expect(() => parseProcessJobProjection({ ...internal(), subagentProgress: { ...progress, route } })).toThrow(TypeError);
  });
});
