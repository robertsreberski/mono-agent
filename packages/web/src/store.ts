import { createECDH, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  classifyNotifySuppression,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";

import {
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_LIVE_INPUTS_PER_THREAD,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  type WebAgentSummary,
  type WebAttachment,
  type WebMessage,
  type WebMessagePart,
  type WebMessageStatus,
  type WebNotificationTriggerKind,
  type WebCronJob,
  type WebCronOverview,
  type WebCronRun,
  type WebCronRunSummary,
  type WebCronRunPage,
  type WebMessagePage,
  type WebQuote,
  type WebRunState,
  type WebThread,
  type WebToolCall,
  type WebThreadDetail,
  type WebThreadPage,
  type WebPushSubscriptionState,
  type WebPushSubscriptionStatus,
} from "./contracts.js";
import { WebConsoleError } from "./errors.js";
import { webPushPreview } from "./push-preview.js";
import { prepareWebStatePaths, type WebStatePathOptions, type WebStatePaths } from "./state-paths.js";

interface AgentRow {
  source_id: string;
  label: string;
  status: string;
  pinned: number;
  health: string | null;
  supports_attachments: number;
  models_json: string | null;
  default_model: string | null;
  default_effort: string | null;
  efforts_json: string | null;
  model_options_json: string | null;
  cron_read: number;
  cron_actions: number;
  ask_by_id: number;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  source_id: string;
  title: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  trigger_kind: string | null;
  cron_job_id: string | null;
  cron_configured: number | null;
  can_send: number;
  can_upload: number;
  message_count: number;
}

interface NotificationDeliveryRow {
  source_id: string;
  delivery_key: string;
  thread_id: string | null;
  message_id: string | null;
  job_id: string | null;
  run_id: string | null;
  trigger_kind: string;
  payload_sha256: string;
  created_at: string;
  completed_at: string | null;
}

interface CronChannelRow {
  source_id: string;
  job_id: string;
  thread_id: string;
  configured: number;
  created_at: string;
  updated_at: string;
}

export interface CronRunReconciliationResult {
  readonly messages: readonly WebMessage[];
  readonly changed: boolean;
}

export interface CronOverviewSyncResult {
  readonly overview: WebCronOverview;
  readonly changed: boolean;
}

type IncomingCronJob = Omit<WebCronJob, "threadId">;
type IncomingCronOverview = Omit<WebCronOverview, "jobs"> & {
  readonly sourceId: string;
  readonly jobs: readonly IncomingCronJob[];
};

interface MessagePageRow extends MessageRow {
  ordered_at: string;
  role_rank: number;
  storage_rowid: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  parts_json: string;
  created_at: string;
  updated_at: string;
  status: string;
}

interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  model: string | null;
  effort: string | null;
  assistant_message_id: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface LiveInputRow {
  id: string;
  thread_id: string;
  message_id: string;
  active_turn_id: string | null;
  text: string;
  model: string | null;
  effort: string | null;
  status: "offered" | "queued";
  created_at: string;
  updated_at: string;
}

export interface StoredAttachment {
  readonly id: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "document";
  readonly status: "staged" | "committed";
  readonly uploaded: boolean;
  readonly storageName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AttachmentRow {
  id: string;
  thread_id: string | null;
  message_id: string | null;
  name: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  status: string;
  uploaded: number;
  storage_name: string;
  created_at: string;
  updated_at: string;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  endpoint_sha256: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  site_origin: string;
  key_fingerprint: string;
  state: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
}

interface PushEventRow {
  id: string;
  logical_key: string;
  kind: string;
  thread_id: string | null;
  source_id: string | null;
  title: string;
  body: string;
  tag: string;
  topic: string;
  expires_at: string;
  created_at: string;
}

interface PushDeliveryRow {
  event_id: string;
  subscription_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type WebPushEventKind =
  | "response.ready"
  | "input.required"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "test";

export interface WebPushIdentity {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly fingerprint: string;
}

export interface RegisterWebPushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expirationTime?: number;
  readonly siteOrigin: string;
  readonly keyFingerprint: string;
  readonly previousSubscriptionId?: string;
  readonly previousEndpoint?: string;
}

export interface StoredWebPushSubscription extends WebPushSubscriptionStatus {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expirationTime?: number;
  readonly siteOrigin: string;
}

export interface StoredWebPushEvent {
  readonly id: string;
  readonly logicalKey: string;
  readonly kind: WebPushEventKind;
  readonly threadId?: string;
  readonly sourceId?: string;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly topic: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface ClaimedWebPushDelivery {
  readonly event: StoredWebPushEvent;
  readonly subscription: StoredWebPushSubscription;
  readonly attempts: number;
}

const WEB_STORAGE_SCHEMA_VERSION = 6;
const MAX_REVISIONS_PER_THREAD = 1_000;
export const WEB_THREAD_PAGE_MAX = 200;
export const WEB_MESSAGE_PAGE_MAX = 100;
const MAX_ACTIVE_PUSH_SUBSCRIPTIONS = 32;
const MAX_PENDING_PUSH_DELIVERIES_PER_SUBSCRIPTION = 200;
const PUSH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface OpenWebStoreOptions extends WebStatePathOptions {
  readonly clock?: () => Date;
}

export interface CreateStoredUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly kind: "image" | "document";
  readonly declaredSize?: number;
}

export interface BeginStoredTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly quote?: WebQuote;
  readonly model?: string;
  readonly effort?: string;
}

export interface BeginStoredTurnResult {
  readonly turnId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly quote?: WebQuote;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly attachments: readonly StoredAttachment[];
  readonly thread: WebThread;
}

export interface StoredLiveInput {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly status: "offered" | "queued";
  readonly createdAt: string;
}

export interface ReserveStoredLiveInputResult {
  readonly input: StoredLiveInput;
  readonly message: WebMessage;
  readonly thread: WebThread;
  readonly offered: boolean;
}

export interface ReserveWebNotificationInput {
  readonly sourceId: string;
  readonly deliveryKey: string;
  readonly triggerKind: WebNotificationTriggerKind;
  readonly text: string;
  readonly jobId?: string;
  readonly runId?: string;
}

export interface WebNotificationReservation extends ReserveWebNotificationInput {
  readonly threadId?: string;
  readonly payloadSha256: string;
  readonly duplicate: boolean;
  readonly tombstoned?: true;
}

export interface CompleteWebNotificationResult {
  readonly thread?: WebThread;
  readonly duplicate: boolean;
  readonly tombstoned?: true;
}

export function cronChannelReadOnlyError(): WebConsoleError {
  return new WebConsoleError(
    "cron_channel_read_only",
    "Cron channels are read-only. Scheduled runs and history are managed by the agent.",
    409,
  );
}

export class WebStore {
  readonly paths: WebStatePaths;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private closed = false;

  private constructor(database: DatabaseSync, paths: WebStatePaths, clock: () => Date) {
    this.database = database;
    this.paths = paths;
    this.clock = clock;
  }

  static async open(options: OpenWebStoreOptions = {}): Promise<WebStore> {
    const paths = await prepareWebStatePaths(options);
    return WebStore.openPrepared(paths, options);
  }

  static async openPrepared(paths: WebStatePaths, options: Pick<OpenWebStoreOptions, "clock"> = {}): Promise<WebStore> {
    const existing = await lstat(paths.database).catch(() => undefined);
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new WebConsoleError("invalid_state_database", "Web state database must be a regular file.", 409);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (existing !== undefined && currentUid !== undefined && existing.uid !== currentUid) {
      throw new WebConsoleError("invalid_state_owner", "Web state database is not owned by the current user.", 409);
    }
    const database = new DatabaseSync(paths.database, { timeout: 5_000 });
    const store = new WebStore(database, paths, options.clock ?? (() => new Date()));
    try {
      store.initialize();
      await Promise.all([
        chmod(paths.database, 0o600),
        chmod(`${paths.database}-wal`, 0o600).catch(ignoreMissing),
        chmod(`${paths.database}-shm`, 0o600).catch(ignoreMissing),
      ]);
      store.recoverInterruptedTurns();
      store.recoverLiveInputs();
      store.recoverWebPushDeliveries();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  replaceAgents(agents: readonly WebAgentSummary[]): boolean {
    const current = this.listAgents();
    const currentById = new Map(current.map((agent) => [agent.sourceId, agent]));
    const incomingIds = new Set(agents.map((agent) => agent.sourceId));
    const changed = agents.some((agent) => {
      const prior = currentById.get(agent.sourceId);
      return prior === undefined || !isDeepStrictEqual(prior, { ...agent, pinned: prior.pinned });
    }) || current.some((agent) => !incomingIds.has(agent.sourceId) && agent.status !== "offline");
    if (!changed) return false;
    this.transaction(() => {
      this.database.prepare("UPDATE agents SET status = 'offline'").run();
      const statement = this.database.prepare(`
        INSERT INTO agents (
          source_id, label, status, health, supports_attachments, models_json,
          default_model, default_effort, efforts_json, model_options_json,
          cron_read, cron_actions, ask_by_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          health = excluded.health,
          supports_attachments = excluded.supports_attachments,
          models_json = excluded.models_json,
          default_model = excluded.default_model,
          default_effort = excluded.default_effort,
          efforts_json = excluded.efforts_json,
          model_options_json = excluded.model_options_json,
          cron_read = excluded.cron_read,
          cron_actions = excluded.cron_actions,
          ask_by_id = excluded.ask_by_id,
          updated_at = excluded.updated_at
      `);
      for (const agent of agents) {
        statement.run(
          agent.sourceId,
          agent.label,
          agent.status,
          agent.health ?? null,
          agent.supportsAttachments ? 1 : 0,
          stringifyOptional(agent.models),
          agent.defaultModel ?? null,
          agent.defaultEffort ?? null,
          stringifyOptional(agent.efforts),
          stringifyOptional(agent.modelOptions),
          agent.cron?.read === true ? 1 : 0,
          agent.cron?.actions === true ? 1 : 0,
          agent.supportsAskById === true ? 1 : 0,
          agent.updatedAt,
        );
      }
    });
    return true;
  }

  listAgents(): WebAgentSummary[] {
    const rows = this.database.prepare(agentSelectSql("ORDER BY pinned DESC, a.label COLLATE NOCASE, a.source_id")).all() as unknown as AgentRow[];
    return rows.map(mapAgent);
  }

  getAgent(sourceId: string): WebAgentSummary | undefined {
    const row = this.database.prepare(agentSelectSql("WHERE a.source_id = ?")).get(sourceId) as unknown as AgentRow | undefined;
    return row === undefined ? undefined : mapAgent(row);
  }

  setAgentPinned(sourceId: string, pinned: boolean): WebAgentSummary {
    if (this.getAgent(sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    const key = agentPinSettingKey(sourceId);
    if (pinned) this.setSetting(key, "1");
    else this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
    const agent = this.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    return agent;
  }

  reserveNotification(input: ReserveWebNotificationInput): WebNotificationReservation {
    if (this.getAgent(input.sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The notification agent is no longer available.", 404);
    }
    if (input.deliveryKey.length === 0 || input.deliveryKey.length > 1_024) {
      throw new WebConsoleError("invalid_notification", "Notification deliveryKey must contain 1 to 1024 characters.", 400);
    }
    if (input.text.trim().length === 0) {
      throw new WebConsoleError("invalid_notification", "Notification text cannot be empty.", 400);
    }
    if ((input.jobId === undefined) !== (input.runId === undefined)
      || (input.jobId !== undefined && input.triggerKind !== "cron")) {
      throw new WebConsoleError(
        "invalid_notification",
        "jobId and runId must be supplied together for cron notifications only.",
        400,
      );
    }
    const channel = input.jobId === undefined
      ? undefined
      : this.cronChannel(input.sourceId, input.jobId);
    const threadId = input.jobId === undefined
      ? notificationThreadId(input.sourceId, input.deliveryKey)
      : channel?.thread_id ?? cronChannelThreadId(input.sourceId, input.jobId);
    // Identity is compared through the structured columns below. Keep the
    // content digest compatible with pre-v5 receipts so a newly-structured
    // replay of an adopted historical delivery remains idempotent.
    const payloadSha256 = notificationPayloadSha256(input.triggerKind, input.text);
    const existing = this.database.prepare(`
      SELECT * FROM notification_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get(input.sourceId, input.deliveryKey) as unknown as NotificationDeliveryRow | undefined;
    if (existing !== undefined) {
      const historicalIdentity = input.jobId === undefined
        && existing.trigger_kind === "cron"
        && existing.job_id !== null
        && existing.run_id !== null
        ? legacyCronDeliveryIdentity(input.deliveryKey)
        : undefined;
      const expectedJobId = input.jobId ?? historicalIdentity?.jobId ?? null;
      const expectedRunId = input.runId ?? historicalIdentity?.runId ?? null;
      if (existing.trigger_kind !== input.triggerKind
        || existing.payload_sha256 !== payloadSha256
        || existing.job_id !== expectedJobId
        || existing.run_id !== expectedRunId) {
        throw new WebConsoleError(
          "notification_idempotency_conflict",
          "The notification delivery key was already used with different content.",
          409,
        );
      }
      if (existing.completed_at !== null && existing.thread_id === null) {
        return {
          ...input,
          ...(historicalIdentity === undefined ? {} : historicalIdentity),
          payloadSha256,
          duplicate: true,
          tombstoned: true,
        };
      }
      if (existing.completed_at !== null && this.getThread(existing.thread_id!) === undefined) {
        throw new WebConsoleError("storage_corrupt", "A completed notification is missing its conversation.", 500);
      }
      return {
        ...input,
        ...(historicalIdentity === undefined ? {} : historicalIdentity),
        ...(existing.thread_id === null ? {} : { threadId: existing.thread_id }),
        payloadSha256,
        duplicate: existing.completed_at !== null,
      };
    }
    const now = this.now();
    if (input.jobId !== undefined
      && input.runId !== undefined
      && this.database.prepare(`
        SELECT 1 FROM cron_channel_deletions WHERE source_id = ? AND job_id = ?
      `).get(input.sourceId, input.jobId) !== undefined) {
      this.database.prepare(`
        INSERT INTO notification_deliveries (
          source_id, delivery_key, thread_id, trigger_kind, job_id, run_id,
          message_id, payload_sha256, created_at, completed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        input.sourceId,
        input.deliveryKey,
        input.triggerKind,
        input.jobId,
        input.runId,
        payloadSha256,
        now,
        now,
      );
      return { ...input, payloadSha256, duplicate: true, tombstoned: true };
    }
    this.database.prepare(`
      INSERT INTO notification_deliveries (
        source_id, delivery_key, thread_id, trigger_kind, job_id, run_id,
        message_id, payload_sha256, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
    `).run(
      input.sourceId,
      input.deliveryKey,
      threadId,
      input.triggerKind,
      input.jobId ?? null,
      input.runId ?? null,
      payloadSha256,
      now,
    );
    return { ...input, threadId, payloadSha256, duplicate: false };
  }

  /** Agent-history namespace for a reserved console delivery. */
  notificationConversationId(reservation: WebNotificationReservation): string {
    if (reservation.threadId === undefined) {
      throw new WebConsoleError("notification_reservation_lost", "The notification reservation has no target.", 409);
    }
    return reservation.jobId === undefined
      ? `web:${reservation.threadId}`
      : cronConsoleConversationId(reservation.sourceId, reservation.jobId);
  }

  completeNotification(reservation: WebNotificationReservation): CompleteWebNotificationResult {
    const existing = this.database.prepare(`
      SELECT * FROM notification_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get(reservation.sourceId, reservation.deliveryKey) as unknown as NotificationDeliveryRow | undefined;
    if (existing === undefined
      || existing.trigger_kind !== reservation.triggerKind
      || existing.payload_sha256 !== reservation.payloadSha256
      || existing.job_id !== (reservation.jobId ?? null)
      || existing.run_id !== (reservation.runId ?? null)) {
      throw new WebConsoleError("notification_reservation_lost", "The notification reservation is no longer valid.", 409);
    }
    if (existing.completed_at !== null) {
      if (existing.thread_id === null) return { duplicate: true, tombstoned: true };
      return { thread: this.requireThread(existing.thread_id), duplicate: true };
    }
    if (existing.thread_id === null || reservation.threadId === undefined) {
      throw new WebConsoleError("notification_reservation_lost", "The notification reservation lost its target.", 409);
    }
    const now = this.now();
    let turnId: string = randomUUID();
    let assistantMessageId: string = randomUUID();
    let completedThreadId = existing.thread_id;
    this.transaction(() => {
      const cronChannel = reservation.jobId === undefined
        ? undefined
        : this.cronChannel(reservation.sourceId, reservation.jobId);
      completedThreadId = cronChannel?.thread_id ?? existing.thread_id!;
      const existingThread = this.getThread(completedThreadId);
      if (existingThread === undefined) {
        const title = reservation.jobId === undefined
          ? reservation.triggerKind === "cron" ? "Cron notification" : "Webhook notification"
          : `Cron · ${reservation.jobId}`;
        this.database.prepare(`
          INSERT INTO threads (
            id, source_id, conversation_id, title, title_manual, trigger_kind, archived_at,
            created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, 1)
        `).run(
          completedThreadId,
          reservation.sourceId,
          reservation.jobId === undefined
            ? `web:${completedThreadId}`
            : cronConsoleConversationId(reservation.sourceId, reservation.jobId),
          title,
          reservation.triggerKind,
          now,
          now,
        );
      } else if (reservation.jobId === undefined) {
        throw new WebConsoleError("notification_idempotency_conflict", "The notification conversation already exists.", 409);
      }
      if (reservation.jobId !== undefined) {
        this.database.prepare(`
          INSERT INTO cron_channels (
            source_id, job_id, thread_id, configured, created_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(source_id, job_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            updated_at = excluded.updated_at
        `).run(reservation.sourceId, reservation.jobId, completedThreadId, now, now);
      }
      const mappedRun = reservation.jobId === undefined || reservation.runId === undefined
        ? undefined
        : this.database.prepare(`
            SELECT turn_id, message_id FROM cron_run_messages
            WHERE source_id = ? AND job_id = ? AND run_id = ? AND thread_id = ?
          `).get(
            reservation.sourceId,
            reservation.jobId,
            reservation.runId,
            completedThreadId,
          ) as unknown as { turn_id: string; message_id: string } | undefined;
      if (mappedRun === undefined) {
        this.database.prepare(`
          INSERT INTO turns (
            id, thread_id, status, text, model, effort, assistant_message_id,
            started_at, finished_at, error_code, error_message
          ) VALUES (?, ?, 'complete', '', NULL, NULL, ?, ?, ?, NULL, NULL)
        `).run(turnId, completedThreadId, assistantMessageId, now, now);
        this.database.prepare(`
          INSERT INTO messages (
            id, thread_id, turn_id, role, parts_json, created_at, updated_at, status
          ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, 'complete')
        `).run(
          assistantMessageId,
          completedThreadId,
          turnId,
          JSON.stringify([{ type: "text", text: reservation.text } satisfies WebMessagePart]),
          now,
          now,
        );
      } else {
        turnId = mappedRun.turn_id;
        assistantMessageId = mappedRun.message_id;
        const message = this.database.prepare(`
          SELECT parts_json FROM messages WHERE id = ? AND thread_id = ? AND turn_id = ?
        `).get(assistantMessageId, completedThreadId, turnId) as unknown as { parts_json: string } | undefined;
        if (message === undefined) {
          throw new WebConsoleError("storage_corrupt", "A cron run mapping is missing its message.", 500);
        }
        const parts = parseParts(message.parts_json);
        if (!parts.some((part) => part.type === "text" && part.text === reservation.text)) {
          parts.push({ type: "text", text: reservation.text });
          this.database.prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(parts), now, assistantMessageId);
        }
      }
      this.database.prepare(`
        UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?
      `).run(now, completedThreadId);
      this.recordThreadRevision(completedThreadId, "notification_created", now);
      this.database.prepare(`
        UPDATE notification_deliveries SET thread_id = ?, message_id = ?, completed_at = ?
        WHERE source_id = ? AND delivery_key = ? AND completed_at IS NULL
      `).run(completedThreadId, assistantMessageId, now, reservation.sourceId, reservation.deliveryKey);
      const agent = this.getAgent(reservation.sourceId);
      this.enqueueWebPushEventInTransaction({
        logicalKey: notificationPushLogicalKey(reservation.sourceId, reservation.deliveryKey),
        kind: "response.ready",
        threadId: completedThreadId,
        sourceId: reservation.sourceId,
        title: `${agent?.label ?? "mono-agent"} · ${reservation.triggerKind.toUpperCase()}`,
        body: reservation.text,
        expiresAt: new Date(new Date(now).getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        notBefore: new Date(new Date(now).getTime() + 3_000).toISOString(),
      });
    });
    return { thread: this.requireThread(completedThreadId), duplicate: false };
  }

  /** Persist an agent-authoritative overview without deriving scheduler facts in the console. */
  syncCronOverviewResult(overview: IncomingCronOverview): CronOverviewSyncResult {
    const effectiveJobs = this.effectiveIncomingCronJobs(overview.sourceId, overview.jobs);
    if (this.cronOverviewMatches(overview, effectiveJobs)) {
      const stored = this.storedCronOverview(overview.sourceId);
      if (stored === undefined) {
        throw new WebConsoleError("storage_corrupt", "Matched cron overview disappeared.", 500);
      }
      const threadByJobId = new Map(stored.jobs.map((job) => [job.jobId, job.threadId]));
      return {
        overview: {
          generatedAt: overview.generatedAt,
          actionsEnabled: overview.actionsEnabled,
          jobs: effectiveJobs.map((job) => {
            const threadId = threadByJobId.get(job.jobId);
            if (threadId === undefined) {
              throw new WebConsoleError("storage_corrupt", "Matched cron channel is missing.", 500);
            }
            return { ...job, threadId };
          }),
          ...(overview.degradedReason === undefined ? {} : { degradedReason: overview.degradedReason }),
          ...(overview.jobsTruncated === true ? { jobsTruncated: true as const } : {}),
        },
        changed: false,
      };
    }
    return { overview: this.syncCronOverview(overview), changed: true };
  }

  syncCronOverview(overview: IncomingCronOverview): WebCronOverview {
    if (this.getAgent(overview.sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    }
    const effectiveJobs = this.effectiveIncomingCronJobs(overview.sourceId, overview.jobs);
    const now = this.now();
    const jobs: WebCronJob[] = [];
    this.transaction(() => {
      this.database.prepare("UPDATE cron_channels SET configured = 0, updated_at = ? WHERE source_id = ?")
        .run(now, overview.sourceId);
      // Jobs omitted by the new authoritative overview remain historical
      // channels. Reconcile their cached payload too so an offline read cannot
      // resurrect the prior configured:true value after the relational column
      // has already been cleared.
      const removedSnapshots = this.database.prepare(`
        SELECT s.job_id, s.payload_json
        FROM cron_job_snapshots s
        JOIN cron_channels c ON c.source_id = s.source_id AND c.job_id = s.job_id
        WHERE s.source_id = ? AND c.configured = 0
      `).all(overview.sourceId) as unknown as Array<{ job_id: string; payload_json: string }>;
      const markSnapshotRemoved = this.database.prepare(`
        UPDATE cron_job_snapshots SET payload_json = ?, updated_at = ?
        WHERE source_id = ? AND job_id = ?
      `);
      for (const snapshot of removedSnapshots) {
        const job = parseStoredCronJob(snapshot.payload_json);
        markSnapshotRemoved.run(
          JSON.stringify({ ...job, configured: false }),
          now,
          overview.sourceId,
          snapshot.job_id,
        );
      }
      for (const job of effectiveJobs) {
        if (job.configured) {
          this.database.prepare("DELETE FROM cron_channel_deletions WHERE source_id = ? AND job_id = ?")
            .run(overview.sourceId, job.jobId);
        }
        const current = this.cronChannel(overview.sourceId, job.jobId);
        const threadId = current?.thread_id ?? cronChannelThreadId(overview.sourceId, job.jobId);
        const existingThread = this.database.prepare("SELECT source_id, trigger_kind FROM threads WHERE id = ?")
          .get(threadId) as unknown as { source_id: string; trigger_kind: string | null } | undefined;
        if (existingThread !== undefined
          && (existingThread.source_id !== overview.sourceId || existingThread.trigger_kind !== "cron")) {
          throw new WebConsoleError("storage_corrupt", "Cron channel identity collides with another conversation.", 500);
        }
        if (existingThread === undefined) {
          this.database.prepare(`
            INSERT INTO threads (
              id, source_id, conversation_id, title, title_manual, trigger_kind,
              archived_at, created_at, updated_at, revision
            ) VALUES (?, ?, ?, ?, 0, 'cron', NULL, ?, ?, 1)
          `).run(
            threadId,
            overview.sourceId,
            cronConsoleConversationId(overview.sourceId, job.jobId),
            `Cron · ${job.jobId}`,
            now,
            now,
          );
          this.database.prepare(`
            INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at)
            VALUES ('thread', ?, 1, 'cron_channel_created', ?)
          `).run(threadId, now);
        } else {
          this.database.prepare(`
            UPDATE threads SET trigger_kind = 'cron',
              title = CASE WHEN title_manual = 0 THEN ? ELSE title END
            WHERE id = ?
          `).run(`Cron · ${job.jobId}`, threadId);
        }
        this.database.prepare(`
          INSERT INTO cron_channels (source_id, job_id, thread_id, configured, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, job_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            configured = excluded.configured,
            updated_at = excluded.updated_at
        `).run(overview.sourceId, job.jobId, threadId, job.configured ? 1 : 0, now, now);
        this.database.prepare(`
          INSERT INTO cron_job_snapshots (source_id, job_id, payload_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source_id, job_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `).run(overview.sourceId, job.jobId, JSON.stringify(job), now);
        jobs.push({ ...job, threadId });
      }
      this.database.prepare(`
        INSERT INTO cron_overviews (
          source_id, generated_at, actions_enabled, degraded_reason, jobs_truncated, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          generated_at = excluded.generated_at,
          actions_enabled = excluded.actions_enabled,
          degraded_reason = excluded.degraded_reason,
          jobs_truncated = excluded.jobs_truncated,
          updated_at = excluded.updated_at
      `).run(
        overview.sourceId,
        overview.generatedAt,
        overview.actionsEnabled ? 1 : 0,
        overview.degradedReason ?? null,
        overview.jobsTruncated === true ? 1 : 0,
        now,
      );
    });
    return {
      generatedAt: overview.generatedAt,
      actionsEnabled: overview.actionsEnabled,
      jobs,
      ...(overview.degradedReason === undefined ? {} : { degradedReason: overview.degradedReason }),
      ...(overview.jobsTruncated === true ? { jobsTruncated: true as const } : {}),
    };
  }

  private effectiveIncomingCronJobs(
    sourceId: string,
    jobs: readonly IncomingCronJob[],
  ): readonly IncomingCronJob[] {
    const tombstoned = this.database.prepare(`
      SELECT 1 FROM cron_channel_deletions WHERE source_id = ? AND job_id = ?
    `);
    return jobs.filter((job) => job.configured || tombstoned.get(sourceId, job.jobId) === undefined);
  }

  private cronOverviewMatches(
    overview: IncomingCronOverview,
    effectiveJobs: readonly IncomingCronJob[],
  ): boolean {
    const stored = this.storedCronOverview(overview.sourceId);
    if (stored === undefined
      || stored.actionsEnabled !== overview.actionsEnabled
      || stored.degradedReason !== overview.degradedReason
      || (stored.jobsTruncated === true) !== (overview.jobsTruncated === true)) return false;
    const storedById = new Map(stored.jobs.map((job) => [job.jobId, job]));
    for (const incoming of effectiveJobs) {
      const current = storedById.get(incoming.jobId);
      if (current === undefined) return false;
      const { threadId: _threadId, ...currentPayload } = current;
      if (!isDeepStrictEqual(currentPayload, incoming)) return false;
    }
    if (overview.jobsTruncated === true) return true;
    const incomingIds = new Set(effectiveJobs.map((job) => job.jobId));
    return stored.jobs.every((job) => incomingIds.has(job.jobId) || job.configured === false);
  }

  storedCronOverview(sourceId: string): WebCronOverview | undefined {
    const overview = this.database.prepare("SELECT * FROM cron_overviews WHERE source_id = ?")
      .get(sourceId) as unknown as {
        generated_at: string;
        actions_enabled: number;
        degraded_reason: string | null;
        jobs_truncated: number;
      } | undefined;
    if (overview === undefined) return undefined;
    const rows = this.database.prepare(`
      SELECT s.payload_json, c.thread_id, c.configured
      FROM cron_job_snapshots s
      JOIN cron_channels c ON c.source_id = s.source_id AND c.job_id = s.job_id
      WHERE s.source_id = ? ORDER BY s.job_id
    `).all(sourceId) as unknown as Array<{ payload_json: string; thread_id: string; configured: number }>;
    const jobs = rows.map((row) => ({
      ...parseStoredCronJob(row.payload_json),
      configured: row.configured === 1,
      threadId: row.thread_id,
    }));
    return {
      generatedAt: overview.generated_at,
      actionsEnabled: overview.actions_enabled === 1,
      jobs,
      ...(overview.degraded_reason === null ? {} : { degradedReason: overview.degraded_reason }),
      ...(overview.jobs_truncated === 1 ? { jobsTruncated: true as const } : {}),
    };
  }

  cronThread(sourceId: string, jobId: string): WebThread | undefined {
    const channel = this.cronChannel(sourceId, jobId);
    return channel === undefined ? undefined : this.getThread(channel.thread_id);
  }

  cronConversationIdForThread(threadId: string): string | undefined {
    const resolved = this.resolveThreadId(threadId);
    const row = this.database.prepare(`
      SELECT s.payload_json FROM cron_channels c
      JOIN cron_job_snapshots s ON s.source_id = c.source_id AND s.job_id = c.job_id
      WHERE c.thread_id = ?
    `).get(resolved) as unknown as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseStoredCronJob(row.payload_json).conversationId;
  }

  storedCronRuns(sourceId: string, jobId: string, limit = 100): WebCronRunPage {
    const bounded = boundedPageLimit(limit, 100);
    const rows = this.database.prepare(`
      SELECT payload_json FROM cron_run_messages
      WHERE source_id = ? AND job_id = ?
      ORDER BY ordered_at DESC, sequence DESC, run_id DESC LIMIT ?
    `).all(sourceId, jobId, bounded) as unknown as Array<{ payload_json: string }>;
    return { runs: rows.map((row) => parseStoredCronRun(row.payload_json)) };
  }

  reconcileCronRuns(sourceId: string, jobId: string, runs: readonly WebCronRun[]): WebMessage[] {
    return [...this.reconcileCronRunsResult(sourceId, jobId, runs).messages];
  }

  reconcileCronRunsResult(
    sourceId: string,
    jobId: string,
    runs: readonly WebCronRun[],
  ): CronRunReconciliationResult {
    const channel = this.cronChannel(sourceId, jobId);
    if (channel === undefined) {
      throw new WebConsoleError("cron_job_not_found", "Cron channel not found.", 404);
    }
    const jobRow = this.database.prepare(`
      SELECT payload_json FROM cron_job_snapshots WHERE source_id = ? AND job_id = ?
    `).get(sourceId, jobId) as unknown as { payload_json: string } | undefined;
    const conversationId = jobRow === undefined
      ? `cron:${jobId}`
      : parseStoredCronJob(jobRow.payload_json).conversationId;
    const ordered = [...runs].sort(compareCronRuns);
    if (ordered.length === 0) return { messages: [], changed: false };
    const now = this.now();
    const messageIds: string[] = [];
    let changed = false;
    this.transaction(() => {
      for (const run of ordered) {
        if (run.jobId !== jobId) {
          throw new WebConsoleError("invalid_cron_response", "Cron run belongs to another job.", 502);
        }
        const mapped = this.database.prepare(`
          SELECT thread_id, turn_id, message_id, ordered_at, sequence, payload_json
          FROM cron_run_messages
          WHERE source_id = ? AND job_id = ? AND run_id = ?
        `).get(sourceId, jobId, run.runId) as unknown as {
          thread_id: string;
          turn_id: string;
          message_id: string;
          ordered_at: string;
          sequence: number;
          payload_json: string;
        } | undefined;
        if (mapped !== undefined && (mapped.ordered_at !== run.orderedAt || mapped.sequence !== run.sequence)) {
          throw new WebConsoleError(
            "invalid_cron_response",
            "Cron run ordering identity changed after admission.",
            502,
          );
        }
        const delivered = mapped === undefined
          ? this.database.prepare(`
              SELECT d.message_id, m.turn_id
              FROM notification_deliveries d
              JOIN messages m ON m.id = d.message_id
              WHERE d.source_id = ? AND d.job_id = ? AND d.run_id = ?
                AND d.thread_id = ? AND d.completed_at IS NOT NULL
              ORDER BY d.completed_at DESC LIMIT 1
            `).get(sourceId, jobId, run.runId, channel.thread_id) as unknown as {
              message_id: string;
              turn_id: string;
            } | undefined
          : undefined;
        const turnId = mapped?.turn_id ?? delivered?.turn_id ?? cronEntityId("turn", sourceId, jobId, run.runId);
        const messageId = mapped?.message_id ?? delivered?.message_id ?? cronEntityId("message", sourceId, jobId, run.runId);
        messageIds.push(messageId);
        const prior = this.database.prepare(`
          SELECT thread_id, turn_id, parts_json, created_at, status FROM messages WHERE id = ?
        `).get(messageId) as unknown as {
          thread_id: string;
          turn_id: string | null;
          parts_json: string;
          created_at: string;
          status: string;
        } | undefined;
        const priorParts = prior === undefined ? [] : parseParts(prior.parts_json);
        const parts = cronRunParts(
          run,
          priorParts,
          conversationId,
        );
        const serializedParts = JSON.stringify(parts);
        const status = cronMessageStatus(run.status);
        const turnStatus = status === "running" ? "running" : status;
        const finishedAt = status === "running" ? null : run.completedAt ?? run.orderedAt;
        const existingTurn = this.database.prepare(`
          SELECT thread_id, status, text, assistant_message_id, started_at, finished_at,
            error_code, error_message FROM turns WHERE id = ?
        `).get(turnId) as unknown as {
          thread_id: string;
          status: string;
          text: string;
          assistant_message_id: string;
          started_at: string;
          finished_at: string | null;
          error_code: string | null;
          error_message: string | null;
        } | undefined;
        const preserveLoadedText = run.projection === "summary"
          && run.fieldsTruncated?.includes("text") === true
          && priorParts.some((part) => part.type === "telemetry"
            && part.event === "cron_run"
            && record(part.data)?.activityLoaded === true);
        const preserveLoadedError = run.projection === "summary"
          && priorParts.some((part) => part.type === "telemetry"
            && part.event === "cron_run"
            && record(part.data)?.activityLoaded === true)
          && (run.fieldsTruncated?.includes("error") === true
            || run.fieldsTruncated?.includes("failureKind") === true);
        const turnText = preserveLoadedText && existingTurn !== undefined
          ? existingTurn.text
          : run.text ?? "";
        const turnErrorCode = preserveLoadedError && existingTurn !== undefined
          ? existingTurn.error_code
          : run.failureKind ?? null;
        const turnErrorMessage = preserveLoadedError && existingTurn !== undefined
          ? existingTurn.error_message
          : run.error ?? null;
        if (existingTurn === undefined) {
          this.database.prepare(`
            INSERT INTO turns (
              id, thread_id, status, text, model, effort, assistant_message_id,
              started_at, finished_at, error_code, error_message
            ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
          `).run(
            turnId,
            channel.thread_id,
            turnStatus,
            turnText,
            messageId,
            run.orderedAt,
            finishedAt,
            turnErrorCode,
            turnErrorMessage,
          );
          changed = true;
        } else if (
          existingTurn.thread_id !== channel.thread_id
          || existingTurn.status !== turnStatus
          || existingTurn.text !== turnText
          || existingTurn.assistant_message_id !== messageId
          || existingTurn.started_at !== run.orderedAt
          || existingTurn.finished_at !== finishedAt
          || existingTurn.error_code !== turnErrorCode
          || existingTurn.error_message !== turnErrorMessage
        ) {
          this.database.prepare(`
            UPDATE turns SET thread_id = ?, status = ?, text = ?, assistant_message_id = ?,
              started_at = ?, finished_at = ?, error_code = ?, error_message = ?
            WHERE id = ?
          `).run(
            channel.thread_id,
            turnStatus,
            turnText,
            messageId,
            run.orderedAt,
            finishedAt,
            turnErrorCode,
            turnErrorMessage,
            turnId,
          );
          changed = true;
        }
        if (prior === undefined) {
          this.database.prepare(`
            INSERT INTO messages (
              id, thread_id, turn_id, role, parts_json, created_at, updated_at, status
            ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
          `).run(messageId, channel.thread_id, turnId, serializedParts, run.orderedAt, now, status);
          changed = true;
        } else if (
          prior.thread_id !== channel.thread_id
          || prior.turn_id !== turnId
          || prior.parts_json !== serializedParts
          || prior.created_at !== run.orderedAt
          || prior.status !== status
        ) {
          this.database.prepare(`
            UPDATE messages SET thread_id = ?, turn_id = ?, parts_json = ?,
              created_at = ?, updated_at = ?, status = ? WHERE id = ?
          `).run(channel.thread_id, turnId, serializedParts, run.orderedAt, now, status, messageId);
          changed = true;
        }
        // Detail is a message projection, not a replacement for the compact
        // page identity. Keeping the existing summary prevents the next
        // unchanged page poll from undoing a detail load and creating churn.
        const serializedRun = run.projection === "detail" && mapped !== undefined
          ? mapped.payload_json
          : JSON.stringify(cronRunSummary(run));
        if (mapped === undefined
          || mapped.thread_id !== channel.thread_id
          || mapped.turn_id !== turnId
          || mapped.message_id !== messageId
          || mapped.payload_json !== serializedRun) {
          this.database.prepare(`
            INSERT INTO cron_run_messages (
              source_id, job_id, run_id, thread_id, turn_id, message_id,
              ordered_at, sequence, payload_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, job_id, run_id) DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              message_id = excluded.message_id,
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
          `).run(
            sourceId,
            jobId,
            run.runId,
            channel.thread_id,
            turnId,
            messageId,
            run.orderedAt,
            run.sequence,
            serializedRun,
            now,
          );
          changed = true;
        }
      }
      if (changed) {
        const newest = ordered.at(-1)!;
        this.database.prepare(`
          UPDATE threads SET updated_at = MAX(updated_at, ?), revision = revision + 1 WHERE id = ?
        `).run(newest.completedAt ?? newest.startedAt ?? newest.orderedAt, channel.thread_id);
        this.recordThreadRevision(channel.thread_id, "cron_runs_reconciled", now);

        const excess = this.database.prepare(`
          SELECT turn_id FROM (
            SELECT turn_id, ROW_NUMBER() OVER (
              PARTITION BY source_id, job_id ORDER BY ordered_at DESC, sequence DESC, run_id DESC
            ) AS retained_row
            FROM cron_run_messages WHERE source_id = ? AND job_id = ?
          ) WHERE retained_row > 500
        `).all(sourceId, jobId) as unknown as Array<{ turn_id: string }>;
        const remove = this.database.prepare("DELETE FROM turns WHERE id = ?");
        for (const row of excess) remove.run(row.turn_id);
      }
    });
    return {
      messages: [...new Set(messageIds)].map((messageId) => this.requireMessage(messageId)),
      changed,
    };
  }

  createThread(sourceId: string): WebThread {
    const agent = this.getAgent(sourceId);
    if (agent === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    const id = randomUUID();
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO threads (
          id, source_id, conversation_id, title, title_manual, archived_at,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'New conversation', 0, NULL, ?, ?, 1)
      `).run(id, sourceId, `web:${id}`, now, now);
      this.database.prepare("INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at) VALUES ('thread', ?, 1, 'created', ?)")
        .run(id, now);
      this.setSetting("current_thread_id", id);
    });
    return this.requireThread(id);
  }

  /** Bounded bootstrap: at most one 200-row bucket per (source_id, archived). */
  listThreads(): WebThread[] {
    const rows = this.database.prepare(threadSelectSql(`
      WHERE t.id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_id, CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END
                   ORDER BY updated_at DESC, id DESC
                 ) AS bucket_row
          FROM threads
        ) WHERE bucket_row <= ${String(WEB_THREAD_PAGE_MAX)}
      )
      ORDER BY t.updated_at DESC, t.id DESC
    `)).all() as unknown as ThreadRow[];
    return rows.map((row) => this.mapThread(row));
  }

  listThreadsPage(input: {
    readonly sourceId: string;
    readonly archived: boolean;
    readonly limit?: number;
    readonly before?: string;
  }): WebThreadPage {
    if (this.getAgent(input.sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    }
    const limit = boundedPageLimit(input.limit, WEB_THREAD_PAGE_MAX);
    const cursor = input.before === undefined ? undefined : decodeThreadCursor(input.before);
    const archivedSql = input.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL";
    const beforeSql = cursor === undefined
      ? ""
      : "AND (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))";
    const values: Array<string | number> = [input.sourceId];
    if (cursor !== undefined) values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    values.push(limit + 1);
    const rows = this.database.prepare(threadSelectSql(`
      WHERE t.source_id = ? AND ${archivedSql} ${beforeSql}
      ORDER BY t.updated_at DESC, t.id DESC LIMIT ?
    `)).all(...values) as unknown as ThreadRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      threads: pageRows.map((row) => this.mapThread(row)),
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor({ updatedAt: last.updated_at, id: last.id }) }
        : {}),
    };
  }

  resolveThreadId(id: string): string {
    let resolved = id;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth += 1) {
      if (seen.has(resolved)) {
        throw new WebConsoleError("storage_corrupt", "Conversation redirects contain a cycle.", 500);
      }
      seen.add(resolved);
      const row = this.database.prepare("SELECT new_thread_id FROM thread_redirects WHERE old_thread_id = ?")
        .get(resolved) as unknown as { new_thread_id: string } | undefined;
      if (row === undefined) return resolved;
      resolved = row.new_thread_id;
    }
    throw new WebConsoleError("storage_corrupt", "Conversation redirect chain is too deep.", 500);
  }

  getThread(id: string): WebThread | undefined {
    const resolved = this.resolveThreadId(id);
    const row = this.database.prepare(threadSelectSql("WHERE t.id = ?")).get(resolved) as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : this.mapThread(row);
  }

  getThreadDetail(id: string): WebThreadDetail | undefined {
    const resolved = this.resolveThreadId(id);
    const thread = this.getThread(resolved);
    if (thread === undefined) return undefined;
    const page = this.listMessagesPage(resolved);
    return {
      thread,
      messages: page.messages,
      ...(page.nextCursor === undefined ? {} : { messagesNextCursor: page.nextCursor }),
    };
  }

  listMessagesPage(
    id: string,
    input: { readonly before?: string; readonly limit?: number } = {},
  ): WebMessagePage {
    const resolved = this.resolveThreadId(id);
    if (this.getThread(resolved) === undefined) {
      throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    }
    const limit = boundedPageLimit(input.limit, WEB_MESSAGE_PAGE_MAX);
    const cursor = input.before === undefined ? undefined : decodeMessageCursor(input.before);
    const rank = messageRoleRankSql("m", "t");
    const orderedAt = "COALESCE(t.started_at, m.created_at)";
    const beforeSql = cursor === undefined ? "" : `AND (
      ${orderedAt} < ?
      OR (${orderedAt} = ? AND ${rank} < ?)
      OR (${orderedAt} = ? AND ${rank} = ? AND m.created_at < ?)
      OR (${orderedAt} = ? AND ${rank} = ? AND m.created_at = ? AND m.rowid < ?)
    )`;
    const values: Array<string | number> = [resolved];
    if (cursor !== undefined) {
      values.push(
        cursor.orderedAt,
        cursor.orderedAt,
        cursor.roleRank,
        cursor.orderedAt,
        cursor.roleRank,
        cursor.createdAt,
        cursor.orderedAt,
        cursor.roleRank,
        cursor.createdAt,
        cursor.rowid,
      );
    }
    values.push(limit + 1);
    const rows = this.database.prepare(`
      SELECT m.*, ${orderedAt} AS ordered_at, ${rank} AS role_rank, m.rowid AS storage_rowid
      FROM messages m
      LEFT JOIN turns t ON t.id = m.turn_id
      WHERE m.thread_id = ? ${beforeSql}
      ORDER BY ordered_at DESC, role_rank DESC, m.created_at DESC, storage_rowid DESC
      LIMIT ?
    `).all(...values) as unknown as MessagePageRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit).reverse();
    const oldest = pageRows[0];
    return {
      messages: pageRows.map((row) => this.mapMessage(row)),
      ...(hasMore && oldest !== undefined
        ? {
            nextCursor: encodeCursor({
              orderedAt: oldest.ordered_at,
              roleRank: oldest.role_rank,
              createdAt: oldest.created_at,
              rowid: oldest.storage_rowid,
            }),
          }
        : {}),
    };
  }

  currentThreadId(): string | undefined {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = 'current_thread_id'").get() as unknown as { value: string } | undefined;
    if (row === undefined) return undefined;
    const resolved = this.resolveThreadId(row.value);
    if (this.getThread(resolved) === undefined) return undefined;
    if (resolved !== row.value) this.setSetting("current_thread_id", resolved);
    return resolved;
  }

  selectThread(id: string): void {
    const resolved = this.resolveThreadId(id);
    this.requireThread(resolved);
    this.setSetting("current_thread_id", resolved);
  }

  patchThread(id: string, patch: { readonly title?: string; readonly archived?: boolean }): WebThread {
    id = this.resolveThreadId(id);
    const current = this.requireThread(id);
    const now = this.now();
    const title = patch.title === undefined ? undefined : normalizeTitle(patch.title);
    const archivedAt = patch.archived === undefined ? undefined : patch.archived ? now : null;
    this.transaction(() => {
      const sets = ["updated_at = ?", "revision = revision + 1"];
      const values: Array<string | null> = [now];
      if (title !== undefined) {
        sets.push("title = ?", "title_manual = 1");
        values.push(title);
      }
      if (archivedAt !== undefined) {
        sets.push("archived_at = ?");
        values.push(archivedAt);
      }
      values.push(id);
      this.database.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      this.recordThreadRevision(id, title !== undefined ? "title_changed" : patch.archived ? "archived" : "unarchived", now);
      if (patch.archived === true && this.currentThreadId() === id) {
        this.database.prepare("DELETE FROM settings WHERE key = 'current_thread_id'").run();
      }
    });
    return { ...this.requireThread(id), sourceId: current.sourceId };
  }

  async deleteArchivedThread(id: string): Promise<{ readonly orphanedFiles: number }> {
    id = this.resolveThreadId(id);
    const thread = this.requireThread(id);
    if (thread.archivedAt === null) {
      throw new WebConsoleError("thread_not_archived", "Archive the conversation before deleting it.", 409);
    }
    const cronChannel = this.database.prepare("SELECT * FROM cron_channels WHERE thread_id = ?")
      .get(id) as unknown as CronChannelRow | undefined;
    if (cronChannel?.configured === 1) {
      throw new WebConsoleError(
        "cron_channel_configured",
        "Configured cron channels can be archived but not deleted.",
        409,
      );
    }
    const attachments = this.database.prepare("SELECT * FROM attachments WHERE thread_id = ?")
      .all(id) as unknown as AttachmentRow[];
    this.transaction(() => {
      const now = this.now();
      this.database.prepare(`
        UPDATE push_deliveries SET status = 'dropped', updated_at = ?, finished_at = ?, last_error_code = 'thread_deleted'
        WHERE event_id IN (SELECT id FROM push_events WHERE thread_id = ?)
          AND status IN ('pending', 'sending')
      `).run(now, now, id);
      // Keep the delivery receipt after its channel is removed. Replays remain
      // duplicates and can never resurrect a deleted historical channel.
      this.database.prepare(`
        UPDATE notification_deliveries
        SET thread_id = NULL, message_id = NULL, completed_at = COALESCE(completed_at, ?)
        WHERE thread_id = ?
      `).run(now, id);
      if (cronChannel !== undefined) {
        this.database.prepare(`
          INSERT INTO cron_channel_deletions (source_id, job_id, deleted_at)
          VALUES (?, ?, ?)
          ON CONFLICT(source_id, job_id) DO UPDATE SET deleted_at = excluded.deleted_at
        `).run(cronChannel.source_id, cronChannel.job_id, now);
      }
      this.database.prepare("DELETE FROM cron_channels WHERE thread_id = ?").run(id);
      this.database.prepare("DELETE FROM revisions WHERE entity_kind = 'thread' AND entity_id = ?").run(id);
      this.database.prepare("DELETE FROM threads WHERE id = ?").run(id);
      this.database.prepare("DELETE FROM settings WHERE key = 'current_thread_id' AND value = ?").run(id);
    });

    let orphanedFiles = 0;
    for (const row of attachments) {
      await unlink(this.attachmentPath(mapStoredAttachment(row))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") orphanedFiles += 1;
      });
    }
    return { orphanedFiles };
  }

  createUpload(input: CreateStoredUploadInput): StoredAttachment {
    const id = randomUUID();
    const now = this.now();
    const storageName = `${id}.bin`;
    this.database.prepare(`
      INSERT INTO attachments (
        id, thread_id, message_id, name, content_type, size_bytes, kind,
        status, uploaded, storage_name, created_at, updated_at
      ) VALUES (?, NULL, NULL, ?, ?, ?, ?, 'staged', 0, ?, ?, ?)
    `).run(id, input.name, input.contentType, input.declaredSize ?? 0, input.kind, storageName, now, now);
    return this.requireStoredAttachment(id);
  }

  markUploadComplete(id: string, sizeBytes: number): StoredAttachment {
    const attachment = this.requireStoredAttachment(id);
    if (attachment.status !== "staged" || attachment.threadId !== undefined) {
      throw new WebConsoleError("attachment_committed", "A committed attachment cannot be replaced.", 409);
    }
    const now = this.now();
    this.database.prepare("UPDATE attachments SET size_bytes = ?, uploaded = 1, updated_at = ? WHERE id = ?")
      .run(sizeBytes, now, id);
    return this.requireStoredAttachment(id);
  }

  getStoredAttachment(id: string): StoredAttachment | undefined {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as unknown as AttachmentRow | undefined;
    return row === undefined ? undefined : mapStoredAttachment(row);
  }

  stagedUploadUsage(): { readonly count: number; readonly bytes: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM attachments WHERE status = 'staged' AND thread_id IS NULL
    `).get() as unknown as { count: number; bytes: number };
    return row;
  }

  attachmentPath(attachment: Pick<StoredAttachment, "storageName">): string {
    return resolve(this.paths.uploads, attachment.storageName);
  }

  async removeStagedAttachment(id: string): Promise<void> {
    const attachment = this.requireStoredAttachment(id);
    if (attachment.status !== "staged" || attachment.threadId !== undefined) {
      throw new WebConsoleError("attachment_committed", "Committed attachments are retained with their conversation.", 409);
    }
    await unlink(this.attachmentPath(attachment)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  async purgeStagedAttachments(before: string): Promise<number> {
    const rows = this.database.prepare(`
      SELECT * FROM attachments
      WHERE status = 'staged' AND thread_id IS NULL AND created_at < ?
    `).all(before) as unknown as AttachmentRow[];
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await unlink(this.attachmentPath(mapStoredAttachment(row))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.transaction(() => {
      const remove = this.database.prepare("DELETE FROM attachments WHERE id = ? AND status = 'staged' AND thread_id IS NULL");
      for (const row of rows) remove.run(row.id);
    });
    return rows.length;
  }

  async purgePartialUploadFiles(before?: string): Promise<number> {
    const entries = await readdir(this.paths.uploads, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.bin\.partial-[0-9a-f-]{36}$/iu.test(entry.name)) continue;
      const path = resolve(this.paths.uploads, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (before !== undefined && info.mtime.toISOString() >= before) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }

  async purgeUnreferencedAttachmentFiles(): Promise<number> {
    const referenced = new Set(
      (this.database.prepare("SELECT storage_name FROM attachments").all() as unknown as Array<{ storage_name: string }>)
        .map((row) => row.storage_name),
    );
    const entries = await readdir(this.paths.uploads, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.bin$/iu.test(entry.name) || referenced.has(entry.name)) continue;
      const path = resolve(this.paths.uploads, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }

  beginTurn(input: BeginStoredTurnInput): BeginStoredTurnResult {
    const threadId = this.resolveThreadId(input.threadId);
    const thread = this.requireThread(threadId);
    if (thread.archivedAt !== null) {
      throw new WebConsoleError("thread_archived", "Unarchive this conversation before sending another message.", 409);
    }
    if (thread.trigger?.kind === "cron") throw cronChannelReadOnlyError();
    if (!thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    const active = this.database.prepare("SELECT id FROM turns WHERE thread_id = ? AND status = 'running'").get(threadId);
    if (active !== undefined) {
      throw new WebConsoleError("turn_active", "This conversation already has an active turn.", 409);
    }
    const uniqueIds = [...new Set(input.attachmentIds)];
    if (uniqueIds.length !== input.attachmentIds.length || uniqueIds.length > WEB_MAX_FILES_PER_TURN) {
      throw new WebConsoleError("attachment_limit", `A turn accepts at most ${WEB_MAX_FILES_PER_TURN} distinct attachments.`, 400);
    }
    const attachments = uniqueIds.map((id) => this.requireStoredAttachment(id));
    if (attachments.length > 0 && !thread.canUpload) {
      throw new WebConsoleError("attachments_unsupported", "This agent does not advertise web attachment support.", 409);
    }
    for (const attachment of attachments) {
      if (attachment.status !== "staged" || attachment.threadId !== undefined || !attachment.uploaded) {
        throw new WebConsoleError("attachment_unavailable", `Attachment ${attachment.id} is not ready.`, 409);
      }
    }
    const aggregateBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (aggregateBytes > WEB_MAX_TURN_ATTACHMENT_BYTES) {
      throw new WebConsoleError("attachment_aggregate_limit", "The turn's attachments exceed the 64 MiB aggregate limit.", 413);
    }
    if (input.text.trim().length === 0 && attachments.length === 0) {
      throw new WebConsoleError("empty_turn", "Enter a message or attach at least one file.", 400);
    }
    if (input.quote !== undefined) {
      if (input.quote.text.trim().length === 0 || input.quote.messageId.trim().length === 0) {
        throw new WebConsoleError("invalid_quote", "Quoted text and its source message are required.", 400);
      }
      const source = this.database.prepare(
        "SELECT id FROM messages WHERE id = ? AND thread_id = ?",
      ).get(input.quote.messageId, threadId);
      if (source === undefined) {
        throw new WebConsoleError(
          "invalid_quote",
          "The quoted message does not belong to this conversation.",
          400,
        );
      }
    }

    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(turnId, threadId, input.text, input.model ?? null, input.effort ?? null, assistantMessageId, now);

      const userParts: WebMessagePart[] = [
        ...(input.quote === undefined
          ? []
          : [{ type: "telemetry" as const, event: QUOTE_TELEMETRY_EVENT, data: input.quote }]),
        ...(input.text.length === 0 ? [] : [{ type: "text" as const, text: input.text }]),
      ];
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete')
      `).run(userMessageId, threadId, turnId, JSON.stringify(userParts), now, now);
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
      `).run(assistantMessageId, threadId, turnId, now, now);

      const commitAttachment = this.database.prepare(`
        UPDATE attachments
        SET thread_id = ?, message_id = ?, status = 'committed', updated_at = ?
        WHERE id = ?
      `);
      for (const attachment of attachments) {
        commitAttachment.run(threadId, userMessageId, now, attachment.id);
      }

      const title = deriveAutomaticTitle(input.text, attachments);
      this.database.prepare(`
        UPDATE threads
        SET title = CASE WHEN title_manual = 0 AND title = 'New conversation' THEN ? ELSE title END,
            updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(title, now, threadId);
      this.recordThreadRevision(threadId, "turn_started", now);
      this.setSetting("current_thread_id", threadId);
    });

    return {
      turnId,
      conversationId: `web:${threadId}`,
      text: input.text,
      ...(input.quote === undefined ? {} : { quote: input.quote }),
      userMessageId,
      assistantMessageId,
      attachments: attachments.map((attachment) => this.requireStoredAttachment(attachment.id)),
      thread: this.requireThread(threadId),
    };
  }

  reserveLiveInput(threadId: string, text: string): ReserveStoredLiveInputResult {
    threadId = this.resolveThreadId(threadId);
    const thread = this.requireThread(threadId);
    if (thread.archivedAt !== null) {
      throw new WebConsoleError("thread_archived", "Unarchive this conversation before sending another message.", 409);
    }
    if (thread.trigger?.kind === "cron") throw cronChannelReadOnlyError();
    if (!thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    if (text.trim().length === 0) {
      throw new WebConsoleError("empty_turn", "Enter a message.", 400);
    }
    if (text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS) {
      throw new WebConsoleError(
        "turn_text_too_large",
        `A live follow-up may contain at most ${AGENT_LIVE_INPUT_MAX_CHARACTERS} characters.`,
        413,
      );
    }
    const usage = this.database.prepare(
      "SELECT COUNT(*) AS count FROM live_inputs WHERE thread_id = ?",
    ).get(threadId) as unknown as { count: number };
    if (usage.count >= WEB_MAX_LIVE_INPUTS_PER_THREAD) {
      throw new WebConsoleError("live_input_queue_full", "Too many follow-up messages are waiting.", 429);
    }
    const active = this.database.prepare(
      "SELECT id, model, effort FROM turns WHERE thread_id = ? AND status = 'running'",
    ).get(threadId) as unknown as Pick<TurnRow, "id" | "model" | "effort"> | undefined;
    const id = randomUUID();
    const messageId = randomUUID();
    const now = this.now();
    const status = active === undefined ? "queued" : "offered";
    const parts: WebMessagePart[] = [
      liveInputTelemetry(status === "offered" ? "pending" : "queued"),
      { type: "text", text },
    ];
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete')
      `).run(messageId, threadId, active?.id ?? null, JSON.stringify(parts), now, now);
      this.database.prepare(`
        INSERT INTO live_inputs (
          id, thread_id, message_id, active_turn_id, text, model, effort, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        threadId,
        messageId,
        active?.id ?? null,
        text,
        active?.model ?? null,
        active?.effort ?? null,
        status,
        now,
        now,
      );
      const title = deriveAutomaticTitle(text, []);
      this.database.prepare(`
        UPDATE threads
        SET title = CASE WHEN title_manual = 0 AND title = 'New conversation' THEN ? ELSE title END,
            updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(title, now, threadId);
      this.recordThreadRevision(threadId, "live_input_received", now);
      this.setSetting("current_thread_id", threadId);
    });
    const stored = this.requireLiveInput(id);
    return {
      input: mapLiveInput(stored),
      message: this.requireMessage(messageId),
      thread: this.requireThread(threadId),
      offered: status === "offered",
    };
  }

  markLiveInputApplied(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "applied")), now, row.message_id);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_applied", now);
    });
    return this.requireMessage(row.message_id);
  }

  queueLiveInput(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE live_inputs SET status = 'queued', active_turn_id = NULL, updated_at = ? WHERE id = ?
      `).run(now, id);
      this.database.prepare("UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "queued")), now, row.message_id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_queued", now);
    });
    return this.requireMessage(row.message_id);
  }

  cancelLiveInput(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "cancelled")), now, row.message_id);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_cancelled", now);
    });
    return this.requireMessage(row.message_id);
  }

  cancelLiveInputs(threadId: string): WebMessage[] {
    threadId = this.resolveThreadId(threadId);
    const rows = this.database.prepare(
      "SELECT * FROM live_inputs WHERE thread_id = ? ORDER BY created_at, rowid",
    ).all(threadId) as unknown as LiveInputRow[];
    if (rows.length === 0) return [];
    const now = this.now();
    this.transaction(() => {
      const update = this.database.prepare(
        "UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        const message = this.requireMessage(row.message_id);
        update.run(JSON.stringify(withLiveInputStatus(message.parts, "cancelled")), now, row.message_id);
      }
      this.database.prepare("DELETE FROM live_inputs WHERE thread_id = ?").run(threadId);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, threadId);
      this.recordThreadRevision(threadId, "live_inputs_cancelled", now);
    });
    return rows.map((row) => this.requireMessage(row.message_id));
  }

  queuedLiveInputThreadIds(): string[] {
    return (this.database.prepare(`
      SELECT thread_id FROM live_inputs WHERE status = 'queued'
      GROUP BY thread_id ORDER BY MIN(created_at), thread_id
    `).all() as unknown as Array<{ thread_id: string }>).map((row) => row.thread_id);
  }

  promoteNextQueuedLiveInput(threadId: string): BeginStoredTurnResult | undefined {
    threadId = this.resolveThreadId(threadId);
    const active = this.database.prepare(
      "SELECT id FROM turns WHERE thread_id = ? AND status = 'running'",
    ).get(threadId);
    if (active !== undefined) return undefined;
    const row = this.database.prepare(`
      SELECT * FROM live_inputs
      WHERE thread_id = ? AND status = 'queued'
      ORDER BY created_at, rowid LIMIT 1
    `).get(threadId) as unknown as LiveInputRow | undefined;
    if (row === undefined) return undefined;
    const thread = this.requireThread(threadId);
    if (!thread.canSend || thread.archivedAt !== null) return undefined;
    const turnId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = this.now();
    const userMessage = this.requireMessage(row.message_id);
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(turnId, threadId, row.text, row.model, row.effort, assistantMessageId, now);
      this.database.prepare("UPDATE messages SET turn_id = ?, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(turnId, JSON.stringify(withoutLiveInputTelemetry(userMessage.parts)), now, row.message_id);
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
      `).run(assistantMessageId, threadId, turnId, now, now);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(row.id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, threadId);
      this.recordThreadRevision(threadId, "turn_started", now);
    });
    return {
      turnId,
      conversationId: `web:${threadId}`,
      text: row.text,
      userMessageId: row.message_id,
      assistantMessageId,
      attachments: [],
      thread: this.requireThread(threadId),
    };
  }

  applyStreamFrame(turnId: string, frame: AgentStreamWireFrame): WebMessage {
    return this.applyStreamFrames(turnId, [frame]);
  }

  applyStreamFrames(turnId: string, frames: readonly AgentStreamWireFrame[]): WebMessage {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") return this.requireMessage(turn.assistant_message_id);
    const message = this.requireMessage(turn.assistant_message_id);
    const parts = [...message.parts];
    let actualModel: string | undefined;
    let actualEffort: string | undefined;
    for (const frame of frames) {
      if (frame.kind === "status") {
        parts.push({ type: "telemetry", event: "status", data: { text: frame.text } });
      } else if (frame.kind === "append") {
        appendTextPart(parts, "text", frame.delta);
      } else if (frame.kind === "replace") {
        replaceWholeText(parts, frame.text);
      } else if (frame.kind === "event") {
        applyEvent(parts, frame.event);
        if (frame.event.type === "runtime_telemetry" && frame.event.kind === "run_config") {
          if (typeof frame.event.data?.model === "string") actualModel = frame.event.data.model;
          if (typeof frame.event.data?.effort === "string") actualEffort = frame.event.data.effort;
        }
      }
    }
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(parts), now, message.id);
      if (actualModel !== undefined || actualEffort !== undefined) {
        this.database.prepare(`
          UPDATE turns SET
            model = CASE WHEN ? IS NULL THEN model ELSE ? END,
            effort = CASE WHEN ? IS NULL THEN effort ELSE ? END
          WHERE id = ?
        `).run(actualModel ?? null, actualModel ?? null, actualEffort ?? null, actualEffort ?? null, turnId);
      }
    });
    return this.requireMessage(message.id);
  }

  completeTurn(turnId: string, finalText?: string, metadata?: Readonly<Record<string, unknown>>): WebThreadDetail {
    const runtime = runtimeMetadata(metadata);
    return this.finishTurn(turnId, "complete", finalText, undefined, undefined, runtime);
  }

  failTurn(turnId: string, error: { readonly message: string; readonly code?: string; readonly cancelled?: boolean }): WebThreadDetail {
    return this.finishTurn(
      turnId,
      error.cancelled === true ? "cancelled" : "failed",
      undefined,
      error.code,
      error.message,
      undefined,
    );
  }

  interruptTurn(turnId: string, message = "The web service stopped before this turn completed."): WebThreadDetail {
    return this.finishTurn(turnId, "interrupted", undefined, "interrupted", message, undefined);
  }

  activeTurn(threadId: string): { readonly id: string; readonly conversationId: string } | undefined {
    threadId = this.resolveThreadId(threadId);
    const row = this.database.prepare("SELECT id FROM turns WHERE thread_id = ? AND status = 'running'").get(threadId) as unknown as { id: string } | undefined;
    return row === undefined ? undefined : { id: row.id, conversationId: `web:${threadId}` };
  }

  listActiveTurnIds(): string[] {
    const rows = this.database.prepare("SELECT id FROM turns WHERE status = 'running'").all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  threadIdForTurn(turnId: string): string | undefined {
    const row = this.database.prepare("SELECT thread_id FROM turns WHERE id = ?").get(turnId) as unknown as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  ensureWebPushIdentity(generate: () => { readonly publicKey: string; readonly privateKey: string }): WebPushIdentity {
    const rows = this.database.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('web_push_public_key', 'web_push_private_key', 'web_push_key_fingerprint')
    `).all() as unknown as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const publicKey = values.get("web_push_public_key");
    const privateKey = values.get("web_push_private_key");
    const fingerprint = values.get("web_push_key_fingerprint");
    const present = [publicKey, privateKey, fingerprint].filter((value) => value !== undefined).length;
    if (present > 0 && present < 3) {
      throw new WebConsoleError(
        "web_push_identity_corrupt",
        "The stored Web Push identity is incomplete. Reset web state before enabling notifications again.",
        500,
      );
    }
    if (publicKey !== undefined && privateKey !== undefined && fingerprint !== undefined) {
      if (!isValidVapidKeyPair(publicKey, privateKey) || fingerprint !== pushKeyFingerprint(publicKey)) {
        throw new WebConsoleError(
          "web_push_identity_corrupt",
          "The stored Web Push identity is invalid. Reset web state before enabling notifications again.",
          500,
        );
      }
      return { publicKey, privateKey, fingerprint };
    }

    const generated = generate();
    if (!isValidVapidKeyPair(generated.publicKey, generated.privateKey)) {
      throw new WebConsoleError("web_push_identity_generation_failed", "Unable to generate a valid Web Push identity.", 500);
    }
    const generatedFingerprint = pushKeyFingerprint(generated.publicKey);
    this.transaction(() => {
      this.setSetting("web_push_public_key", generated.publicKey);
      this.setSetting("web_push_private_key", generated.privateKey);
      this.setSetting("web_push_key_fingerprint", generatedFingerprint);
    });
    return { ...generated, fingerprint: generatedFingerprint };
  }

  registerWebPushSubscription(input: RegisterWebPushSubscriptionInput): WebPushSubscriptionStatus {
    const endpointSha256 = createHash("sha256").update(input.endpoint).digest("hex");
    const previousEndpointSha256 = input.previousEndpoint === undefined
      ? undefined
      : createHash("sha256").update(input.previousEndpoint).digest("hex");
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM push_subscriptions WHERE endpoint_sha256 = ?")
        .get(endpointSha256) as unknown as PushSubscriptionRow | undefined;
      const replacements = new Set<string>();
      if (input.previousSubscriptionId !== undefined) {
        const row = this.database.prepare("SELECT id FROM push_subscriptions WHERE id = ? AND site_origin = ?")
          .get(input.previousSubscriptionId, input.siteOrigin) as unknown as { id: string } | undefined;
        if (row !== undefined) replacements.add(row.id);
      }
      if (previousEndpointSha256 !== undefined) {
        const row = this.database.prepare("SELECT id FROM push_subscriptions WHERE endpoint_sha256 = ? AND site_origin = ?")
          .get(previousEndpointSha256, input.siteOrigin) as unknown as { id: string } | undefined;
        if (row !== undefined) replacements.add(row.id);
      }
      if (existing !== undefined) replacements.delete(existing.id);

      const now = this.now();
      for (const replacementId of replacements) {
        this.database.prepare(`
          UPDATE push_subscriptions SET state = 'expired', disabled_at = ?, updated_at = ?,
            last_error_at = ?, last_error_code = 'subscription_rotated'
          WHERE id = ? AND state = 'active'
        `).run(now, now, now, replacementId);
        this.database.prepare(`
          UPDATE push_deliveries SET status = 'stale', updated_at = ?, finished_at = ?,
            last_error_code = 'subscription_rotated'
          WHERE subscription_id = ? AND status IN ('pending', 'sending')
        `).run(now, now, replacementId);
      }

      if (existing?.state !== "active") {
        const active = this.database.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE state = 'active'")
          .get() as unknown as { count: number };
        if (active.count >= MAX_ACTIVE_PUSH_SUBSCRIPTIONS) {
          throw new WebConsoleError(
            "push_subscription_limit",
            `This console already has ${MAX_ACTIVE_PUSH_SUBSCRIPTIONS} active notification subscriptions.`,
            409,
          );
        }
      }
      const id = existing?.id ?? randomUUID();
      this.database.prepare(`
        INSERT INTO push_subscriptions (
          id, endpoint, endpoint_sha256, p256dh, auth, expiration_time, site_origin,
          key_fingerprint, state, created_at, updated_at, disabled_at,
          last_success_at, last_error_at, last_error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)
        ON CONFLICT(endpoint_sha256) DO UPDATE SET
          endpoint = excluded.endpoint,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          expiration_time = excluded.expiration_time,
          site_origin = excluded.site_origin,
          key_fingerprint = excluded.key_fingerprint,
          state = 'active',
          updated_at = excluded.updated_at,
          disabled_at = NULL,
          last_error_at = NULL,
          last_error_code = NULL
      `).run(
        id,
        input.endpoint,
        endpointSha256,
        input.p256dh,
        input.auth,
        input.expirationTime ?? null,
        input.siteOrigin,
        input.keyFingerprint,
        now,
        now,
      );
      return this.requirePushSubscriptionStatus(id);
    });
  }

  getWebPushSubscription(id: string): WebPushSubscriptionStatus | undefined {
    const row = this.database.prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as unknown as PushSubscriptionRow | undefined;
    return row === undefined ? undefined : mapPushSubscriptionStatus(row);
  }

  disableWebPushSubscription(id: string): void {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE push_subscriptions SET state = 'disabled', disabled_at = ?, updated_at = ?
      WHERE id = ? AND state != 'disabled'
    `).run(now, now, id);
    if (result.changes === 0 && this.getWebPushSubscription(id) === undefined) {
      throw new WebConsoleError("push_subscription_not_found", "Notification subscription not found.", 404);
    }
    this.database.prepare(`
      UPDATE push_deliveries SET status = 'dropped', updated_at = ?, finished_at = ?, last_error_code = 'subscription_disabled'
      WHERE subscription_id = ? AND status IN ('pending', 'sending')
    `).run(now, now, id);
  }

  expireWebPushSubscription(id: string, reason: string): void {
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE push_subscriptions SET state = 'expired', disabled_at = ?, updated_at = ?,
          last_error_at = ?, last_error_code = ? WHERE id = ?
      `).run(now, now, now, reason, id);
      this.database.prepare(`
        UPDATE push_deliveries SET status = 'stale', updated_at = ?, finished_at = ?, last_error_code = ?
        WHERE subscription_id = ? AND status IN ('pending', 'sending')
      `).run(now, now, reason, id);
    });
  }

  enqueueWebPushEvent(input: {
    readonly logicalKey: string;
    readonly kind: WebPushEventKind;
    readonly threadId?: string;
    readonly sourceId?: string;
    readonly title: string;
    readonly body: string;
    readonly expiresAt: string;
    readonly notBefore?: string;
    readonly subscriptionId?: string;
  }): StoredWebPushEvent | undefined {
    return this.transaction(() => this.enqueueWebPushEventInTransaction(input));
  }

  enqueueWebPushTest(subscriptionId: string): StoredWebPushEvent {
    const subscription = this.requirePushSubscription(subscriptionId);
    if (subscription.state !== "active") {
      throw new WebConsoleError("push_subscription_inactive", "Notification subscription is not active.", 409);
    }
    const latest = this.database.prepare(`
      SELECT e.created_at FROM push_events e
      JOIN push_deliveries d ON d.event_id = e.id
      WHERE d.subscription_id = ? AND e.kind = 'test'
      ORDER BY e.created_at DESC LIMIT 1
    `).get(subscriptionId) as unknown as { created_at: string } | undefined;
    if (latest !== undefined && this.clock().getTime() - new Date(latest.created_at).getTime() < 10_000) {
      throw new WebConsoleError("push_test_rate_limited", "Wait 10 seconds before sending another test notification.", 429);
    }
    const now = this.clock();
    const event = this.enqueueWebPushEvent({
      logicalKey: `test:${randomUUID()}`,
      kind: "test",
      title: "mono-agent notifications",
      body: "Push notifications are connected.",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      notBefore: now.toISOString(),
      subscriptionId,
    });
    if (event === undefined) throw new WebConsoleError("push_subscription_inactive", "Notification subscription is not active.", 409);
    return event;
  }

  webPushEventByLogicalKey(logicalKey: string): StoredWebPushEvent | undefined {
    const row = this.database.prepare("SELECT * FROM push_events WHERE logical_key = ?").get(logicalKey) as unknown as PushEventRow | undefined;
    return row === undefined ? undefined : mapPushEvent(row);
  }

  acknowledgeWebPushEvent(eventId: string, subscriptionId: string): boolean {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE push_deliveries SET status = 'suppressed', updated_at = ?, finished_at = ?, last_error_code = NULL
      WHERE event_id = ? AND subscription_id = ? AND status = 'pending' AND attempts = 0
    `).run(now, now, eventId, subscriptionId);
    return result.changes > 0;
  }

  claimDueWebPushDeliveries(limit: number): ClaimedWebPushDelivery[] {
    const now = this.now();
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE push_deliveries SET status = 'dropped', updated_at = ?, finished_at = ?, last_error_code = 'expired'
        WHERE status IN ('pending', 'sending')
          AND event_id IN (SELECT id FROM push_events WHERE expires_at <= ?)
      `).run(now, now, now);
      const rows = this.database.prepare(`
        SELECT d.event_id, d.subscription_id, d.status, d.attempts, d.next_attempt_at,
          d.last_status_code, d.last_error_code, d.created_at, d.updated_at, d.finished_at,
          e.id AS e_id, e.logical_key, e.kind, e.thread_id, e.source_id, e.title, e.body,
          e.tag, e.topic, e.expires_at, e.created_at AS e_created_at,
          s.id AS s_id, s.endpoint, s.endpoint_sha256, s.p256dh, s.auth, s.expiration_time,
          s.site_origin, s.key_fingerprint, s.state, s.created_at AS s_created_at,
          s.updated_at AS s_updated_at, s.disabled_at, s.last_success_at, s.last_error_at, s.last_error_code AS s_last_error_code
        FROM push_deliveries d
        JOIN push_events e ON e.id = d.event_id
        JOIN push_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND e.expires_at > ? AND s.state = 'active'
        ORDER BY d.next_attempt_at, d.created_at, d.rowid
        LIMIT ?
      `).all(now, now, limit) as unknown as Array<Record<string, unknown>>;
      const claim = this.database.prepare(`
        UPDATE push_deliveries SET status = 'sending', updated_at = ?
        WHERE event_id = ? AND subscription_id = ? AND status = 'pending'
      `);
      const claimed: ClaimedWebPushDelivery[] = [];
      for (const row of rows) {
        if (claim.run(now, row.event_id as string, row.subscription_id as string).changes === 0) continue;
        claimed.push({
          event: mapPushEvent({
            id: row.e_id as string,
            logical_key: row.logical_key as string,
            kind: row.kind as string,
            thread_id: row.thread_id as string | null,
            source_id: row.source_id as string | null,
            title: row.title as string,
            body: row.body as string,
            tag: row.tag as string,
            topic: row.topic as string,
            expires_at: row.expires_at as string,
            created_at: row.e_created_at as string,
          }),
          subscription: mapPushSubscription({
            id: row.s_id as string,
            endpoint: row.endpoint as string,
            endpoint_sha256: row.endpoint_sha256 as string,
            p256dh: row.p256dh as string,
            auth: row.auth as string,
            expiration_time: row.expiration_time as number | null,
            site_origin: row.site_origin as string,
            key_fingerprint: row.key_fingerprint as string,
            state: row.state as string,
            created_at: row.s_created_at as string,
            updated_at: row.s_updated_at as string,
            disabled_at: row.disabled_at as string | null,
            last_success_at: row.last_success_at as string | null,
            last_error_at: row.last_error_at as string | null,
            last_error_code: row.s_last_error_code as string | null,
          }),
          attempts: row.attempts as number,
        });
      }
      return claimed;
    });
  }

  settleWebPushDelivery(input: {
    readonly eventId: string;
    readonly subscriptionId: string;
    readonly status: "accepted" | "stale" | "failed" | "config_error" | "dropped";
    readonly statusCode?: number;
    readonly errorCode?: string;
  }): void {
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE push_deliveries SET status = ?, attempts = attempts + 1, updated_at = ?, finished_at = ?,
          last_status_code = ?, last_error_code = ?
        WHERE event_id = ? AND subscription_id = ? AND status = 'sending'
      `).run(
        input.status,
        now,
        now,
        input.statusCode ?? null,
        input.errorCode ?? null,
        input.eventId,
        input.subscriptionId,
      );
      if (input.status === "accepted") {
        this.database.prepare(`
          UPDATE push_subscriptions SET last_success_at = ?, updated_at = ?, last_error_code = NULL
          WHERE id = ?
        `).run(now, now, input.subscriptionId);
      } else {
        this.database.prepare(`
          UPDATE push_subscriptions SET last_error_at = ?, updated_at = ?, last_error_code = ?
          WHERE id = ?
        `).run(now, now, input.errorCode ?? input.status, input.subscriptionId);
      }
    });
  }

  retryWebPushDelivery(input: {
    readonly eventId: string;
    readonly subscriptionId: string;
    readonly nextAttemptAt: string;
    readonly statusCode?: number;
    readonly errorCode: string;
  }): void {
    const now = this.now();
    this.database.prepare(`
      UPDATE push_deliveries SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?,
        updated_at = ?, last_status_code = ?, last_error_code = ?
      WHERE event_id = ? AND subscription_id = ? AND status = 'sending'
    `).run(
      input.nextAttemptAt,
      now,
      input.statusCode ?? null,
      input.errorCode,
      input.eventId,
      input.subscriptionId,
    );
  }

  deferClaimedWebPushDelivery(eventId: string, subscriptionId: string, nextAttemptAt: string): void {
    this.database.prepare(`
      UPDATE push_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE event_id = ? AND subscription_id = ? AND status = 'sending'
    `).run(nextAttemptAt, this.now(), eventId, subscriptionId);
  }

  staleWebPushEvent(logicalKey: string, reason = "resolved"): void {
    const now = this.now();
    this.database.prepare(`
      UPDATE push_deliveries SET status = 'stale', updated_at = ?, finished_at = ?, last_error_code = ?
      WHERE event_id = (SELECT id FROM push_events WHERE logical_key = ?)
        AND status IN ('pending', 'sending')
    `).run(now, now, reason, logicalKey);
  }

  webPushDueQueueDepth(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM push_deliveries
      WHERE status = 'sending' OR (status = 'pending' AND next_attempt_at <= ?)
    `).get(this.now()) as unknown as { count: number };
    return row.count;
  }

  purgeWebPushState(): void {
    const before = new Date(this.clock().getTime() - PUSH_RETENTION_MS).toISOString();
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM push_subscriptions WHERE state IN ('disabled', 'expired') AND updated_at < ?
      `).run(before);
      this.database.prepare(`
        DELETE FROM push_events WHERE created_at < ? AND NOT EXISTS (
          SELECT 1 FROM push_deliveries d WHERE d.event_id = push_events.id AND d.status IN ('pending', 'sending')
        )
      `).run(before);
    });
  }

  private initialize(): void {
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const versionRow = this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
      if (versionRow.user_version > WEB_STORAGE_SCHEMA_VERSION) {
        throw new WebConsoleError(
          "unsupported_storage_schema",
          `Web state schema ${versionRow.user_version} is newer than supported schema ${WEB_STORAGE_SCHEMA_VERSION}.`,
          500,
        );
      }
      if (versionRow.user_version < 0) {
        throw new WebConsoleError("storage_corrupt", "Web state schema version is invalid.", 500);
      }
      const migrating = versionRow.user_version < WEB_STORAGE_SCHEMA_VERSION;
      if (migrating) this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        health TEXT,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        models_json TEXT,
        default_model TEXT,
        default_effort TEXT,
        efforts_json TEXT,
        model_options_json TEXT,
        cron_read INTEGER NOT NULL DEFAULT 0,
        cron_actions INTEGER NOT NULL DEFAULT 0,
        ask_by_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        conversation_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        title_manual INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        assistant_message_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_per_thread
        ON turns(thread_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS live_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL CHECK (status IN ('offered', 'queued')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_inputs_by_thread
        ON live_inputs(thread_id, status, created_at);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        storage_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id, created_at);
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_by_entity ON revisions(entity_kind, entity_id, revision);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        delivery_key TEXT NOT NULL,
        thread_id TEXT,
        message_id TEXT,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook')),
        job_id TEXT,
        run_id TEXT,
        payload_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK ((job_id IS NULL AND run_id IS NULL) OR (trigger_kind = 'cron' AND job_id IS NOT NULL AND run_id IS NOT NULL)),
        PRIMARY KEY (source_id, delivery_key)
      );
      CREATE INDEX IF NOT EXISTS notification_deliveries_by_thread
        ON notification_deliveries(thread_id) WHERE thread_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cron_channels (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS cron_channels_by_source
        ON cron_channels(source_id, configured, job_id);
      CREATE TABLE IF NOT EXISTS cron_channel_deletions (
        source_id TEXT NOT NULL REFERENCES agents(source_id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS cron_overviews (
        source_id TEXT PRIMARY KEY REFERENCES agents(source_id) ON DELETE CASCADE,
        generated_at TEXT NOT NULL,
        actions_enabled INTEGER NOT NULL CHECK (actions_enabled IN (0, 1)),
        degraded_reason TEXT,
        jobs_truncated INTEGER NOT NULL DEFAULT 0 CHECK (jobs_truncated IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cron_job_snapshots (
        source_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id),
        FOREIGN KEY (source_id, job_id) REFERENCES cron_channels(source_id, job_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS cron_run_messages (
        source_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        ordered_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id, run_id),
        FOREIGN KEY (source_id, job_id) REFERENCES cron_channels(source_id, job_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS cron_run_messages_by_order
        ON cron_run_messages(source_id, job_id, ordered_at DESC, sequence DESC, run_id DESC);
      CREATE TABLE IF NOT EXISTS thread_redirects (
        old_thread_id TEXT PRIMARY KEY,
        new_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (old_thread_id <> new_thread_id)
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        endpoint_sha256 TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time INTEGER,
        site_origin TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'expired')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_by_state
        ON push_subscriptions(state, updated_at);
      CREATE TABLE IF NOT EXISTS push_events (
        id TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN (
          'response.ready', 'input.required', 'run.failed', 'run.cancelled', 'run.interrupted', 'test'
        )),
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tag TEXT NOT NULL,
        topic TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_events_by_expiry ON push_events(expires_at);
      CREATE TABLE IF NOT EXISTS push_deliveries (
        event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'sending', 'accepted', 'suppressed', 'stale', 'failed', 'config_error', 'dropped'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_status_code INTEGER,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (event_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS push_deliveries_due
        ON push_deliveries(status, next_attempt_at, created_at);
      `);
        if (versionRow.user_version === 1) {
          const columns = this.database.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
          if (!columns.some((column) => column.name === "trigger_kind")) {
            this.database.exec(
              "ALTER TABLE threads ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook'))",
            );
          }
        }
        if (versionRow.user_version < 5) this.migrateCronChannels();
        if (versionRow.user_version < 6) {
          const columns = new Set((this.database.prepare("PRAGMA table_info(cron_overviews)").all() as Array<{ name: string }>)
            .map((column) => column.name));
          if (!columns.has("jobs_truncated")) {
            this.database.exec(
              "ALTER TABLE cron_overviews ADD COLUMN jobs_truncated INTEGER NOT NULL DEFAULT 0 CHECK (jobs_truncated IN (0, 1))",
            );
          }
        }
        if (migrating) this.database.exec(`PRAGMA user_version = ${WEB_STORAGE_SCHEMA_VERSION}; COMMIT`);
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      this.validateStorage();
    } catch (error) {
      if (error instanceof WebConsoleError) throw error;
      throw new WebConsoleError("storage_corrupt", `Unable to initialize web state: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  /**
   * Schema-v5 adoption runs after every older fixup inside the same
   * BEGIN IMMEDIATE transaction. Each operation is guarded by the resulting
   * schema/keys, so reopening an interrupted migration is idempotent.
   */
  private migrateCronChannels(): void {
    const agentColumns = new Set((this.database.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!agentColumns.has("cron_read")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN cron_read INTEGER NOT NULL DEFAULT 0");
    }
    if (!agentColumns.has("cron_actions")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN cron_actions INTEGER NOT NULL DEFAULT 0");
    }
    if (!agentColumns.has("ask_by_id")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN ask_by_id INTEGER NOT NULL DEFAULT 0");
    }

    const deliveryColumns = this.database.prepare("PRAGMA table_info(notification_deliveries)")
      .all() as Array<{ name: string; notnull: number }>;
    const threadColumn = deliveryColumns.find((column) => column.name === "thread_id");
    if (!deliveryColumns.some((column) => column.name === "job_id") || threadColumn?.notnull === 1) {
      const legacyRows = this.database.prepare("SELECT * FROM notification_deliveries")
        .all() as unknown as Array<{
          source_id: string;
          delivery_key: string;
          thread_id: string;
          trigger_kind: string;
          payload_sha256: string;
          created_at: string;
          completed_at: string | null;
        }>;
      this.database.exec(`
        DROP TABLE notification_deliveries;
        CREATE TABLE notification_deliveries (
          source_id TEXT NOT NULL REFERENCES agents(source_id),
          delivery_key TEXT NOT NULL,
          thread_id TEXT,
          message_id TEXT,
          trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook')),
          job_id TEXT,
          run_id TEXT,
          payload_sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          CHECK ((job_id IS NULL AND run_id IS NULL) OR (trigger_kind = 'cron' AND job_id IS NOT NULL AND run_id IS NOT NULL)),
          PRIMARY KEY (source_id, delivery_key)
        );
        CREATE INDEX notification_deliveries_by_thread
          ON notification_deliveries(thread_id) WHERE thread_id IS NOT NULL;
      `);
      const insert = this.database.prepare(`
        INSERT INTO notification_deliveries (
          source_id, delivery_key, thread_id, trigger_kind, job_id, run_id,
          message_id, payload_sha256, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        const identity = row.trigger_kind === "cron" ? legacyCronDeliveryIdentity(row.delivery_key) : undefined;
        insert.run(
          row.source_id,
          row.delivery_key,
          row.thread_id,
          row.trigger_kind,
          identity?.jobId ?? null,
          identity?.runId ?? null,
          row.payload_sha256,
          row.created_at,
          row.completed_at,
        );
      }
      this.database.exec(`
        UPDATE notification_deliveries
        SET message_id = (
          SELECT m.id FROM messages m
          WHERE m.thread_id = notification_deliveries.thread_id AND m.role = 'assistant'
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
        )
        WHERE completed_at IS NOT NULL
      `);
    }

    // Startup recovery normally runs after schema initialization. Cron adoption
    // can merge several legacy notification threads into one thread, though,
    // and two independently-running legacy turns would violate the one-active-
    // turn index during that reparenting. Settle them while this migration's
    // BEGIN IMMEDIATE transaction still owns the database, before any merge.
    this.recoverInterruptedTurnsInTransaction();

    const adoptable = this.database.prepare(`
      SELECT d.source_id, d.job_id, d.thread_id, d.created_at, t.created_at AS thread_created_at
      FROM notification_deliveries d
      JOIN threads t ON t.id = d.thread_id
      WHERE d.trigger_kind = 'cron' AND d.job_id IS NOT NULL AND d.run_id IS NOT NULL
        AND d.thread_id IS NOT NULL AND d.completed_at IS NOT NULL
      ORDER BY d.source_id, d.job_id, t.created_at, d.created_at, d.thread_id
    `).all() as unknown as Array<{
      source_id: string;
      job_id: string;
      thread_id: string;
      created_at: string;
      thread_created_at: string;
    }>;
    const groups = new Map<string, typeof adoptable>();
    for (const row of adoptable) {
      const key = `${row.source_id}\0${row.job_id}`;
      const group = groups.get(key) ?? [];
      if (!group.some((entry) => entry.thread_id === row.thread_id)) group.push(row);
      groups.set(key, group);
    }
    const now = this.now();
    for (const rows of groups.values()) {
      const canonical = rows[0];
      if (canonical === undefined) continue;
      const existing = this.cronChannel(canonical.source_id, canonical.job_id);
      const canonicalId = existing?.thread_id ?? canonical.thread_id;
      const conversationId = cronConsoleConversationId(canonical.source_id, canonical.job_id);
      this.database.prepare(`
        UPDATE threads SET conversation_id = ?, trigger_kind = 'cron', title = ?, updated_at = MAX(updated_at, ?)
        WHERE id = ?
      `).run(conversationId, `Cron · ${canonical.job_id}`, canonical.created_at, canonicalId);
      this.database.prepare(`
        INSERT INTO cron_channels (source_id, job_id, thread_id, configured, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(source_id, job_id) DO NOTHING
      `).run(canonical.source_id, canonical.job_id, canonicalId, canonical.thread_created_at, now);

      for (const legacy of rows) {
        if (legacy.thread_id === canonicalId) continue;
        this.database.prepare("UPDATE turns SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE messages SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE live_inputs SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE attachments SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE push_events SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE notification_deliveries SET thread_id = ? WHERE thread_id = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare(`
          UPDATE revisions SET entity_id = ? WHERE entity_kind = 'thread' AND entity_id = ?
        `).run(canonicalId, legacy.thread_id);
        this.database.prepare("UPDATE settings SET value = ? WHERE key = 'current_thread_id' AND value = ?")
          .run(canonicalId, legacy.thread_id);
        this.database.prepare(`
          INSERT INTO thread_redirects (old_thread_id, new_thread_id, created_at)
          VALUES (?, ?, ?) ON CONFLICT(old_thread_id) DO UPDATE SET new_thread_id = excluded.new_thread_id
        `).run(legacy.thread_id, canonicalId, now);
        this.database.prepare("DELETE FROM threads WHERE id = ?").run(legacy.thread_id);
      }
      this.database.prepare(`
        UPDATE threads SET revision = revision + 1,
          updated_at = MAX(updated_at, COALESCE((SELECT MAX(created_at) FROM messages WHERE thread_id = ?), updated_at))
        WHERE id = ?
      `).run(canonicalId, canonicalId);
    }
  }

  private validateStorage(): void {
    const check = this.database.prepare("PRAGMA quick_check(1)").get() as unknown as Record<string, unknown> | undefined;
    if (check === undefined || !Object.values(check).includes("ok")) {
      throw new WebConsoleError("storage_corrupt", "Web state failed SQLite integrity validation.", 500);
    }
    const requiredTables = new Set([
      "agents",
      "threads",
      "turns",
      "messages",
      "live_inputs",
      "attachments",
      "revisions",
      "settings",
      "notification_deliveries",
      "cron_channels",
      "cron_channel_deletions",
      "cron_overviews",
      "cron_job_snapshots",
      "cron_run_messages",
      "thread_redirects",
      "push_subscriptions",
      "push_events",
      "push_deliveries",
    ]);
    const tables = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>;
    for (const table of tables) requiredTables.delete(table.name);
    if (requiredTables.size > 0) {
      throw new WebConsoleError("storage_corrupt", `Web state is missing tables: ${[...requiredTables].join(", ")}.`, 500);
    }
    const messages = this.database.prepare("SELECT id, parts_json FROM messages").all() as unknown as Array<{ id: string; parts_json: string }>;
    for (const message of messages) {
      try {
        parseParts(message.parts_json);
      } catch {
        throw new WebConsoleError("storage_corrupt", `Message ${message.id} contains invalid persisted parts.`, 500);
      }
    }
  }

  private recoverInterruptedTurns(): void {
    const active = this.listActiveTurnIds();
    for (const turnId of active) {
      this.interruptTurn(turnId, "The web service restarted before this turn completed.");
    }
  }

  private recoverInterruptedTurnsInTransaction(): void {
    const active = this.listActiveTurnIds();
    for (const turnId of active) {
      this.finishTurnInTransaction(
        turnId,
        "interrupted",
        undefined,
        "interrupted",
        "The web service restarted before this turn completed.",
        undefined,
      );
    }
  }

  private recoverLiveInputs(): void {
    const rows = this.database.prepare(
      "SELECT * FROM live_inputs WHERE status = 'offered' ORDER BY created_at, rowid",
    ).all() as unknown as LiveInputRow[];
    if (rows.length === 0) return;
    const now = this.now();
    const threadIds = new Set(rows.map((row) => row.thread_id));
    this.transaction(() => {
      const updateInput = this.database.prepare(`
        UPDATE live_inputs SET status = 'queued', active_turn_id = NULL, updated_at = ? WHERE id = ?
      `);
      const updateMessage = this.database.prepare(
        "UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        const persisted = this.database.prepare("SELECT parts_json FROM messages WHERE id = ?")
          .get(row.message_id) as unknown as { parts_json: string } | undefined;
        if (persisted === undefined) {
          throw new WebConsoleError("storage_corrupt", `Live input ${row.id} has no message.`, 500);
        }
        updateInput.run(now, row.id);
        updateMessage.run(
          JSON.stringify(withLiveInputStatus(parseParts(persisted.parts_json), "queued")),
          now,
          row.message_id,
        );
      }
      for (const threadId of threadIds) {
        this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, threadId);
        this.recordThreadRevision(threadId, "live_inputs_recovered", now);
      }
    });
  }

  private recoverWebPushDeliveries(): void {
    const now = this.now();
    this.database.prepare(`
      UPDATE push_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'sending'
    `).run(now, now);
  }

  private finishTurn(
    turnId: string,
    status: Exclude<WebMessageStatus, "running">,
    finalText?: string,
    errorCode?: string,
    errorMessage?: string,
    runtime?: { readonly model?: string; readonly effort?: string },
  ): WebThreadDetail {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") {
      return this.requireThreadDetail(turn.thread_id);
    }
    this.transaction(() => {
      this.finishTurnInTransaction(turnId, status, finalText, errorCode, errorMessage, runtime);
    });
    return this.requireThreadDetail(turn.thread_id);
  }

  private finishTurnInTransaction(
    turnId: string,
    status: Exclude<WebMessageStatus, "running">,
    finalText?: string,
    errorCode?: string,
    errorMessage?: string,
    runtime?: { readonly model?: string; readonly effort?: string },
  ): void {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") return;
    const existing = this.requireMessage(turn.assistant_message_id);
    const parts = [...existing.parts];
    if (finalText !== undefined && finalText.length > 0) reconcileFinalText(parts, finalText);
    if (errorMessage !== undefined) {
      parts.push({ type: "error", ...(errorCode === undefined ? {} : { code: errorCode }), message: errorMessage });
    }
    const now = this.now();
    const thread = this.requireThread(turn.thread_id);
    const agent = this.getAgent(thread.sourceId);
    this.database.prepare(`
        UPDATE turns SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
          model = CASE WHEN ? IS NULL THEN model ELSE ? END,
          effort = CASE WHEN ? IS NULL THEN effort ELSE ? END
        WHERE id = ?
    `).run(
        status,
        now,
        errorCode ?? null,
        errorMessage ?? null,
        runtime?.model ?? null,
        runtime?.model ?? null,
        runtime?.effort ?? null,
        runtime?.effort ?? null,
        turnId,
      );
    this.database.prepare("UPDATE messages SET parts_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(parts), status, now, existing.id);
    this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(now, turn.thread_id);
    this.recordThreadRevision(turn.thread_id, `turn_${status}`, now);
    const recentEnoughForRecoveredInterruption = status !== "interrupted"
      || new Date(now).getTime() - new Date(existing.updatedAt).getTime() <= 60 * 60 * 1_000;
    // Projected cron turns are agent-owned scheduler state. Restart recovery
    // still settles the local projection, but only web-owned turns may emit a
    // Web Push terminal notification from this service.
    if (thread.trigger?.kind !== "cron" && recentEnoughForRecoveredInterruption) {
      const kind: WebPushEventKind = status === "complete"
        ? "response.ready"
        : status === "cancelled"
          ? "run.cancelled"
          : status === "interrupted"
            ? "run.interrupted"
            : "run.failed";
      const label = agent?.label ?? "mono-agent";
      const body = status === "complete"
        ? parts.filter((part): part is Extract<WebMessagePart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join(" ")
        : status === "cancelled"
          ? "The run was cancelled."
          : status === "interrupted"
            ? "The run was interrupted when the web service stopped."
            : errorMessage ?? "The run failed.";
      this.enqueueWebPushEventInTransaction({
        logicalKey: `turn:${turnId}:terminal`,
        kind,
        threadId: turn.thread_id,
        sourceId: thread.sourceId,
        title: status === "complete"
          ? `${label} replied`
          : status === "cancelled"
            ? `${label} run cancelled`
            : status === "interrupted"
              ? `${label} run interrupted`
              : `${label} run failed`,
        body,
        expiresAt: new Date(new Date(now).getTime() + (status === "complete" ? 24 : 1) * 60 * 60 * 1_000).toISOString(),
        notBefore: new Date(new Date(now).getTime() + 3_000).toISOString(),
      });
    }
  }

  private mapThread(row: ThreadRow): WebThread {
    const runState = this.latestRunState(row.id);
    const preview = this.lastMessagePreview(row.id);
    return {
      id: row.id,
      sourceId: row.source_id,
      title: row.title,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      ...(row.trigger_kind === "cron"
        ? {
            trigger: {
              kind: "cron" as const,
              ...(row.cron_job_id === null ? {} : { jobId: row.cron_job_id }),
              ...(row.cron_configured === null ? {} : { configured: row.cron_configured === 1 }),
            },
          }
        : row.trigger_kind === "webhook"
          ? { trigger: { kind: "webhook" as const } }
          : {}),
      ...(preview === undefined ? {} : { lastMessagePreview: preview }),
      messageCount: row.message_count,
      runState,
      canSend: row.can_send === 1,
      canUpload: row.can_upload === 1,
    };
  }

  private mapMessage(row: MessageRow): WebMessage {
    const attachments = this.database.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id")
      .all(row.id) as unknown as AttachmentRow[];
    const storedParts = parseParts(row.parts_json);
    const quote = quoteFromParts(storedParts);
    const liveInputStatus = liveInputStatusFromParts(storedParts);
    return {
      id: row.id,
      threadId: row.thread_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      role: normalizeRole(row.role),
      ...(quote === undefined ? {} : { quote }),
      parts: storedParts.filter(
        (part) => part.type !== "telemetry"
          || (part.event !== QUOTE_TELEMETRY_EVENT && part.event !== LIVE_INPUT_TELEMETRY_EVENT),
      ),
      attachments: attachments.map((attachment) => toWebAttachment(mapStoredAttachment(attachment))),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: normalizeMessageStatus(row.status),
      ...(liveInputStatus === undefined ? {} : { liveInputStatus }),
    };
  }

  private latestRunState(threadId: string): WebRunState {
    const row = this.database.prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as unknown as TurnRow | undefined;
    if (row === undefined) return { status: "idle" };
    const status = normalizeRunStatus(row.status);
    return {
      id: row.id,
      status,
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.error_message === null
        ? {}
        : { error: { ...(row.error_code === null ? {} : { code: row.error_code }), message: row.error_message } }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.effort === null ? {} : { effort: row.effort }),
    };
  }

  private lastMessagePreview(threadId: string): string | undefined {
    const row = this.database.prepare("SELECT parts_json FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as unknown as { parts_json: string } | undefined;
    if (row === undefined) return undefined;
    const text = parseParts(row.parts_json)
      .filter((part): part is Extract<WebMessagePart, { type: "text" | "reasoning" }> => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    return text.length === 0 ? undefined : text.slice(0, 160);
  }

  private cronChannel(sourceId: string, jobId: string): CronChannelRow | undefined {
    return this.database.prepare(`
      SELECT * FROM cron_channels WHERE source_id = ? AND job_id = ?
    `).get(sourceId, jobId) as unknown as CronChannelRow | undefined;
  }

  private requireThread(id: string): WebThread {
    const thread = this.getThread(id);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return thread;
  }

  private requireThreadDetail(id: string): WebThreadDetail {
    const detail = this.getThreadDetail(id);
    if (detail === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return detail;
  }

  private requireTurn(id: string): TurnRow {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow | undefined;
    if (row === undefined) throw new WebConsoleError("turn_not_found", "Turn not found.", 404);
    return row;
  }

  private requireMessage(id: string): WebMessage {
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow | undefined;
    if (row === undefined) throw new WebConsoleError("message_not_found", "Message not found.", 404);
    return this.mapMessage(row);
  }

  private getLiveInput(id: string): LiveInputRow | undefined {
    return this.database.prepare("SELECT * FROM live_inputs WHERE id = ?")
      .get(id) as unknown as LiveInputRow | undefined;
  }

  private requireLiveInput(id: string): LiveInputRow {
    const row = this.getLiveInput(id);
    if (row === undefined) throw new WebConsoleError("live_input_not_found", "Live input not found.", 404);
    return row;
  }

  private requireStoredAttachment(id: string): StoredAttachment {
    const attachment = this.getStoredAttachment(id);
    if (attachment === undefined) throw new WebConsoleError("attachment_not_found", "Attachment not found.", 404);
    return attachment;
  }

  private requirePushSubscription(id: string): StoredWebPushSubscription {
    const row = this.database.prepare("SELECT * FROM push_subscriptions WHERE id = ?")
      .get(id) as unknown as PushSubscriptionRow | undefined;
    if (row === undefined) {
      throw new WebConsoleError("push_subscription_not_found", "Notification subscription not found.", 404);
    }
    return mapPushSubscription(row);
  }

  private requirePushSubscriptionStatus(id: string): WebPushSubscriptionStatus {
    const status = this.getWebPushSubscription(id);
    if (status === undefined) {
      throw new WebConsoleError("push_subscription_not_found", "Notification subscription not found.", 404);
    }
    return status;
  }

  private enqueueWebPushEventInTransaction(input: {
    readonly logicalKey: string;
    readonly kind: WebPushEventKind;
    readonly threadId?: string;
    readonly sourceId?: string;
    readonly title: string;
    readonly body: string;
    readonly expiresAt: string;
    readonly notBefore?: string;
    readonly subscriptionId?: string;
  }): StoredWebPushEvent | undefined {
    const existing = this.database.prepare("SELECT * FROM push_events WHERE logical_key = ?")
      .get(input.logicalKey) as unknown as PushEventRow | undefined;
    if (existing !== undefined) return mapPushEvent(existing);

    const targets = input.subscriptionId === undefined
      ? this.database.prepare("SELECT id FROM push_subscriptions WHERE state = 'active' ORDER BY created_at, id")
        .all() as unknown as Array<{ id: string }>
      : this.database.prepare("SELECT id FROM push_subscriptions WHERE id = ? AND state = 'active'")
        .all(input.subscriptionId) as unknown as Array<{ id: string }>;
    if (targets.length === 0) return undefined;

    const now = this.now();
    const expiry = new Date(input.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= new Date(now).getTime()) {
      throw new WebConsoleError("invalid_push_event", "Notification expiry must be in the future.", 500);
    }
    const nextAttemptAt = input.notBefore ?? new Date(new Date(now).getTime() + 3_000).toISOString();
    const id = randomUUID();
    const title = webPushPreview(input.title, "mono-agent");
    const body = webPushPreview(input.body);
    const topic = createHash("sha256")
      .update(input.logicalKey)
      .digest("base64url")
      .slice(0, 32);
    const tag = `mono-agent-${id}`;
    this.database.prepare(`
      INSERT INTO push_events (
        id, logical_key, kind, thread_id, source_id, title, body, tag, topic, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.logicalKey,
      input.kind,
      input.threadId ?? null,
      input.sourceId ?? null,
      title,
      body,
      tag,
      topic,
      expiry.toISOString(),
      now,
    );
    const insert = this.database.prepare(`
      INSERT INTO push_deliveries (
        event_id, subscription_id, status, attempts, next_attempt_at,
        last_status_code, last_error_code, created_at, updated_at, finished_at
      ) VALUES (?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, NULL)
    `);
    for (const target of targets) {
      const pending = this.database.prepare(`
        SELECT COUNT(*) AS count FROM push_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'sending')
      `).get(target.id) as unknown as { count: number };
      const dropCount = Math.max(0, pending.count - MAX_PENDING_PUSH_DELIVERIES_PER_SUBSCRIPTION + 1);
      if (dropCount > 0) {
        this.database.prepare(`
          UPDATE push_deliveries SET status = 'dropped', updated_at = ?, finished_at = ?, last_error_code = 'queue_limit'
          WHERE rowid IN (
            SELECT rowid FROM push_deliveries
            WHERE subscription_id = ? AND status = 'pending'
            ORDER BY created_at, rowid LIMIT ?
          )
        `).run(now, now, target.id, dropCount);
      }
      insert.run(id, target.id, nextAttemptAt, now, now);
    }
    return {
      id,
      logicalKey: input.logicalKey,
      kind: input.kind,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      title,
      body,
      tag,
      topic,
      expiresAt: expiry.toISOString(),
      createdAt: now,
    };
  }

  private recordThreadRevision(threadId: string, event: string, now: string): void {
    const row = this.database.prepare("SELECT revision FROM threads WHERE id = ?").get(threadId) as unknown as { revision: number };
    this.database.prepare("INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at) VALUES ('thread', ?, ?, ?, ?)")
      .run(threadId, row.revision, event, now);
    this.database.prepare(`
      DELETE FROM revisions WHERE id IN (
        SELECT id FROM revisions
        WHERE entity_kind = 'thread' AND entity_id = ?
        ORDER BY revision DESC, id DESC LIMIT -1 OFFSET ?
      )
    `).run(threadId, MAX_REVISIONS_PER_THREAD);
  }

  private setSetting(key: string, value: string): void {
    this.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function mapPushSubscriptionStatus(row: PushSubscriptionRow): WebPushSubscriptionStatus {
  const state: WebPushSubscriptionState = row.state === "disabled" || row.state === "expired"
    ? row.state
    : "active";
  return {
    id: row.id,
    state,
    keyFingerprint: row.key_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_success_at === null ? {} : { lastSuccessAt: row.last_success_at }),
    ...(row.last_error_at === null ? {} : { lastErrorAt: row.last_error_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
  };
}

function mapPushSubscription(row: PushSubscriptionRow): StoredWebPushSubscription {
  return {
    ...mapPushSubscriptionStatus(row),
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    ...(row.expiration_time === null ? {} : { expirationTime: row.expiration_time }),
    siteOrigin: row.site_origin,
  };
}

function mapPushEvent(row: PushEventRow): StoredWebPushEvent {
  const validKinds: readonly WebPushEventKind[] = [
    "response.ready",
    "input.required",
    "run.failed",
    "run.cancelled",
    "run.interrupted",
    "test",
  ];
  if (!validKinds.includes(row.kind as WebPushEventKind)) {
    throw new WebConsoleError("storage_corrupt", `Push event ${row.id} has an invalid kind.`, 500);
  }
  return {
    id: row.id,
    logicalKey: row.logical_key,
    kind: row.kind as WebPushEventKind,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    title: row.title,
    body: row.body,
    tag: row.tag,
    topic: row.topic,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function pushKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("base64url");
}

function isBase64Url(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isValidVapidKeyPair(publicKey: string, privateKey: string): boolean {
  if (!isBase64Url(publicKey, 32, 128) || !isBase64Url(privateKey, 24, 96)) return false;
  try {
    const decodedPublic = Buffer.from(publicKey, "base64url");
    const decodedPrivate = Buffer.from(privateKey, "base64url");
    if (decodedPublic.byteLength !== 65 || decodedPublic[0] !== 4 || decodedPrivate.byteLength !== 32) return false;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(decodedPrivate);
    const derivedPublic = ecdh.getPublicKey();
    return derivedPublic.byteLength === decodedPublic.byteLength && timingSafeEqual(derivedPublic, decodedPublic);
  } catch {
    return false;
  }
}

function threadSelectSql(suffix: string): string {
  return `
    SELECT t.id, t.source_id, t.title, t.trigger_kind, t.archived_at, t.created_at, t.updated_at, t.revision,
           cc.job_id AS cron_job_id, cc.configured AS cron_configured,
           CASE WHEN t.trigger_kind = 'cron' THEN 0
                WHEN a.status = 'online' OR a.status = 'degraded' THEN 1 ELSE 0 END AS can_send,
           CASE WHEN t.trigger_kind = 'cron' THEN 0
                WHEN (a.status = 'online' OR a.status = 'degraded') AND a.supports_attachments = 1 THEN 1 ELSE 0 END AS can_upload,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t JOIN agents a ON a.source_id = t.source_id
    LEFT JOIN cron_channels cc ON cc.thread_id = t.id
    ${suffix}
  `;
}

function agentSelectSql(suffix: string): string {
  return `
    SELECT a.*,
           CASE WHEN EXISTS (
             SELECT 1 FROM settings s
             WHERE s.key = 'agent_pin:' || a.source_id AND s.value = '1'
           ) THEN 1 ELSE 0 END AS pinned
    FROM agents a
    ${suffix}
  `;
}

function agentPinSettingKey(sourceId: string): string {
  return `agent_pin:${sourceId}`;
}

function notificationThreadId(sourceId: string, deliveryKey: string): string {
  const digest = createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(deliveryKey)
    .digest("hex")
    .slice(0, 32);
  return `notification-${digest}`;
}

function cronChannelThreadId(sourceId: string, jobId: string): string {
  return `cron-${stableDigest(sourceId, jobId)}`;
}

function cronConsoleConversationId(sourceId: string, jobId: string): string {
  return `web-cron:${stableDigest(sourceId, jobId)}`;
}

function cronEntityId(kind: "turn" | "message", sourceId: string, jobId: string, runId: string): string {
  return `cron-${kind}-${stableDigest(sourceId, jobId, runId)}`;
}

function stableDigest(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value).update("\0");
  return hash.digest("hex").slice(0, 32);
}

function notificationPayloadSha256(kind: WebNotificationTriggerKind, text: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(text)
    .digest("hex");
}

export function notificationPushLogicalKey(sourceId: string, deliveryKey: string): string {
  return `web-new:${stableDigest(sourceId, deliveryKey)}`;
}

function legacyCronDeliveryIdentity(deliveryKey: string): { readonly jobId: string; readonly runId: string } | undefined {
  // Parse from the anchored terminal suffix and fixed-width canonical UTC
  // timestamp. The greedy job segment may therefore contain legal literal
  // colons while malformed prefixes/suffixes remain unadoptable.
  const isoTimestamp = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)";
  const success = new RegExp(`^cron:(.+):${isoTimestamp}:success$`, "u").exec(deliveryKey);
  const failure = new RegExp(`^cron:(.+):${isoTimestamp}:failure:[^:]+$`, "u").exec(deliveryKey);
  const match = success ?? failure;
  if (match === null) return undefined;
  const encodedJobId = match[1];
  const middle = match[2];
  if (encodedJobId === undefined || middle === undefined) return undefined;
  const timestamp = Date.parse(middle);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== middle) return undefined;
  try {
    const jobId = decodeURIComponent(encodedJobId);
    if (jobId.length === 0) return undefined;
    return { jobId, runId: `cron:${encodedJobId}:${middle}` };
  } catch {
    return undefined;
  }
}

function compareCronRuns(left: WebCronRun, right: WebCronRun): number {
  return left.orderedAt.localeCompare(right.orderedAt)
    || left.sequence - right.sequence
    || left.runId.localeCompare(right.runId);
}

function cronMessageStatus(status: WebCronRun["status"]): WebMessageStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "complete";
}

function cronRunParts(
  run: WebCronRun,
  prior: readonly WebMessagePart[],
  conversationId: string,
): WebMessagePart[] {
  const silent = run.status === "succeeded" && classifyNotifySuppression(run.text) !== "none";
  const priorCron = prior.find(
    (part): part is Extract<WebMessagePart, { type: "telemetry" }> =>
      part.type === "telemetry" && part.event === "cron_run",
  );
  const priorCronData = record(priorCron?.data);
  const priorActivityLoaded = priorCronData?.activityLoaded === true;
  const priorLoadedEventCount = Number.isSafeInteger(priorCronData?.loadedEventCount)
    ? Number(priorCronData?.loadedEventCount)
    : undefined;
  const priorActivityEventCount = Number.isSafeInteger(priorCronData?.activityEventCount)
    ? Number(priorCronData?.activityEventCount)
    : priorLoadedEventCount;
  const activityLoaded = run.projection === "detail"
    || (priorActivityLoaded && priorActivityEventCount === run.eventCount);
  const activityStale = run.projection === "summary"
    && priorActivityLoaded
    && priorActivityEventCount !== run.eventCount;
  const eventsTruncated = run.projection === "detail"
    ? run.eventsTruncated === true
    : run.eventsTruncated === true || (priorActivityLoaded && priorCronData?.eventsTruncated === true);
  // Reconciliation updates one durable message in place. Strip the prior
  // synthetic state/identity before rebuilding it, while retaining a genuine
  // notification text that arrived before the operator run projection.
  const retained = prior.filter((part) =>
    !(part.type === "telemetry" && part.event === "cron_run")
    && !(part.type === "text" && isSyntheticCronStateText(part.text)));
  const parts: WebMessagePart[] = run.projection === "summary"
    ? [...retained]
    : retained.filter((part) => part.type === "text" || part.type === "error");
  for (const event of run.projection === "detail" ? run.events : []) applyEvent(parts, event);
  const preserveLoadedText = run.projection === "summary"
    && run.fieldsTruncated?.includes("text") === true
    && priorActivityLoaded;
  const preserveLoadedError = run.projection === "summary"
    && priorActivityLoaded
    && (run.fieldsTruncated?.includes("error") === true
      || run.fieldsTruncated?.includes("failureKind") === true);
  if (!silent && !preserveLoadedText && run.text !== undefined && run.text.length > 0) {
    reconcileFinalText(parts, run.text);
  }
  const hasText = parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  if (!hasText) {
    const stateText = run.status === "succeeded"
      ? "Completed silently (no message was reported)."
      : run.status === "skipped_overlap"
        ? run.blockedByTrigger === "manual"
          ? "Scheduled firing skipped because an operator-started manual run was still in flight."
          : "Firing skipped because the previous run was still in flight."
        : run.status === "queued"
          ? `Queued behind an active run${run.queueDepth === undefined ? "." : ` (position ${String(run.queueDepth)}).`}`
          : run.status === "dropped"
            ? "Dropped because the pending-run queue was full."
            : run.status === "cancelled"
              ? "Run cancelled."
              : run.status === "failed"
                ? "Run failed."
                : run.status === "admitted"
                  ? "Run admitted and waiting to start."
                  : "Run is in progress.";
    parts.push({ type: "text", text: stateText });
  }
  if (!preserveLoadedError
    && run.error !== undefined
    && !parts.some((part) => part.type === "error" && part.message === run.error)) {
    parts.push({
      type: "error",
      ...(run.failureKind === undefined ? {} : { code: run.failureKind }),
      message: run.error,
    });
  }
  parts.push({
    type: "telemetry",
    event: "cron_run",
    data: {
      runId: run.runId,
      conversationId,
      scheduledAt: run.scheduledAt,
      orderedAt: run.orderedAt,
      sequence: run.sequence,
      trigger: run.trigger,
      status: run.status,
      ...(silent ? { silent: true } : {}),
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
      ...(run.artifactRunId === undefined ? {} : { artifactRunId: run.artifactRunId }),
      ...(run.blockedByRunId === undefined ? {} : { blockedByRunId: run.blockedByRunId }),
      eventCount: run.eventCount,
      ...(activityLoaded
        ? {
            activityLoaded: true,
            activityEventCount: run.eventCount,
            loadedEventCount: run.projection === "detail" ? run.eventsIncluded : priorLoadedEventCount ?? run.eventCount,
          }
        : {}),
      ...(activityStale ? { activityStale: true, loadedEventCount: priorLoadedEventCount } : {}),
      ...(eventsTruncated ? { eventsTruncated: true } : {}),
      ...(run.fieldsTruncated === undefined ? {} : { fieldsTruncated: run.fieldsTruncated }),
    },
  });
  return parts;
}

function cronRunSummary(run: WebCronRun): WebCronRunSummary {
  if (run.projection === "summary") return run;
  const { events: _events, eventsIncluded: _eventsIncluded, ...base } = run;
  return { ...base, projection: "summary" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSyntheticCronStateText(text: string): boolean {
  return text === "Completed silently (no message was reported)."
    || text === "Scheduled firing skipped because an operator-started manual run was still in flight."
    || text === "Firing skipped because the previous run was still in flight."
    || text.startsWith("Queued behind an active run")
    || text === "Dropped because the pending-run queue was full."
    || text === "Run cancelled."
    || text === "Run failed."
    || text === "Run admitted and waiting to start."
    || text === "Run is in progress.";
}

function parseStoredCronJob(serialized: string): Omit<WebCronJob, "threadId"> {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new WebConsoleError("storage_corrupt", "Stored cron job metadata is invalid JSON.", 500);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WebConsoleError("storage_corrupt", "Stored cron job metadata is invalid.", 500);
  }
  const job = value as Partial<Omit<WebCronJob, "threadId">>;
  if (typeof job.jobId !== "string"
    || typeof job.conversationId !== "string"
    || typeof job.configured !== "boolean"
    || typeof job.declaredEnabled !== "boolean"
    || typeof job.effectiveEnabled !== "boolean"
    || !["healthy", "warning", "unhealthy", "disabled", "unknown"].includes(String(job.health))) {
    throw new WebConsoleError("storage_corrupt", "Stored cron job metadata is invalid.", 500);
  }
  return job as Omit<WebCronJob, "threadId">;
}

function parseStoredCronRun(serialized: string): WebCronRunSummary {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new WebConsoleError("storage_corrupt", "Stored cron run metadata is invalid JSON.", 500);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WebConsoleError("storage_corrupt", "Stored cron run metadata is invalid.", 500);
  }
  const raw = value as Record<string, unknown>;
  const legacyEvents = Array.isArray(raw.events) ? raw.events : undefined;
  const { events: _legacyEvents, ...legacyBase } = raw;
  const run = (raw.projection === undefined
    ? {
        ...legacyBase,
        projection: "summary",
        eventCount: legacyEvents?.length ?? 0,
        ...(legacyEvents === undefined ? {} : { eventsTruncated: true }),
      }
    : raw) as Partial<WebCronRunSummary>;
  if (run.projection !== "summary"
    || typeof run.runId !== "string"
    || typeof run.jobId !== "string"
    || typeof run.scheduledAt !== "string"
    || typeof run.orderedAt !== "string"
    || !Number.isSafeInteger(run.sequence)
    || (run.trigger !== "scheduled" && run.trigger !== "manual")
    || !["admitted", "running", "queued", "succeeded", "failed", "cancelled", "skipped_overlap", "dropped"]
      .includes(String(run.status))
    || !Number.isSafeInteger(run.eventCount)
    || Number(run.eventCount) < 0) {
    throw new WebConsoleError("storage_corrupt", "Stored cron run metadata is invalid.", 500);
  }
  return run as WebCronRunSummary;
}

function messageRoleRankSql(messageAlias: string, turnAlias: string): string {
  return `CASE WHEN ${messageAlias}.turn_id IS NOT NULL AND ${messageAlias}.role = 'user' THEN 0
    WHEN ${messageAlias}.turn_id IS NOT NULL AND ${messageAlias}.role = 'system' THEN 1
    WHEN ${messageAlias}.turn_id IS NOT NULL THEN 2 ELSE 3 END`;
}

function boundedPageLimit(value: number | undefined, maximum: number): number {
  const normalized = value ?? maximum;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new WebConsoleError("invalid_page", `limit must be 1-${String(maximum)}.`, 400);
  }
  return normalized;
}

function encodeCursor(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): Record<string, unknown> {
  if (value.length === 0 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
}

function decodeThreadCursor(value: string): { readonly updatedAt: string; readonly id: string } {
  const cursor = decodeCursor(value);
  if (typeof cursor.updatedAt !== "string" || typeof cursor.id !== "string") {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
  return { updatedAt: cursor.updatedAt, id: cursor.id };
}

function decodeMessageCursor(value: string): {
  readonly orderedAt: string;
  readonly roleRank: number;
  readonly createdAt: string;
  readonly rowid: number;
} {
  const cursor = decodeCursor(value);
  if (typeof cursor.orderedAt !== "string"
    || !Number.isSafeInteger(cursor.roleRank)
    || typeof cursor.createdAt !== "string"
    || !Number.isSafeInteger(cursor.rowid)) {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
  return {
    orderedAt: cursor.orderedAt,
    roleRank: cursor.roleRank as number,
    createdAt: cursor.createdAt,
    rowid: cursor.rowid as number,
  };
}

function mapAgent(row: AgentRow): WebAgentSummary {
  const models = parseStringArray(row.models_json);
  const efforts = parseStringArray(row.efforts_json);
  const modelOptions = parseRecord(row.model_options_json);
  return {
    sourceId: row.source_id,
    label: row.label,
    status: row.status === "online" || row.status === "degraded" ? row.status : "offline",
    pinned: row.pinned === 1,
    ...(row.health === null ? {} : { health: row.health }),
    supportsAttachments: row.supports_attachments === 1,
    ...(models === undefined ? {} : { models }),
    ...(row.default_model === null ? {} : { defaultModel: row.default_model }),
    ...(row.default_effort === null ? {} : { defaultEffort: row.default_effort }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(modelOptions === undefined ? {} : { modelOptions }),
    ...(row.cron_read === 1
      ? { cron: { read: true, actions: row.cron_actions === 1 } }
      : {}),
    ...(row.ask_by_id === 1 ? { supportsAskById: true } : {}),
    updatedAt: row.updated_at,
  };
}

function mapStoredAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    kind: row.kind === "image" ? "image" : "document",
    status: row.status === "committed" ? "committed" : "staged",
    uploaded: row.uploaded === 1,
    storageName: row.storage_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLiveInput(row: LiveInputRow): StoredLiveInput {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toWebAttachment(attachment: StoredAttachment): WebAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    status: attachment.status,
    uploaded: attachment.uploaded,
    createdAt: attachment.createdAt,
    ...(attachment.uploaded ? { contentUrl: `/api/v1/uploads/${encodeURIComponent(attachment.id)}/content` } : {}),
  };
}

function applyEvent(parts: WebMessagePart[], event: AgentStreamEvent): void {
  if (event.type === "assistant_thought") {
    appendTextPart(parts, "reasoning", event.text);
    return;
  }
  if (event.type === "tool_call_started") {
    const subagent = subagentOf(event);
    if (subagent !== undefined) {
      const group = ensureSubagentPart(parts, subagent);
      // The bookend only announces the subagent; the group it belongs to is the
      // whole of its contribution here.
      if (event.metadata?.subagentLifecycle === true) {
        replaceSubagentPart(parts, {
          ...group,
          ...(event.arguments === undefined ? {} : { args: event.arguments }),
          ...(event.history === undefined ? {} : { history: event.history }),
        });
        return;
      }
      upsertSubagentCall(parts, group, {
        toolCallId: event.id,
        toolName: subagentToolName(event.name),
        ...(event.arguments === undefined ? {} : { args: event.arguments }),
        status: "running",
      });
      return;
    }
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name,
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      ...(event.history === undefined ? {} : { history: event.history }),
      status: "running",
    });
    return;
  }
  if (event.type === "tool_call_progress") {
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name ?? existingToolName(parts, event.id) ?? "Tool",
      ...(event.partialResult === undefined ? {} : { result: event.partialResult }),
      status: "running",
    });
    return;
  }
  if (event.type === "tool_call_completed") {
    const status = event.isError === true ? "failed" : "complete";
    const subagent = subagentOf(event);
    if (subagent !== undefined) {
      const group = ensureSubagentPart(parts, subagent);
      if (event.metadata?.subagentLifecycle === true) {
        replaceSubagentPart(parts, {
          ...group,
          status,
          ...(event.history === undefined ? {} : { history: event.history }),
          ...(event.executionMs === undefined ? {} : { executionMs: event.executionMs }),
          ...(subagent.costUsd === undefined ? {} : { costUsd: subagent.costUsd }),
        });
        return;
      }
      upsertSubagentCall(parts, group, {
        toolCallId: event.id,
        toolName: subagentToolName(event.name ?? existingSubagentToolName(group, event.id) ?? "Tool"),
        ...(event.arguments === undefined ? {} : { args: event.arguments }),
        ...(event.content === undefined ? {} : { result: event.content }),
        ...(event.history === undefined ? {} : { history: event.history }),
        status,
      });
      return;
    }
    // The parent `Agent` call completes against the group that replaced its
    // tool-call part, so its answer and outcome are not lost to the conversion.
    const group = findSubagentPart(parts, event.id);
    if (group !== undefined) {
      replaceSubagentPart(parts, {
        ...group,
        status,
        ...(event.history === undefined ? {} : { history: event.history }),
        ...(event.content === undefined ? {} : { result: event.content }),
        ...(event.executionMs === undefined ? {} : { executionMs: event.executionMs }),
      });
      return;
    }
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name ?? existingToolName(parts, event.id) ?? "Tool",
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      ...(event.content === undefined ? {} : { result: event.content }),
      ...(event.history === undefined ? {} : { history: event.history }),
      status,
    });
    return;
  }
  if (event.type === "runtime_telemetry" && event.kind === "context_compaction") {
    upsertContextCompaction(parts, event);
    return;
  }
  parts.push({ type: "telemetry", event: event.type, data: event });
}

