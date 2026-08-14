import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCronAdapter,
  type CronFiringIdentity,
  type CronJobResult,
} from "@mono-agent/cron-adapter";
import { MAX_CRON_OPERATOR_RESPONSE_BYTES } from "@mono-agent/operator-adapter";

import {
  CronControlStoreError,
  cronActionRequestHash,
  inspectCronControlStore,
  openCronControlStore,
  resolveCronControlPaths,
  type CronControlStore,
} from "../cron-control-store.js";

const roots: string[] = [];
const stores: CronControlStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(async (store) => await store.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(now: () => Date = () => new Date("2026-08-14T10:00:00.000Z")) {
  // Keep the lexical mkdtemp path: on macOS tmpdir() is normally below /var,
  // whose canonical spelling is /private/var. This exercises the same
  // product path used by the final demo instead of hiding it with realpath().
  const cwd = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-"));
  roots.push(cwd);
  const store = await openCronControlStore(cwd, { now });
  stores.push(store);
  return { cwd, store };
}

function terminal(
  firing: CronFiringIdentity,
  kind: "skipped" | "queued" | "dropped",
  active?: CronFiringIdentity,
): CronJobResult {
  if (kind === "skipped") {
    if (active === undefined) throw new Error("active firing required");
    return {
      kind,
      reason: "overlap",
      cronRunId: firing.runId,
      jobId: firing.jobId,
      scheduledAt: firing.scheduledAt,
      orderedAt: firing.orderedAt,
      sequence: firing.sequence,
      trigger: firing.trigger,
      blockedByRunId: active.runId,
      blockedByTrigger: active.trigger,
    };
  }
  return {
    kind,
    ...(kind === "queued" ? { queueDepth: 1 } : { reason: "overflow" as const }),
    cronRunId: firing.runId,
    jobId: firing.jobId,
    scheduledAt: firing.scheduledAt,
    orderedAt: firing.orderedAt,
    sequence: firing.sequence,
    trigger: firing.trigger,
  } as CronJobResult;
}

function succeeded(firing: CronFiringIdentity, text = "done"): CronJobResult {
  return {
    kind: "succeeded",
    cronRunId: firing.runId,
    jobId: firing.jobId,
    scheduledAt: firing.scheduledAt,
    orderedAt: firing.orderedAt,
    sequence: firing.sequence,
    trigger: firing.trigger,
    startedAt: firing.orderedAt,
    completedAt: firing.orderedAt,
    text,
  };
}

describe("cron control store", () => {
  it("distinguishes an absent first-run store from corrupt and insecure state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-"));
    roots.push(cwd);
    expect(await inspectCronControlStore(cwd)).toEqual({ status: "absent" });

    const store = await openCronControlStore(cwd);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });

    const paths = resolveCronControlPaths(cwd);
    await writeFile(paths.marker, "not a mono-agent control marker\n");
    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "degraded", reason: expect.stringContaining("marker") });
    await expect(openCronControlStore(cwd)).rejects.toMatchObject({ kind: "corrupt" });

    await writeFile(paths.marker, `${JSON.stringify({ kind: "mono-agent-cron-control", schema: 1 })}\n`);
    if (process.platform !== "win32") {
      await chmod(paths.database, 0o644);
      expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "degraded", reason: expect.stringContaining("owner-only") });
    }
  });

  it("canonicalizes the trusted cwd while keeping the managed control subtree owner-private", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-alias-"));
    roots.push(cwd);
    const canonicalCwd = await realpath(cwd);

    const store = await openCronControlStore(cwd);
    stores.push(store);

    expect(store.paths.root).toBe(join(canonicalCwd, ".mono-agent", "cron-control-v1"));
    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
  });

  it("waits through a transient writer handoff but still rejects actual database corruption", async () => {
    const { cwd, store } = await fixture();
    const paths = store.paths;
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(workerData.database, { timeout: 0 });
      database.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
      }, 75);
    `, { eval: true, workerData: { database: paths.database } });
    await new Promise<void>((resolvePromise, reject) => {
      worker.once("message", (message) => {
        if (message === "locked") resolvePromise();
        else reject(new Error(`Unexpected worker message: ${String(message)}`));
      });
      worker.once("error", reject);
    });
    const workerExit = once(worker, "exit");

    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
    expect(await workerExit).toEqual([0]);

    await writeFile(paths.database, "not a sqlite database", "utf8");
    expect(await inspectCronControlStore(cwd)).toMatchObject({
      status: "degraded",
      reason: expect.stringMatching(/database|sqlite/iu),
    });
  });

  it("runs one whole-database check across repeated inspection and one store open", async () => {
    const { cwd, store } = await fixture();
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const originalPrepare = DatabaseSync.prototype.prepare;
    let quickChecks = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql.trim() === "PRAGMA quick_check(1)") quickChecks += 1;
      return originalPrepare.call(this, sql);
    });

    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(quickChecks).toBe(1);
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link hop inside the managed state subtree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-link-"));
    const redirectedParent = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-target-"));
    roots.push(cwd, redirectedParent);
    await mkdir(join(redirectedParent, "cron-control-v1"), { mode: 0o700 });
    await symlink(redirectedParent, join(cwd, ".mono-agent"), "dir");

    await expect(openCronControlStore(cwd)).rejects.toMatchObject({ kind: "corrupt" });
    expect(await inspectCronControlStore(cwd)).toMatchObject({
      status: "degraded",
      reason: expect.stringContaining("symbolic-link hop"),
    });
  });

  it("leases one live owner and releases the lease on close", async () => {
    const { cwd, store } = await fixture();
    await expect(openCronControlStore(cwd)).rejects.toMatchObject({ kind: "lease_conflict" });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(reopened.overrides()).toEqual(new Map());
  });

  it("persists overrides, idempotency, audit, and disjoint manual identities", async () => {
    const { cwd, store } = await fixture();
    store.syncConfiguredJobs(["daily:brief"]);
    const enableHash = cronActionRequestHash({ action: "set_enabled", jobId: "daily:brief", enabled: false });
    expect(store.setEnabledAction({
      jobId: "daily:brief",
      enabled: false,
      idempotencyKey: "enable-one",
      requestHash: enableHash,
    })).toEqual({ enabled: false, replayed: false });
    expect(store.setEnabledAction({
      jobId: "daily:brief",
      enabled: false,
      idempotencyKey: "enable-one",
      requestHash: enableHash,
    })).toEqual({ enabled: false, replayed: true });
    expect(() => store.setEnabledAction({
      jobId: "daily:brief",
      enabled: true,
      idempotencyKey: "enable-one",
      requestHash: cronActionRequestHash({ action: "set_enabled", jobId: "daily:brief", enabled: true }),
    })).toThrowError(expect.objectContaining({ kind: "idempotency_conflict" }));

    const actionHash = cronActionRequestHash({ action: "run_now", jobId: "daily:brief" });
    const manual = store.runNowAction({
      jobId: "daily:brief",
      idempotencyKey: "run-one",
      requestHash: actionHash,
      observedAt: "2026-08-14T10:00:00.000Z",
    });
    expect(manual.firing).toMatchObject({
      runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z:m1",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence: 1,
      trigger: "manual",
    });
    expect(store.runNowAction({
      jobId: "daily:brief",
      idempotencyKey: "run-one",
      requestHash: actionHash,
      observedAt: "2026-08-14T10:01:00.000Z",
    })).toMatchObject({ replayed: true, firing: { runId: manual.firing.runId } });

    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(reopened.overrides()).toEqual(new Map([["daily:brief", false]]));
    expect(reopened.replayRunNowAction({
      jobId: "daily:brief",
      idempotencyKey: "run-one",
      requestHash: actionHash,
    })).toMatchObject({ runId: manual.firing.runId });
    const database = new DatabaseSync(reopened.paths.database, { readOnly: true });
    expect((database.prepare("SELECT COUNT(*) AS count FROM cron_audit").get() as { count: number }).count).toBeGreaterThanOrEqual(2);
    database.close();
  });

  it("allocates one durable sequence and immutable orderedAt for every visible firing state", async () => {
    const { store } = await fixture();
    const active = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:01:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    const skipped = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:02:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    const queued = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:03:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    const dropped = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:04:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult(terminal(skipped, "skipped", active));
    store.recordResult(terminal(queued, "queued"));
    store.recordResult(terminal(dropped, "dropped"));

    const ordered = store.runs("digest", 10).runs;
    expect(ordered.map((run) => [run.sequence, run.status, run.orderedAt])).toEqual([
      [4, "dropped", "2026-08-14T10:00:00.000Z"],
      [3, "queued", "2026-08-14T10:00:00.000Z"],
      [2, "skipped_overlap", "2026-08-14T10:00:00.000Z"],
      [1, "admitted", "2026-08-14T10:00:00.000Z"],
    ]);
    expect(ordered[2]).toMatchObject({ blockedByRunId: active.runId, blockedByTrigger: "scheduled" });
  });

  it("runs the production scheduler through the durable allocator/start/result path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store } = await fixture(() => new Date(Date.now()));
    store.syncConfiguredJobs(["production-path"]);
    const responder = { respond: vi.fn(async () => ({ text: "stored result" })) };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "production-path", expression: "* * * * *", prompt: "run" }],
      now: () => new Date(Date.now()),
      admitFiring: (input) => store.allocateFiring(input),
      onRunStarted: (firing, startedAt) => store.markStarted(firing, startedAt),
      onResult: (result) => store.recordResult(result),
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => store.runs("production-path", 10).runs).toEqual([
        expect.objectContaining({
          runId: "cron:production-path:1970-01-01T00:01:00.000Z",
          sequence: 1,
          orderedAt: "1970-01-01T00:01:00.000Z",
          status: "succeeded",
          text: "stored result",
        }),
      ]);
      expect(responder.respond).toHaveBeenCalledOnce();
    } finally {
      scheduler.stop();
    }
  });

  it("degrades but stays re-armed when the real control-store allocator fails inside the timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store } = await fixture(() => new Date(Date.now()));
    await store.close();
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) };
    const degraded = vi.fn();
    const error = vi.fn();
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "closed-store", expression: "* * * * *", prompt: "run" }],
      now: () => new Date(Date.now()),
      admitFiring: (input) => store.allocateFiring(input),
      onRunStarted: (firing, startedAt) => store.markStarted(firing, startedAt),
      onResult: (result) => store.recordResult(result),
      onDegraded: degraded,
      logger: { error },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.snapshots()[0]).toMatchObject({
        nextRunAt: "1970-01-01T00:02:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(degraded).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(2);
      expect(responder.respond).not.toHaveBeenCalled();
      expect(scheduler.snapshots()[0]).toMatchObject({
        nextRunAt: "1970-01-01T00:03:00.000Z",
      });
    } finally {
      scheduler.stop();
    }
  });

  it("uses a keyset cursor that remains stable when a newer firing arrives", async () => {
    const { store } = await fixture();
    for (let minute = 1; minute <= 4; minute += 1) {
      const at = `2026-08-14T10:0${String(minute)}:00.000Z`;
      store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
    }
    const first = store.runs("digest", 2);
    expect(first.runs.map((run) => run.sequence)).toEqual([4, 3]);
    expect(first.nextCursor).toBeDefined();
    store.runNowAction({
      jobId: "digest",
      idempotencyKey: "newer-manual",
      requestHash: cronActionRequestHash({ action: "run_now", jobId: "digest" }),
      observedAt: "2026-08-14T10:05:00.000Z",
    });
    const second = store.runs("digest", 2, first.nextCursor);
    expect(second.runs.map((run) => run.sequence)).toEqual([2, 1]);
  });

  it("keeps 100-run pages compact, paginates older rows, and bounds one-run activity detail", async () => {
    const { store } = await fixture();
    const event = {
      type: "runtime_warning" as const,
      warningKind: "fixture",
      message: `activity ${"x".repeat(320)}`,
    };
    for (let index = 0; index < 101; index += 1) {
      const at = new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1_000).toISOString();
      const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
      for (let position = 0; position < 30; position += 1) store.appendEvent(firing, event);
      store.recordResult(succeeded(firing, `Result ${String(index)}`));
    }

    const first = store.runs("digest", 100);
    expect(first.runs).toHaveLength(100);
    expect(first.runs.every((run) => run.projection === "summary" && !("events" in run))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
    expect(first.nextCursor).toBeDefined();

    const legacyFullPage = {
      runs: first.runs.map((run) => ({ ...run, events: Array.from({ length: 30 }, () => event) })),
    };
    expect(Buffer.byteLength(JSON.stringify(legacyFullPage), "utf8")).toBeGreaterThan(1024 * 1024);

    const older = store.runs("digest", 100, first.nextCursor);
    expect(older.runs).toHaveLength(1);
    expect(older.nextCursor).toBeUndefined();
    const detail = store.getRun(first.runs[0]!.runId);
    expect(detail).toMatchObject({ projection: "detail", eventCount: 30, eventsIncluded: 30 });
    expect(Buffer.byteLength(JSON.stringify({ run: detail }), "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
  });

  it("marks oversized stored activity and human fields when the detail wire budget omits them", async () => {
    const { store } = await fixture();
    const at = "2026-08-14T10:00:00.000Z";
    const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
    store.appendEvent(firing, { type: "runtime_warning", message: "x".repeat(512 * 1024) });
    store.appendEvent(firing, { type: "runtime_warning", message: "y".repeat(1024 * 1024) });
    store.recordResult(succeeded(firing, "z".repeat(1024 * 1024)));

    const summary = store.lastRun("digest")!;
    expect(summary).toMatchObject({
      projection: "summary",
      eventCount: 1,
      eventsTruncated: true,
      fieldsTruncated: ["text"],
    });
    expect(Buffer.byteLength(summary.text!, "utf8")).toBeLessThanOrEqual(2 * 1024);

    const detail = store.getRun(firing.runId)!;
    expect(detail).toMatchObject({
      projection: "detail",
      eventCount: 1,
      eventsIncluded: 0,
      events: [],
      eventsTruncated: true,
      fieldsTruncated: ["text"],
    });
    expect(Buffer.byteLength(JSON.stringify({ run: detail }), "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
  });

  it("replays an evicted manual run from its bounded receipt without admitting it twice", async () => {
    const { store } = await fixture();
    const requestHash = cronActionRequestHash({ action: "run_now", jobId: "digest" });
    const manual = store.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
      observedAt: "2026-08-14T10:00:00.000Z",
    });
    store.recordResult(succeeded(manual.firing, "Manual terminal summary"));

    for (let index = 1; index <= 500; index += 1) {
      const at = new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1_000).toISOString();
      const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
      store.recordResult(succeeded(firing));
    }

    expect(store.getRun(manual.firing.runId)).toBeUndefined();
    expect(store.replayRunNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
    })).toMatchObject({
      runId: manual.firing.runId,
      status: "succeeded",
      text: "Manual terminal summary",
    });
    expect(store.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
      observedAt: "2026-08-14T11:00:00.000Z",
    })).toMatchObject({ replayed: true, firing: { runId: manual.firing.runId } });
    expect(store.runs("digest", 500).runs).toHaveLength(500);
  });

  it("reconciles every admitted, running, or queued firing as cancelled after restart", async () => {
    const { cwd, store } = await fixture();
    const admitted = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:01:00.000Z",
      observedAt: "2026-08-14T10:01:00.000Z",
      trigger: "scheduled",
    });
    const running = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:02:00.000Z",
      observedAt: "2026-08-14T10:02:00.000Z",
      trigger: "scheduled",
    });
    store.markStarted(running, "2026-08-14T10:02:00.000Z");
    const queued = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:03:00.000Z",
      observedAt: "2026-08-14T10:03:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult(terminal(queued, "queued"));
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await openCronControlStore(cwd, { now: () => new Date("2026-08-14T11:00:00.000Z") });
    stores.push(reopened);
    for (const firing of [admitted, running, queued]) {
      expect(reopened.getRun(firing.runId)).toMatchObject({
        status: "cancelled",
        completedAt: "2026-08-14T11:00:00.000Z",
        error: expect.stringContaining("restarted"),
      });
    }
  });
});
