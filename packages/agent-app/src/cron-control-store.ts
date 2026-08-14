import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MAX_CRON_OPERATOR_DETAIL_ARTIFACT_ID_BYTES,
  MAX_CRON_OPERATOR_DETAIL_ERROR_BYTES,
  MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES,
  MAX_CRON_OPERATOR_DETAIL_EVENTS,
  MAX_CRON_OPERATOR_DETAIL_FAILURE_KIND_BYTES,
  MAX_CRON_OPERATOR_DETAIL_TEXT_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_ARTIFACT_ID_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_ERROR_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_FAILURE_KIND_BYTES,
  MAX_CRON_OPERATOR_SUMMARY_TEXT_BYTES,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";
import type { CronFiringIdentity, CronJobResult, CronRunTrigger } from "@mono-agent/cron-adapter";
import type {
  CronOperatorRun,
  CronOperatorRunBase,
  CronOperatorRunDetail,
  CronOperatorRunPage,
  CronOperatorRunSummary,
  CronOperatorRunTruncatedField,
} from "@mono-agent/operator-adapter";

const CONTROL_SCHEMA = 1;
const CONTROL_MARKER = ".mono-agent-cron-control";
const CONTROL_DATABASE = "state.sqlite";
const CONTROL_LEASE = "lease.sqlite";
const CONTROL_INITIALIZING_SUFFIX = ".initializing";
const MARKER_CONTENT = `${JSON.stringify({ kind: "mono-agent-cron-control", schema: CONTROL_SCHEMA })}\n`;
const INITIALIZING_MARKER_CONTENT = `${JSON.stringify({
  kind: "mono-agent-cron-control",
  schema: CONTROL_SCHEMA,
  state: "initializing",
})}\n`;
const MAX_RUNS_PER_JOB = 500;
const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const MAX_IDEMPOTENCY_RECORDS = 2_048;
const MAX_AUDIT_RECORDS = 5_000;
const MAX_EVENTS_PER_RUN = MAX_CRON_OPERATOR_DETAIL_EVENTS;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES_PER_RUN = 4 * 1024 * 1024;
const MAX_DETAIL_EVENT_BYTES = MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES;
const MAX_SUMMARY_TEXT_BYTES = MAX_CRON_OPERATOR_SUMMARY_TEXT_BYTES;
const MAX_SUMMARY_ERROR_BYTES = MAX_CRON_OPERATOR_SUMMARY_ERROR_BYTES;
const MAX_DETAIL_TEXT_BYTES = MAX_CRON_OPERATOR_DETAIL_TEXT_BYTES;
const MAX_DETAIL_ERROR_BYTES = MAX_CRON_OPERATOR_DETAIL_ERROR_BYTES;
const MAX_SUMMARY_ARTIFACT_ID_BYTES = MAX_CRON_OPERATOR_SUMMARY_ARTIFACT_ID_BYTES;
const MAX_DETAIL_ARTIFACT_ID_BYTES = MAX_CRON_OPERATOR_DETAIL_ARTIFACT_ID_BYTES;
const MAX_SUMMARY_FAILURE_KIND_BYTES = MAX_CRON_OPERATOR_SUMMARY_FAILURE_KIND_BYTES;
const MAX_DETAIL_FAILURE_KIND_BYTES = MAX_CRON_OPERATOR_DETAIL_FAILURE_KIND_BYTES;
// Inspection runs synchronously during config load. A bounded wait absorbs a
// brief DELETE-journal writer handoff without letting sustained contention
// stall reload indefinitely or be mistaken for a permanently corrupt store.
const INSPECTION_BUSY_TIMEOUT_MS = 500;

export interface CronControlPaths {
  readonly root: string;
  readonly marker: string;
  readonly database: string;
  readonly lease: string;
}

export type CronControlInspection =
  | { readonly status: "absent" }
  | { readonly status: "initializing" }
  | { readonly status: "ready"; readonly overrides: ReadonlyMap<string, boolean> }
  | { readonly status: "degraded"; readonly reason: string };

export type CronControlInitializationCheckpoint =
  | "parent_ready"
  | "initializing_root_ready"
  | "initializing_marker_file_ready"
  | "initializing_marker_ready"
  | "database_file_ready"
  | "database_schema_ready"
  | "lease_file_ready"
  | "lease_schema_ready"
  | "permissions_ready"
  | "ready_marker_ready"
  | "published";

export interface OpenCronControlStoreOptions {
  readonly now?: () => Date;
  /** Test seam for simulating process death after one durable initialization boundary. */
  readonly onInitializationCheckpoint?: (
    checkpoint: CronControlInitializationCheckpoint,
  ) => void | Promise<void>;
}

export class CronControlStoreError extends Error {
  readonly kind: "corrupt" | "insecure" | "lease_conflict" | "idempotency_conflict" | "replay_expired";

  constructor(kind: CronControlStoreError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CronControlStoreError";
    this.kind = kind;
  }
}