function contextCompactionOperationId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "runtime_telemetry" || event.kind !== "context_compaction") return undefined;
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const operationId = (data as Record<string, unknown>).operationId;
  return typeof operationId === "string" && operationId.length > 0 ? operationId : undefined;
}

function upsertContextCompaction(
  parts: WebMessagePart[],
  event: Extract<AgentStreamEvent, { type: "runtime_telemetry" }>,
): void {
  const operationId = contextCompactionOperationId(event);
  const next: WebMessagePart = { type: "telemetry", event: event.type, data: event };
  if (operationId === undefined) {
    parts.push(next);
    return;
  }
  const index = parts.findIndex(
    (part) => part.type === "telemetry" && contextCompactionOperationId(part.data) === operationId,
  );
  if (index < 0) parts.push(next);
  else parts[index] = next;
}

function existingToolName(parts: readonly WebMessagePart[], id: string): string | undefined {
  const existing = parts.find((part) => part.type === "tool-call" && part.toolCallId === id);
  return existing?.type === "tool-call" ? existing.toolName : undefined;
}

type SubagentPart = Extract<WebMessagePart, { type: "subagent" }>;

/**
 * The subagent this tool event belongs to, or undefined for the agent's own
 * work. Validated rather than cast: `metadata` is an open record arriving over
 * the operator wire, so a malformed payload must fall through to an ordinary
 * tool-call part instead of keying a group on a non-string.
 */
