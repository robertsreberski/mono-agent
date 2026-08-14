import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CRON_JOBS,
  type CronAdapterConfig,
  type CronAdapterStartResult,
  type CronFiringIdentity,
} from "@mono-agent/cron-adapter";
import { MAX_CRON_OPERATOR_RESPONSE_BYTES } from "@mono-agent/operator-adapter";

import { openCronControlStore, type CronControlStore } from "../cron-control-store.js";
import { createCronOperatorService } from "../cron-operator-service.js";

const roots: string[] = [];
const stores: CronControlStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => await store.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const job = {
  id: "digest",
  enabled: true,
  expression: "*/5 * * * *",
  timezone: "Europe/Amsterdam",
  prompt: "Prepare digest",
};

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-cron-operator-")));
  roots.push(cwd);
  const store = await openCronControlStore(cwd, { now: () => new Date("2026-08-14T10:00:00.000Z") });
  stores.push(store);
  store.syncConfiguredJobs([job.id]);
  let enabled = true;
  let activeRunId: string | undefined;
  const runNow = vi.fn((_jobId: string, firing?: CronFiringIdentity) => {
    activeRunId = firing?.runId;
    if (firing === undefined) throw new Error("durable firing required");
    return firing;
  });
  const setEffectiveEnabled = vi.fn((_jobId: string, value: boolean) => {
    enabled = value;
    return snapshot();
  });
  const snapshot = () => ({
    jobId: job.id,
    expression: job.expression,
    timezone: job.timezone,
    effectiveEnabled: enabled,
    conversationId: `cron:${job.id}`,
    nextRunAt: "2026-08-14T10:05:00.000Z",
    ...(activeRunId === undefined ? {} : { activeRunId }),
  });
  const adapter: CronAdapterStartResult = {
    jobs: [job],
    activeJobCount: 0,
    snapshots: () => [snapshot()],
    runNow,
    setEffectiveEnabled,
    stop: () => undefined,
  };
  return { store, adapter, runNow, setEffectiveEnabled };
}

function config(actions = true): CronAdapterConfig {
  return { jobs: [job], operatorActionsEnabled: actions };
}

