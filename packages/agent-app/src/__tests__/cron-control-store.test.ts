import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_AGENT_REPLY_PARTS,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
  parseCronOperatorRunPage,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";
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
  type CronControlInitializationCheckpoint,
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
  // whose canonical spelling is /private/var. Keep that lexical product path
  // instead of hiding it with realpath().
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
  it("resumes every durable first-initialization boundary after an injected crash", async () => {
    const checkpoints: readonly CronControlInitializationCheckpoint[] = [
      "parent_ready",
      "initializing_root_ready",
      "initializing_marker_file_ready",
      "initializing_marker_ready",
      "database_file_ready",
      "database_schema_ready",
      "lease_file_ready",
      "lease_schema_ready",
      "permissions_ready",
      "ready_marker_ready",
      "published",
    ];

    for (const crashAt of checkpoints) {
      const cwd = await mkdtemp(join(tmpdir(), `mono-agent-cron-control-crash-${crashAt}-`));
      roots.push(cwd);
      let injected = false;
      await expect(openCronControlStore(cwd, {
        onInitializationCheckpoint(checkpoint) {
          if (!injected && checkpoint === crashAt) {
            injected = true;
            throw new Error(`injected crash at ${checkpoint}`);
          }
        },
      })).rejects.toThrow(`injected crash at ${crashAt}`);
      expect(injected).toBe(true);
      expect(await inspectCronControlStore(cwd)).toMatchObject({
        status: crashAt === "parent_ready"
          ? "absent"
          : crashAt === "published"
            ? "ready"
            : "initializing",
      });

      const reopened = await openCronControlStore(cwd);
      stores.push(reopened);
      expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
      await reopened.close();
      stores.splice(stores.indexOf(reopened), 1);
    }
  });

  it.skipIf(process.platform === "win32")("rejects an unsafe path injected into incomplete initialization", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-incomplete-link-"));
    const target = await mkdtemp(join(tmpdir(), "mono-agent-cron-control-incomplete-target-"));
    roots.push(cwd, target);
    await expect(openCronControlStore(cwd, {
      onInitializationCheckpoint(checkpoint) {
        if (checkpoint === "initializing_marker_ready") throw new Error("injected crash");
      },
    })).rejects.toThrow("injected crash");

    const paths = resolveCronControlPaths(await realpath(cwd));
    const initializingRoot = `${paths.root}.initializing`;
    const targetFile = join(target, "outside.sqlite");
    await writeFile(targetFile, "outside", { mode: 0o600 });
    await symlink(targetFile, join(initializingRoot, "state.sqlite"));

    expect(await inspectCronControlStore(cwd)).toMatchObject({
      status: "degraded",
      reason: expect.stringMatching(/single-link|regular file/iu),
    });
    await expect(openCronControlStore(cwd)).rejects.toMatchObject({ kind: "corrupt" });
  });

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

  it("never treats a completed store with a missing marker as recoverable initialization", async () => {
    const { cwd, store } = await fixture();
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const paths = resolveCronControlPaths(await realpath(cwd));
    await rm(paths.marker);

    expect(await inspectCronControlStore(cwd)).toMatchObject({
      status: "degraded",
      reason: expect.stringContaining("marker"),
    });
    await expect(openCronControlStore(cwd)).rejects.toMatchObject({ kind: "corrupt" });
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

  it("sanitizes, persists, projects, and reopens successful and cancelled reply-part outcomes", async () => {
    const { cwd, store } = await fixture();
    const requestHash = cronActionRequestHash({ action: "run_now", jobId: "digest" });
    const manual = store.runNowAction({
      jobId: "digest",
      idempotencyKey: "rich-outcome-run",
      requestHash,
      observedAt: "2026-08-14T10:00:00.000Z",
    });
    const sensitive = "/private/report.csv?token=secret";
    const hostileOutcomes = new Array<unknown>(23);
    hostileOutcomes[0] = {
      partIndex: 999,
      partType: "attachment",
      status: "failed",
      code: "artifact_missing",
      message: sensitive,
      localPath: sensitive,
    };
    store.recordResult({
      ...succeeded(manual.firing, "  exact durable text\n"),
      replyPartOutcomes: hostileOutcomes,
    } as CronJobResult);

    const cancelled = store.allocateFiring({
      jobId: "digest",
      scheduledAt: "2026-08-14T10:01:00.000Z",
      observedAt: "2026-08-14T10:01:00.000Z",
      trigger: "scheduled",
    });
    const cancelledOutcomes = [{
      partIndex: 0,
      partType: "failure" as const,
      status: "failed" as const,
      code: "artifact_missing" as const,
      message: "Reply part failed before destination delivery.",
    }];
    store.recordResult({
      kind: "cancelled",
      cronRunId: cancelled.runId,
      jobId: cancelled.jobId,
      scheduledAt: cancelled.scheduledAt,
      orderedAt: cancelled.orderedAt,
      sequence: cancelled.sequence,
      trigger: cancelled.trigger,
      startedAt: cancelled.orderedAt,
      completedAt: cancelled.orderedAt,
      error: "Cron job cancelled (responder resolved after abort).",
      replyPartOutcomes: cancelledOutcomes,
    });

    const succeededSummary = store.getRunSummary(manual.firing.runId);
    const succeededDetail = store.getRun(manual.firing.runId);
    expect(succeededSummary).toMatchObject({
      status: "succeeded",
      text: "  exact durable text\n",
      replyPartOutcomes: expect.arrayContaining([
        expect.objectContaining({ partIndex: 0, partType: "attachment", code: "unsupported_destination" }),
      ]),
    });
    expect(succeededSummary?.replyPartOutcomes).toHaveLength(MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES);
    expect(succeededDetail?.replyPartOutcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(succeededDetail?.replyPartOutcomes?.at(-1)).toMatchObject({ partIndex: 19, affectedPartCount: 4 });
    expect(succeededDetail?.replyPartOutcomes?.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES))
      .toEqual(succeededSummary?.replyPartOutcomes);
    expect(JSON.stringify(succeededSummary?.replyPartOutcomes)).not.toContain("null");
    expect(JSON.stringify(succeededSummary)).not.toContain(sensitive);
    expect(store.runs("digest", 10).runs).toEqual([
      expect.objectContaining({ status: "cancelled", replyPartOutcomes: cancelledOutcomes }),
      expect.objectContaining({ status: "succeeded", replyPartOutcomes: succeededSummary?.replyPartOutcomes }),
    ]);
    expect(store.lastRun("digest")).toMatchObject({
      status: "cancelled",
      error: "Cron job cancelled (responder resolved after abort).",
      replyPartOutcomes: cancelledOutcomes,
    });
    expect(store.replayRunNowAction({
      jobId: "digest",
      idempotencyKey: "rich-outcome-run",
      requestHash,
    })).toMatchObject({ replyPartOutcomes: succeededSummary?.replyPartOutcomes });

    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = new DatabaseSync(resolveCronControlPaths(await realpath(cwd)).database, { readOnly: true });
    const persisted = database.prepare(
      "SELECT reply_part_outcomes_json FROM cron_runs WHERE run_id = ?",
    ).get(manual.firing.runId) as { reply_part_outcomes_json: string };
    const receipt = database.prepare(
      "SELECT response_json FROM action_idempotency WHERE idempotency_key = ?",
    ).get("rich-outcome-run") as { response_json: string };
    database.close();
    expect(JSON.parse(persisted.reply_part_outcomes_json)).toMatchObject({
      schemaVersion: 1,
      replyPartOutcomes: succeededDetail?.replyPartOutcomes,
    });
    expect(Buffer.byteLength(persisted.reply_part_outcomes_json, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(persisted.reply_part_outcomes_json).not.toContain(sensitive);
    expect(JSON.parse(receipt.response_json)).not.toHaveProperty("run.replyPartOutcomes");

    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(reopened.getRun(manual.firing.runId)).toMatchObject({
      text: "  exact durable text\n",
      replyPartOutcomes: succeededDetail?.replyPartOutcomes,
    });
    expect(reopened.lastRun("digest")).toMatchObject({
      status: "cancelled",
      replyPartOutcomes: cancelledOutcomes,
    });
    expect(reopened.runs("digest", 10).runs).toEqual([
      expect.objectContaining({ status: "cancelled", replyPartOutcomes: cancelledOutcomes }),
      expect.objectContaining({ status: "succeeded", replyPartOutcomes: succeededSummary?.replyPartOutcomes }),
    ]);
    expect(reopened.replayRunNowAction({
      jobId: "digest",
      idempotencyKey: "rich-outcome-run",
      requestHash,
    })).toMatchObject({ replyPartOutcomes: succeededSummary?.replyPartOutcomes });
  });

  it("treats future persisted outcome schemas as unavailable across reopened public projections", async () => {
    const { cwd, store } = await fixture();
    const firing = store.allocateFiring({
      jobId: "future-outcomes",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult({
      ...succeeded(firing, "future-compatible text"),
      replyPartOutcomes: [{
        partIndex: 0,
        partType: "attachment",
        status: "failed",
        code: "unsupported_destination",
        message: "Attachment reply parts are unsupported on this destination.",
      }],
    } as CronJobResult);
    const databasePath = store.paths.database;
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE cron_runs SET reply_part_outcomes_json = ? WHERE run_id = ?")
      .run(JSON.stringify({
        schemaVersion: 2,
        replyPartOutcomes: { futureShape: true },
        futureMetadata: "not interpreted after rollback",
      }), firing.runId);
    database.close();

    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    const projections = [
      reopened.getRun(firing.runId),
      reopened.getRunSummary(firing.runId),
      reopened.lastRun("future-outcomes"),
      reopened.runs("future-outcomes", 10).runs[0],
    ];
    for (const projection of projections) {
      expect(projection).toMatchObject({
        runId: firing.runId,
        status: "succeeded",
        text: "future-compatible text",
      });
      expect(projection).not.toHaveProperty("replyPartOutcomes");
    }
  });

  it("upgrades schema-1 stores without the additive outcome column and keeps older rows readable", async () => {
    const { cwd, store } = await fixture();
    const firing = store.allocateFiring({
      jobId: "legacy",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult(succeeded(firing, "legacy text"));
    const databasePath = store.paths.database;
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE cron_runs DROP COLUMN reply_part_outcomes_json");
    legacy.close();

    expect(await inspectCronControlStore(cwd)).toMatchObject({ status: "ready" });
    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(reopened.getRun(firing.runId)).toMatchObject({ status: "succeeded", text: "legacy text" });
    expect(reopened.getRun(firing.runId)).not.toHaveProperty("replyPartOutcomes");
    const upgraded = new DatabaseSync(reopened.paths.database, { readOnly: true });
    expect((upgraded.prepare("PRAGMA table_info(cron_runs)").all() as Array<{ name: string }>)
      .some((column) => column.name === "reply_part_outcomes_json")).toBe(true);
    upgraded.close();
  });

  it("rejects malformed, oversized, and invalid current-schema outcome envelopes before projection", async () => {
    const { cwd, store } = await fixture();
    const corrupt = store.allocateFiring({
      jobId: "corrupt-outcomes",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    const oversized = store.allocateFiring({
      jobId: "oversized-outcomes",
      scheduledAt: "2026-08-14T10:01:00.000Z",
      observedAt: "2026-08-14T10:01:00.000Z",
      trigger: "scheduled",
    });
    const invalidCurrent = store.allocateFiring({
      jobId: "invalid-current-outcomes",
      scheduledAt: "2026-08-14T10:02:00.000Z",
      observedAt: "2026-08-14T10:02:00.000Z",
      trigger: "scheduled",
    });
    store.recordResult(succeeded(corrupt));
    store.recordResult(succeeded(oversized));
    store.recordResult(succeeded(invalidCurrent));
    const databasePath = store.paths.database;
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE cron_runs SET reply_part_outcomes_json = ? WHERE run_id = ?")
      .run("{not-json", corrupt.runId);
    database.prepare("UPDATE cron_runs SET reply_part_outcomes_json = ? WHERE run_id = ?")
      .run(`${" ".repeat(20_000)}{\"schemaVersion\":1,\"replyPartOutcomes\":[]}`, oversized.runId);
    database.prepare("UPDATE cron_runs SET reply_part_outcomes_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ schemaVersion: 1, replyPartOutcomes: [] }), invalidCurrent.runId);
    database.close();

    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(() => reopened.getRun(corrupt.runId)).toThrowError(
      expect.objectContaining({ kind: "corrupt" }),
    );
    expect(() => reopened.getRunSummary(oversized.runId)).toThrowError(
      expect.objectContaining({ kind: "corrupt" }),
    );
    expect(() => reopened.getRun(invalidCurrent.runId)).toThrowError(
      expect.objectContaining({ kind: "corrupt" }),
    );
  });

  it("keeps the first terminal result immutable against late results and stream events", async () => {
    const { store } = await fixture();
    const firing = store.allocateFiring({
      jobId: "first-terminal-wins",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      observedAt: "2026-08-14T10:00:00.000Z",
      trigger: "scheduled",
    });
    store.markStarted(firing, firing.orderedAt);
    store.appendEvent(firing, { type: "runtime_warning", message: "before terminal" });
    const firstOutcomes = [{
      partIndex: 0,
      partType: "failure" as const,
      status: "failed" as const,
      code: "artifact_missing" as const,
      message: "Reply part failed before destination delivery.",
    }];
    store.recordResult({
      kind: "cancelled",
      cronRunId: firing.runId,
      jobId: firing.jobId,
      scheduledAt: firing.scheduledAt,
      orderedAt: firing.orderedAt,
      sequence: firing.sequence,
      trigger: firing.trigger,
      startedAt: firing.orderedAt,
      completedAt: firing.orderedAt,
      error: "first terminal cancellation",
      replyPartOutcomes: firstOutcomes,
    });

    const lateSensitive = "/private/late.txt?token=secret";
    store.recordResult({
      ...succeeded(firing, lateSensitive),
      replyPartOutcomes: [{
        partIndex: 99,
        partType: "attachment",
        status: "failed",
        code: "artifact_missing",
        message: lateSensitive,
      }],
    } as CronJobResult);
    let lateEventSerialized = false;
    const lateEvent = { type: "runtime_warning" } as Record<string, unknown>;
    Object.defineProperty(lateEvent, "message", {
      enumerable: true,
      get() {
        lateEventSerialized = true;
        return lateSensitive;
      },
    });
    expect(() => store.appendEvent(firing, lateEvent as unknown as AgentStreamEvent)).not.toThrow();

    const projected = store.getRun(firing.runId);
    expect(projected).toMatchObject({
      status: "cancelled",
      error: "first terminal cancellation",
      eventCount: 1,
      events: [{ type: "runtime_warning", message: "before terminal" }],
      replyPartOutcomes: firstOutcomes,
    });
    expect(projected).not.toHaveProperty("text");
    expect(JSON.stringify(projected)).not.toContain(lateSensitive);
    expect(lateEventSerialized).toBe(false);
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
    const replyPartOutcomes = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, partIndex) => ({
      partIndex,
      partType: "failure" as const,
      status: "failed" as const,
      code: "artifact_integrity_failed" as const,
      message: "Reply part failed before destination delivery.",
    }));
    for (let index = 0; index < 101; index += 1) {
      const at = new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1_000).toISOString();
      const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
      if (index === 100) {
        for (let position = 0; position < 30; position += 1) store.appendEvent(firing, event);
      }
      store.recordResult({
        ...succeeded(firing, `Result ${String(index)}`),
        replyPartOutcomes,
      } as CronJobResult);
    }

    const first = store.runs("digest", 100);
    expect(first.runs).toHaveLength(100);
    expect(first.runs.every((run) => run.projection === "summary" && !("events" in run))).toBe(true);
    expect(first.runs.every((run) =>
      run.replyPartOutcomes?.length === MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES)).toBe(true);
    expect(first.runs[0]?.replyPartOutcomes).toEqual(
      replyPartOutcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES),
    );
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
    expect(detail?.replyPartOutcomes).toEqual(replyPartOutcomes);
    expect(Buffer.byteLength(JSON.stringify({ run: detail }), "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
  });

  it("byte-paginates hostile-maximal stored summaries with monotonic nonempty progress", async () => {
    const { cwd, store } = await fixture();
    const replyPartOutcomes = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, partIndex) => ({
      partIndex,
      partType: "failure" as const,
      status: "failed" as const,
      code: "artifact_integrity_failed" as const,
      message: "Reply part failed before destination delivery.",
    }));
    for (let index = 1; index <= 101; index += 1) {
      const at = new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1_000).toISOString();
      const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
      store.recordResult({ ...succeeded(firing), replyPartOutcomes } as CronJobResult);
    }

    const database = new DatabaseSync(resolveCronControlPaths(await realpath(cwd)).database);
    try {
      const update = database.prepare(`
        UPDATE cron_runs SET run_id = ?, artifact_run_id = ?, text = ?, error = ?, failure_kind = ?,
          blocked_by_run_id = ?, blocked_by_trigger = 'manual', queue_depth = ?, event_count = 256,
          events_truncated = 1
        WHERE sequence = ?
      `);
      for (let sequence = 1; sequence <= 101; sequence += 1) {
        update.run(
          `${"r".repeat(2_040)}${String(sequence).padStart(8, "0")}`,
          "a".repeat(513),
          "t".repeat(2_049),
          "e".repeat(513),
          "f".repeat(129),
          "b".repeat(2_048),
          Number.MAX_SAFE_INTEGER,
          sequence,
        );
      }
    } finally {
      database.close();
    }

    const sequences: number[] = [];
    const pageLengths: number[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = store.runs("digest", 100, before);
      pages += 1;
      expect(page.runs.length).toBeGreaterThan(0);
      pageLengths.push(page.runs.length);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        MAX_CRON_OPERATOR_RESPONSE_BYTES,
      );
      expect(parseCronOperatorRunPage(page)).toEqual(page);
      sequences.push(...page.runs.map((run) => run.sequence));
      before = page.nextCursor;
    } while (before !== undefined);

    expect(pages).toBeGreaterThan(1);
    expect(pageLengths[0]).toBeLessThan(100);
    expect(sequences).toEqual(Array.from({ length: 101 }, (_, index) => 101 - index));
    expect(new Set(sequences).size).toBe(101);
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

  it("reopens and replays an evicted manual run from a rollback-safe receipt without admitting it twice", async () => {
    const { cwd, store } = await fixture();
    const requestHash = cronActionRequestHash({ action: "run_now", jobId: "digest" });
    const manual = store.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
      observedAt: "2026-08-14T10:00:00.000Z",
    });
    const replayOutcomes = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, partIndex) => ({
      partIndex,
      partType: "attachment" as const,
      status: "failed" as const,
      code: "unsupported_destination" as const,
      message: "Attachment reply parts are unsupported on this destination.",
    }));
    store.recordResult({
      ...succeeded(manual.firing, "Manual terminal summary"),
      replyPartOutcomes: replayOutcomes,
    } as CronJobResult);

    for (let index = 1; index <= 500; index += 1) {
      const at = new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1_000).toISOString();
      const firing = store.allocateFiring({ jobId: "digest", scheduledAt: at, observedAt: at, trigger: "scheduled" });
      store.recordResult(succeeded(firing));
    }

    expect(store.getRun(manual.firing.runId)).toBeUndefined();
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(resolveCronControlPaths(await realpath(cwd)).database);
    const persisted = database.prepare(
      "SELECT response_json FROM action_idempotency WHERE idempotency_key = ?",
    ).get("manual-evicted") as { response_json: string };
    const receipt = JSON.parse(persisted.response_json) as { run: Record<string, unknown> };
    const rollbackRunKeys = new Set([
      "projection", "runId", "jobId", "scheduledAt", "orderedAt", "sequence", "trigger", "status",
      "startedAt", "completedAt", "artifactRunId", "text", "error", "failureKind", "blockedByRunId",
      "blockedByTrigger", "queueDepth", "eventCount", "fieldsTruncated", "eventsTruncated",
    ]);
    expect(Object.keys(receipt)).toEqual(["run"]);
    expect(Object.keys(receipt.run).every((key) => rollbackRunKeys.has(key))).toBe(true);
    expect(receipt.run).not.toHaveProperty("replyPartOutcomes");
    // An intermediate rich-outcome build wrote the full 20-record detail
    // contract into this rollback receipt. Preserve replay compatibility while
    // ensuring the current compact-summary ceiling is restored after reopen.
    database.prepare(`
      UPDATE action_idempotency SET response_json = ? WHERE idempotency_key = ?
    `).run(JSON.stringify({
      run: { ...receipt.run, replyPartOutcomes: replayOutcomes },
    }), "manual-evicted");
    database.close();

    const reopened = await openCronControlStore(cwd);
    stores.push(reopened);
    expect(reopened.getRun(manual.firing.runId)).toBeUndefined();
    const replay = reopened.replayRunNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
    });
    expect(replay).toMatchObject({
      runId: manual.firing.runId,
      status: "succeeded",
      text: "Manual terminal summary",
      replyPartOutcomes: replayOutcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES),
    });
    expect(replay?.replyPartOutcomes).toHaveLength(MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES);
    const replayedAction = reopened.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-evicted",
      requestHash,
      observedAt: "2026-08-14T11:00:00.000Z",
    });
    expect(replayedAction).toMatchObject({
      replayed: true,
      firing: { runId: manual.firing.runId },
      run: { replyPartOutcomes: replayOutcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES) },
    });
    expect(reopened.runs("digest", 500).runs).toHaveLength(500);
  });

  it("retains same-timestamp idempotency receipts deterministically by key", async () => {
    const timestamp = "2026-08-14T10:00:00.000Z";
    const { store } = await fixture(() => new Date(timestamp));
    store.syncConfiguredJobs(["digest"]);

    const database = new DatabaseSync(store.paths.database);
    database.exec("BEGIN IMMEDIATE");
    try {
      const insert = database.prepare(`
        INSERT INTO action_idempotency (
          idempotency_key, action, job_id, request_hash, response_json, target_run_id, created_at
        ) VALUES (?, 'set_enabled', 'digest', 'fixture-hash', '{"enabled":true}', NULL, ?)
      `);
      for (let index = 0; index < 2_048; index += 1) {
        insert.run(`receipt-${String(index).padStart(4, "0")}`, timestamp);
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    store.setEnabledAction({
      jobId: "digest",
      enabled: true,
      idempotencyKey: "zz-current",
      requestHash: cronActionRequestHash({ action: "set_enabled", jobId: "digest", enabled: true }),
    });

    const retained = new DatabaseSync(store.paths.database, { readOnly: true });
    try {
      const keys = (retained.prepare(`
        SELECT idempotency_key FROM action_idempotency ORDER BY idempotency_key
      `).all() as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key);
      expect(keys).toHaveLength(2_048);
      expect(keys).not.toContain("receipt-0000");
      expect(keys).toContain("receipt-0001");
      expect(keys).toContain("receipt-2047");
      expect(keys).toContain("zz-current");
    } finally {
      retained.close();
    }
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

  it("rolls back interrupted-run reconciliation when its receipt update fails, then replays deterministically", async () => {
    const { cwd, store } = await fixture();
    const requestHash = cronActionRequestHash({ action: "run_now", jobId: "digest" });
    const manual = store.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-reconcile",
      requestHash,
      observedAt: "2026-08-14T10:00:00.000Z",
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const injector = new DatabaseSync(store.paths.database);
    try {
      injector.exec(`
        CREATE TRIGGER fail_reconciliation_receipt
        BEFORE UPDATE OF response_json ON action_idempotency
        WHEN OLD.idempotency_key = 'manual-reconcile'
        BEGIN
          SELECT RAISE(ABORT, 'injected receipt update failure');
        END;
      `);
    } finally {
      injector.close();
    }

    await expect(openCronControlStore(cwd, {
      now: () => new Date("2026-08-14T11:00:00.000Z"),
    })).rejects.toThrow(/injected receipt update failure/iu);

    const afterFailure = new DatabaseSync(store.paths.database);
    try {
      const run = afterFailure.prepare("SELECT status FROM cron_runs WHERE run_id = ?")
        .get(manual.firing.runId) as { status: string };
      const receipt = afterFailure.prepare(`
        SELECT response_json FROM action_idempotency WHERE idempotency_key = 'manual-reconcile'
      `).get() as { response_json: string };
      expect(run.status).toBe("admitted");
      expect(JSON.parse(receipt.response_json)).toMatchObject({ run: { status: "admitted" } });
      afterFailure.exec("DROP TRIGGER fail_reconciliation_receipt");
    } finally {
      afterFailure.close();
    }

    const reopened = await openCronControlStore(cwd, {
      now: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    stores.push(reopened);
    expect(reopened.getRun(manual.firing.runId)).toMatchObject({
      status: "cancelled",
      completedAt: "2026-08-14T11:00:00.000Z",
    });
    expect(reopened.replayRunNowAction({
      jobId: "digest",
      idempotencyKey: "manual-reconcile",
      requestHash,
    })).toMatchObject({ runId: manual.firing.runId, status: "cancelled" });
    expect(reopened.runNowAction({
      jobId: "digest",
      idempotencyKey: "manual-reconcile",
      requestHash,
      observedAt: "2026-08-14T12:00:00.000Z",
    })).toMatchObject({ replayed: true, firing: { runId: manual.firing.runId } });
    expect(reopened.runs("digest", 10).runs).toHaveLength(1);
  });
});