function subagentOf(
  event: Extract<AgentStreamEvent, { type: "tool_call_started" | "tool_call_completed" }>,
): {
  readonly id: string;
  readonly name: string;
  readonly label?: string;
  readonly costUsd?: number;
} | undefined {
  const subagent = event.metadata?.subagent;
  if (typeof subagent !== "object" || subagent === null || Array.isArray(subagent)) return undefined;
  const record = subagent as Record<string, unknown>;
  // The provider's task/thread id may differ (and is retained as nativeId in
  // the open metadata record). Only the initiating parent tool-use id is a
  // stable attachment key across Pi, Claude, and Codex.
  const canonicalId = typeof record.id === "string" ? record.id.trim() : "";
  if (canonicalId.length === 0) return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  // Only the closing bookend carries a price, and only when the runtime priced
  // the subagent's model at all.
  const costUsd = typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0
    ? record.costUsd
    : undefined;
  return {
    id: canonicalId,
    name: name.length === 0 ? "subagent" : name,
    ...(label.length === 0 ? {} : { label }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Drop the `<profile>▸` prefix: the group header already names the profile. */
function subagentToolName(name: string): string {
  const index = name.indexOf("▸");
  if (index < 0) return name;
  const tool = name.slice(index + 1).trim();
  return tool.length === 0 ? name : tool;
}

function findSubagentPart(parts: readonly WebMessagePart[], id: string): SubagentPart | undefined {
  return parts.find(
    (part): part is SubagentPart => part.type === "subagent" && part.toolCallId === id,
  );
}

function existingSubagentToolName(group: SubagentPart, id: string): string | undefined {
  return group.calls.find((call) => call.toolCallId === id)?.toolName;
}

/**
 * Find the group for one delegation, converting the parent `Agent` tool-call
 * part **in place** so the transcript keeps its original position. A group is
 * created outright when that part is absent (a truncated or replayed stream).
 */
function ensureSubagentPart(
  parts: WebMessagePart[],
  subagent: { readonly id: string; readonly name: string; readonly label?: string },
): SubagentPart {
  const existing = findSubagentPart(parts, subagent.id);
  if (existing !== undefined) return existing;

  const index = parts.findIndex(
    (part) => part.type === "tool-call" && part.toolCallId === subagent.id,
  );
  const previous = index < 0 ? undefined : parts[index];
  const group: SubagentPart = {
    type: "subagent",
    toolCallId: subagent.id,
    name: subagent.name,
    ...(subagent.label === undefined ? {} : { label: subagent.label }),
    ...(previous?.type === "tool-call" && previous.args !== undefined ? { args: previous.args } : {}),
    ...(previous?.type === "tool-call" && previous.result !== undefined ? { result: previous.result } : {}),
    ...(previous?.type === "tool-call" && previous.history !== undefined ? { history: previous.history } : {}),
    status: previous?.type === "tool-call" ? previous.status : "running",
    calls: [],
  };
  if (index < 0) parts.push(group);
  else parts[index] = group;
  return group;
}

function replaceSubagentPart(parts: WebMessagePart[], next: SubagentPart): void {
  const index = parts.findIndex(
    (part) => part.type === "subagent" && part.toolCallId === next.toolCallId,
  );
  if (index < 0) parts.push(next);
  else parts[index] = next;
}

function upsertSubagentCall(
  parts: WebMessagePart[],
  group: SubagentPart,
  next: WebToolCall,
): void {
  const index = group.calls.findIndex((call) => call.toolCallId === next.toolCallId);
  const calls = index < 0
    ? [...group.calls, next]
    : group.calls.map((call, at) => at === index ? { ...call, ...next } : call);
  replaceSubagentPart(parts, { ...group, calls });
}

function upsertToolCall(parts: WebMessagePart[], next: Extract<WebMessagePart, { type: "tool-call" }>): void {
  const index = parts.findIndex((part) => part.type === "tool-call" && part.toolCallId === next.toolCallId);
  if (index < 0) {
    parts.push(next);
    return;
  }
  const previous = parts[index];
  if (previous?.type === "tool-call") parts[index] = { ...previous, ...next };
}

/**
 * Whether a stored part reaches the transcript at all. The console renders
 * exactly one kind of telemetry — context compaction — and drops the rest in
 * `convertPart`, so every other telemetry part is invisible between two runs of
 * prose.
 */
function isRenderedPart(part: WebMessagePart): boolean {
  if (part.type !== "telemetry") return true;
  const event = part.data;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  return record.type === "runtime_telemetry" && record.kind === "context_compaction";
}

/**
 * Append a streamed delta to the trailing run of `type`.
 *
 * Invisible parts land between text deltas constantly: a status frame pushes
 * one, and so does every stream event `applyEvent` does not map. Merging only
 * into the very last part therefore opened a NEW text part on each of them —
 * usually mid-word, since deltas do not respect word boundaries — and the
 * console renders every text part as its own markdown block, so a sentence
 * visibly broke in half. Skipping the parts the console never renders keeps
 * prose in one run, while a real tool call or delegation, which IS rendered,
 * still separates the text on either side of it.
 */
function appendTextPart(parts: WebMessagePart[], type: "text" | "reasoning", delta: string): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined) break;
    if (!isRenderedPart(part)) continue;
    if (part.type !== type) break;
    parts[index] = { type, text: `${part.text}${delta}` };
    return;
  }
  parts.push({ type, text: delta });
}

