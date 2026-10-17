import { expect, it } from "vitest";
import type { ProcessJobProcessResult } from "@mono-agent/turn/host/types";

import { PROCESS_JOBS_DEFAULTS } from "../process-jobs-config.js";
import type { DurableProcessJobRecord } from "../process-jobs-store.js";
import { ProcessJobServiceError } from "../process-jobs/errors.js";
import { boundedNewestRecords, conversationSlotAvailable, enforceAdmission, terminalFromResult } from "../process-jobs/policy.js";

function record(state: DurableProcessJobRecord["state"], id = "job"): DurableProcessJobRecord {
  // Pure policy fixtures supply only the fields these decisions inspect.
  return { jobId: id, state, cancelRequested: false, admittedAt: "2026-01-01T00:00:00.000Z", chainDepth: 0,
    origin: { normalizedReplyTarget: "web:fictional" }, wake: { state: "pending" } } as DurableProcessJobRecord;
}

it.each([
  [{ aborted: true, timedOut: true, spawnError: "failed" }, true, true, "cancelled", "process_job_cleanup_incomplete"],
  [{ timedOut: true, spawnError: "failed" }, false, true, "timed_out", "process_job_store_error"],
  [{ spawnError: "failed" }, false, false, "spawn_failed", "process_job_spawn_failed"],
  [{ code: 0 }, true, true, "failed", "process_job_cleanup_incomplete"],
  [{ code: 0 }, false, false, "succeeded", undefined],
] as const)("preserves terminal precedence for %j", (overrides, cleanup, artifact, state, code) => {
  const result = { code: 1, signal: null, spawnError: null, aborted: false, timedOut: false,
    bufferExceeded: false, ...overrides } as ProcessJobProcessResult;
  expect(terminalFromResult(record("running"), result, cleanup ? new Error("private cleanup") : undefined,
    artifact ? new Error("private artifact") : undefined)).toMatchObject({ state, ...(code === undefined ? {} : { code }) });
});

it("keeps the cancellation flag authoritative and never exposes raw failure diagnostics", () => {
  const current = record("running");
  current.cancelRequested = true;
  const result = terminalFromResult(current, { code: 0, signal: null, spawnError: null } as ProcessJobProcessResult,
    new Error("private canary"), undefined);
  expect(result.state).toBe("cancelled");
  expect(result.message).not.toContain("private canary");
  const error = new ProcessJobServiceError(result.code!, result.message);
  expect(error.name).toBe("ProcessJobServiceError");
  expect(error.message).not.toContain("private canary");
});

it("checks pending-wake capacity before queue capacity with the same metadata", () => {
  const settings = { ...PROCESS_JOBS_DEFAULTS, configured: true, maxConcurrent: 1, maxQueued: 1,
    retention: { ...PROCESS_JOBS_DEFAULTS.retention, maxRecords: 1 } };
  expect(() => enforceAdmission([record("queued", "a"), record("queued", "b"), record("running", "c")],
    "web:fictional", 0, settings)).toThrowError(expect.objectContaining({
      code: "process_job_capacity", occupancy: 3, limit: 3, limitKey: "processJobs.pendingWakeCap",
    }));
});

it("allows a nested descendant past its ancestor but does not mutate snapshot order", () => {
  const ancestor = record("running", "ancestor");
  const child = { ...record("queued", "child"), chainDepth: 1 };
  expect(conversationSlotAvailable([ancestor], child, { ...PROCESS_JOBS_DEFAULTS, configured: true, maxActivePerConversation: 1 })).toBe(true);
  const records: readonly DurableProcessJobRecord[] = [record("failed", "z"), ancestor, child];
  const before = [...records];
  expect(boundedNewestRecords(records).map((entry) => entry.jobId)).toEqual(["ancestor", "child", "z"]);
  expect(records).toEqual(before);
});