export interface CronControlStore {
  readonly paths: CronControlPaths;
  overrides(): ReadonlyMap<string, boolean>;
  syncConfiguredJobs(jobIds: readonly string[]): void;
  knownJobIds(): readonly string[];
  allocateFiring(input: {
    readonly jobId: string;
    readonly scheduledAt: string;
    readonly observedAt: string;
    readonly trigger: CronRunTrigger;
  }): CronFiringIdentity;
  replayRunNowAction(input: {
    readonly jobId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): CronOperatorRunSummary | undefined;
  runNowAction(input: {
    readonly jobId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly observedAt: string;
  }): {
    readonly firing: CronFiringIdentity;
    readonly run?: CronOperatorRunSummary;
    readonly replayed: boolean;
  };
  replayEnabledAction(input: {
    readonly jobId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): boolean | undefined;
  setEnabledAction(input: {
    readonly jobId: string;
    readonly enabled: boolean;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): { readonly enabled: boolean; readonly replayed: boolean };
  markStarted(firing: CronFiringIdentity, startedAt: string): void;
  appendEvent(firing: CronFiringIdentity, event: AgentStreamEvent): void;
  recordResult(result: CronJobResult): void;
  getRun(runId: string): CronOperatorRunDetail | undefined;
  getRunSummary(runId: string): CronOperatorRunSummary | undefined;
  lastRun(jobId: string): CronOperatorRunSummary | undefined;
  runs(jobId: string, limit: number, before?: string): CronOperatorRunPage;
  audit(input: {
    readonly action: string;
    readonly jobId?: string;
    readonly outcome: string;
    readonly idempotencyKey?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }): void;
  close(): Promise<void>;
}

export function resolveCronControlPaths(cwd: string): CronControlPaths {
  const root = resolve(cwd, ".mono-agent", "cron-control-v1");
  return {
    root,
    marker: join(root, CONTROL_MARKER),
    database: join(root, CONTROL_DATABASE),
    lease: join(root, CONTROL_LEASE),
  };
}

export async function inspectCronControlStore(cwd: string): Promise<CronControlInspection> {
  try {
    const paths = await resolveCanonicalCronControlPaths(cwd);
    const initializingPaths = initializationPaths(paths);
    const root = await lstatIfPresent(paths.root);
    if (root === undefined) {
      const initializingRoot = await lstatIfPresent(initializingPaths.root);
      if (initializingRoot === undefined) return { status: "absent" };
      await assertRecoverableInitialization(initializingPaths, initializingRoot);
      return { status: "initializing" };
    }
    if (await lstatIfPresent(initializingPaths.root) !== undefined) {
      throw new CronControlStoreError(
        "corrupt",
        `Cron control state has an ambiguous completed and initializing root: ${paths.root}`,
      );
    }
    return { status: "ready", overrides: await inspectReadyControlStore(paths, root) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "degraded", reason };
  }
}

export async function openCronControlStore(
  cwd: string,
  options: OpenCronControlStoreOptions = {},
): Promise<CronControlStore> {
  // The caller-selected agent cwd is the trust boundary. Canonicalize that
  // boundary once so platform aliases above it (notably macOS /var ->
  // /private/var) do not look like attacker-controlled links in our state
  // subtree. The strict realpath checks below still reject links introduced in
  // .mono-agent/cron-control-v1 itself.
  const canonicalCwd = await realpath(resolve(cwd));
  const paths = resolveCronControlPaths(canonicalCwd);
  const initial = await inspectCronControlStore(canonicalCwd);
  if (initial.status === "absent" || initial.status === "initializing") {
    await initializeControlStore(paths, options.onInitializationCheckpoint);
  } else if (initial.status === "degraded") {
    throw new CronControlStoreError("corrupt", initial.reason);
  }
  // Re-run the bounded structural/path inspection immediately before opening
  // the lease. This retains the managed-subtree swap checks without repeating
  // the whole-database quick_check.
  const verified = await inspectCronControlStore(canonicalCwd);
  if (verified.status !== "ready") {
    throw new CronControlStoreError(
      "corrupt",
      verified.status === "degraded" ? verified.reason : "Cron control state disappeared during startup.",
    );
  }

  const lease = new DatabaseSync(paths.lease, { timeout: 0 });
  try {
    lease.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    lease.close();
    throw new CronControlStoreError(
      "lease_conflict",
      `Cron control state is already owned by another live process: ${paths.root}`,
      { cause: error },
    );
  }
  const releaseLease = (): void => {
    try {
      if (lease.isTransaction) lease.exec("ROLLBACK");
    } finally {
      lease.close();
    }
  };
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(paths.database, { timeout: 5_000 });
  } catch (error) {
    releaseLease();
    throw error;
  }
  const now = options.now ?? (() => new Date());
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;");
    // This is intentionally the only O(database) health check in the normal
    // inspect -> open lifecycle. It runs after exclusive ownership is proven
    // and before interrupted-run reconciliation or any scheduler admission.
    assertHealthyDatabase(database);
    ensureControlSchemaColumns(database);
    reconcileInterruptedRuns(database, now().toISOString());
  } catch (error) {
    database.close();
    releaseLease();
    throw error;
  }

  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new CronControlStoreError("corrupt", "Cron control store is closed.");
  };
  const withTransaction = <T>(operation: () => T): T => {
    requireOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };
  const allocate = (input: {
    readonly jobId: string;
    readonly scheduledAt: string;
    readonly observedAt: string;
    readonly trigger: CronRunTrigger;
  }): CronFiringIdentity => {
    const previous = database.prepare("SELECT last_sequence FROM job_sequences WHERE job_id = ?")
      .get(input.jobId) as { last_sequence: number } | undefined;
    const sequence = (previous?.last_sequence ?? 0) + 1;
    database.prepare(`
      INSERT INTO job_sequences (job_id, last_sequence) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET last_sequence = excluded.last_sequence
    `).run(input.jobId, sequence);
    const runId = input.trigger === "manual"
      ? `cron:${encodeURIComponent(input.jobId)}:${input.observedAt}:m${String(sequence)}`
      : `cron:${encodeURIComponent(input.jobId)}:${input.scheduledAt}`;
    database.prepare(`
      INSERT INTO cron_runs (
        run_id, job_id, scheduled_at, ordered_at, sequence, trigger, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?)
    `).run(runId, input.jobId, input.scheduledAt, input.observedAt, sequence, input.trigger, input.observedAt);
    return {
      runId,
      jobId: input.jobId,
      scheduledAt: input.scheduledAt,
      orderedAt: input.observedAt,
      sequence,
      trigger: input.trigger,
    };
  };