/**
 * Text parts on either side of one of these came from DIFFERENT assistant
 * messages: a tool call ends the message that requested it, so prose written
 * after the result belongs to the next one. Reasoning does not — a single
 * message can carry `thinking, text, thinking, text`, which `appendTextPart`
 * splits into two text parts even though the provider reports one answer.
 */
function separatesAssistantMessages(part: WebMessagePart): boolean {
  return part.type === "tool-call" || part.type === "subagent" || part.type === "error";
}

/**
 * Settle the streamed transcript against the turn's authoritative final text.
 *
 * `finalText` is the LAST assistant message's text plus whatever the harness
 * composed around it (a prepended rollover notice, an appended failover line) —
 * NOT the concatenation of everything streamed. Prose the model writes BETWEEN
 * tool calls lives in earlier text parts and is no part of it. Re-slicing
 * `finalText` across every text part by character length therefore smeared one
 * answer over that prose: each slot kept its own length and received a
 * contiguous piece of the answer, usually cut mid-word, while the prose it held
 * was overwritten. The console reads the last text part as the answer, so a
 * whole reply arrived shredded across the activity log.
 *
 * Two shapes do cover everything streamed and are honoured exactly: an equal
 * concatenation (the runtime falls back to the whole run when the last message
 * carried no text of its own) and that concatenation plus a suffix appended
 * after the stream closed. Otherwise the answer owns the TRAILING RUN of text
 * and nothing before it.
 *
 * The answer always lands in the last text part, never a new one: the webapp
 * joins adjacent text before folding, so a part pushed here would be glued onto
 * the prose in front of it — the very symptom this repairs.
 */
