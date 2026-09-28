import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  openOwnedState,
  openOwnedStateReadOnly,
  resolveOwnedStatePaths,
  type OwnedStateHandle,
} from "./owned-state-sqlite.js";
import type { TelegramScheduleTiming } from "./telegram-schedule-timing.js";

/**
 * Durable store for agent-managed Telegram schedules
 * (`<agent>/.mono-agent/telegram-schedules-v1/state.sqlite`).
 *
 * Deliberately separate from config-owned cron state: model tools may only
 * touch these records. A schedule stores its resolved destination (chat and
 * internal topic id) so a later topic rename never retargets it; the topic id
 * never leaves the host. Each firing is claimed durably (unique per schedule,
 * revision and scheduled time) before any model work, and its execution and
 * delivery outcomes are recorded separately.
 */

export const TELEGRAM_SCHEDULES_STATE_NAME = "telegram-schedules-v1";
export const TELEGRAM_SCHEDULES_STATE_LABEL = "Telegram schedule state";
const SCHEMA_VERSION = 1;
const MAX_RUNS_PER_SCHEDULE = 500;
const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_AUDIT_RECORDS = 5_000;
/** Finished one-offs (completed or missed) kept per bot for inspection. */
const MAX_FINISHED_SCHEDULES = 50;
const FINISHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type TelegramScheduleState = "active" | "paused" | "completed" | "missed";

export type TelegramScheduleExecution =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "missed"
  | "skipped_overlap"
  | "skipped_capacity"
  | "skipped_interval"
  | "skipped_busy"
  | "blocked";

export type TelegramScheduleDelivery =
  | "pending"
  | "delivered"
  | "suppressed"
  | "failed"
  | "unknown"
  | "not_attempted";

export interface TelegramScheduleDestination {
  readonly chatId: string;
  /** Internal forum topic id; absent for the chat's main conversation. Host-only. */
  readonly topicId?: number;
  /** Display label captured at resolution (`Chat › Topic`). */
  readonly label: string;
}

export interface TelegramScheduleRecord {
  readonly id: string;
  readonly botId: string;
  readonly revision: number;
  readonly name: string;
  readonly prompt: string;
  readonly timing: TelegramScheduleTiming;
  readonly destination: TelegramScheduleDestination;
  readonly producerConversationId: string;
  readonly state: TelegramScheduleState;
  readonly pausedReason?: string;
  readonly nextRunAt?: string;
  readonly lastFiredAt?: string;
  readonly consecutiveDeliveryFailures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRun?: TelegramScheduleRunRecord;
}

export interface TelegramScheduleRunRecord {
  readonly runId: string;
  readonly scheduleId: string;
  readonly revision: number;
  readonly scheduledAt: string;
  readonly claimedAt: string;
  readonly finishedAt?: string;
  readonly execution: TelegramScheduleExecution;
  readonly delivery: TelegramScheduleDelivery;
  readonly detail?: string;
}

export interface TelegramScheduleCreateInput {
  readonly botId: string;
  readonly name: string;
  readonly prompt: string;
  readonly timing: TelegramScheduleTiming;
  readonly destination: TelegramScheduleDestination;
  readonly producerConversationId: string;
  readonly nextRunAt: string;
  /** Idempotency key: a retried create with the same key returns the first record. */
  readonly createKey?: string;
}

export interface TelegramScheduleUpdateInput {
  readonly name?: string;
  readonly prompt?: string;
  readonly timing?: TelegramScheduleTiming;
  readonly destination?: TelegramScheduleDestination;
  readonly state?: "active" | "paused";
  readonly nextRunAt?: string | null;
  readonly pausedReason?: string | null;
}

export class TelegramScheduleConflictError extends Error {
  readonly code: "not_found" | "revision_conflict" | "limit_reached";