  return {
    paths,
    overrides() {
      requireOpen();
      return new Map((database.prepare(
        "SELECT job_id, runtime_enabled FROM job_controls WHERE runtime_enabled IS NOT NULL ORDER BY job_id",
      ).all() as Array<{ job_id: string; runtime_enabled: number }>).map((row) => [row.job_id, row.runtime_enabled === 1]));
    },
    syncConfiguredJobs(jobIds) {
      withTransaction(() => {
        const timestamp = now().toISOString();
        const statement = database.prepare(`
          INSERT INTO cron_jobs (job_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
          ON CONFLICT(job_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `);
        for (const jobId of jobIds) statement.run(jobId, timestamp, timestamp);
      });
    },
    knownJobIds() {
      requireOpen();
      return (database.prepare("SELECT job_id FROM cron_jobs ORDER BY job_id").all() as Array<{ job_id: string }>)
        .map((row) => row.job_id);
    },
    allocateFiring(input) {
      return withTransaction(() => allocate(input));
    },
    replayRunNowAction(input) {
      requireOpen();
      const replay = idempotencyRecord(database, input.idempotencyKey, "run_now", input.jobId, input.requestHash);
      if (replay === undefined) return undefined;
      const stored = parseRunNowReceipt(replay);
      const runId = typeof stored === "string" ? stored : stored.runId;
      const record = runRow(database, runId);
      if (record !== undefined) return operatorRunSummary(record);
      if (typeof stored !== "string") return stored;
      throw new CronControlStoreError(
        "replay_expired",
        `Cron action replay expired after run retention: ${runId}`,
      );
    },
    runNowAction(input) {
      return withTransaction(() => {
        const replay = idempotencyRecord(database, input.idempotencyKey, "run_now", input.jobId, input.requestHash);
        if (replay !== undefined) {
          const stored = parseRunNowReceipt(replay);
          const runId = typeof stored === "string" ? stored : stored.runId;
          const record = runRow(database, runId);
          if (record !== undefined) {
            return { firing: firingFromRow(record), run: operatorRunSummary(record), replayed: true };
          }
          if (typeof stored !== "string") {
            return { firing: firingFromOperatorRun(stored), run: stored, replayed: true };
          }
          throw new CronControlStoreError(
            "replay_expired",
            `Cron action replay expired after run retention: ${runId}`,
          );
        }
        const firing = allocate({
          jobId: input.jobId,
          scheduledAt: input.observedAt,
          observedAt: input.observedAt,
          trigger: "manual",
        });
        const allocated = runRow(database, firing.runId);
        if (allocated === undefined) {
          throw new CronControlStoreError("corrupt", "Allocated cron run is missing.");
        }
        const run = operatorRunSummary(allocated);
        insertIdempotency(database, {
          key: input.idempotencyKey,
          action: "run_now",
          jobId: input.jobId,
          requestHash: input.requestHash,
          response: JSON.stringify({ run }),
          targetRunId: firing.runId,
          createdAt: input.observedAt,
        });
        insertAudit(database, {
          action: "run_now",
          jobId: input.jobId,
          outcome: "accepted",
          idempotencyKey: input.idempotencyKey,
          detail: { runId: firing.runId },
          createdAt: input.observedAt,
        });
        applyRetention(database, now());
        return { firing, run, replayed: false };
      });
    },
    replayEnabledAction(input) {
      requireOpen();
      const replay = idempotencyRecord(database, input.idempotencyKey, "set_enabled", input.jobId, input.requestHash);
      if (replay === undefined) return undefined;
      const parsed = JSON.parse(replay) as { enabled?: unknown };
      if (typeof parsed.enabled !== "boolean") {
        throw new CronControlStoreError("corrupt", "Stored cron enable idempotency result is invalid.");
      }
      return parsed.enabled;
    },
    setEnabledAction(input) {
      return withTransaction(() => {
        const replay = idempotencyRecord(database, input.idempotencyKey, "set_enabled", input.jobId, input.requestHash);
        if (replay !== undefined) {
          const parsed = JSON.parse(replay) as { enabled?: unknown };
          if (typeof parsed.enabled !== "boolean") {
            throw new CronControlStoreError("corrupt", "Stored cron enable idempotency result is invalid.");
          }
          return { enabled: parsed.enabled, replayed: true };
        }
        const timestamp = now().toISOString();
        database.prepare(`
          INSERT INTO job_controls (job_id, runtime_enabled, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(job_id) DO UPDATE SET runtime_enabled = excluded.runtime_enabled, updated_at = excluded.updated_at
        `).run(input.jobId, input.enabled ? 1 : 0, timestamp);
        insertIdempotency(database, {
          key: input.idempotencyKey,
          action: "set_enabled",
          jobId: input.jobId,
          requestHash: input.requestHash,
          response: JSON.stringify({ enabled: input.enabled }),
          createdAt: timestamp,
        });
        insertAudit(database, {
          action: input.enabled ? "enable" : "disable",
          jobId: input.jobId,
          outcome: "completed",
          idempotencyKey: input.idempotencyKey,
          detail: { effectiveEnabled: input.enabled },
          createdAt: timestamp,
        });
        applyRetention(database, now());
        return { enabled: input.enabled, replayed: false };
      });
    },
    markStarted(firing, startedAt) {
      requireOpen();
      database.prepare(`
        UPDATE cron_runs SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE run_id = ?
      `).run(startedAt, firing.runId);
    },
    appendEvent(firing, event) {
      withTransaction(() => {
        const encoded = JSON.stringify(event);
        const bytes = Buffer.byteLength(encoded, "utf8");
        const row = database.prepare(`
          SELECT event_count, event_bytes FROM cron_runs WHERE run_id = ?
        `).get(firing.runId) as { event_count: number; event_bytes: number } | undefined;
        if (row === undefined) throw new CronControlStoreError("corrupt", `Unknown cron run: ${firing.runId}`);
        if (
          bytes > MAX_EVENT_BYTES
          || row.event_count >= MAX_EVENTS_PER_RUN
          || row.event_bytes + bytes > MAX_EVENT_BYTES_PER_RUN
        ) {
          database.prepare("UPDATE cron_runs SET events_truncated = 1 WHERE run_id = ?").run(firing.runId);
          return;
        }
        database.prepare(`
          INSERT INTO cron_run_events (run_id, position, event_json, bytes) VALUES (?, ?, ?, ?)
        `).run(firing.runId, row.event_count + 1, encoded, bytes);
        database.prepare(`
          UPDATE cron_runs SET event_count = event_count + 1, event_bytes = event_bytes + ? WHERE run_id = ?
        `).run(bytes, firing.runId);
      });
    },
    recordResult(result) {
      withTransaction(() => {
        const fields = resultFields(result);
        const changed = database.prepare(`
          UPDATE cron_runs SET
            status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, artifact_run_id = ?,
            text = ?, error = ?, failure_kind = ?, blocked_by_run_id = ?, blocked_by_trigger = ?, queue_depth = ?
          WHERE run_id = ?
        `).run(
          fields.status,
          fields.startedAt ?? null,
          fields.completedAt ?? null,
          fields.artifactRunId ?? null,
          fields.text ?? null,
          fields.error ?? null,
          fields.failureKind ?? null,
          fields.blockedByRunId ?? null,
          fields.blockedByTrigger ?? null,
          fields.queueDepth ?? null,
          result.cronRunId,
        );
        if (changed.changes !== 1) {
          throw new CronControlStoreError("corrupt", `Unknown cron run result: ${result.cronRunId}`);
        }
        const completed = runRow(database, result.cronRunId);
        if (completed === undefined) {
          throw new CronControlStoreError("corrupt", `Updated cron run is missing: ${result.cronRunId}`);
        }
        updateRunNowReceipt(database, completed);
        if (fields.completedAt !== undefined) applyRetention(database, now());
      });
    },
    getRun(runId) {
      requireOpen();
      const row = runRow(database, runId);
      return row === undefined ? undefined : operatorRunDetail(database, row);
    },
    getRunSummary(runId) {
      requireOpen();
      const row = runRow(database, runId);
      return row === undefined ? undefined : operatorRunSummary(row);
    },
    lastRun(jobId) {
      requireOpen();
      const row = database.prepare(`${RUN_SELECT} WHERE job_id = ? ORDER BY ordered_at DESC, sequence DESC, run_id DESC LIMIT 1`)
        .get(jobId) as RunRow | undefined;
      return row === undefined ? undefined : operatorRunSummary(row);
    },
    runs(jobId, limit, before) {
      requireOpen();
      const cursor = before === undefined ? undefined : decodeCursor(before);
      const rows = (cursor === undefined
        ? database.prepare(`${RUN_SELECT} WHERE job_id = ? ORDER BY ordered_at DESC, sequence DESC, run_id DESC LIMIT ?`)
          .all(jobId, limit + 1)
        : database.prepare(`${RUN_SELECT} WHERE job_id = ? AND (
              ordered_at < ? OR (ordered_at = ? AND sequence < ?)
              OR (ordered_at = ? AND sequence = ? AND run_id < ?)
            ) ORDER BY ordered_at DESC, sequence DESC, run_id DESC LIMIT ?`)
          .all(jobId, cursor.orderedAt, cursor.orderedAt, cursor.sequence, cursor.orderedAt, cursor.sequence, cursor.runId, limit + 1)) as unknown as RunRow[];
      const selected = rows.slice(0, limit);
      const tail = selected[selected.length - 1];
      return {
        runs: selected.map(operatorRunSummary),
        ...(rows.length <= limit || tail === undefined
          ? {}
          : { nextCursor: encodeCursor({ orderedAt: tail.ordered_at, sequence: tail.sequence, runId: tail.run_id }) }),
      };
    },
    audit(input) {
      withTransaction(() => {
        insertAudit(database, { ...input, createdAt: now().toISOString() });
        applyRetention(database, now());
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        releaseLease();
      }
    },
  };
}

export function cronActionRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

async function resolveCanonicalCronControlPaths(cwd: string): Promise<CronControlPaths> {
  return resolveCronControlPaths(await realpath(resolve(cwd)));
}

function initializationPaths(paths: CronControlPaths): CronControlPaths {
  const root = `${paths.root}${CONTROL_INITIALIZING_SUFFIX}`;
  return {
    root,
    marker: join(root, CONTROL_MARKER),
    database: join(root, CONTROL_DATABASE),
    lease: join(root, CONTROL_LEASE),
  };
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  return await lstat(path).catch((error: unknown) => missing(error) ? undefined : Promise.reject(error));
}

async function inspectReadyControlStore(paths: CronControlPaths, root: Stats): Promise<ReadonlyMap<string, boolean>> {
  assertOwnedDirectory(root, paths.root);
  if (await realpath(paths.root) !== paths.root) {
    throw new CronControlStoreError("insecure", `Cron control state contains a symbolic-link hop: ${paths.root}`);
  }
  await assertOwnedFile(paths.marker, "Cron control marker");
  if (await readFile(paths.marker, "utf8") !== MARKER_CONTENT) {
    throw new CronControlStoreError("corrupt", `Cron control marker is invalid: ${paths.marker}`);
  }
  await assertOwnedFile(paths.database, "Cron control database");
  await assertOwnedFile(paths.lease, "Cron control lease database");
  const database = new DatabaseSync(paths.database, {
    readOnly: true,
    timeout: INSPECTION_BUSY_TIMEOUT_MS,
  });
  try {
    // Config inspection reads only the bounded state needed to decide which
    // jobs may arm. The lease-owning open below is the one lifecycle boundary
    // that performs the whole-database quick_check before scheduler startup.
    assertSupportedDatabaseSchema(database);
    const overrides = new Map<string, boolean>();
    for (const row of database.prepare(
      "SELECT job_id, runtime_enabled FROM job_controls WHERE runtime_enabled IS NOT NULL ORDER BY job_id",
    ).all() as Array<{ job_id: string; runtime_enabled: number }>) {
      overrides.set(row.job_id, row.runtime_enabled === 1);
    }
    return overrides;
  } finally {
    database.close();
  }
}

async function assertRecoverableInitialization(paths: CronControlPaths, root: Stats): Promise<void> {
  assertOwnedDirectory(root, paths.root);
  if (await realpath(paths.root) !== paths.root) {
    throw new CronControlStoreError(
      "insecure",
      `Cron control initialization contains a symbolic-link hop: ${paths.root}`,
    );
  }
  const allowedEntries = new Set([
    CONTROL_MARKER,
    CONTROL_DATABASE,
    CONTROL_LEASE,
    `${CONTROL_DATABASE}-journal`,
    `${CONTROL_DATABASE}-shm`,
    `${CONTROL_DATABASE}-wal`,
    `${CONTROL_LEASE}-journal`,
    `${CONTROL_LEASE}-shm`,
    `${CONTROL_LEASE}-wal`,
  ]);
  const entries = await readdir(paths.root);
  for (const entry of entries) {
    if (!allowedEntries.has(entry)) {
      throw new CronControlStoreError(
        "corrupt",
        `Cron control initialization contains an unexpected entry: ${join(paths.root, entry)}`,
      );
    }
    await assertOwnedFile(join(paths.root, entry), "Cron control initialization entry");
  }
  if (entries.includes(CONTROL_MARKER)) {
    const marker = await readFile(paths.marker, "utf8");
    const recoverableMarker = marker.length === 0
      || INITIALIZING_MARKER_CONTENT.startsWith(marker)
      || MARKER_CONTENT.startsWith(marker);
    if (!recoverableMarker) {
      throw new CronControlStoreError("corrupt", `Cron control initialization marker is invalid: ${paths.marker}`);
    }
  }
}

async function initializeControlStore(
  paths: CronControlPaths,
  onCheckpoint?: (checkpoint: CronControlInitializationCheckpoint) => void | Promise<void>,
): Promise<void> {
  const checkpoint = async (value: CronControlInitializationCheckpoint): Promise<void> => {
    await onCheckpoint?.(value);
  };
  const parent = dirname(paths.root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  assertOwnedDirectory(parentInfo, parent);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) {
    throw new CronControlStoreError("insecure", `Cron control parent contains a symbolic-link hop: ${parent}`);
  }
  await checkpoint("parent_ready");

  if (await lstatIfPresent(paths.root) !== undefined) {
    throw new CronControlStoreError("corrupt", `Cron control state appeared during initialization: ${paths.root}`);
  }
  const initializing = initializationPaths(paths);
  let initializingRoot = await lstatIfPresent(initializing.root);
  if (initializingRoot === undefined) {
    await mkdir(initializing.root, { mode: 0o700 });
    initializingRoot = await lstat(initializing.root);
    await syncDirectory(parent);
  }
  await assertRecoverableInitialization(initializing, initializingRoot);
  await checkpoint("initializing_root_ready");

  await writeInitializationMarker(initializing.marker, initializing.root, checkpoint);
  await syncDirectory(initializing.root);
  await checkpoint("initializing_marker_ready");

  await prepareInitializationControlDatabase(initializing.database, initializing.root, checkpoint);
  await prepareInitializationLeaseDatabase(initializing.lease, initializing.root, checkpoint);
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(initializing.root, 0o700),
      chmod(initializing.marker, 0o600),
      chmod(initializing.database, 0o600),
      chmod(initializing.lease, 0o600),
    ]);
  }
  await checkpoint("permissions_ready");

  await writeExactOwnerFile(initializing.marker, MARKER_CONTENT);
  await checkpoint("ready_marker_ready");
  await inspectReadyControlStore(initializing, await lstat(initializing.root));
  assertInitializationLeaseSchema(initializing.lease);

  if (await lstatIfPresent(paths.root) !== undefined) {
    throw new CronControlStoreError("corrupt", `Cron control state appeared during initialization: ${paths.root}`);
  }
  await rename(initializing.root, paths.root);
  await syncDirectory(parent);
  await checkpoint("published");
}