function reconcileFinalText(parts: WebMessagePart[], finalText: string): void {
  const textIndexes: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.type === "text") textIndexes.push(index);
  }
  if (textIndexes.length === 0) {
    parts.push({ type: "text", text: finalText });
    return;
  }
  const textAt = (index: number): string => {
    const part = parts[index];
    return part?.type === "text" ? part.text : "";
  };
  const lastIndex = textIndexes[textIndexes.length - 1] as number;
  const streamed = textIndexes.map(textAt).join("");
  if (streamed === finalText) return;
  // Everything streamed is still a prefix of the answer, so only the tail is
  // missing: a truncated stream, or a line the harness appended after it closed.
  if (finalText.startsWith(streamed)) {
    parts[lastIndex] = { type: "text", text: `${textAt(lastIndex)}${finalText.slice(streamed.length)}` };
    return;
  }
  // How many trailing text parts did this answer stream into? Reasoning between
  // two of them keeps them one answer; a tool call makes the earlier one another
  // message's prose, which stays exactly as it streamed.
  let first = textIndexes.length - 1;
  let tail = textAt(lastIndex);
  while (first > 0) {
    const previous = textIndexes[first - 1] as number;
    if (parts.slice(previous + 1, textIndexes[first] as number).some(separatesAssistantMessages)) break;
    const candidate = `${textAt(previous)}${tail}`;
    if (!finalText.includes(candidate)) break;
    tail = candidate;
    first -= 1;
  }
  // Absorbed parts are removed rather than left behind repeating half the
  // answer. Splicing high-to-low keeps the surviving indexes valid.
  parts[lastIndex] = { type: "text", text: finalText };
  for (let position = textIndexes.length - 2; position >= first; position -= 1) {
    parts.splice(textIndexes[position] as number, 1);
  }
}