  constructor(code: TelegramScheduleConflictError["code"], message: string) {
    super(message);
    this.name = "TelegramScheduleConflictError";
    this.code = code;
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
      at TEXT,
      expression TEXT,
      timezone TEXT,
      chat_id TEXT NOT NULL,
      topic_id INTEGER CHECK (topic_id IS NULL OR topic_id > 0),
      destination_label TEXT NOT NULL,
      producer_conversation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'missed')),
      paused_reason TEXT,
      next_run_at TEXT,
      last_fired_at TEXT,
      consecutive_delivery_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      create_key TEXT UNIQUE
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      finished_at TEXT,
      execution TEXT NOT NULL,
      delivery TEXT NOT NULL,
      detail TEXT,
      UNIQUE (schedule_id, revision, scheduled_at)
    );
    CREATE INDEX runs_by_schedule ON runs (schedule_id, claimed_at);
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT
    );
  `);
}

interface ScheduleRow {
  readonly id: string;
  readonly bot_id: string;
  readonly revision: number;
  readonly name: string;
  readonly prompt: string;
  readonly kind: "once" | "cron";
  readonly at: string | null;
  readonly expression: string | null;
  readonly timezone: string | null;
  readonly chat_id: string;
  readonly topic_id: number | null;
  readonly destination_label: string;
  readonly producer_conversation_id: string;
  readonly state: TelegramScheduleState;
  readonly paused_reason: string | null;
  readonly next_run_at: string | null;
  readonly last_fired_at: string | null;
  readonly consecutive_delivery_failures: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunRow {
  readonly run_id: string;
  readonly schedule_id: string;
  readonly revision: number;
  readonly scheduled_at: string;
  readonly claimed_at: string;
  readonly finished_at: string | null;
  readonly execution: TelegramScheduleExecution;
  readonly delivery: TelegramScheduleDelivery;
  readonly detail: string | null;
}

export interface TelegramScheduleStore {
  list(botId?: string): readonly TelegramScheduleRecord[];
  get(id: string): TelegramScheduleRecord | undefined;
  /** Count of active + paused schedules (the `maxSchedules` budget). */
  countLive(botId: string): number;
  create(input: TelegramScheduleCreateInput, limit: number, actor: string): TelegramScheduleRecord;
  update(id: string, expectedRevision: number, input: TelegramScheduleUpdateInput, actor: string): TelegramScheduleRecord;
  delete(id: string, expectedRevision: number | undefined, actor: string): void;
  /**
   * Durably claim one firing and advance the schedule in the same
   * transaction. Returns undefined when the occurrence was already claimed.
   */
  claim(input: {
    readonly scheduleId: string;
    readonly revision: number;
    readonly scheduledAt: string;
    readonly nextRunAt: string | undefined;
    readonly execution: TelegramScheduleExecution;
    readonly delivery: TelegramScheduleDelivery;
    readonly detail?: string;
    readonly fired: boolean;
  }): TelegramScheduleRunRecord | undefined;
  finishRun(runId: string, outcome: {
    readonly execution: TelegramScheduleExecution;
    readonly delivery: TelegramScheduleDelivery;
    readonly detail?: string;
  }): void;
  /** Adjust the failure streak; pauses the schedule with `pauseReason` when set. */
  recordDeliveryStreak(scheduleId: string, revision: number, failed: boolean, pauseReason?: string): void;
  /** Mark runs left `running` by a previous process as interrupted with unknown delivery. */
  reconcileInterrupted(): number;
  close(): void;
}

export async function openTelegramScheduleStore(input: {
  readonly cwd: string;
  readonly now?: () => Date;
}): Promise<TelegramScheduleStore> {
  const state = await openOwnedState({
    cwd: input.cwd,
    name: TELEGRAM_SCHEDULES_STATE_NAME,
    label: TELEGRAM_SCHEDULES_STATE_LABEL,
    schemaVersion: SCHEMA_VERSION,
    createSchema,
  });
  return createStoreOnHandle(state, input.now ?? (() => new Date()));
}

/** Read-only listing without the writer lease (operator CLI). */
export async function inspectTelegramSchedules(cwd: string): Promise<readonly TelegramScheduleRecord[] | undefined> {
  const database = await openOwnedStateReadOnly(
    resolveOwnedStatePaths(cwd, TELEGRAM_SCHEDULES_STATE_NAME).root,
    TELEGRAM_SCHEDULES_STATE_LABEL,
    SCHEMA_VERSION,
  );
  if (database === undefined) return undefined;
  try {
    return listSchedules(database, undefined);
  } finally {
    database.close();
  }
}

function createStoreOnHandle(state: OwnedStateHandle, now: () => Date): TelegramScheduleStore {
  const { database } = state;
  const audit = (scheduleId: string, action: string, actor: string, detail?: string): void => {
    database.prepare("INSERT INTO audit (at, schedule_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now().toISOString(), scheduleId, action, actor, detail ?? null);
    database.prepare(
      "DELETE FROM audit WHERE seq <= (SELECT seq FROM audit ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    ).run(MAX_AUDIT_RECORDS);
  };
  const getRow = (id: string): ScheduleRow | undefined =>
    database.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  const requireRevision = (id: string, expectedRevision: number | undefined): ScheduleRow => {
    const row = getRow(id);
    if (row === undefined) {
      throw new TelegramScheduleConflictError("not_found", "No schedule has that id.");
    }
    if (expectedRevision !== undefined && row.revision !== expectedRevision) {
      throw new TelegramScheduleConflictError(
        "revision_conflict",
        `The schedule changed (now revision ${String(row.revision)}); list schedules again and retry with the current revision.`,
      );
    }
    return row;
  };
  const pruneFinished = (botId: string): void => {
    const cutoff = new Date(now().getTime() - FINISHED_RETENTION_MS).toISOString();
    const stale = database.prepare(`
      SELECT id FROM schedules WHERE bot_id = ? AND state IN ('completed', 'missed') AND (
        updated_at < ? OR id NOT IN (
          SELECT id FROM schedules WHERE bot_id = ? AND state IN ('completed', 'missed')
          ORDER BY updated_at DESC LIMIT ?
        )
      )
    `).all(botId, cutoff, botId, MAX_FINISHED_SCHEDULES) as Array<{ id: string }>;
    for (const { id } of stale) {
      database.prepare("DELETE FROM runs WHERE schedule_id = ? AND execution != 'running'").run(id);
      database.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    }
  };
  const pruneRuns = (scheduleId: string): void => {
    const cutoff = new Date(now().getTime() - RUN_RETENTION_MS).toISOString();
    database.prepare("DELETE FROM runs WHERE schedule_id = ? AND claimed_at < ? AND execution != 'running'")
      .run(scheduleId, cutoff);
    database.prepare(`
      DELETE FROM runs WHERE schedule_id = ? AND execution != 'running' AND run_id IN (
        SELECT run_id FROM runs WHERE schedule_id = ? ORDER BY claimed_at DESC LIMIT -1 OFFSET ?
      )
    `).run(scheduleId, scheduleId, MAX_RUNS_PER_SCHEDULE);
  };

  return {
    list(botId) {
      return listSchedules(database, botId);
    },
    get(id) {
      const row = getRow(id);
      return row === undefined ? undefined : recordFromRow(row, lastRunFor(database, id));
    },
    countLive(botId) {
      return (database.prepare(
        "SELECT COUNT(*) AS n FROM schedules WHERE bot_id = ? AND state IN ('active', 'paused')",
      ).get(botId) as { n: number }).n;
    },
    create(input, limit, actor) {
      return state.transaction(() => {
        if (input.createKey !== undefined) {
          const existing = database.prepare("SELECT * FROM schedules WHERE create_key = ?").get(input.createKey) as
            | ScheduleRow
            | undefined;
          if (existing !== undefined) return recordFromRow(existing, lastRunFor(database, existing.id));
        }
        const live = (database.prepare(
          "SELECT COUNT(*) AS n FROM schedules WHERE bot_id = ? AND state IN ('active', 'paused')",
        ).get(input.botId) as { n: number }).n;
        if (live >= limit) {
          throw new TelegramScheduleConflictError(
            "limit_reached",
            `The configured limit of ${String(limit)} schedules is reached; delete one first.`,
          );
        }
        pruneFinished(input.botId);
        const id = `sch_${randomBytes(9).toString("base64url")}`;
        const at = now().toISOString();
        database.prepare(`
          INSERT INTO schedules (
            id, bot_id, revision, name, prompt, kind, at, expression, timezone, chat_id, topic_id,
            destination_label, producer_conversation_id, state, next_run_at, created_at, updated_at, create_key
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(
          id,
          input.botId,
          input.name,
          input.prompt,
          input.timing.kind,
          input.timing.kind === "once" ? input.timing.at : null,
          input.timing.kind === "cron" ? input.timing.expression : null,
          input.timing.kind === "cron" ? input.timing.timezone : null,
          input.destination.chatId,
          input.destination.topicId ?? null,
          input.destination.label,
          input.producerConversationId,
          input.nextRunAt,
          at,
          at,
          input.createKey ?? null,
        );
        audit(id, "create", actor);
        return recordFromRow(getRow(id)!, undefined);
      });
    },
    update(id, expectedRevision, input, actor) {
      return state.transaction(() => {
        const row = requireRevision(id, expectedRevision);
        // The service decides every state transition; the store applies it.
        const timing = input.timing;
        const nextState = input.state ?? row.state;
        database.prepare(`
          UPDATE schedules SET
            revision = revision + 1,
            name = ?, prompt = ?, kind = ?, at = ?, expression = ?, timezone = ?,
            chat_id = ?, topic_id = ?, destination_label = ?,
            state = ?, paused_reason = ?, next_run_at = ?,
            consecutive_delivery_failures = CASE WHEN ? THEN 0 ELSE consecutive_delivery_failures END,
            updated_at = ?
          WHERE id = ?
        `).run(
          input.name ?? row.name,
          input.prompt ?? row.prompt,
          timing?.kind ?? row.kind,
          timing === undefined ? row.at : timing.kind === "once" ? timing.at : null,
          timing === undefined ? row.expression : timing.kind === "cron" ? timing.expression : null,
          timing === undefined ? row.timezone : timing.kind === "cron" ? timing.timezone : null,
          input.destination?.chatId ?? row.chat_id,
          input.destination === undefined ? row.topic_id : input.destination.topicId ?? null,
          input.destination?.label ?? row.destination_label,
          nextState,
          input.pausedReason === undefined ? (nextState === "paused" ? row.paused_reason : null) : input.pausedReason,
          input.nextRunAt === undefined ? row.next_run_at : input.nextRunAt,
          nextState === "active" ? 1 : 0,
          now().toISOString(),
          id,
        );
        audit(id, "update", actor);
        return recordFromRow(getRow(id)!, lastRunFor(database, id));
      });
    },
    delete(id, expectedRevision, actor) {
      state.transaction(() => {
        requireRevision(id, expectedRevision);
        database.prepare("DELETE FROM schedules WHERE id = ?").run(id);
        database.prepare("DELETE FROM runs WHERE schedule_id = ? AND execution != 'running'").run(id);
        audit(id, "delete", actor);
      });
    },
    claim(input) {
      return state.transaction(() => {
        const row = getRow(input.scheduleId);
        if (row === undefined || row.revision !== input.revision || row.state !== "active") return undefined;
        const existing = database.prepare(
          "SELECT run_id FROM runs WHERE schedule_id = ? AND revision = ? AND scheduled_at = ?",
        ).get(input.scheduleId, input.revision, input.scheduledAt);
        if (existing !== undefined) return undefined;
        const runId = `srun_${randomBytes(9).toString("base64url")}`;
        const claimedAt = now().toISOString();
        const finished = input.execution === "running" ? null : claimedAt;
        database.prepare(`
          INSERT INTO runs (run_id, schedule_id, revision, scheduled_at, claimed_at, finished_at, execution, delivery, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          input.scheduleId,
          input.revision,
          input.scheduledAt,
          claimedAt,
          finished,
          input.execution,
          input.delivery,
          input.detail ?? null,
        );
        const terminalState = row.kind === "once"
          ? (input.execution === "missed" ? "missed" : "completed")
          : undefined;
        database.prepare(`
          UPDATE schedules SET
            next_run_at = ?,
            last_fired_at = CASE WHEN ? THEN ? ELSE last_fired_at END,
            state = COALESCE(?, state)
          WHERE id = ?
        `).run(
          input.nextRunAt ?? null,
          input.fired ? 1 : 0,
          claimedAt,
          input.nextRunAt === undefined ? terminalState ?? null : null,
          input.scheduleId,
        );
        pruneRuns(input.scheduleId);
        return {
          runId,
          scheduleId: input.scheduleId,
          revision: input.revision,
          scheduledAt: input.scheduledAt,
          claimedAt,
          ...(finished === null ? {} : { finishedAt: finished }),
          execution: input.execution,
          delivery: input.delivery,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        };
      });
    },
    finishRun(runId, outcome) {
      database.prepare(
        "UPDATE runs SET execution = ?, delivery = ?, detail = ?, finished_at = ? WHERE run_id = ?",
      ).run(outcome.execution, outcome.delivery, outcome.detail ?? null, now().toISOString(), runId);
      // A run whose schedule was deleted while it was in flight has nothing left to report on.
      database.prepare(
        "DELETE FROM runs WHERE run_id = ? AND NOT EXISTS (SELECT 1 FROM schedules WHERE schedules.id = runs.schedule_id)",
      ).run(runId);
    },
    recordDeliveryStreak(scheduleId, revision, failed, pauseReason) {
      state.transaction(() => {
        const row = getRow(scheduleId);
        if (row === undefined || row.revision !== revision) return;
        if (!failed) {
          database.prepare("UPDATE schedules SET consecutive_delivery_failures = 0 WHERE id = ?").run(scheduleId);
          return;
        }
        database.prepare(
          "UPDATE schedules SET consecutive_delivery_failures = consecutive_delivery_failures + 1 WHERE id = ?",
        ).run(scheduleId);
        if (pauseReason !== undefined && row.state === "active") {
          database.prepare(
            "UPDATE schedules SET state = 'paused', paused_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          ).run(pauseReason, now().toISOString(), scheduleId);
          audit(scheduleId, "pause", "host", pauseReason);
        }
      });
    },
    reconcileInterrupted() {
      const result = database.prepare(`
        UPDATE runs SET execution = 'interrupted', delivery = CASE WHEN delivery = 'pending' THEN 'unknown' ELSE delivery END,
          finished_at = ?, detail = 'The agent stopped while this run was in flight; it is not replayed.'
        WHERE execution = 'running'
      `).run(now().toISOString());
      return Number(result.changes);
    },
    close() {
      state.close();
    },
  };
}

function listSchedules(database: DatabaseSync, botId: string | undefined): readonly TelegramScheduleRecord[] {
  const rows = (botId === undefined
    ? database.prepare("SELECT * FROM schedules ORDER BY created_at, id").all()
    : database.prepare("SELECT * FROM schedules WHERE bot_id = ? ORDER BY created_at, id").all(botId)) as unknown as ScheduleRow[];
  return rows.map((row) => recordFromRow(row, lastRunFor(database, row.id)));
}

function lastRunFor(database: DatabaseSync, scheduleId: string): TelegramScheduleRunRecord | undefined {
  const row = database.prepare(
    "SELECT * FROM runs WHERE schedule_id = ? ORDER BY claimed_at DESC, rowid DESC LIMIT 1",
  ).get(scheduleId) as RunRow | undefined;
  return row === undefined ? undefined : runFromRow(row);
}

function runFromRow(row: RunRow): TelegramScheduleRunRecord {
  return {
    runId: row.run_id,
    scheduleId: row.schedule_id,
    revision: row.revision,
    scheduledAt: row.scheduled_at,
    claimedAt: row.claimed_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    execution: row.execution,
    delivery: row.delivery,
    ...(row.detail === null ? {} : { detail: row.detail }),
  };
}

function recordFromRow(row: ScheduleRow, lastRun: TelegramScheduleRunRecord | undefined): TelegramScheduleRecord {
  const timing: TelegramScheduleTiming = row.kind === "once"
    ? { kind: "once", at: row.at ?? "" }
    : { kind: "cron", expression: row.expression ?? "", timezone: row.timezone ?? "UTC" };
  return {
    id: row.id,
    botId: row.bot_id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    timing,
    destination: {
      chatId: row.chat_id,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      label: row.destination_label,
    },
    producerConversationId: row.producer_conversation_id,
    state: row.state,
    ...(row.paused_reason === null ? {} : { pausedReason: row.paused_reason }),
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    ...(row.last_fired_at === null ? {} : { lastFiredAt: row.last_fired_at }),
    consecutiveDeliveryFailures: row.consecutive_delivery_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(lastRun === undefined ? {} : { lastRun }),
  };
}