describe("cron operator service", () => {
  it("is read-only unless actions are explicitly enabled with a healthy store and adapter", async () => {
    const service = createCronOperatorService({
      config: config(false),
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect(service.overview()).toMatchObject({ actionsEnabled: false, jobs: [{ jobId: "digest" }] });
    expect(() => service.runNow("digest", { idempotencyKey: "disabled" }))
      .toThrowError(expect.objectContaining({ code: "actions_disabled", status: 403 }));
    expect(service.configView()).toEqual({ id: "cron", label: "Cron", status: "active", fields: [] });
  });

  it("requires agent-issued confirmation, preserves idempotency, and returns the durable manual run", async () => {
    const { store, adapter, runNow } = await fixture();
    const service = createCronOperatorService({
      config: config(),
      store,
      adapter,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    const first = service.runNow("digest", { idempotencyKey: "manual-one" });
    expect(first).toMatchObject({
      kind: "confirmation_required",
      confirmation: { message: expect.stringContaining("scheduled firing will be recorded as skipped_overlap") },
    });
    if (first instanceof Promise || first.kind !== "confirmation_required") throw new Error("confirmation required");
    const accepted = service.runNow("digest", {
      idempotencyKey: "manual-one",
      confirmationToken: first.confirmation.token,
    });
    expect(accepted).toMatchObject({
      kind: "completed",
      replayed: false,
      value: { run: { runId: "cron:digest:2026-08-14T10:00:00.000Z:m1", trigger: "manual", sequence: 1 } },
    });
    expect(runNow).toHaveBeenCalledOnce();
    expect(service.runNow("digest", { idempotencyKey: "manual-one" })).toMatchObject({
      kind: "completed",
      replayed: true,
      value: { run: { runId: "cron:digest:2026-08-14T10:00:00.000Z:m1" } },
    });
    expect(runNow).toHaveBeenCalledOnce();
  });

  it("terminally reconciles a committed run-now receipt when adapter dispatch throws", async () => {
    const { store, adapter, runNow } = await fixture();
    runNow.mockImplementationOnce(() => { throw new Error("adapter stopped after admission"); });
    const error = vi.fn();
    const service = createCronOperatorService({
      config: config(),
      store,
      adapter,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      now: () => new Date("2026-08-14T10:00:00.000Z"),
      logger: { error },
    });
    const first = service.runNow("digest", { idempotencyKey: "manual-dispatch-failure" });
    if (first instanceof Promise || first.kind !== "confirmation_required") throw new Error("confirmation required");

    const failed = service.runNow("digest", {
      idempotencyKey: "manual-dispatch-failure",
      confirmationToken: first.confirmation.token,
    });
    if (failed instanceof Promise) throw new Error("synchronous fixture expected");
    expect(failed).toMatchObject({
      kind: "completed",
      replayed: false,
      value: {
        run: {
          runId: "cron:digest:2026-08-14T10:00:00.000Z:m1",
          status: "failed",
          completedAt: "2026-08-14T10:00:00.000Z",
          error: "Cron manual run could not be dispatched.",
          failureKind: "operator_dispatch_failed",
        },
      },
    });
    expect(store.lastRun("digest")).toMatchObject({
      status: "failed",
      failureKind: "operator_dispatch_failed",
    });
    const replay = service.runNow("digest", { idempotencyKey: "manual-dispatch-failure" });
    if (replay instanceof Promise) throw new Error("synchronous fixture expected");
    expect(replay).toEqual({ ...failed, replayed: true });
    expect(runNow).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Cron operator run-now dispatch failed.",
      expect.objectContaining({
        runId: "cron:digest:2026-08-14T10:00:00.000Z:m1",
        failureKind: "operator_dispatch_failed",
      }),
    );
  });

  it("persists effective enable state only after confirmation and reports it authoritatively", async () => {
    const { store, adapter, setEffectiveEnabled } = await fixture();
    const changed = vi.fn();
    const service = createCronOperatorService({
      config: config(),
      store,
      adapter,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      onEffectiveEnabledChanged: changed,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    const first = service.setEffectiveEnabled("digest", false, { idempotencyKey: "disable-one" });
    if (first instanceof Promise || first.kind !== "confirmation_required") throw new Error("confirmation required");
    expect(store.overrides()).toEqual(new Map());
    expect(service.setEffectiveEnabled("digest", false, {
      idempotencyKey: "disable-one",
      confirmationToken: first.confirmation.token,
    })).toMatchObject({
      kind: "completed",
      replayed: false,
      value: { job: { declaredEnabled: true, effectiveEnabled: false, health: "disabled" } },
    });
    expect(store.overrides()).toEqual(new Map([["digest", false]]));
    expect(setEffectiveEnabled).toHaveBeenCalledWith("digest", false);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("attributes an overlap skip to the manual run without degrading job health", async () => {
    const { store, adapter } = await fixture();
    const manual = store.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-health",
      requestHash: "manual-health-hash",
      observedAt: "2026-08-14T10:00:00.000Z",
    }).firing;
    const scheduled = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:05:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult({
      kind: "skipped",
      reason: "overlap",
      cronRunId: scheduled.runId,
      jobId: scheduled.jobId,
      scheduledAt: scheduled.scheduledAt,
      orderedAt: scheduled.orderedAt,
      sequence: scheduled.sequence,
      trigger: scheduled.trigger,
      blockedByRunId: manual.runId,
      blockedByTrigger: "manual",
    });
    const service = createCronOperatorService({
      config: config(),
      store,
      adapter,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
    });
    expect(service.overview()).toMatchObject({
      jobs: [{
        jobId: "digest",
        health: "healthy",
        lastRun: { status: "skipped_overlap", blockedByRunId: manual.runId, blockedByTrigger: "manual" },
      }],
    });
  });

  it("keeps removed jobs as read-only configured:false history", async () => {
    const { store } = await fixture();
    store.syncConfiguredJobs(["removed-job"]);
    const service = createCronOperatorService({
      config: { jobs: [], operatorActionsEnabled: true },
      store,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
    });
    expect(service.overview()).toMatchObject({
      actionsEnabled: false,
      jobs: expect.arrayContaining([
        expect.objectContaining({ jobId: "removed-job", configured: false, health: "disabled" }),
      ]),
    });
    expect(() => service.runNow("removed-job", { idempotencyKey: "removed" }))
      .toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("bounds overview history and keeps lastRun compact while detail stays explicit", async () => {
    const { store, adapter } = await fixture();
    store.syncConfiguredJobs(Array.from({ length: MAX_CRON_JOBS + 8 }, (_, index) => `historical-${String(index).padStart(3, "0")}`));
    const firing = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.appendEvent(firing, { type: "runtime_warning", message: "bounded activity" });
    const service = createCronOperatorService({
      config: config(),
      store,
      adapter,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });

    const overview = service.overview();
    if (overview instanceof Promise) throw new Error("synchronous fixture expected");
    expect(overview.jobs).toHaveLength(MAX_CRON_JOBS);
    expect(overview.jobsTruncated).toBe(true);
    expect(overview.jobs.find((candidate) => candidate.jobId === "digest")?.lastRun).toMatchObject({
      projection: "summary",
      eventCount: 1,
    });
    expect(overview.jobs.find((candidate) => candidate.jobId === "digest")?.lastRun).not.toHaveProperty("events");
    expect(Buffer.byteLength(JSON.stringify(overview), "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);

    expect(service.run({ jobId: "digest", runId: firing.runId })).toMatchObject({
      projection: "detail",
      eventsIncluded: 1,
      events: [{ type: "runtime_warning", message: "bounded activity" }],
    });
    expect(() => service.run({ jobId: "digest", runId: "cron:other" }))
      .toThrowError(expect.objectContaining({ code: "not_found", status: 404 }));
  });
});