/** Replace the whole assistant text while retaining non-text transcript parts. */
function replaceWholeText(parts: WebMessagePart[], text: string): void {
  let lastTextIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }
  if (lastTextIndex < 0) {
    parts.push({ type: "text", text });
    return;
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== "text") continue;
    if (index === lastTextIndex) parts[index] = { type: "text", text };
    else parts.splice(index, 1);
  }
}

function deriveAutomaticTitle(text: string, attachments: readonly StoredAttachment[]): string {
  const candidate = text.trim().length > 0 ? text : attachments[0]?.name ?? "New conversation";
  return normalizeTitle(candidate.replace(/\s+/gu, " ").slice(0, 80));
}

function normalizeTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, " ").slice(0, 120);
  if (title.length === 0) throw new WebConsoleError("invalid_title", "A conversation title cannot be empty.", 400);
  return title;
}

function parseParts(value: string): WebMessagePart[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts are not valid JSON.", 500);
  }
  if (!Array.isArray(parsed) || !parsed.every(isWebMessagePart)) {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts have an invalid shape.", 500);
  }
  quoteFromParts(parsed);
  return parsed;
}

const QUOTE_TELEMETRY_EVENT = "quote";
const LIVE_INPUT_TELEMETRY_EVENT = "live_input";

type WebLiveInputStatus = NonNullable<WebMessage["liveInputStatus"]>;

