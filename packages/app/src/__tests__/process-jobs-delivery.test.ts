import { expect, expectTypeOf, it } from "vitest";

import type { DurableProcessJobRecord } from "../process-jobs-store.js";
import type { SubagentOwnerIdentity } from "../subagent-registry-ownership.js";
import { publishManagedJob, type ManagedPublicationOperations } from "../process-jobs/managed-publication.js";
import { deliverProcessJobWake, type ProcessJobWakeOperations } from "../process-jobs/wake-delivery.js";
import type { NotifyDeliveryResult } from "../channels/types.js";

it.each([false, true])("copies the exact durable certificate before acknowledgement (finalize failure=%s)", async (failFinalize) => {
  const events: string[] = [];
  let releaseConfirm!: () => void;
  const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
  let confirmEntered!: () => void;
  const entered = new Promise<void>((resolve) => { confirmEntered = resolve; });
  const record = { jobId: "fictional-job", kind: "internal", state: "succeeded", subagentOwnership: {
    registryRoot: "/fictional/registry", owner: { settlement: "settled" }, disposition: { status: "ok" },
    publication: { sequence: 7, state: "pending", receiptPending: true },
  } } as DurableProcessJobRecord;
  const identity = { jobId: record.jobId } as SubagentOwnerIdentity;
  const operations: ManagedPublicationOperations = {
    assertWritable: () => { events.push("writable"); },
    read: async () => record,
    matchesRegistry: () => true,
    identity: () => identity,
    neverStarted: () => false,
    publish: async (phase, publication) => {
      expect(publication.sequence).toBe(7);
      expect(publication.identity).toBe(identity);
      expect(publication.released).toBe(true);
      events.push(phase);
      if (phase === "confirm") { confirmEntered(); await confirmGate; }
      if (phase === "finalize" && failFinalize) throw new Error("fixture finalize failure");
    },
    confirm: async () => { events.push("job-confirmed"); },
    recordCertificate: async () => { events.push("certificate-copied"); },
    acknowledgeReceipt: async () => { events.push("capacity-released"); },
    discardArtifacts: async () => { events.push("discard"); },
    finish: () => { events.push("wake"); },
  };
  const publication = publishManagedJob(record.jobId, operations);
  await entered;
  expect(events).toEqual(["writable", "intent", "confirm"]);
  releaseConfirm();
  if (failFinalize) {
    await expect(publication).rejects.toThrow("fixture finalize failure");
    expect(events).toEqual(["writable", "intent", "confirm", "job-confirmed", "finalize"]);
  } else {
    await publication;
    expect(events).toEqual(["writable", "intent", "confirm", "job-confirmed", "finalize",
      "certificate-copied", "acknowledge", "capacity-released", "wake"]);
  }
});

it("exposes named operations rather than mutable state or a generic mutation port", () => {
  expectTypeOf<Extract<keyof ProcessJobWakeOperations, "store" | "withLock" | "active" | "wakeTasks">>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof ManagedPublicationOperations, "store" | "mutate" | "managedPublications">>().toEqualTypeOf<never>();
});

it.each([
  ["ambiguous", { delivered: false, retryable: true, ambiguous: true }, false],
  ["crossed without a receipt", { delivered: false, code: "possibly_applied_steer", retryable: true, ambiguous: true }, false],
  ["confirmed crossed delivery", { delivered: true, retryable: true }, false],
  ["permanent refusal", { delivered: false, retryable: false }, false],
  ["safe refusal", { delivered: false, retryable: true, ambiguous: false }, true],
] satisfies [string, NotifyDeliveryResult, boolean][])("preserves write-before-wake and non-replay for %s", async (_name, receipt, retries) => {
  const events: string[] = [];
  const keys: string[] = [];
  const decisions: boolean[] = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  let attempts = 0;
  const record = {
    jobId: "fictional-job", tool: "Exec", state: "succeeded", summary: "fictional command",
    origin: { conversationId: "fictional-conversation", replyToConversationId: "fictional-conversation", channel: "slack",
      runId: "fictional-run", historyBoundary: "fictional-run", bucket: null },
    admittedAt: now.toISOString(), queueDeadlineAt: now.toISOString(), startedAt: now.toISOString(),
    runtimeDeadlineAt: null, completedAt: now.toISOString(), chainDepth: 0,
    maxRuntimeMs: 1_000, maxOutputBytes: 1_024, previewChars: 100,
    stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null,
    exitCode: 0, signal: null, durationMs: 0, cancelRequested: false, lastError: null,
    wake: { state: "pending", attempts: 0, deliveryKey: "fictional-stable-key", lastAttemptAt: null },
  } as DurableProcessJobRecord;
  const operations: ProcessJobWakeOperations = {
    beginAttempt: async (id) => {
      expect(id).toBe(record.jobId);
      events.push("begin");
      attempts += 1;
      return { record: { ...record, wake: { ...record.wake, attempts } }, previousDelivery: undefined };
    },
    updateSurface: async () => { events.push("surface"); },
    readSalvage: async () => undefined,
    wake: async (input) => {
      // The external edge must not be entered until its durable attempt exists.
      expect(events.at(-1)).toBe("surface");
      expect(attempts).toBe(keys.length + 1);
      keys.push(input.deliveryKey);
      events.push("wake");
      return keys.length === 1 ? receipt : { delivered: true };
    },
    settleAttempt: async (_id, _attempt, _result, decision) => {
      events.push("settle");
      decisions.push(decision.safeRetry);
    },
    updateSurfaceById: async () => { events.push("refresh"); },
    now: () => now,
    applyRetention: async () => { events.push("retain"); },
    rearm: () => { events.push("rearm"); },
    sleep: async (milliseconds) => { expect(milliseconds).toBe(100); events.push("sleep"); },
    isStopping: () => false,
  };
  await deliverProcessJobWake(record.jobId, operations);
  const attempt = ["begin", "surface", "wake", "settle", "refresh"];
  expect(events).toEqual(retries ? [...attempt, "sleep", ...attempt, "retain"] : [...attempt, "retain"]);
  expect(attempts).toBe(retries ? 2 : 1);
  expect(keys).toEqual(Array(retries ? 2 : 1).fill(record.wake.deliveryKey));
  expect(decisions).toEqual(retries ? [true, false] : [false]);
});