async function createOwnerFile(path: string): Promise<boolean> {
  if (await lstatIfPresent(path) !== undefined) return false;
  const file = await open(path, "wx", 0o600);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}

async function writeInitializationMarker(
  path: string,
  root: string,
  checkpoint: (checkpoint: CronControlInitializationCheckpoint) => Promise<void>,
): Promise<void> {
  await createOwnerFile(path);
  await assertOwnedFile(path, "Cron control initialization marker");
  await syncDirectory(root);
  await checkpoint("initializing_marker_file_ready");
  await writeExactOwnerFile(path, INITIALIZING_MARKER_CONTENT);
}

async function writeExactOwnerFile(path: string, content: string): Promise<void> {
  await assertOwnedFile(path, "Cron control initialization marker");
  const file = await open(path, "r+");
  try {
    await file.truncate(0);
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function prepareInitializationControlDatabase(
  path: string,
  root: string,
  checkpoint: (checkpoint: CronControlInitializationCheckpoint) => Promise<void>,
): Promise<void> {
  await createOwnerFile(path);
  await assertOwnedFile(path, "Cron control initialization database");
  await syncDirectory(root);
  await checkpoint("database_file_ready");
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const tables = userTableNames(database);
    if (version?.user_version === 0 && tables.length === 0) createSchema(database);
    else assertInitializationControlSchema(database);
  } finally {
    database.close();
  }
  await syncFile(path);
  await checkpoint("database_schema_ready");
}

async function prepareInitializationLeaseDatabase(
  path: string,
  root: string,
  checkpoint: (checkpoint: CronControlInitializationCheckpoint) => Promise<void>,
): Promise<void> {
  await createOwnerFile(path);
  await assertOwnedFile(path, "Cron control initialization lease database");
  await syncDirectory(root);
  await checkpoint("lease_file_ready");
  const lease = new DatabaseSync(path, { timeout: 5_000 });
  try {
    const tables = userTableNames(lease);
    if (tables.length === 0) {
      lease.exec("PRAGMA journal_mode=DELETE; CREATE TABLE lease_guard (id INTEGER PRIMARY KEY CHECK (id = 1));");
    } else {
      assertInitializationLeaseDatabase(lease);
    }
  } finally {
    lease.close();
  }
  await syncFile(path);
  await checkpoint("lease_schema_ready");
}

function userTableNames(database: DatabaseSync): readonly string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function assertInitializationControlSchema(database: DatabaseSync): void {
  assertHealthyDatabase(database);
  const expected = [
    "action_idempotency",
    "cron_audit",
    "cron_jobs",
    "cron_run_events",
    "cron_runs",
    "job_controls",
    "job_sequences",
  ];
  if (JSON.stringify(userTableNames(database)) !== JSON.stringify(expected)) {
    throw new CronControlStoreError("corrupt", "Cron control initialization database has an ambiguous schema.");
  }
}

function assertInitializationLeaseDatabase(database: DatabaseSync): void {
  const check = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
  if (check === undefined || Object.values(check)[0] !== "ok"
    || JSON.stringify(userTableNames(database)) !== JSON.stringify(["lease_guard"])) {
    throw new CronControlStoreError("corrupt", "Cron control initialization lease database is corrupt.");
  }
  database.prepare("SELECT id FROM lease_guard LIMIT 1").get();
}

function assertInitializationLeaseSchema(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true, timeout: INSPECTION_BUSY_TIMEOUT_MS });
  try {
    assertInitializationLeaseDatabase(database);
  } finally {
    database.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA foreign_keys=ON;
    BEGIN IMMEDIATE;
    CREATE TABLE cron_jobs (
      job_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE job_controls (
      job_id TEXT PRIMARY KEY,
      runtime_enabled INTEGER CHECK (runtime_enabled IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_sequences (
      job_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
    );
    CREATE TABLE cron_runs (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      ordered_at TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      artifact_run_id TEXT,
      text TEXT,
      error TEXT,
      failure_kind TEXT,
      blocked_by_run_id TEXT,
      blocked_by_trigger TEXT,
      queue_depth INTEGER,
      event_count INTEGER NOT NULL DEFAULT 0,
      event_bytes INTEGER NOT NULL DEFAULT 0,
      events_truncated INTEGER NOT NULL DEFAULT 0 CHECK (events_truncated IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE (job_id, sequence)
    );
    CREATE INDEX cron_runs_job_order ON cron_runs(job_id, ordered_at DESC, sequence DESC, run_id DESC);
    CREATE TABLE cron_run_events (
      run_id TEXT NOT NULL REFERENCES cron_runs(run_id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, position)
    );
    CREATE TABLE action_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      target_run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE cron_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      job_id TEXT,
      outcome TEXT NOT NULL,
      idempotency_key TEXT,
      detail_json TEXT
    );
    PRAGMA user_version=${String(CONTROL_SCHEMA)};
    COMMIT;
  `);
}

function assertSupportedDatabaseSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  if (version?.user_version !== CONTROL_SCHEMA) {
    throw new CronControlStoreError("corrupt", "Cron control database is corrupt or uses an unsupported schema.");
  }
}

function assertHealthyDatabase(database: DatabaseSync): void {
  assertSupportedDatabaseSchema(database);
  const check = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
  const result = check === undefined ? undefined : Object.values(check)[0];
  if (result !== "ok") {
    throw new CronControlStoreError("corrupt", "Cron control database is corrupt or uses an unsupported schema.");
  }
}

function ensureControlSchemaColumns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(action_idempotency)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "target_run_id")) {
    // This feature's first schema revision existed in review worktrees before
    // run receipts needed a direct retention link. The additive repair keeps
    // those private stores restartable without weakening schema validation.
    database.exec("ALTER TABLE action_idempotency ADD COLUMN target_run_id TEXT");
  }
}

function reconcileInterruptedRuns(database: DatabaseSync, completedAt: string): void {
  const interrupted = database.prepare(`
    SELECT run_id FROM cron_runs WHERE status IN ('admitted', 'running', 'queued')
  `).all() as Array<{ run_id: string }>;
  database.prepare(`
    UPDATE cron_runs SET status = 'cancelled', completed_at = ?,
      error = COALESCE(error, 'Agent restarted before this cron firing completed.')
    WHERE status IN ('admitted', 'running', 'queued')
  `).run(completedAt);
  for (const { run_id: runId } of interrupted) {
    const row = runRow(database, runId);
    if (row !== undefined) updateRunNowReceipt(database, row);
  }
}

interface RunRow {
  readonly run_id: string;
  readonly job_id: string;
  readonly scheduled_at: string;
  readonly ordered_at: string;
  readonly sequence: number;
  readonly trigger: CronRunTrigger;
  readonly status: CronOperatorRun["status"];
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly artifact_run_id: string | null;
  readonly text: string | null;
  readonly error: string | null;
  readonly failure_kind: string | null;
  readonly blocked_by_run_id: string | null;
  readonly blocked_by_trigger: CronRunTrigger | null;
  readonly queue_depth: number | null;
  readonly event_count: number;
  readonly events_truncated: number;
}

const RUN_SELECT = `SELECT run_id, job_id, scheduled_at, ordered_at, sequence, trigger, status,
  started_at, completed_at, artifact_run_id, text, error, failure_kind,
  blocked_by_run_id, blocked_by_trigger, queue_depth, event_count, events_truncated FROM cron_runs`;

function runRow(database: DatabaseSync, runId: string): RunRow | undefined {
  return database.prepare(`${RUN_SELECT} WHERE run_id = ?`).get(runId) as RunRow | undefined;
}

function firingFromRow(row: RunRow): CronFiringIdentity {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    scheduledAt: row.scheduled_at,
    orderedAt: row.ordered_at,
    sequence: row.sequence,
    trigger: row.trigger,
  };
}

function firingFromOperatorRun(run: CronOperatorRunSummary): CronFiringIdentity {
  return {
    runId: run.runId,
    jobId: run.jobId,
    scheduledAt: run.scheduledAt,
    orderedAt: run.orderedAt,
    sequence: run.sequence,
    trigger: run.trigger,
  };
}

function operatorRunSummary(row: RunRow): CronOperatorRunSummary {
  return operatorRunBase(row, {
    projection: "summary",
    textBytes: MAX_SUMMARY_TEXT_BYTES,
    errorBytes: MAX_SUMMARY_ERROR_BYTES,
    artifactRunIdBytes: MAX_SUMMARY_ARTIFACT_ID_BYTES,
    failureKindBytes: MAX_SUMMARY_FAILURE_KIND_BYTES,
  });
}

function operatorRunDetail(database: DatabaseSync, row: RunRow): CronOperatorRunDetail {
  const eventRows = database.prepare(
    "SELECT event_json, bytes FROM cron_run_events WHERE run_id = ? ORDER BY position",
  ).all(row.run_id) as Array<{ event_json: string; bytes: number }>;
  const events: AgentStreamEvent[] = [];
  let eventBytes = 2;
  let wireTruncated = false;
  for (const event of eventRows) {
    const nextBytes = eventBytes + event.bytes + (events.length === 0 ? 0 : 1);
    if (nextBytes > MAX_DETAIL_EVENT_BYTES) {
      wireTruncated = true;
      break;
    }
    try {
      events.push(JSON.parse(event.event_json) as AgentStreamEvent);
      eventBytes = nextBytes;
    } catch {
      wireTruncated = true;
    }
  }
  const base = operatorRunBase(row, {
    projection: "detail",
    textBytes: MAX_DETAIL_TEXT_BYTES,
    errorBytes: MAX_DETAIL_ERROR_BYTES,
    artifactRunIdBytes: MAX_DETAIL_ARTIFACT_ID_BYTES,
    failureKindBytes: MAX_DETAIL_FAILURE_KIND_BYTES,
  });
  return {
    ...base,
    projection: "detail",
    events,
    eventsIncluded: events.length,
    ...(base.eventsTruncated === true || wireTruncated ? { eventsTruncated: true as const } : {}),
  };
}

function operatorRunBase<P extends "summary" | "detail">(
  row: RunRow,
  limits: {
    readonly projection: P;
    readonly textBytes: number;
    readonly errorBytes: number;
    readonly artifactRunIdBytes: number;
    readonly failureKindBytes: number;
  },
): CronOperatorRunBase & { readonly projection: P } {
  const truncated: CronOperatorRunTruncatedField[] = [];
  const text = boundedRunField(row.text, limits.textBytes, "text", truncated);
  const error = boundedRunField(row.error, limits.errorBytes, "error", truncated);
  const artifactRunId = boundedRunField(
    row.artifact_run_id,
    limits.artifactRunIdBytes,
    "artifactRunId",
    truncated,
  );
  const failureKind = boundedRunField(
    row.failure_kind,
    limits.failureKindBytes,
    "failureKind",
    truncated,
  );
  return {
    projection: limits.projection,
    runId: row.run_id,
    jobId: row.job_id,
    scheduledAt: row.scheduled_at,
    orderedAt: row.ordered_at,
    sequence: row.sequence,
    trigger: row.trigger,
    status: row.status,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(artifactRunId === undefined ? {} : { artifactRunId }),
    ...(text === undefined ? {} : { text }),
    ...(error === undefined ? {} : { error }),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(row.blocked_by_run_id === null ? {} : { blockedByRunId: row.blocked_by_run_id }),
    ...(row.blocked_by_trigger === null ? {} : { blockedByTrigger: row.blocked_by_trigger }),
    ...(row.queue_depth === null ? {} : { queueDepth: row.queue_depth }),
    eventCount: row.event_count,
    ...(truncated.length === 0 ? {} : { fieldsTruncated: truncated }),
    ...(row.events_truncated === 1 ? { eventsTruncated: true as const } : {}),
  };
}

function boundedRunField(
  value: string | null,
  maxBytes: number,
  field: CronOperatorRunTruncatedField,
  truncated: CronOperatorRunTruncatedField[],
): string | undefined {
  if (value === null) return undefined;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  truncated.push(field);
  return truncateUtf8(value, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function resultFields(result: CronJobResult): {
  readonly status: CronOperatorRun["status"];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly artifactRunId?: string;
  readonly text?: string;
  readonly error?: string;
  readonly failureKind?: string;
  readonly blockedByRunId?: string;
  readonly blockedByTrigger?: CronRunTrigger;
  readonly queueDepth?: number;
} {
  if (result.kind === "succeeded") {
    const runId = typeof result.metadata?.runId === "string" ? result.metadata.runId : undefined;
    return {
      status: "succeeded",
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      ...(runId === undefined ? {} : { artifactRunId: runId }),
      ...(result.text === undefined ? {} : { text: result.text }),
    };
  }
  if (result.kind === "failed" || result.kind === "cancelled") {
    return {
      status: result.kind,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      ...(result.runId === undefined ? {} : { artifactRunId: result.runId }),
      error: result.error,
      ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
    };
  }
  if (result.kind === "skipped") {
    return {
      status: "skipped_overlap",
      completedAt: result.orderedAt,
      blockedByRunId: result.blockedByRunId,
      blockedByTrigger: result.blockedByTrigger,
    };
  }
  if (result.kind === "queued") return { status: "queued", queueDepth: result.queueDepth };
  return { status: "dropped", completedAt: result.orderedAt };
}

function idempotencyRecord(
  database: DatabaseSync,
  key: string,
  action: string,
  jobId: string,
  requestHash: string,
): string | undefined {
  const row = database.prepare(`
    SELECT action, job_id, request_hash, response_json FROM action_idempotency WHERE idempotency_key = ?
  `).get(key) as { action: string; job_id: string; request_hash: string; response_json: string } | undefined;
  if (row === undefined) return undefined;
  if (row.action !== action || row.job_id !== jobId || row.request_hash !== requestHash) {
    throw new CronControlStoreError(
      "idempotency_conflict",
      "The cron idempotency key was already used for a different action.",
    );
  }
  return row.response_json;
}

function parseRunNowReceipt(serialized: string): CronOperatorRunSummary | string {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new CronControlStoreError(
      "corrupt",
      "Stored cron run-now idempotency result is invalid.",
      { cause: error },
    );
  }
  const receipt = record(value);
  const run = record(receipt?.run);
  if (run === undefined) {
    // Pre-detail development receipts did not retain a terminal summary. A
    // missing target is an expired replay, not database corruption, and must
    // never be admitted as a second job execution.
    const legacyRunId = typeof receipt?.runId === "string" ? receipt.runId : undefined;
    if (legacyRunId !== undefined) return legacyRunId;
    throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
  }
  const allowed = new Set([
    "projection", "runId", "jobId", "scheduledAt", "orderedAt", "sequence", "trigger", "status",
    "startedAt", "completedAt", "artifactRunId", "text", "error", "failureKind", "blockedByRunId",
    "blockedByTrigger", "queueDepth", "eventCount", "fieldsTruncated", "eventsTruncated",
  ]);
  if (Object.keys(run).some((key) => !allowed.has(key))
    || run.projection !== "summary"
    || typeof run.runId !== "string"
    || typeof run.jobId !== "string"
    || typeof run.scheduledAt !== "string"
    || typeof run.orderedAt !== "string"
    || !Number.isSafeInteger(run.sequence)
    || (run.trigger !== "scheduled" && run.trigger !== "manual")
    || !["admitted", "running", "queued", "succeeded", "failed", "cancelled", "skipped_overlap", "dropped"]
      .includes(String(run.status))
    || !Number.isSafeInteger(run.eventCount)
    || Number(run.eventCount) < 0
    || (run.eventsTruncated !== undefined && run.eventsTruncated !== true)) {
    throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
  }
  for (const field of [
    "startedAt", "completedAt", "artifactRunId", "text", "error", "failureKind", "blockedByRunId",
  ] as const) {
    if (run[field] !== undefined && typeof run[field] !== "string") {
      throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
    }
  }
  if (run.blockedByTrigger !== undefined
    && run.blockedByTrigger !== "scheduled"
    && run.blockedByTrigger !== "manual") {
    throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
  }
  if (run.queueDepth !== undefined && !Number.isSafeInteger(run.queueDepth)) {
    throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
  }
  const truncatedFields = ["artifactRunId", "error", "failureKind", "text"];
  if (run.fieldsTruncated !== undefined
    && (!Array.isArray(run.fieldsTruncated)
      || run.fieldsTruncated.some((field) => !truncatedFields.includes(String(field))))) {
    throw new CronControlStoreError("corrupt", "Stored cron run-now idempotency result is invalid.");
  }
  return run as unknown as CronOperatorRunSummary;
}

function updateRunNowReceipt(database: DatabaseSync, row: RunRow): void {
  database.prepare(`
    UPDATE action_idempotency SET response_json = ?
    WHERE action = 'run_now' AND target_run_id = ?
  `).run(JSON.stringify({ run: operatorRunSummary(row) }), row.run_id);
}

function insertIdempotency(database: DatabaseSync, input: {
  readonly key: string;
  readonly action: string;
  readonly jobId: string;
  readonly requestHash: string;
  readonly response: string;
  readonly targetRunId?: string;
  readonly createdAt: string;
}): void {
  database.prepare(`
    INSERT INTO action_idempotency (
      idempotency_key, action, job_id, request_hash, response_json, target_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.key,
    input.action,
    input.jobId,
    input.requestHash,
    input.response,
    input.targetRunId ?? null,
    input.createdAt,
  );
}

function insertAudit(database: DatabaseSync, input: {
  readonly action: string;
  readonly jobId?: string;
  readonly outcome: string;
  readonly idempotencyKey?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): void {
  database.prepare(`
    INSERT INTO cron_audit (created_at, action, job_id, outcome, idempotency_key, detail_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.createdAt,
    input.action,
    input.jobId ?? null,
    input.outcome,
    input.idempotencyKey ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  );
}

function applyRetention(database: DatabaseSync, date: Date): void {
  const runCutoff = new Date(date.getTime() - RUN_RETENTION_MS).toISOString();
  database.prepare(`
    DELETE FROM cron_runs WHERE run_id IN (
      SELECT run_id FROM (
        SELECT run_id, ordered_at,
          ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY ordered_at DESC, sequence DESC, run_id DESC) AS rank
        FROM cron_runs WHERE status NOT IN ('admitted', 'running', 'queued')
      ) WHERE rank > ? OR ordered_at < ?
    )
  `).run(MAX_RUNS_PER_JOB, runCutoff);
  const idempotencyCutoff = new Date(date.getTime() - IDEMPOTENCY_RETENTION_MS).toISOString();
  database.prepare(`
    DELETE FROM action_idempotency WHERE created_at < ? OR idempotency_key IN (
      SELECT idempotency_key FROM action_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )
  `).run(idempotencyCutoff, MAX_IDEMPOTENCY_RECORDS);
  const auditCutoff = new Date(date.getTime() - AUDIT_RETENTION_MS).toISOString();
  database.prepare(`
    DELETE FROM cron_audit WHERE created_at < ? OR id IN (
      SELECT id FROM cron_audit ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
    )
  `).run(auditCutoff, MAX_AUDIT_RECORDS);
}

function encodeCursor(value: { readonly orderedAt: string; readonly sequence: number; readonly runId: string }): string {
  return Buffer.from(JSON.stringify([value.orderedAt, value.sequence, value.runId]), "utf8").toString("base64url");
}

function decodeCursor(value: string): { readonly orderedAt: string; readonly sequence: number; readonly runId: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || typeof parsed[0] !== "string"
      || Number.isNaN(Date.parse(parsed[0]))
      || !Number.isSafeInteger(parsed[1])
      || Number(parsed[1]) <= 0
      || typeof parsed[2] !== "string"
      || parsed[2].length === 0
    ) throw new Error("invalid");
    return { orderedAt: parsed[0], sequence: Number(parsed[1]), runId: parsed[2] };
  } catch (error) {
    throw new CronControlStoreError("corrupt", "Cron run cursor is invalid.", { cause: error });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function assertOwnedFile(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (missing(error)) {
      throw new CronControlStoreError("corrupt", `${label} is missing: ${path}`, { cause: error });
    }
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new CronControlStoreError("insecure", `${label} is not a single-link regular file: ${path}`);
  }
  assertOwner(info, path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new CronControlStoreError("insecure", `${label} permissions are not owner-only: ${path}`);
  }
}

function assertOwnedDirectory(info: Stats, path: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CronControlStoreError("insecure", `Cron control state is not a real directory: ${path}`);
  }
  assertOwner(info, path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new CronControlStoreError("insecure", `Cron control state permissions are not owner-only: ${path}`);
  }
}

function assertOwner(info: { readonly uid: number }, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new CronControlStoreError("insecure", `Cron control state is not owned by the current user: ${path}`);
  }
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