function liveInputTelemetry(status: WebLiveInputStatus): WebMessagePart {
  return { type: "telemetry", event: LIVE_INPUT_TELEMETRY_EVENT, data: { status } };
}

function withoutLiveInputTelemetry(parts: readonly WebMessagePart[]): WebMessagePart[] {
  return parts.filter(
    (part) => part.type !== "telemetry" || part.event !== LIVE_INPUT_TELEMETRY_EVENT,
  );
}

function withLiveInputStatus(
  parts: readonly WebMessagePart[],
  status: WebLiveInputStatus,
): WebMessagePart[] {
  return [liveInputTelemetry(status), ...withoutLiveInputTelemetry(parts)];
}

function liveInputStatusFromParts(parts: readonly WebMessagePart[]): WebLiveInputStatus | undefined {
  const markers = parts.filter(
    (part): part is Extract<WebMessagePart, { type: "telemetry" }> =>
      part.type === "telemetry" && part.event === LIVE_INPUT_TELEMETRY_EVENT,
  );
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input metadata is duplicated.", 500);
  }
  const data = markers[0]?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input metadata is invalid.", 500);
  }
  const status = (data as Record<string, unknown>).status;
  if (status !== "pending" && status !== "applied" && status !== "queued" && status !== "cancelled") {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input status is invalid.", 500);
  }
  return status;
}

function quoteFromParts(parts: readonly WebMessagePart[]): WebQuote | undefined {
  const markers = parts.filter(
    (part): part is Extract<WebMessagePart, { type: "telemetry" }> =>
      part.type === "telemetry" && part.event === QUOTE_TELEMETRY_EVENT,
  );
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata is duplicated.", 500);
  }
  const data = markers[0]?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata has an invalid shape.", 500);
  }
  const quote = data as Record<string, unknown>;
  if (
    typeof quote.text !== "string" || quote.text.trim().length === 0 ||
    typeof quote.messageId !== "string" || quote.messageId.trim().length === 0
  ) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata has an invalid shape.", 500);
  }
  return { text: quote.text, messageId: quote.messageId };
}

function isWebToolCallStatus(value: unknown): boolean {
  return value === "running" || value === "complete" || value === "failed";
}

function isWebToolCall(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return typeof call.toolCallId === "string"
    && typeof call.toolName === "string"
    && isWebToolCallStatus(call.status)
    && (call.history === undefined || isSessionToolHistoryMetadata(call.history));
}

function isSessionToolHistoryMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const history = value as Record<string, unknown>;
  const states = new Set([
    "success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted",
  ]);
  return (history.persistence === "persisted" || history.persistence === "failed")
    && history.untrusted === true
    && (history.recordId === undefined || boundedHistoryString(history.recordId, 4_096))
    && (history.sequence === undefined || positiveSafeInteger(history.sequence))
    && (history.terminalState === undefined || (
      typeof history.terminalState === "string" && states.has(history.terminalState)
    ))
    && (history.truncated === undefined || typeof history.truncated === "boolean")
    && (history.originalBytes === undefined || nonNegativeSafeInteger(history.originalBytes))
    && (history.retainedBytes === undefined || nonNegativeSafeInteger(history.retainedBytes))
    && (history.errorCode === undefined || boundedHistoryString(history.errorCode, 256))
    && (history.artifactReferences === undefined || (
      Array.isArray(history.artifactReferences)
      && history.artifactReferences.length <= 32
      && history.artifactReferences.every((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
        const artifact = entry as Record<string, unknown>;
        return boundedHistoryString(artifact.id, 4_096) && typeof artifact.available === "boolean";
      })
    ));
}

function boundedHistoryString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isWebMessagePart(value: unknown): value is WebMessagePart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string";
  if (part.type === "tool-call") return isWebToolCall(part);
  if (part.type === "subagent") {
    return typeof part.toolCallId === "string"
      && typeof part.name === "string"
      && (part.label === undefined || typeof part.label === "string")
      && (part.executionMs === undefined || typeof part.executionMs === "number")
      && (part.costUsd === undefined || typeof part.costUsd === "number")
      && (part.history === undefined || isSessionToolHistoryMetadata(part.history))
      && isWebToolCallStatus(part.status)
      && Array.isArray(part.calls)
      && part.calls.every(isWebToolCall);
  }
  if (part.type === "telemetry") return typeof part.event === "string";
  if (part.type === "error") return typeof part.message === "string" && (part.code === undefined || typeof part.code === "string");
  return false;
}

function parseStringArray(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseRecord(value: string | null): WebAgentSummary["modelOptions"] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as NonNullable<WebAgentSummary["modelOptions"]>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeRole(value: string): WebMessage["role"] {
  return value === "assistant" || value === "system" ? value : "user";
}

function normalizeMessageStatus(value: string): WebMessageStatus {
  return value === "running" || value === "failed" || value === "cancelled" || value === "interrupted"
    ? value
    : "complete";
}

function normalizeRunStatus(value: string): WebRunState["status"] {
  return value === "running" || value === "failed" || value === "cancelled" || value === "interrupted"
    ? value
    : "complete";
}

function runtimeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): { readonly model?: string; readonly effort?: string } | undefined {
  const runtime = metadata?.runtime;
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) return undefined;
  const record = runtime as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model : undefined;
  const effort = typeof record.effort === "string" ? record.effort : undefined;
  return model === undefined && effort === undefined ? undefined : {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
