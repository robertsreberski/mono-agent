import { createECDH, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { normalizeMonitorTerminalReply, hasMonitorReplyContent, monitorReplyText } from "./monitor-reply.js";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  AGENT_LIVE_INPUT_MAX_MESSAGES,
  MAX_AGENT_REPLY_PARTS,
  classifyNotifySuppression,
  NOTHING_TO_REPORT_SENTINEL,
  type AgentReplyPart,
  parseMonitorProjection,
  parseProcessJobProjection,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
  type MonitorProjection,
  type ProcessJobProjection,
  type ProcessJobState,
} from "@mono-agent/agent-contracts";

import {
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_LIVE_INPUTS_PER_THREAD,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  type WebAgentProvider,
  type WebAgentRunSettings,
  type WebAgentSummary,
  type WebAttachment,
  type WebMessage,
  type WebMessageDelta,
  type WebMessageDeltaOp,
  type WebMessagePart,
  type WebMessageStatus,
  type WebCronJob,
  type WebCronOverview,
  type WebCronRun,
  type WebCronRunSummary,
  type WebCronRunPage,
  type WebMessagePage,
  type WebThreadNotificationTriggerKind,
  type WebQuote,
  type WebRunState,
  type WebThread,
  type WebToolCall,
  type WebThreadDetail,
  type WebThreadPage,
  type WebThreadSearchHit,
  type WebThreadSearchPage,
  type WebPushSubscriptionState,
  type WebPushSubscriptionStatus,
} from "./contracts.js";
import { WebConsoleError } from "./errors.js";
import { runWebStorageMigrations, validateWebStorageMigrationRegistry, WEB_STORAGE_SCHEMA_VERSION } from "./store-migrations.js";
import { webPushPreview } from "./push-preview.js";
import { prepareWebStatePaths, type WebStatePathOptions, type WebStatePaths } from "./state-paths.js";

/** The mutable fields of one conversation. */
interface ThreadPatch {
  readonly title?: string;
  readonly archived?: boolean;
  readonly model?: string | null;
  readonly effort?: string | null;
}

interface AgentRow {
  source_id: string;
  label: string;
  status: string;
  discovered: number;
  pinned: number;
  health: string | null;
  supports_attachments: number;
  supports_provider_auth: number;
  models_json: string | null;
  default_model: string | null;
  default_effort: string | null;
  efforts_json: string | null;
  model_options_json: string | null;
  providers_json: string | null;
  cron_read: number;
  cron_actions: number;
  ask_by_id: number;
  override_model: string | null;
  override_effort: string | null;
  updated_at: string;
}

export interface CreateStoredThreadInput {
  readonly model?: string | null;
  readonly effort?: string | null;
}

interface ThreadRow {
  id: string;
  source_id: string;
  title: string;
  title_manual: number;
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
  run_model: string | null;
  run_effort: string | null;
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

interface ProcessJobCardRow {
  source_id: string;
  job_id: string;
  delivery_key: string;
  thread_id: string;
  message_id: string;
  projection_sha256: string;
  response_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronRunReconciliationResult {
  readonly messages: readonly WebMessage[];
  /** Whether the visible transcript changed and needs a revision/invalidation. */
  readonly changed: boolean;
  /**
   * The messages this reconciliation INSERTED or rewrote, which is a subset of
   * `messages`: a poll that reconciles to the rows already stored writes
   * nothing and must cost a console nothing.
   */
  readonly writtenMessageIds: readonly string[];
  readonly suppressedRunIds?: readonly string[];
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
  /** Parts writes so far. See {@link WebMessage.seq}; pre-v17 rows read 0. */
  seq: number;
  /** `turns.finished_at`, when the query joined the turn; a single-row read looks it up instead. */
  turn_finished_at?: string | null;
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
  /**
   * `upload` is a file the operator sent. `reply` is the console's own durable
   * copy of an image the agent published, kept so it outlives the agent's
   * retention deadline and stays viewable while that agent is stopped.
   */
  readonly origin: "upload" | "reply";
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
  origin: string;
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

/**
 * The searchable text of one message row, derived in SQL so the index cannot
 * drift from `parts_json`: every write path in this store goes through the
 * triggers below rather than remembering to maintain a second copy. Legacy
 * Monitor history gets an association-verified projection repair at open; its
 * canonical parts remain untouched.
 *
 * Only `text` parts are indexed. Reasoning is the agent's working-out and tool
 * payloads are machine JSON; both would drown a search of what was actually
 * said in a conversation.
 *
 * The two highlight sentinels are stripped here rather than trusted to be
 * absent: a message that quotes one would otherwise come back in a snippet as
 * an unbalanced marker and corrupt the client's highlighting.
 */
const MESSAGE_SEARCH_BODY_SQL = `
  SELECT replace(replace(group_concat(json_extract(value, '$.text'), ' '), char(2), ''), char(3), '')
    FROM json_each(%SOURCE%.parts_json)
   WHERE json_extract(value, '$.type') = 'text'
     AND json_extract(value, '$.text') IS NOT NULL`;

const messageSearchBody = (source: "new" | "m"): string =>
  MESSAGE_SEARCH_BODY_SQL.replaceAll("%SOURCE%", source);

/**
 * `unicode61 remove_diacritics 2` folds accents, so an unaccented query still
 * finds accented prose. The write triggers are guarded on `json_valid` because
 * an unindexed message is one missing search hit, while a failed insert would
 * be a lost message.
 */
const MESSAGE_SEARCH_REINDEX_SQL = `
        DELETE FROM message_search WHERE rowid = old.rowid;
        INSERT INTO message_search(rowid, body)
        SELECT new.rowid, (${messageSearchBody("new")});`;

/**
 * A streaming answer is rewritten every ~50 ms, and re-extracting a large
 * message's text on each snapshot costs several times the row write itself
 * (measured at ~6x, and ~23 ms per snapshot on the largest real messages). A
 * running message is therefore left out of the index entirely — including at
 * insert, because a cron run is inserted with real prose while still running,
 * and indexing that body once would freeze it: the thread would keep matching
 * narration it no longer contains. It is swept in when it settles, by either
 * statement shape, since some paths write `parts_json` and `status` together and
 * others write only one of them. `reindexUnsettledMessages` closes the remaining
 * hole, a process that dies mid-turn.
 */
const MESSAGE_SEARCH_SCHEMA_SQL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        body,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS message_search_insert
        AFTER INSERT ON messages
        WHEN json_valid(new.parts_json) AND new.status <> 'running' BEGIN
        INSERT INTO message_search(rowid, body)
        SELECT new.rowid, (${messageSearchBody("new")});
      END;
      CREATE TRIGGER IF NOT EXISTS message_search_update
        AFTER UPDATE OF parts_json ON messages
        WHEN json_valid(new.parts_json) AND new.status <> 'running' BEGIN
        ${MESSAGE_SEARCH_REINDEX_SQL}
      END;
      CREATE TRIGGER IF NOT EXISTS message_search_settle
        AFTER UPDATE OF status ON messages
        WHEN json_valid(new.parts_json) AND old.status = 'running' AND new.status <> 'running' BEGIN
        ${MESSAGE_SEARCH_REINDEX_SQL}
      END;
      CREATE TRIGGER IF NOT EXISTS message_search_delete
        AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
      END;`;

/**
 * Messages still marked running carry whatever text the last snapshot left, and
 * the triggers deliberately skipped them. Sweeping them at open means a turn
 * killed by a crash is searchable rather than silently missing forever.
 */
const MESSAGE_SEARCH_UNSETTLED_SQL = `
      DELETE FROM message_search
       WHERE rowid IN (SELECT rowid FROM messages WHERE status = 'running');
      INSERT INTO message_search(rowid, body)
      SELECT m.rowid, (${messageSearchBody("m")})
        FROM messages m
       WHERE m.status = 'running' AND json_valid(m.parts_json);`;

const MESSAGE_SEARCH_BACKFILL_SQL = `
      DELETE FROM message_search;
      INSERT INTO message_search(rowid, body)
      SELECT m.rowid, (${messageSearchBody("m")})
        FROM messages m
       WHERE json_valid(m.parts_json);`;

/** Rows scanned before ranking cuts off; bounds the cost of a one-letter term. */
const MESSAGE_SEARCH_SCAN_LIMIT = 400;
export const WEB_THREAD_SEARCH_MAX = 50;
/** Below this a query matches almost everything, so it is not worth running. */
export const WEB_THREAD_SEARCH_MIN_QUERY = 2;
/**
 * Wrap each match inside a returned snippet so the client can highlight it.
 * Control characters, and stripped from the indexed body above, so a snippet's
 * markers are always the ones `snippet()` added.
 */
export const WEB_SEARCH_HIGHLIGHT_OPEN = "\u0002";
export const WEB_SEARCH_HIGHLIGHT_CLOSE = "\u0003";

/**
 * An FTS5 MATCH expression for a typed query. Each token is quoted (so the
 * user's punctuation can never be read as FTS operator syntax) and given a
 * prefix `*` so typing narrows results as you go. Tokens are ANDed: adding a
 * word should cut the result list, not grow it.
 */
export function messageSearchMatchExpression(raw: string): string | undefined {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length === 0 ? undefined : tokens.map((token) => `"${token}"*`).join(" ");
}

/** Escape the LIKE wildcards so a literal `%` in a title search stays literal. */
export function escapeLikeTerm(raw: string): string {
  return raw.replaceAll(/[\\%_]/gu, (character) => `\\${character}`);
}

const MAX_REVISIONS_PER_THREAD = 1_000;
export const WEB_THREAD_PAGE_MAX = 200;
/**
 * What one page is when the caller does not say.
 *
 * A sidebar shows a handful of conversations and pages from there, so both the
 * bootstrap's bucket and the thread-list route answer with this rather than the
 * whole per-bucket cap.
 */
export const WEB_THREAD_PAGE_DEFAULT = 50;
export const WEB_MESSAGE_PAGE_MAX = 100;
/**
 * What one page of a transcript is when the caller does not say.
 *
 * A conversation read used to answer with the whole cap, which on a tool-heavy
 * thread is hundreds of kilobytes the viewport never shows. The console renders
 * the tail and pages backwards from `messagesNextCursor`, so the default is the
 * screenful rather than the ceiling.
 */
export const WEB_MESSAGE_PAGE_DEFAULT = 30;
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

export interface BeginStoredAssistantTurnResult {
  readonly turnId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly assistantMessageId: string;
  readonly attachments: readonly [];
  readonly thread: WebThread;
}

export type StoredTurnExecution = BeginStoredTurnResult | BeginStoredAssistantTurnResult;

export type ProcessJobWakeReservation =
  | { readonly kind: "new" }
  | { readonly kind: "completed"; readonly disposition: "steered" | "follow_up" }
  | { readonly kind: "uncertain" };

export type MonitorWakeReservation =
  | { readonly kind: "new" }
  | { readonly kind: "completed"; readonly disposition: "steered" | "follow_up" }
  | { readonly kind: "uncertain" };

export interface StoredLiveInput {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly status: "offered" | "queued";
  readonly createdAt: string;
}

/**
 * One parts write's outcome: the stored message, and what changed inside it.
 *
 * The delta is absent only when the call found nothing to write — a turn that
 * already settled — because a write is the only thing that moves a sequence
 * number, and a delta nobody wrote would be a version that does not exist.
 */
export interface StoredMessageWrite {
  readonly message: WebMessage;
  readonly delta?: WebMessageDelta;
}

/**
 * A settled turn: its conversation as it now reads, and the one parts write
 * that settling it made.
 *
 * The write travels with the detail because the console needs both and they
 * describe the same moment: the detail is what a fresh reader would see, and
 * `write.delta` is how a reader already holding the previous version gets
 * there. Absent when the turn had already settled and nothing was written.
 */
export interface StoredTurnFinish extends WebThreadDetail {
  readonly write?: StoredMessageWrite;
}

/** The columns a parts write may move alongside `parts_json` and `seq`. */
interface MessagePartsColumns {
  readonly status?: WebMessageStatus;
  /** `null` detaches the row from its turn; omitting it leaves the turn alone. */
  readonly turnId?: string | null;
  readonly threadId?: string;
  readonly createdAt?: string;
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
  readonly triggerKind: WebThreadNotificationTriggerKind;
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
  /**
   * The assistant row this completion wrote, when it wrote one.
   *
   * The service invalidates on it. The store is the only thing that knows the
   * id -- the row is either inserted here or found through the cron-run
   * mapping -- and a console that is told only the conversation summary has no
   * way to learn that a message moved.
   */
  readonly messageId?: string;
}

/**
 * A process-job card upsert, plus the message it owns.
 *
 * The card's message id is what the service invalidates on, and the store is
 * the only thing that knows it: looking for the card by scanning a page of the
 * conversation loses every job that finished behind a page of later messages.
 */
export interface UpsertWebProcessJobCardResult extends CompleteWebNotificationResult {
  readonly messageId: string;
}

export function cronChannelReadOnlyError(): WebConsoleError {
  return new WebConsoleError(
    "cron_channel_read_only",
    "Cron channels are read-only. Scheduled runs and history are managed by the agent.",
    409,
  );
}

export interface UpsertWebProcessJobCardInput {
  readonly sourceId: string;
  readonly threadId: string;
  readonly deliveryKey: string;
  readonly processJob: ProcessJobProjection;
  readonly responseText?: string;
  readonly replyParts?: readonly AgentReplyPart[];
}

export class WebStore {
  readonly paths: WebStatePaths;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private closed = false;
  /**
   * The agent PROCESS generation each live summary was built from, by source
   * id. Deliberately not a column: it describes the process behind a source id
   * right now, so a value read back from disk after a console restart would be
   * a claim about a process nobody probed. `replaceAgents` is the only writer,
   * and it drops ids discovery no longer reports.
   */
  private readonly agentGenerations = new Map<string, string>();
  /**
   * `writeMessageParts` statements by the columns they assign. A streaming
   * answer is written every ~50 ms and the SET list is one of a handful of
   * shapes, so preparing each shape once keeps the hot path off the SQL
   * compiler. Keyed by the generated SQL, which is derived solely from which
   * columns the caller moves.
   */
  private readonly partsWriteStatements = new Map<string, StatementSync>();

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
      // After recovery, so anything the recovery settled is already indexed by
      // its own trigger and this only sweeps what genuinely stayed running.
      store.reindexUnsettledMessages();
      store.reindexLegacyMonitorMessages();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Drop the cached statements first: they hold native handles onto the
    // connection this is about to close.
    this.partsWriteStatements.clear();
    this.database.close();
  }

  /**
   * Persist the discovered agent list. Returns whether the change is worth
   * telling clients about.
   *
   * `updatedAt` is a heartbeat timestamp that moves on every discovery poll, so
   * comparing it made this return `true` roughly once every five seconds. At the
   * time, `agents.changed` carried the whole agent list, every model, every model
   * option and every provider. Measured against a 67-agent fleet that was 60 KB
   * per event and 99.5% of all SSE traffic: ~42 MiB/hour to an idle console with
   * nobody using it. The event is now a compact invalidation, but a heartbeat is
   * still not a state change worth making every browser re-bootstrap for.
   *
   * So the two questions are separated. Any difference at all is still written,
   * because the store should hold the freshest heartbeat; only a difference that
   * survives normalizing `updatedAt` is broadcast. Nothing in the console reads
   * an agent's `updatedAt` --- it stays on the wire for clients that want it, it
   * just no longer triggers a fleet-sized frame on its own. `agentGeneration()`
   * already excludes it for the same reason.
   */
  replaceAgents(agents: readonly WebAgentSummary[]): boolean {
    const current = this.listAgents();
    const currentById = new Map(current.map((agent) => [agent.sourceId, agent]));
    const incomingIds = new Set(agents.map((agent) => agent.sourceId));
    // Presence is separate from reachability. An offline summary still belongs
    // in the picker because discovery found its source; an omitted source does
    // not, even when it was already offline before it disappeared.
    const departed = current.some((agent) => !incomingIds.has(agent.sourceId));
    const differs = (agent: WebAgentSummary, ignoreHeartbeat: boolean): boolean => {
      const prior = currentById.get(agent.sourceId);
      if (prior === undefined) return true;
      // `pinned` is store-owned and never arrives from discovery; normalizing it
      // keeps a locally pinned agent from looking like an incoming change.
      const next = { ...agent, pinned: prior.pinned, runSettings: prior.runSettings };
      if (!ignoreHeartbeat) return !isDeepStrictEqual(prior, next);
      return !isDeepStrictEqual({ ...prior, updatedAt: "" }, { ...next, updatedAt: "" });
    };
    const changed = agents.some((agent) => differs(agent, false)) || departed;
    const notable = agents.some((agent) => differs(agent, true)) || departed;
    // After `current` is read (it carries the PREVIOUS generations) and after
    // both comparisons, so a restart behind an otherwise identical summary
    // still reads as a change and still reaches the browser.
    //
    // And only once the row it describes is actually on disk. Advancing before
    // the transaction made the map a claim the database had not agreed to: a
    // transaction that threw left the NEW generation stitched onto the OLD row,
    // so the retry compared the new summary against a prior that already
    // carried its generation, found only `updatedAt` different, and returned
    // `notable === false`. The restart broadcast was then lost permanently ---
    // not deferred --- and an open console stayed stale until it reconnected.
    const adoptGenerations = (): void => {
      this.agentGenerations.clear();
      for (const agent of agents) {
        if (agent.generation !== undefined) this.agentGenerations.set(agent.sourceId, agent.generation);
      }
    };
    if (!changed) {
      // Nothing to persist, so there is nothing for the adoption to outrun:
      // every incoming generation already equals the one it is replacing, or
      // `changed` would be true. The map is still swept so a departed agent
      // does not leave one behind.
      adoptGenerations();
      return false;
    }
    this.transaction(() => {
      // Rows stay as foreign-key parents for retained conversations and
      // delivery ledgers. Discovery presence controls whether they are part of
      // the live console projection; it is restored by the upsert below when a
      // source id returns.
      this.database.prepare("UPDATE agents SET status = 'offline', discovered = 0 WHERE discovered = 1").run();
      const statement = this.database.prepare(`
        INSERT INTO agents (
          source_id, label, status, discovered, health, supports_attachments, supports_provider_auth, models_json,
          default_model, default_effort, efforts_json, model_options_json,
          providers_json, cron_read, cron_actions, ask_by_id, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          discovered = 1,
          health = excluded.health,
          supports_attachments = excluded.supports_attachments,
          supports_provider_auth = excluded.supports_provider_auth,
          models_json = excluded.models_json,
          default_model = excluded.default_model,
          default_effort = excluded.default_effort,
          efforts_json = excluded.efforts_json,
          model_options_json = excluded.model_options_json,
          providers_json = excluded.providers_json,
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
          agent.supportsProviderAuth === true ? 1 : 0,
          stringifyOptional(agent.models),
          agent.defaultModel ?? null,
          agent.defaultEffort ?? null,
          stringifyOptional(agent.efforts),
          stringifyOptional(agent.modelOptions),
          stringifyOptional(agent.providers),
          agent.cron?.read === true ? 1 : 0,
          agent.cron?.actions === true ? 1 : 0,
          agent.supportsAskById === true ? 1 : 0,
          agent.updatedAt,
        );
      }
    });
    adoptGenerations();
    return notable;
  }

  /**
   * A failed registry walk is not an authoritative empty registry. Keep every
   * currently discovered source in the console, but make its lack of a live
   * connection explicit until a later successful discovery reconciles it.
   */
  markDiscoveredAgentsOffline(): boolean {
    const changed = this.listAgents().some((agent) => agent.status !== "offline");
    this.agentGenerations.clear();
    if (!changed) return false;
    this.database.prepare(`
      UPDATE agents SET status = 'offline'
      WHERE discovered = 1 AND status != 'offline'
    `).run();
    return true;
  }

  listAgents(): WebAgentSummary[] {
    const rows = this.database.prepare(agentSelectSql(
      "WHERE a.discovered = 1 ORDER BY pinned DESC, a.label COLLATE NOCASE, a.source_id",
    )).all() as unknown as AgentRow[];
    return rows.map((row) => this.withGeneration(mapAgent(row)));
  }

  getAgent(sourceId: string): WebAgentSummary | undefined {
    const row = this.database.prepare(agentSelectSql(
      "WHERE a.source_id = ? AND a.discovered = 1",
    )).get(sourceId) as unknown as AgentRow | undefined;
    return row === undefined ? undefined : this.withGeneration(mapAgent(row));
  }

  private getStoredAgent(sourceId: string): WebAgentSummary | undefined {
    const row = this.database.prepare(agentSelectSql("WHERE a.source_id = ?"))
      .get(sourceId) as unknown as AgentRow | undefined;
    return row === undefined ? undefined : this.withGeneration(mapAgent(row));
  }

  /** Stitch the live generation onto a row read back from disk. */
  private withGeneration(agent: WebAgentSummary): WebAgentSummary {
    const generation = this.agentGenerations.get(agent.sourceId);
    return generation === undefined ? agent : { ...agent, generation };
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

  setAgentRunOverride(
    sourceId: string,
    override: { readonly model: string | null; readonly effort: string | null },
  ): WebAgentSummary {
    if (this.getAgent(sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    if (override.model === null && override.effort === null) {
      throw new WebConsoleError(
        "invalid_request",
        "Choose a model or effort override, or use Revert to config.",
        400,
      );
    }
    this.database.prepare(`
      INSERT INTO agent_run_overrides (source_id, model, effort, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        model = excluded.model,
        effort = excluded.effort,
        updated_at = excluded.updated_at
    `).run(sourceId, override.model, override.effort, this.now());
    return this.getAgent(sourceId)!;
  }

  clearAgentRunOverride(sourceId: string): WebAgentSummary {
    if (this.getAgent(sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    this.database.prepare("DELETE FROM agent_run_overrides WHERE source_id = ?").run(sourceId);
    return this.getAgent(sourceId)!;
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
    /**
     * Whether this completion actually MOVED the assistant row.
     *
     * A notification that maps onto a cron run whose message already carries
     * this text writes nothing at all, and naming the row anyway costs every
     * subscribed console one message read for a transcript that did not change.
     */
    let wroteMessage = false;
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
          serializeParts([{ type: "text", text: reservation.text } satisfies WebMessagePart]),
          now,
          now,
        );
        wroteMessage = true;
      } else {
        turnId = mappedRun.turn_id;
        assistantMessageId = mappedRun.message_id;
        const message = this.database.prepare(`
          SELECT parts_json, cron_suppressed FROM messages WHERE id = ? AND thread_id = ? AND turn_id = ?
        `).get(assistantMessageId, completedThreadId, turnId) as unknown as { parts_json: string; cron_suppressed: number } | undefined;
        if (message === undefined) {
          throw new WebConsoleError("storage_corrupt", "A cron run mapping is missing its message.", 500);
        }
        const parts = parseParts(message.parts_json).filter((part) => !(part.type === "text" && isSyntheticCronStateText(part.text)))
          .map((part): WebMessagePart => part.type === "telemetry" && part.event === "cron_run"
            ? { ...part, data: withoutCronSilentFlag(part.data) } : part);
        if (!parts.some((part) => part.type === "text" && part.text === reservation.text)) parts.push({ type: "text", text: reservation.text });
        if (message.cron_suppressed === 1 || serializeParts(parts) !== message.parts_json) {
          this.database.prepare("UPDATE messages SET cron_suppressed = 0 WHERE id = ?").run(assistantMessageId);
          this.writeMessageParts(assistantMessageId, parts, now);
          wroteMessage = true;
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
      const agent = this.getStoredAgent(reservation.sourceId);
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
    return {
      thread: this.requireThread(completedThreadId),
      duplicate: false,
      // Only when there is a write to name. See `wroteMessage`.
      ...(wroteMessage ? { messageId: assistantMessageId } : {}),
    };
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
      SELECT payload_json, message_id FROM cron_run_messages
      WHERE source_id = ? AND job_id = ?
      ORDER BY ordered_at DESC, sequence DESC, run_id DESC LIMIT ?
    `).all(sourceId, jobId, bounded) as unknown as Array<{ payload_json: string; message_id: string }>;
    return {
      runs: rows.map((row) => parseStoredCronRun(row.payload_json)),
      messages: [...rows].reverse().flatMap((row) => {
        const message = this.getMessage(row.message_id);
        return message === undefined ? [] : [message];
      }),
    };
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
    if (ordered.length === 0) return { messages: [], changed: false, writtenMessageIds: [] };
    const now = this.now();
    const messageIds: string[] = [];
    // Only the rows whose parts this run actually moved -- see
    // {@link CronRunReconciliationResult.writtenMessageIds}.
    const written = new Set<string>();
    let changed = false;
    let storedChanged = false;
    let visibleActivityAt: string | undefined;
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
        const delivered = this.database.prepare(`
              SELECT d.message_id, m.turn_id
              FROM notification_deliveries d
              JOIN messages m ON m.id = d.message_id
              WHERE d.source_id = ? AND d.job_id = ? AND d.run_id = ?
                AND d.thread_id = ? AND d.completed_at IS NOT NULL
                AND (? IS NULL OR d.message_id = ?)
              ORDER BY d.completed_at DESC LIMIT 1
            `).get(sourceId, jobId, run.runId, channel.thread_id, mapped?.message_id ?? null, mapped?.message_id ?? null) as unknown as {
              message_id: string;
              turn_id: string;
            } | undefined;
        const turnId = mapped?.turn_id ?? delivered?.turn_id ?? cronEntityId("turn", sourceId, jobId, run.runId);
        const messageId = mapped?.message_id ?? delivered?.message_id ?? cronEntityId("message", sourceId, jobId, run.runId);
        messageIds.push(messageId);
        const prior = this.database.prepare(`
          SELECT thread_id, turn_id, parts_json, created_at, status, cron_suppressed FROM messages WHERE id = ?
        `).get(messageId) as unknown as {
          thread_id: string;
          turn_id: string | null;
          parts_json: string;
          created_at: string;
          status: string;
          cron_suppressed: number;
        } | undefined;
        const priorParts = prior === undefined ? [] : parseParts(prior.parts_json);
        let parts = cronRunParts(
          prior?.cron_suppressed === 1 && run.status === "succeeded" && run.fieldsTruncated?.includes("text") === true
            ? { ...run, text: NOTHING_TO_REPORT_SENTINEL } : run,
          priorParts,
          conversationId,
          delivered !== undefined,
        );
        const suppressed = delivered === undefined && !hasMeaningfulCronContent(parts)
          && this.database.prepare("SELECT 1 FROM attachments WHERE message_id = ? LIMIT 1").get(messageId) === undefined
          && (definitelySilentCronRun(run)
            || (run.status === "succeeded" && run.fieldsTruncated?.includes("text") === true && prior?.cron_suppressed === 1));
        if (!suppressed) parts = parts.map(clearSilentCronPart);
        const serializedParts = serializeParts(parts);
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
          storedChanged = true;
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
          storedChanged = true;
        }
        if (prior === undefined) {
          this.database.prepare(`
            INSERT INTO messages (
              id, thread_id, turn_id, role, parts_json, created_at, updated_at, status, cron_suppressed
            ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)
          `).run(messageId, channel.thread_id, turnId, serializedParts, run.orderedAt, now, status, suppressed ? 1 : 0);
          written.add(messageId);
          storedChanged = true;
        } else if (
          prior.thread_id !== channel.thread_id
          || prior.turn_id !== turnId
          || prior.parts_json !== serializedParts
          || prior.created_at !== run.orderedAt
          || prior.status !== status
          || prior.cron_suppressed !== Number(suppressed)
        ) {
          this.writeMessageParts(messageId, parts, now, {
            threadId: channel.thread_id,
            turnId,
            createdAt: run.orderedAt,
            status,
          });
          this.database.prepare("UPDATE messages SET cron_suppressed = ? WHERE id = ?").run(Number(suppressed), messageId);
          written.add(messageId);
          storedChanged = true;
        }
        if (written.has(messageId) && (!suppressed || prior?.cron_suppressed === 0)) changed = true;
        if (written.has(messageId) && !suppressed) {
          const activityAt = run.completedAt ?? run.startedAt ?? run.orderedAt;
          if (visibleActivityAt === undefined || activityAt > visibleActivityAt) visibleActivityAt = activityAt;
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
          storedChanged = true;
        }
      }
      if (storedChanged) {
        if (changed) {
          this.database.prepare(`
            UPDATE threads SET updated_at = MAX(updated_at, COALESCE(?, updated_at)), revision = revision + 1 WHERE id = ?
          `).run(visibleActivityAt ?? null, channel.thread_id);
          this.recordThreadRevision(channel.thread_id, "cron_runs_reconciled", now);
        }
        const excess = this.database.prepare(`
          SELECT turn_id FROM (
            SELECT r.turn_id, ROW_NUMBER() OVER (
              PARTITION BY r.source_id, r.job_id, m.cron_suppressed ORDER BY r.ordered_at DESC, r.sequence DESC, r.run_id DESC
            ) AS retained_row
            FROM cron_run_messages r JOIN messages m ON m.id = r.message_id WHERE r.source_id = ? AND r.job_id = ?
          ) WHERE retained_row > 500
        `).all(sourceId, jobId) as unknown as Array<{ turn_id: string }>;
        const remove = this.database.prepare("DELETE FROM turns WHERE id = ?");
        for (const row of excess) remove.run(row.turn_id);
      }
    });
    return {
      messages: [...new Set(messageIds)].flatMap((id) => { const message = this.getMessage(id); return message === undefined ? [] : [message]; }),
      changed,
      writtenMessageIds: [...written].filter((id) => this.getMessage(id) !== undefined),
      suppressedRunIds: runs.filter((run) => this.database.prepare(`SELECT 1 FROM cron_run_messages r
        JOIN messages m ON m.id = r.message_id WHERE r.source_id = ? AND r.job_id = ? AND r.run_id = ? AND m.cron_suppressed = 1
      `).get(sourceId, jobId, run.runId) !== undefined).map((run) => run.runId),
    };
  }

  /** Append or update exactly one retained card for a web-origin process job. */
  upsertProcessJobCard(input: UpsertWebProcessJobCardInput): UpsertWebProcessJobCardResult {
    const projection = parseProcessJobProjection(input.processJob);
    const thread = this.requireThread(input.threadId);
    if (thread.sourceId !== input.sourceId) {
      throw new WebConsoleError("invalid_notification", "The process job does not belong to this agent thread.", 409);
    }
    const originConversation = projection.origin.conversationId.split("#", 1)[0];
    if (projection.origin.channel !== "web" || originConversation !== `web:${input.threadId}`) {
      throw new WebConsoleError("invalid_notification", "The process job origin does not match this web thread.", 409);
    }
    if (input.deliveryKey !== projection.wake.deliveryKey) {
      throw new WebConsoleError("invalid_notification", "The process job delivery key does not match its projection.", 409);
    }
    if (input.responseText !== undefined
      && (input.responseText.trim().length === 0 || input.responseText.length > 8_000)) {
      throw new WebConsoleError("invalid_notification", "The process job response must contain 1 to 8000 characters.", 413);
    }

    const existing = this.database.prepare(`
      SELECT * FROM process_job_cards WHERE source_id = ? AND job_id = ?
    `).get(input.sourceId, projection.jobId) as unknown as ProcessJobCardRow | undefined;
    const projectionJson = JSON.stringify(projection);
    const projectionSha256 = createHash("sha256").update(projectionJson).digest("hex");
    const now = this.now();
    if (existing === undefined) {
      const messageId = randomUUID();
      const parts = processJobCardParts(projection, input.responseText, input.replyParts);
      this.transaction(() => {
        this.database.prepare(`
          INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
          VALUES (?, ?, NULL, 'assistant', ?, ?, ?, ?)
        `).run(
          messageId,
          input.threadId,
          serializeParts(parts),
          now,
          now,
          isTerminalJobState(projection.state) ? "complete" : "running",
        );
        this.database.prepare(`
          INSERT INTO process_job_cards (
            source_id, job_id, delivery_key, thread_id, message_id,
            projection_sha256, response_text, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.sourceId,
          projection.jobId,
          input.deliveryKey,
          input.threadId,
          messageId,
          projectionSha256,
          input.responseText ?? null,
          now,
          now,
        );
        this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, input.threadId);
        this.recordThreadRevision(input.threadId, "process_job_card_created", now);
      });
      return { thread: this.requireThread(input.threadId), duplicate: false, messageId };
    }

    if (existing.thread_id !== input.threadId || existing.delivery_key !== input.deliveryKey) {
      throw new WebConsoleError(
        "notification_idempotency_conflict",
        "The process job was already bound to a different web thread or delivery key.",
        409,
      );
    }
    const message = this.database.prepare("SELECT * FROM messages WHERE id = ?")
      .get(existing.message_id) as unknown as MessageRow | undefined;
    if (message === undefined || message.thread_id !== input.threadId) {
      throw new WebConsoleError("storage_corrupt", "A retained process-job card is missing its message.", 500);
    }
    const priorParts = parseParts(message.parts_json);
    const priorJobParts = priorParts.filter((part) => part.type === "process-job");
    const priorReplyParts = priorParts.filter(isDurableWebReplyPart);
    const priorPart = priorJobParts[0];
    if (priorJobParts.length !== 1
      || priorPart === undefined
      || priorPart.job.jobId !== projection.jobId
      || priorParts.length !== 1 + priorReplyParts.length) {
      throw new WebConsoleError("storage_corrupt", "A retained process-job card has invalid content.", 500);
    }
    assertProcessJobCardTransition(priorPart.job, projection);
    const hasPriorWakeResponse = existing.response_text !== null || priorReplyParts.length > 0;
    if (hasPriorWakeResponse
      && input.responseText !== undefined
      && input.responseText !== (existing.response_text ?? undefined)) {
      throw new WebConsoleError(
        "notification_idempotency_conflict",
        "The process-job wake response cannot be replaced by different text.",
        409,
      );
    }
    const responseText = input.responseText ?? existing.response_text ?? undefined;
    const nextReplyParts = input.replyParts === undefined
      ? priorReplyParts
      : boundedWebReplyParts(input.replyParts, []);
    if (hasPriorWakeResponse
      && input.replyParts !== undefined
      && !isDeepStrictEqual(nextReplyParts, priorReplyParts)) {
      throw new WebConsoleError(
        "notification_idempotency_conflict",
        "The process-job wake reply parts cannot be replaced by different parts.",
        409,
      );
    }
    const replyPartsChanged = !isDeepStrictEqual(nextReplyParts, priorReplyParts);
    if (existing.projection_sha256 === projectionSha256
      && responseText === (existing.response_text ?? undefined)
      && !replyPartsChanged) {
      return { thread, duplicate: true, messageId: existing.message_id };
    }
    this.transaction(() => {
      this.writeMessageParts(
        existing.message_id,
        [processJobPart(projection, responseText), ...nextReplyParts],
        now,
        { status: isTerminalJobState(projection.state) ? "complete" : "running" },
      );
      this.database.prepare(`
        UPDATE process_job_cards
        SET projection_sha256 = ?, response_text = ?, updated_at = ?
        WHERE source_id = ? AND job_id = ?
      `).run(projectionSha256, responseText ?? null, now, input.sourceId, projection.jobId);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, input.threadId);
      this.recordThreadRevision(input.threadId, "process_job_card_updated", now);
    });
    return { thread: this.requireThread(input.threadId), duplicate: false, messageId: existing.message_id };
  }

  /** Durably claim one web process-job wake before touching the operator. */
  reserveProcessJobWake(input: {
    readonly sourceId: string;
    readonly threadId: string;
    readonly jobId: string;
    readonly deliveryKey: string;
  }): ProcessJobWakeReservation {
    const card = this.database.prepare(`
      SELECT thread_id, delivery_key FROM process_job_cards WHERE source_id = ? AND job_id = ?
    `).get(input.sourceId, input.jobId) as unknown as {
      thread_id: string;
      delivery_key: string;
    } | undefined;
    if (card === undefined
      || card.thread_id !== input.threadId
      || card.delivery_key !== input.deliveryKey) {
      throw new WebConsoleError("invalid_notification", "The process-job wake does not match its retained card.", 409);
    }
    const existing = this.database.prepare(`
      SELECT state, disposition FROM process_job_wake_deliveries
      WHERE source_id = ? AND job_id = ?
    `).get(input.sourceId, input.jobId) as unknown as {
      state: "accepted" | "completed";
      disposition: "steered" | "follow_up" | null;
    } | undefined;
    if (existing?.state === "completed"
      && (existing.disposition === "steered" || existing.disposition === "follow_up")) {
      return { kind: "completed", disposition: existing.disposition };
    }
    if (existing !== undefined) return { kind: "uncertain" };
    const now = this.now();
    this.database.prepare(`
      INSERT INTO process_job_wake_deliveries (
        source_id, job_id, delivery_key, thread_id, state, disposition, turn_id,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'accepted', NULL, NULL, ?, NULL)
    `).run(input.sourceId, input.jobId, input.deliveryKey, input.threadId, now);
    return { kind: "new" };
  }

  completeProcessJobWake(input: {
    readonly sourceId: string;
    readonly jobId: string;
    readonly deliveryKey: string;
    readonly disposition: "steered" | "follow_up";
    readonly turnId?: string;
  }): void {
    const result = this.database.prepare(`
      UPDATE process_job_wake_deliveries
      SET state = 'completed', disposition = ?, turn_id = ?, completed_at = ?
      WHERE source_id = ? AND job_id = ? AND delivery_key = ? AND state = 'accepted'
    `).run(
      input.disposition,
      input.turnId ?? null,
      this.now(),
      input.sourceId,
      input.jobId,
      input.deliveryKey,
    );
    if (result.changes !== 1) {
      throw new WebConsoleError("notification_reservation_lost", "The process-job wake reservation was lost.", 409);
    }
  }

  /** Release a reservation only while no operator delivery has begun. */
  abandonProcessJobWake(input: {
    readonly sourceId: string;
    readonly jobId: string;
    readonly deliveryKey: string;
  }): void {
    this.database.prepare(`
      DELETE FROM process_job_wake_deliveries
      WHERE source_id = ? AND job_id = ? AND delivery_key = ? AND state = 'accepted'
    `).run(input.sourceId, input.jobId, input.deliveryKey);
  }

  /** Durably claim one Monitor wake before touching the operator. */
  reserveMonitorWake(input: {
    readonly sourceId: string;
    readonly threadId: string;
    readonly monitorId: string;
    readonly deliveryKey: string;
    readonly payloadSha256: string;
    readonly monitor: MonitorProjection;
  }): MonitorWakeReservation {
    const monitor = parseMonitorProjection(input.monitor);
    if (monitor.monitorId !== input.monitorId) {
      throw new WebConsoleError("invalid_notification", "The Monitor projection does not match its delivery identity.", 409);
    }
    const thread = this.database.prepare("SELECT source_id, archived_at, trigger_kind FROM threads WHERE id = ?")
      .get(input.threadId) as unknown as {
        source_id: string;
        archived_at: string | null;
        trigger_kind: string | null;
      } | undefined;
    if (thread === undefined || thread.source_id !== input.sourceId) {
      throw new WebConsoleError("invalid_notification", "The Monitor wake does not match its web thread.", 409);
    }
    if (thread.archived_at !== null || thread.trigger_kind !== null) {
      throw new WebConsoleError("thread_archived", "The Monitor wake destination is not an active web conversation.", 409);
    }
    const existing = this.database.prepare(`
      SELECT monitor_id, thread_id, payload_sha256, state, disposition
      FROM monitor_wake_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get(input.sourceId, input.deliveryKey) as unknown as {
      monitor_id: string;
      thread_id: string | null;
      payload_sha256: string;
      state: "accepted" | "completed";
      disposition: "steered" | "follow_up" | null;
    } | undefined;
    if (existing !== undefined) {
      if (existing.monitor_id !== input.monitorId
        || existing.thread_id !== input.threadId
        || existing.payload_sha256 !== input.payloadSha256) {
        throw new WebConsoleError(
          "notification_idempotency_conflict",
          "The Monitor delivery key was already used for a different wake.",
          409,
        );
      }
      if (existing.state === "completed"
        && (existing.disposition === "steered" || existing.disposition === "follow_up")) {
        return { kind: "completed", disposition: existing.disposition };
      }
      return { kind: "uncertain" };
    }
    this.database.prepare(`
      INSERT INTO monitor_wake_deliveries (
        source_id, monitor_id, delivery_key, thread_id, payload_sha256, projection_json,
        state, disposition, turn_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, ?, NULL)
    `).run(
      input.sourceId,
      input.monitorId,
      input.deliveryKey,
      input.threadId,
      input.payloadSha256,
      JSON.stringify(monitor),
      this.now(),
    );
    return { kind: "new" };
  }

  /** Hold terminal pushes while this exact turn's steering receipt is unresolved. */
  setMonitorWakeSteeringTurn(sourceId: string, deliveryKey: string, turnId: string, pending: boolean): void {
    const turn = this.requireTurn(turnId);
    const changed = this.database.prepare(`
      UPDATE monitor_wake_deliveries SET turn_id = ?
      WHERE source_id = ? AND delivery_key = ? AND thread_id = ? AND state = 'accepted'
    `).run(pending ? turnId : null, sourceId, deliveryKey, turn.thread_id);
    if (changed.changes !== 1) {
      throw new WebConsoleError("notification_reservation_lost", "The Monitor steering reservation was lost.", 409);
    }
  }

  completeMonitorWake(input: {
    readonly sourceId: string;
    readonly monitorId: string;
    readonly deliveryKey: string;
    readonly disposition: "steered" | "follow_up";
    readonly turnId?: string;
  }): WebMessage | undefined {
    let messageId: string | undefined;
    this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE monitor_wake_deliveries
        SET state = 'completed', disposition = ?, turn_id = ?, completed_at = ?
        WHERE source_id = ? AND monitor_id = ? AND delivery_key = ? AND state = 'accepted'
      `).run(
        input.disposition,
        input.turnId ?? null,
        this.now(),
        input.sourceId,
        input.monitorId,
        input.deliveryKey,
      );
      if (result.changes !== 1) {
        throw new WebConsoleError("notification_reservation_lost", "The Monitor wake reservation was lost.", 409);
      }
      if (input.turnId === undefined) return;
      const turn = this.requireTurn(input.turnId);
      const reservation = this.database.prepare(`
        SELECT thread_id, projection_json FROM monitor_wake_deliveries
        WHERE source_id = ? AND monitor_id = ? AND delivery_key = ?
      `).get(input.sourceId, input.monitorId, input.deliveryKey) as unknown as {
        thread_id: string | null;
        projection_json: string | null;
      } | undefined;
      if (reservation?.thread_id !== turn.thread_id) {
        throw new WebConsoleError("monitor_origin_mismatch", "The Monitor activity does not belong to this turn.", 409);
      }
      if (reservation.projection_json === null) return;
      let projection: MonitorProjection;
      try {
        projection = parseMonitorProjection(JSON.parse(reservation.projection_json) as unknown);
        if (projection.monitorId !== input.monitorId) throw new TypeError("Monitor identity mismatch.");
      } catch {
        throw new WebConsoleError("storage_corrupt", "A retained Monitor wake projection is invalid.", 500);
      }
      const message = this.requireMessage(turn.assistant_message_id);
      const raw = this.database.prepare("SELECT parts_json FROM messages WHERE id = ?")
        .get(message.id) as unknown as { parts_json: string };
      const original = parseParts(raw.parts_json);
      const normalized = turn.status === "complete" ? normalizeMonitorTerminalReply(original) : { parts: original, changed: false };
      const parts = normalized.parts;
      const activityChanged = upsertMonitorActivity(parts, projection, input.deliveryKey);
      if (turn.status === "complete") this.repairMonitorResponsePush(input.turnId, parts);
      if (!activityChanged && !normalized.changed) return;
      this.writeMessageParts(message.id, parts, this.now());
      messageId = message.id;
    });
    return messageId === undefined ? undefined : this.requireMessage(messageId);
  }

  private hasMonitorTurnAssociation(turnId: string, deliveryKey?: string): boolean {
    const rows = this.database.prepare(`
      SELECT deliveries.delivery_key FROM monitor_wake_deliveries AS deliveries
      JOIN turns ON turns.id = ? AND turns.thread_id = deliveries.thread_id
      JOIN threads ON threads.id = turns.thread_id AND threads.source_id = deliveries.source_id
      WHERE (deliveries.state = 'completed' AND deliveries.turn_id = turns.id
        AND deliveries.disposition IN ('steered', 'follow_up'))
        OR (deliveries.state = 'accepted' AND deliveries.delivery_key = ?)
    `).all(turnId, deliveryKey ?? null);
    return rows.length > 0;
  }

  private repairMonitorResponsePush(turnId: string, parts: readonly WebMessagePart[]): void {
    const key = `turn:${turnId}:terminal`;
    if (hasMonitorReplyContent(parts)) {
      this.database.prepare("UPDATE push_events SET body = ? WHERE logical_key = ? AND kind = 'response.ready'")
        .run(webPushPreview(monitorReplyText(parts)), key);
    } else {
      const now = this.now();
      this.database.prepare(`
        UPDATE push_deliveries SET status = 'suppressed', updated_at = ?, finished_at = ?
        WHERE status = 'pending' AND event_id IN (
          SELECT id FROM push_events WHERE logical_key = ? AND kind = 'response.ready'
        )
      `).run(now, now, key);
    }
  }

  /** Resolve only an exact Monitor live-input receipt belonging to this turn. */
  private monitorWakeProjection(turnId: string, deliveryKey: string): MonitorProjection | undefined {
    const row = this.database.prepare(`
      SELECT deliveries.monitor_id, deliveries.projection_json
      FROM monitor_wake_deliveries AS deliveries
      JOIN turns ON turns.id = ? AND turns.thread_id = deliveries.thread_id
      JOIN threads ON threads.id = turns.thread_id AND threads.source_id = deliveries.source_id
      WHERE deliveries.delivery_key = ?
    `).get(turnId, deliveryKey) as unknown as {
      monitor_id: string;
      projection_json: string | null;
    } | undefined;
    if (row === undefined || row.projection_json === null) return undefined;
    try {
      const projection = parseMonitorProjection(JSON.parse(row.projection_json) as unknown);
      if (projection.monitorId !== row.monitor_id) throw new TypeError("Monitor identity mismatch.");
      return projection;
    } catch {
      throw new WebConsoleError("storage_corrupt", "A retained Monitor wake projection is invalid.", 500);
    }
  }

  /** Release a Monitor reservation only before any operator delivery begins. */
  abandonMonitorWake(input: {
    readonly sourceId: string;
    readonly monitorId: string;
    readonly deliveryKey: string;
  }): void {
    this.database.prepare(`
      DELETE FROM monitor_wake_deliveries
      WHERE source_id = ? AND monitor_id = ? AND delivery_key = ? AND state = 'accepted'
    `).run(input.sourceId, input.monitorId, input.deliveryKey);
  }

  /** Exact retained binding used before proxying a single operator job. */
  processJobCardBelongsToThread(sourceId: string, threadId: string, jobId: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM process_job_cards
      WHERE source_id = ? AND thread_id = ? AND job_id = ?
    `).get(sourceId, threadId, jobId) !== undefined;
  }

  createThread(sourceId: string, explicit: CreateStoredThreadInput = {}): WebThread {
    const agent = this.getAgent(sourceId);
    if (agent === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    const id = randomUUID();
    const now = this.now();
    this.transaction(() => {
      const override = this.database.prepare(`
        SELECT model, effort FROM agent_run_overrides WHERE source_id = ?
      `).get(sourceId) as unknown as { model: string | null; effort: string | null } | undefined;
      const model = explicit.model === undefined ? override?.model ?? null : explicit.model;
      const effort = explicit.effort === undefined ? override?.effort ?? null : explicit.effort;
      this.database.prepare(`
        INSERT INTO threads (
          id, source_id, conversation_id, title, title_manual, archived_at,
          created_at, updated_at, run_model, run_effort, revision
        ) VALUES (?, ?, ?, 'New conversation', 0, NULL, ?, ?, ?, ?, 1)
      `).run(id, sourceId, `web:${id}`, now, now, model, effort);
      this.database.prepare("INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at) VALUES ('thread', ?, 1, 'created', ?)")
        .run(id, now);
      this.setSetting("current_thread_id", id);
    });
    return this.requireThread(id);
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

  /**
   * Conversations of one agent whose title or message prose matches `query`.
   *
   * The sidebar filter this replaces could only see the threads already loaded
   * into the browser, so anything past the first page was unfindable. This runs
   * against the whole store instead: the FTS index ranks message hits by bm25
   * and returns a highlighted snippet, and a separate title pass catches
   * conversations named after something never said inside them.
   */
  searchThreads(input: {
    readonly sourceId: string;
    readonly query: string;
    readonly limit?: number;
  }): WebThreadSearchPage {
    if (this.getAgent(input.sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "Agent not found.", 404);
    }
    const query = input.query.trim();
    const limit = boundedPageLimit(input.limit, WEB_THREAD_SEARCH_MAX);
    const match = query.length < WEB_THREAD_SEARCH_MIN_QUERY
      ? undefined
      : messageSearchMatchExpression(query);
    if (match === undefined) return { hits: [], truncated: false };

    const messageRows = this.database.prepare(`
      SELECT m.thread_id AS thread_id,
             snippet(message_search, 0, ?, ?, char(8230), 12) AS snippet,
             bm25(message_search) AS rank
        FROM message_search
        JOIN messages m ON m.rowid = message_search.rowid
        JOIN threads t ON t.id = m.thread_id
       WHERE message_search MATCH ? AND t.source_id = ? AND ${visibleMessageSql("m")}
       ORDER BY rank
       LIMIT ?
    `).all(
      WEB_SEARCH_HIGHLIGHT_OPEN,
      WEB_SEARCH_HIGHLIGHT_CLOSE,
      match,
      input.sourceId,
      MESSAGE_SEARCH_SCAN_LIMIT + 1,
    ) as unknown as Array<{ thread_id: string; snippet: string | null; rank: number }>;

    // Ranked rows arrive best-first, so the first row seen for a thread is that
    // thread's best snippet and its rank. The extra probe row exists only to
    // detect truncation and must not inflate a count or admit a thread.
    const byThread = new Map<string, { snippet?: string; rank: number; matches: number }>();
    for (const row of messageRows.slice(0, MESSAGE_SEARCH_SCAN_LIMIT)) {
      const existing = byThread.get(row.thread_id);
      if (existing === undefined) {
        byThread.set(row.thread_id, {
          ...(row.snippet === null || row.snippet.length === 0 ? {} : { snippet: row.snippet }),
          rank: row.rank,
          matches: 1,
        });
        continue;
      }
      byThread.set(row.thread_id, { ...existing, matches: existing.matches + 1 });
    }

    // A conversation the user renamed after what it is about may not repeat that
    // word in any message, so titles are matched separately — as a substring,
    // because a title is short enough to scan and short enough to type part of.
    const titleRows = this.database.prepare(`
      SELECT t.id AS id FROM threads t
       WHERE t.source_id = ? AND t.title LIKE '%' || ? || '%' ESCAPE '\\'
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT ?
    `).all(input.sourceId, escapeLikeTerm(query), limit + 1) as unknown as Array<{ id: string }>;
    const titleMatches = new Set(titleRows.slice(0, limit).map((row) => row.id));

    const rankedIds = [...byThread.entries()]
      .map(([threadId, hit]) => ({ threadId, ...hit }))
      .sort((left, right) => left.rank - right.rank)
      .map((hit) => hit.threadId)
      .filter((threadId) => !titleMatches.has(threadId));
    // Title hits lead, because naming a conversation is a deliberate act. But
    // titles are auto-derived from first prompts, so a common word can match
    // more of them than fit one page — and letting titles take every slot would
    // silently return this feature to the title-only search it replaces. Half
    // the page is therefore reserved for ranked message hits whenever there are
    // any, and each side takes the other's unused room.
    const titleIds = [...titleMatches];
    const titleBudget = rankedIds.length === 0
      ? limit
      : Math.max(limit - rankedIds.length, Math.ceil(limit / 2));
    const ordering = [
      ...titleIds.slice(0, titleBudget),
      ...rankedIds,
      ...titleIds.slice(titleBudget),
    ];

    const selectThread = this.database.prepare(threadSelectSql("WHERE t.id = ?"));
    const hits: WebThreadSearchHit[] = [];
    for (const threadId of ordering) {
      if (hits.length >= limit) break;
      const row = selectThread.get(threadId) as unknown as ThreadRow | undefined;
      if (row === undefined) continue;
      const hit = byThread.get(threadId);
      hits.push({
        thread: this.mapThread(row),
        messageMatches: hit?.matches ?? 0,
        titleMatch: titleMatches.has(threadId),
        ...(hit?.snippet === undefined ? {} : { snippet: hit.snippet }),
      });
    }
    return {
      hits,
      // Both queries fetch one row past their cap, so this reports a real cut
      // rather than firing on an exact fill.
      truncated: messageRows.length > MESSAGE_SEARCH_SCAN_LIMIT
        || titleRows.length > limit
        || ordering.length > hits.length,
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

  getThreadDetail(
    id: string,
    options: { readonly limit?: number } = {},
  ): WebThreadDetail | undefined {
    const resolved = this.resolveThreadId(id);
    const thread = this.getThread(resolved);
    if (thread === undefined) return undefined;
    const page = this.listMessagesPage(resolved, { limit: options.limit ?? WEB_MESSAGE_PAGE_DEFAULT });
    return {
      thread,
      messages: page.messages,
      ...(page.nextCursor === undefined ? {} : { messagesNextCursor: page.nextCursor }),
    };
  }

  getMessage(id: string): WebMessage | undefined {
    const row = this.database.prepare(`SELECT * FROM messages WHERE id = ? AND ${visibleMessageSql("messages")}`)
      .get(id) as unknown as MessageRow | undefined;
    return row === undefined ? undefined : this.mapMessage(row);
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
      SELECT m.*, ${orderedAt} AS ordered_at, ${rank} AS role_rank, m.rowid AS storage_rowid,
        t.finished_at AS turn_finished_at
      FROM messages m
      LEFT JOIN turns t ON t.id = m.turn_id
      WHERE m.thread_id = ? AND ${visibleMessageSql("m")} ${beforeSql}
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

  patchThread(id: string, patch: ThreadPatch): WebThread {
    return this.transaction(() => this.writeThreadPatch(id, patch));
  }

  /**
   * Compare-and-set: apply `patch` only while the conversation still carries no
   * run override, and report which way it went.
   *
   * The console's one-time adoption of a browser-local override is the caller.
   * Read and write are ONE `BEGIN IMMEDIATE` here rather than two statements
   * either side of a service-level check: the process lease
   * (`state-paths.ts`) is held on a different database file for the service
   * lifetime, so it makes this process the only *service* writing, not this
   * statement the only writer of `web.sqlite`. Any other connection to the
   * state DB -- a maintenance script, a second console pointed at the same
   * state dir -- could land between a bare read and a bare write, and did in a
   * probe.
   */
  patchThreadIfRunConfigUnset(id: string, patch: ThreadPatch): {
    readonly applied: boolean;
    readonly thread: WebThread;
  } {
    return this.transaction(() => {
      const resolved = this.resolveThreadId(id);
      const current = this.requireThread(resolved);
      if (current.runModel !== null || current.runEffort !== null) {
        return { applied: false, thread: { ...current, sourceId: current.sourceId } };
      }
      return { applied: true, thread: this.writeThreadPatch(resolved, patch) };
    });
  }

  /** The body of {@link patchThread}. Assumes an open transaction. */
  private writeThreadPatch(id: string, patch: ThreadPatch): WebThread {
    id = this.resolveThreadId(id);
    const current = this.requireThread(id);
    const now = this.now();
    const title = patch.title === undefined ? undefined : normalizeTitle(patch.title);
    const archivedAt = patch.archived === undefined ? undefined : patch.archived ? now : null;
    const runModel = patch.model === undefined ? undefined : patch.model;
    const runEffort = patch.effort === undefined ? undefined : patch.effort;
    {
      const sets: string[] = [];
      const values: Array<string | null> = [];
      if (title !== undefined) {
        sets.push("title = ?", "title_manual = 1");
        values.push(title);
      }
      if (archivedAt !== undefined) {
        sets.push("archived_at = ?");
        values.push(archivedAt);
      }
      if (runModel !== undefined) {
        sets.push("run_model = ?");
        values.push(runModel);
      }
      if (runEffort !== undefined) {
        sets.push("run_effort = ?");
        values.push(runEffort);
      }
      // A model/effort-only patch must not reorder the sidebar, so `updated_at`
      // only advances when title or archived state actually changes.
      if (title !== undefined || archivedAt !== undefined) {
        sets.push("updated_at = ?");
        values.push(now);
      }
      sets.push("revision = revision + 1");
      values.push(id);
      this.database.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      this.recordThreadRevision(
        id,
        title !== undefined
          ? "title_changed"
          : archivedAt !== undefined
            ? patch.archived
              ? "archived"
              : "unarchived"
            : "run_config_changed",
        now,
      );
      if (patch.archived === true && this.currentThreadId() === id) {
        this.database.prepare("DELETE FROM settings WHERE key = 'current_thread_id'").run();
      }
    }
    return { ...this.requireThread(id), sourceId: current.sourceId };
  }

  /** Whether the current interactive thread still accepts agent-proposed titles. */
  canApplyAgentTitle(id: string): boolean {
    id = this.resolveThreadId(id);
    const row = this.database.prepare(`
      SELECT title_manual, trigger_kind, archived_at FROM threads WHERE id = ?
    `).get(id) as unknown as {
      title_manual: number;
      trigger_kind: string | null;
      archived_at: string | null;
    } | undefined;
    return row?.title_manual === 0 && row.trigger_kind === null && row.archived_at === null;
  }

  /** Apply one agent title without weakening the permanent manual-title lock. */
  applyAgentTitle(id: string, value: string): WebThread | undefined {
    id = this.resolveThreadId(id);
    const title = normalizeTitle(value);
    const now = this.now();
    let changed = false;
    this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE threads
        SET title = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND title_manual = 0 AND trigger_kind IS NULL
          AND archived_at IS NULL AND title <> ?
      `).run(title, now, id, title);
      if (result.changes !== 1) return;
      changed = true;
      this.recordThreadRevision(id, "title_changed", now);
    });
    return changed ? this.requireThread(id) : undefined;
  }

  async deleteArchivedThread(
    id: string,
    options: { readonly emptyOnly?: boolean } = {},
  ): Promise<{ readonly orphanedFiles: number }> {
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
      if (options.emptyOnly === true) {
        const hasContent = thread.trigger !== undefined || this.database.prepare(`
          SELECT 1 FROM messages WHERE thread_id = ?
          UNION ALL SELECT 1 FROM turns WHERE thread_id = ?
          UNION ALL SELECT 1 FROM attachments WHERE thread_id = ?
          UNION ALL SELECT 1 FROM live_inputs WHERE thread_id = ?
          UNION ALL SELECT 1 FROM process_job_wake_deliveries WHERE thread_id = ?
          UNION ALL SELECT 1 FROM monitor_wake_deliveries WHERE thread_id = ?
          UNION ALL SELECT 1 FROM notification_deliveries WHERE thread_id = ?
          UNION ALL SELECT 1 FROM push_events WHERE thread_id = ?
          LIMIT 1
        `).get(id, id, id, id, id, id, id, id) !== undefined;
        if (hasContent) {
          throw new WebConsoleError(
            "thread_not_empty",
            "The conversation now contains activity and was kept in Archived.",
            409,
          );
        }
      }
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

  /**
   * Durable copies are keyed by the part that produced them, so re-observing a
   * message — a reconnect, a replay, a second read of the same thread — cannot
   * store the same image twice.
   */
  static replyAttachmentId(messageId: string, partId: string): string {
    return `reply:${encodeURIComponent(messageId)}:${encodeURIComponent(partId)}`;
  }

  storedReplyAttachment(messageId: string, partId: string): StoredAttachment | undefined {
    const attachment = this.getStoredAttachment(WebStore.replyAttachmentId(messageId, partId));
    return attachment?.origin === "reply" ? attachment : undefined;
  }

  /**
   * Records an already-written durable copy. Committed on arrival and bound to
   * its thread, so the staged-upload purge and the staged-only delete route both
   * pass it over, while the thread's own delete cascade still reclaims it.
   */
  recordReplyAttachment(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly partId: string;
    readonly name: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly storageName: string;
  }): StoredAttachment {
    const id = WebStore.replyAttachmentId(input.messageId, input.partId);
    const now = this.now();
    this.database.prepare(`
      INSERT INTO attachments (
        id, thread_id, message_id, name, content_type, size_bytes, kind,
        status, uploaded, origin, storage_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'image', 'committed', 1, 'reply', ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.messageId,
      input.name,
      input.contentType,
      input.sizeBytes,
      input.storageName,
      now,
      now,
    );
    return this.requireStoredAttachment(id);
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
        `SELECT id FROM messages WHERE id = ? AND thread_id = ? AND ${visibleMessageSql("messages")}`,
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
      `).run(userMessageId, threadId, turnId, serializeParts(userParts), now, now);
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

  /** Begin one host-owned assistant-only follow-up without inventing a user row. */
  beginAssistantTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    /** Monitor output stays memory-only; callers may retain only a non-secret marker. */
    readonly storedPrompt?: string;
  }): BeginStoredAssistantTurnResult {
    const threadId = this.resolveThreadId(input.threadId);
    const thread = this.requireThread(threadId);
    if (thread.archivedAt !== null) {
      throw new WebConsoleError("thread_archived", "Unarchive this conversation before delivering a background result.", 409);
    }
    if (thread.trigger?.kind === "cron") throw cronChannelReadOnlyError();
    if (!thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    const active = this.database.prepare("SELECT id FROM turns WHERE thread_id = ? AND status = 'running'").get(threadId);
    if (active !== undefined) {
      throw new WebConsoleError("turn_active", "This conversation already has an active turn.", 409);
    }
    if (input.prompt.trim().length === 0) {
      throw new WebConsoleError("empty_turn", "A background follow-up prompt is required.", 400);
    }
    const turnId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'running', ?, NULL, NULL, ?, ?, NULL, NULL, NULL)
      `).run(turnId, threadId, input.storedPrompt ?? input.prompt, assistantMessageId, now);
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
      `).run(assistantMessageId, threadId, turnId, now, now);
      this.database.prepare(
        "UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, threadId);
      this.recordThreadRevision(threadId, "background_follow_up_started", now);
      this.setSetting("current_thread_id", threadId);
    });
    return {
      turnId,
      conversationId: `web:${threadId}`,
      text: input.prompt,
      assistantMessageId,
      attachments: [],
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
      `).run(messageId, threadId, active?.id ?? null, serializeParts(parts), now, now);
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
      this.writeMessageParts(row.message_id, withLiveInputStatus(message.parts, "applied"), now);
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
      this.writeMessageParts(
        row.message_id,
        withLiveInputStatus(message.parts, "queued"),
        now,
        { turnId: null },
      );
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
      this.writeMessageParts(
        row.message_id,
        withLiveInputStatus(message.parts, "cancelled"),
        now,
        { turnId: null },
      );
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
      for (const row of rows) {
        const message = this.requireMessage(row.message_id);
        this.writeMessageParts(
          row.message_id,
          withLiveInputStatus(message.parts, "cancelled"),
          now,
          { turnId: null },
        );
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
      this.writeMessageParts(
        row.message_id,
        withoutLiveInputTelemetry(userMessage.parts),
        now,
        { turnId },
      );
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

  applyStreamFrames(turnId: string, frames: readonly AgentStreamWireFrame[]): StoredMessageWrite {
    const turn = this.requireTurn(turnId);
    // Nothing is written for a turn that already settled, so there is no
    // version for a delta to name.
    if (turn.status !== "running") return { message: this.requireMessage(turn.assistant_message_id) };
    // The base read, the frames applied to it and the write are ONE atomic
    // span, as they already are on the finish path. A delta whose ops were
    // diffed against a version other than the one its `baseSeq` names is
    // self-consistent and WRONG -- the one corruption a sequence number cannot
    // expose, because the console would apply it without complaint.
    const delta = this.transaction(() => {
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
          applyEvent(parts, frame.event, (deliveryKey) => this.monitorWakeProjection(turnId, deliveryKey));
          if (frame.event.type === "runtime_telemetry" && frame.event.kind === "run_config") {
            if (typeof frame.event.data?.model === "string") actualModel = frame.event.data.model;
            if (typeof frame.event.data?.effort === "string") actualEffort = frame.event.data.effort;
          }
        }
      }
      const written = this.writeMessageDelta(message, parts, this.now());
      if (actualModel !== undefined || actualEffort !== undefined) {
        this.database.prepare(`
          UPDATE turns SET
            model = CASE WHEN ? IS NULL THEN model ELSE ? END,
            effort = CASE WHEN ? IS NULL THEN effort ELSE ? END
          WHERE id = ?
        `).run(actualModel ?? null, actualModel ?? null, actualEffort ?? null, actualEffort ?? null, turnId);
      }
      return written;
    });
    return { message: this.requireMessage(turn.assistant_message_id), delta };
  }

  completeTurn(
    turnId: string,
    finalText?: string,
    metadata?: Readonly<Record<string, unknown>>,
    replyParts?: readonly AgentReplyPart[],
    options: { readonly suppressResponsePush?: boolean; readonly monitorWakeDeliveryKey?: string } = {},
  ): StoredTurnFinish {
    const runtime = runtimeMetadata(metadata);
    return this.finishTurn(
      turnId,
      "complete",
      finalText,
      undefined,
      undefined,
      runtime,
      replyParts,
      options.suppressResponsePush === true,
      options.monitorWakeDeliveryKey,
    );
  }

  failTurn(turnId: string, error: { readonly message: string; readonly code?: string; readonly cancelled?: boolean }): StoredTurnFinish {
    return this.finishTurn(
      turnId,
      error.cancelled === true ? "cancelled" : "failed",
      undefined,
      error.code,
      error.message,
      undefined,
    );
  }

  interruptTurn(turnId: string, message = "The web service stopped before this turn completed."): StoredTurnFinish {
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

  turnStatus(turnId: string): WebMessageStatus | undefined {
    const row = this.database.prepare("SELECT status FROM turns WHERE id = ?").get(turnId) as unknown as {
      status: WebMessageStatus;
    } | undefined;
    return row?.status;
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

  /** Stable owner-private key for short-lived message-bound rich-part URLs. */
  ensureReplyAccessKey(generate: () => string): string {
    const existing = this.database.prepare("SELECT value FROM settings WHERE key = 'reply_access_key_v1'")
      .get() as unknown as { value: string } | undefined;
    if (existing !== undefined) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(existing.value)) {
        throw new WebConsoleError("reply_access_key_corrupt", "The stored reply access key is invalid.", 500);
      }
      return existing.value;
    }
    const created = generate();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(created)) {
      throw new WebConsoleError("reply_access_key_generation_failed", "Unable to generate a reply access key.", 500);
    }
    this.setSetting("reply_access_key_v1", created);
    return created;
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
          AND NOT EXISTS (
            SELECT 1 FROM monitor_wake_deliveries m
            WHERE e.kind = 'response.ready' AND m.state = 'accepted' AND m.turn_id IS NOT NULL
              AND e.logical_key = 'turn:' || m.turn_id || ':terminal'
          )
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
      validateWebStorageMigrationRegistry();
      const migrating = versionRow.user_version < WEB_STORAGE_SCHEMA_VERSION;
      if (migrating) this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        discovered INTEGER NOT NULL DEFAULT 1 CHECK (discovered IN (0, 1)),
        health TEXT,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        supports_provider_auth INTEGER NOT NULL DEFAULT 0 CHECK (supports_provider_auth IN (0, 1)),
        models_json TEXT,
        default_model TEXT,
        default_effort TEXT,
        efforts_json TEXT,
        model_options_json TEXT,
        providers_json TEXT,
        cron_read INTEGER NOT NULL DEFAULT 0,
        cron_actions INTEGER NOT NULL DEFAULT 0,
        ask_by_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_overrides (
        source_id TEXT PRIMARY KEY REFERENCES agents(source_id) ON DELETE CASCADE,
        model TEXT,
        effort TEXT,
        updated_at TEXT NOT NULL,
        CHECK (model IS NOT NULL OR effort IS NOT NULL)
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
        run_model TEXT,
        run_effort TEXT,
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
        status TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
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
        origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'reply')),
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
      CREATE TABLE IF NOT EXISTS process_job_wake_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, job_id),
        UNIQUE (source_id, delivery_key)
      );
      CREATE INDEX IF NOT EXISTS process_job_wake_deliveries_by_thread
        ON process_job_wake_deliveries(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS monitor_wake_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        monitor_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        payload_sha256 TEXT NOT NULL,
        projection_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, delivery_key)
      );
      CREATE INDEX IF NOT EXISTS monitor_wake_deliveries_by_thread
        ON monitor_wake_deliveries(thread_id, created_at);
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
      CREATE TABLE IF NOT EXISTS process_job_cards (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        projection_sha256 TEXT NOT NULL,
        response_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id),
        UNIQUE (source_id, delivery_key)
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
      ${MESSAGE_SEARCH_SCHEMA_SQL}
      `);
        runWebStorageMigrations({
          database: this.database,
          originalVersion: versionRow.user_version,
          migrateCronChannels: () => this.migrateCronChannels(),
          migrateMonitorWakeDeliveries: () => this.migrateMonitorWakeDeliveries(),
          suppressSilentCronHistory: () => this.suppressSilentCronHistory(),
          backfillMessageSearch: () => this.database.exec(MESSAGE_SEARCH_BACKFILL_SQL),
        });
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

  private suppressSilentCronHistory(): void {
    const affected = new Set<string>();
    let after = 0;
    while (true) {
      const rows = this.database.prepare(`
        SELECT r.rowid AS cursor, r.*, m.parts_json, m.cron_suppressed
        FROM cron_run_messages r JOIN messages m ON m.id = r.message_id
        WHERE r.rowid > ? ORDER BY r.rowid LIMIT 100
      `).all(after) as unknown as Array<{ cursor: number; source_id: string; job_id: string; run_id: string;
        thread_id: string; message_id: string; payload_json: string; parts_json: string; cron_suppressed: number }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const run = parseStoredCronRun(row.payload_json);
        const parts = parseParts(row.parts_json);
        if (run.runId !== row.run_id || run.jobId !== row.job_id) throw new Error("Invalid cron mapping identity.");
        const delivered = this.database.prepare(`SELECT 1 FROM notification_deliveries
          WHERE source_id = ? AND job_id = ? AND run_id = ? AND message_id = ? AND completed_at IS NOT NULL
        `).get(row.source_id, row.job_id, row.run_id, row.message_id);
        const suppressed = definitelySilentCronRun(run) && delivered === undefined && !hasMeaningfulCronContent(parts)
          && this.database.prepare("SELECT 1 FROM attachments WHERE message_id = ? LIMIT 1").get(row.message_id) === undefined;
        if (row.cron_suppressed === 0 && suppressed) {
          this.database.prepare("UPDATE messages SET cron_suppressed = 1 WHERE id = ?").run(row.message_id);
          affected.add(row.thread_id);
        } else if (!suppressed) {
          // Visible ambiguous/delivered rows must not be hidden by old browser
          // telemetry guards. Keep their content, remove only the stale flag.
          const visibleParts = parts.map(clearSilentCronPart);
          if (visibleParts.some((part, index) => part !== parts[index])) {
            this.database.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(serializeParts(visibleParts), row.message_id);
            affected.add(row.thread_id);
          }
        }
        after = row.cursor;
      }
    }
    for (const id of affected) this.database.prepare("UPDATE threads SET revision = revision + 1 WHERE id = ?").run(id);
  }

  /** Preserve Monitor delivery tombstones while making deleted threads threadless. */
  private migrateMonitorWakeDeliveries(): void {
    const foreignKeys = this.database.prepare("PRAGMA foreign_key_list(monitor_wake_deliveries)")
      .all() as Array<{ from: string; on_delete: string }>;
    if (!foreignKeys.some((key) => key.from === "thread_id" && key.on_delete === "CASCADE")) return;
    const columns = this.database.prepare("PRAGMA table_info(monitor_wake_deliveries)")
      .all() as Array<{ name: string }>;
    const projection = columns.some((column) => column.name === "projection_json") ? "projection_json" : "NULL";
    this.database.exec(`
      CREATE TABLE monitor_wake_deliveries_v14 (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        monitor_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        payload_sha256 TEXT NOT NULL,
        projection_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, delivery_key)
      );
      INSERT INTO monitor_wake_deliveries_v14 (
        source_id, monitor_id, delivery_key, thread_id, payload_sha256, projection_json,
        state, disposition, turn_id, created_at, completed_at
      ) SELECT
        source_id, monitor_id, delivery_key, thread_id, payload_sha256, ${projection},
        state, disposition, turn_id, created_at, completed_at
      FROM monitor_wake_deliveries;
      DROP TABLE monitor_wake_deliveries;
      ALTER TABLE monitor_wake_deliveries_v14 RENAME TO monitor_wake_deliveries;
      CREATE INDEX monitor_wake_deliveries_by_thread
        ON monitor_wake_deliveries(thread_id, created_at);
    `);
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
        "agent_run_overrides",
      "threads",
      "turns",
      "messages",
      "live_inputs",
      "attachments",
      "revisions",
      "settings",
      "notification_deliveries",
      "process_job_wake_deliveries",
      "monitor_wake_deliveries",
      "cron_channels",
      "cron_channel_deletions",
      "cron_overviews",
      "cron_job_snapshots",
      "cron_run_messages",
      "thread_redirects",
      "process_job_cards",
      "push_subscriptions",
      "push_events",
      "push_deliveries",
      "message_search",
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
    const monitorProjections = this.database.prepare(`
      SELECT monitor_id, projection_json
      FROM monitor_wake_deliveries
      WHERE projection_json IS NOT NULL
    `).all() as unknown as Array<{ monitor_id: string; projection_json: string }>;
    for (const row of monitorProjections) {
      try {
        const projection = parseMonitorProjection(JSON.parse(row.projection_json) as unknown);
        if (projection.monitorId !== row.monitor_id) throw new TypeError("Monitor identity mismatch.");
      } catch {
        throw new WebConsoleError("storage_corrupt", "A retained Monitor wake projection is invalid.", 500);
      }
    }
  }

  /**
   * Index the messages the streaming gate skipped and nothing settled — the
   * residue of a process that died mid-turn. Bounded to whatever is still
   * marked running, which is at most one message per interrupted thread.
   */
  private reindexUnsettledMessages(): void {
    this.transaction(() => {
      this.database.exec(MESSAGE_SEARCH_UNSETTLED_SQL);
    });
  }

  /** Repair only the derived search projection of verified legacy Monitor replies.
   * New completions already normalize before the ordinary indexing triggers run.
   * Page by rowid so opening a large retained history does not materialize it all.
   */
  private reindexLegacyMonitorMessages(): void {
    const select = this.database.prepare(`
      SELECT m.rowid AS row_id, m.parts_json FROM messages m
      JOIN turns ON turns.id = m.turn_id AND turns.thread_id = m.thread_id
      JOIN threads ON threads.id = m.thread_id
      WHERE m.rowid > ? AND m.role = 'assistant' AND m.status = 'complete'
        AND EXISTS (
          SELECT 1 FROM monitor_wake_deliveries d
          WHERE d.turn_id = turns.id AND d.thread_id = turns.thread_id
            AND d.source_id = threads.source_id AND d.state = 'completed'
            AND d.disposition IN ('steered', 'follow_up')
        )
      ORDER BY m.rowid LIMIT 100
    `);
    const remove = this.database.prepare("DELETE FROM message_search WHERE rowid = ?");
    const insert = this.database.prepare(`
      INSERT INTO message_search(rowid, body)
      SELECT ?, (${messageSearchBody("m")}) FROM (SELECT ? AS parts_json) m
    `);
    let after = 0;
    while (true) {
      const rows = select.all(after) as unknown as Array<{ row_id: number; parts_json: string }>;
      if (rows.length === 0) return;
      this.transaction(() => {
        for (const row of rows) {
          const normalized = normalizeMonitorTerminalReply(parseParts(row.parts_json));
          if (!normalized.changed) continue;
          remove.run(row.row_id);
          insert.run(row.row_id, serializeParts(normalized.parts));
        }
      });
      after = rows[rows.length - 1]!.row_id;
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
      for (const row of rows) {
        const persisted = this.database.prepare("SELECT parts_json FROM messages WHERE id = ?")
          .get(row.message_id) as unknown as { parts_json: string } | undefined;
        if (persisted === undefined) {
          throw new WebConsoleError("storage_corrupt", `Live input ${row.id} has no message.`, 500);
        }
        updateInput.run(now, row.id);
        this.writeMessageParts(
          row.message_id,
          withLiveInputStatus(parseParts(persisted.parts_json), "queued"),
          now,
          { turnId: null },
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
    replyParts?: readonly AgentReplyPart[],
    suppressResponsePush = false,
    monitorWakeDeliveryKey?: string,
  ): StoredTurnFinish {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") {
      return this.requireThreadDetail(turn.thread_id);
    }
    const write = this.transaction(() => this.finishTurnInTransaction(
      turnId,
      status,
      finalText,
      errorCode,
      errorMessage,
      runtime,
      replyParts,
      suppressResponsePush,
      monitorWakeDeliveryKey,
    ));
    return {
      ...this.requireThreadDetail(turn.thread_id),
      ...(write === undefined ? {} : { write }),
    };
  }

  private finishTurnInTransaction(
    turnId: string,
    status: Exclude<WebMessageStatus, "running">,
    finalText?: string,
    errorCode?: string,
    errorMessage?: string,
    runtime?: { readonly model?: string; readonly effort?: string },
    replyParts?: readonly AgentReplyPart[],
    suppressResponsePush = false,
    monitorWakeDeliveryKey?: string,
  ): StoredMessageWrite | undefined {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") return undefined;
    const existing = this.requireMessage(turn.assistant_message_id);
    let parts = [...existing.parts];
    if (finalText !== undefined && finalText.length > 0) reconcileFinalText(parts, finalText);
    if (replyParts !== undefined) parts = boundedWebReplyParts(replyParts, parts);
    if (errorMessage !== undefined) {
      parts.push({ type: "error", ...(errorCode === undefined ? {} : { code: errorCode }), message: errorMessage });
    }
    const monitorAssociated = status === "complete" && this.hasMonitorTurnAssociation(turnId, monitorWakeDeliveryKey);
    if (monitorAssociated) {
      const normalized = normalizeMonitorTerminalReply(parts);
      parts = normalized.parts;
      // A suppressed callback may still have streamed the sentinel. Preserve a
      // preceding answer and rich output even when its terminal reply was empty.
      suppressResponsePush = !hasMonitorReplyContent(parts);
    }
    const now = this.now();
    const thread = this.requireThread(turn.thread_id);
    const agent = this.getStoredAgent(thread.sourceId);
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
    const delta = this.writeMessageDelta(existing, parts, now, { status });
    this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(now, turn.thread_id);
    this.recordThreadRevision(turn.thread_id, `turn_${status}`, now);
    const recentEnoughForRecoveredInterruption = status !== "interrupted"
      || new Date(now).getTime() - new Date(existing.updatedAt).getTime() <= 60 * 60 * 1_000;
    // Projected cron turns are agent-owned scheduler state. Restart recovery
    // still settles the local projection, but only web-owned turns may emit a
    // Web Push terminal notification from this service.
    if (thread.trigger?.kind !== "cron"
      && recentEnoughForRecoveredInterruption
      && !(status === "complete" && suppressResponsePush)) {
      const kind: WebPushEventKind = status === "complete"
        ? "response.ready"
        : status === "cancelled"
          ? "run.cancelled"
          : status === "interrupted"
            ? "run.interrupted"
            : "run.failed";
      const label = agent?.label ?? "mono-agent";
      const body = status === "complete"
        ? monitorAssociated ? monitorReplyText(parts) : parts.filter((part): part is Extract<WebMessagePart, { type: "text" }> => part.type === "text")
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
    // Re-read rather than reuse `existing`: the settled row is what Task 6
    // pushes beside the delta, and it carries the turn's finish stamp.
    return { message: this.requireMessage(existing.id), delta };
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
      runModel: row.run_model,
      runEffort: row.run_effort,
    };
  }

  /**
   * The ONE statement that persists a message's parts.
   *
   * Every parts write bumps `seq`, and that count is what makes a content
   * delta safe to apply: a console holding version N can tell the write that
   * follows it from one that skipped ahead, and re-read the message instead of
   * guessing. A write that went straight to `parts_json` would mint content no
   * delta describes and no sequence number covers, so this is the only place in
   * the store that names the column. A caller that also moves the row passes
   * the columns it changes here rather than issuing a second statement.
   *
   * Only the two paths a console watches live -- streaming frames and the write
   * that settles a turn -- go on to build a {@link WebMessageDelta} from this.
   * Every other caller (a live-input transition, restart recovery, and the
   * notification, cron-run, process-job and Monitor reconciliations) bumps the
   * version without describing the change: those writes reach the browser as an
   * invalidation it answers by re-reading the message, and the new `seq` is what
   * tells it the re-read is newer than the delta stream it was applying.
   *
   * EVERY caller here owes its console a message event -- a delta, or the
   * `message.changed` naming this row. A subscribed console no longer answers a
   * conversation summary by re-reading the transcript, so a write announced
   * only as a summary is one it never sees. `recoverLiveInputs` is the single
   * exception, and only because it runs at open with no subscriber to tell.
   */
  private writeMessageParts(
    id: string,
    parts: readonly WebMessagePart[],
    now: string,
    columns: MessagePartsColumns = {},
  ): { readonly baseSeq: number; readonly seq: number } {
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    if (columns.threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(columns.threadId);
    }
    if (columns.turnId !== undefined) {
      assignments.push("turn_id = ?");
      values.push(columns.turnId);
    }
    assignments.push("parts_json = ?");
    values.push(serializeParts(parts));
    if (columns.createdAt !== undefined) {
      assignments.push("created_at = ?");
      values.push(columns.createdAt);
    }
    assignments.push("updated_at = ?");
    values.push(now);
    if (columns.status !== undefined) {
      assignments.push("status = ?");
      values.push(columns.status);
    }
    const sql = `UPDATE messages SET ${assignments.join(", ")}, seq = seq + 1 WHERE id = ? RETURNING seq`;
    let statement = this.partsWriteStatements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.partsWriteStatements.set(sql, statement);
    }
    const row = statement.get(...values, id) as unknown as { seq: number } | undefined;
    if (row === undefined) {
      throw new WebConsoleError("storage_corrupt", `Message ${id} is missing from this conversation.`, 500);
    }
    return { baseSeq: row.seq - 1, seq: row.seq };
  }

  /**
   * Persist a message's parts and describe the write as a content delta.
   *
   * `message` must be the message the new parts were DERIVED from: the diff
   * compares by reference, so a delta computed against any other read of the
   * same row would call every part changed.
   */
  private writeMessageDelta(
    message: WebMessage,
    parts: readonly WebMessagePart[],
    now: string,
    columns: MessagePartsColumns = {},
  ): WebMessageDelta {
    const { baseSeq, seq } = this.writeMessageParts(message.id, parts, now, columns);
    // The ops describe `message.parts`; `baseSeq` is what the row actually held
    // when this statement ran. Every caller reads and writes inside one
    // transaction on a single-writer database, so these agree -- and if they
    // ever stopped agreeing, the delta would be a self-consistent description
    // of a version that never existed, which a console applies in silence.
    // Refusing here turns that into a failure the caller can see.
    if (baseSeq !== message.seq) {
      throw new WebConsoleError(
        "storage_corrupt",
        `Message ${message.id} moved from ${String(message.seq)} to ${String(baseSeq)} while its delta was built.`,
        500,
      );
    }
    return {
      messageId: message.id,
      baseSeq,
      seq,
      status: columns.status ?? message.status,
      updatedAt: now,
      ops: diffParts(message.parts, parts),
    };
  }

  private mapMessage(row: MessageRow): WebMessage {
    const attachments = this.database
      .prepare("SELECT * FROM attachments WHERE message_id = ? AND origin = 'upload' ORDER BY created_at, id")
      .all(row.id) as unknown as AttachmentRow[];
    const rawParts = parseParts(row.parts_json);
    const storedParts = row.role === "assistant" && row.status === "complete" && row.turn_id !== null
      && this.hasMonitorTurnAssociation(row.turn_id)
      ? normalizeMonitorTerminalReply(rawParts).parts : rawParts;
    const quote = quoteFromParts(storedParts);
    const liveInputStatus = liveInputStatusFromParts(storedParts);
    const role = normalizeRole(row.role);
    const finishedAt = role === "assistant" ? this.turnFinishedAt(row) : undefined;
    return {
      id: row.id,
      threadId: row.thread_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      role,
      ...(quote === undefined ? {} : { quote }),
      parts: storedParts.filter(
        (part) => part.type !== "telemetry"
          || (part.event !== QUOTE_TELEMETRY_EVENT && part.event !== LIVE_INPUT_TELEMETRY_EVENT),
      ),
      attachments: attachments.map((attachment) => toWebAttachment(mapStoredAttachment(attachment))),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      status: normalizeMessageStatus(row.status),
      ...(liveInputStatus === undefined ? {} : { liveInputStatus }),
      seq: row.seq,
    };
  }

  /**
   * The turn's terminal stamp, which `finishTurnInTransaction` writes with the
   * message status. A page query projects it from its own join; only a
   * single-row read pays for a lookup.
   */
  private turnFinishedAt(row: MessageRow): string | undefined {
    if (row.turn_id === null) return undefined;
    if (row.turn_finished_at !== undefined) return row.turn_finished_at ?? undefined;
    const turn = this.database.prepare("SELECT finished_at FROM turns WHERE id = ?")
      .get(row.turn_id) as unknown as { finished_at: string | null } | undefined;
    return turn?.finished_at ?? undefined;
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
    const row = this.database.prepare(`SELECT * FROM messages WHERE thread_id = ? AND ${visibleMessageSql("messages")} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as unknown as MessageRow | undefined;
    if (row === undefined) return undefined;
    const text = this.mapMessage(row).parts
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
    SELECT t.id, t.source_id, t.title, t.title_manual, t.trigger_kind, t.archived_at, t.created_at, t.updated_at, t.revision,
           t.run_model, t.run_effort,
           cc.job_id AS cron_job_id, cc.configured AS cron_configured,
           CASE WHEN t.trigger_kind = 'cron' THEN 0
                WHEN a.status = 'online' OR a.status = 'degraded' THEN 1 ELSE 0 END AS can_send,
           CASE WHEN t.trigger_kind = 'cron' THEN 0
                WHEN (a.status = 'online' OR a.status = 'degraded') AND a.supports_attachments = 1 THEN 1 ELSE 0 END AS can_upload,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND ${visibleMessageSql("m")}) AS message_count
    FROM threads t JOIN agents a ON a.source_id = t.source_id
    LEFT JOIN cron_channels cc ON cc.thread_id = t.id
    ${suffix}
  `;
}

function agentSelectSql(suffix: string): string {
  return `
    SELECT a.*,
           o.model AS override_model,
           o.effort AS override_effort,
           CASE WHEN EXISTS (
             SELECT 1 FROM settings s
             WHERE s.key = 'agent_pin:' || a.source_id AND s.value = '1'
           ) THEN 1 ELSE 0 END AS pinned
    FROM agents a
    LEFT JOIN agent_run_overrides o ON o.source_id = a.source_id
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

function notificationPayloadSha256(kind: WebThreadNotificationTriggerKind, text: string): string {
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

/** Presentation queries only; storage validation/recovery and retention stay raw. */
function visibleMessageSql(alias: "m" | "messages"): string { return `${alias}.cron_suppressed = 0`; }

function withoutCronSilentFlag(data: unknown): Record<string, unknown> {
  const { silent: _silent, ...rest } = record(data) ?? {};
  return rest;
}

function clearSilentCronPart(part: WebMessagePart): WebMessagePart {
  return part.type === "telemetry" && part.event === "cron_run" && record(part.data)?.silent === true
    ? { ...part, data: withoutCronSilentFlag(part.data) } : part;
}

function definitelySilentCronRun(run: WebCronRun): boolean {
  return run.status === "succeeded" && run.fieldsTruncated?.includes("text") !== true
    && classifyNotifySuppression(run.text) !== "none";
}

function hasMeaningfulCronContent(parts: readonly WebMessagePart[]): boolean {
  return parts.some((part) => part.type === "text"
    ? !isSyntheticCronStateText(part.text) && classifyNotifySuppression(part.text) === "none"
    : part.type === "attachment" || part.type === "error" || part.type === "mcp_app"
      || part.type === "failure" || part.type === "process-job" || part.type === "monitor-activity");
}

function cronRunParts(
  run: WebCronRun,
  prior: readonly WebMessagePart[],
  conversationId: string,
  notificationBacked = false,
): WebMessagePart[] {
  const silent = definitelySilentCronRun(run);
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
    && !(part.type === "text" && !notificationBacked && isSyntheticCronStateText(part.text)));
  const parts: WebMessagePart[] = run.projection === "summary"
    ? [...retained]
    : retained.filter((part) => part.type === "text" || part.type === "error" || part.type === "attachment"
      || part.type === "mcp_app" || part.type === "failure" || part.type === "process-job" || part.type === "monitor-activity");
  for (const event of run.projection === "detail" ? run.events : []) applyEvent(parts, event);
  const preserveLoadedText = run.projection === "summary"
    && run.fieldsTruncated?.includes("text") === true
    && priorActivityLoaded;
  const preserveLoadedError = run.projection === "summary"
    && priorActivityLoaded
    && (run.fieldsTruncated?.includes("error") === true
      || run.fieldsTruncated?.includes("failureKind") === true);
  if (!notificationBacked && !silent && !preserveLoadedText && run.text !== undefined && run.text.length > 0) {
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
      ...(silent && !hasMeaningfulCronContent(parts) ? { silent: true } : {}),
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
  if ((run.text !== undefined && typeof run.text !== "string")
    || (run.fieldsTruncated !== undefined && (!Array.isArray(run.fieldsTruncated) || run.fieldsTruncated.some((field) => typeof field !== "string")))
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
  const providers = parseProviderSummary(row.providers_json);
  const runSettings = agentRunSettings(row);
  return {
    sourceId: row.source_id,
    label: row.label,
    status: row.status === "online" || row.status === "degraded" ? row.status : "offline",
    pinned: row.pinned === 1,
    ...(row.health === null ? {} : { health: row.health }),
    supportsAttachments: row.supports_attachments === 1,
    ...(row.supports_provider_auth === 1 ? { supportsProviderAuth: true } : {}),
    ...(models === undefined ? {} : { models }),
    ...(row.default_model === null ? {} : { defaultModel: row.default_model }),
    ...(row.default_effort === null ? {} : { defaultEffort: row.default_effort }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(modelOptions === undefined ? {} : { modelOptions }),
    runSettings,
    ...(providers === undefined ? {} : { providers }),
    ...(row.cron_read === 1
      ? { cron: { read: true, actions: row.cron_actions === 1 } }
      : {}),
    ...(row.ask_by_id === 1 ? { supportsAskById: true } : {}),
    updatedAt: row.updated_at,
  };
}

function agentRunSettings(row: AgentRow): WebAgentRunSettings {
  const effectiveModel = row.override_model ?? row.default_model;
  const effectiveEffort = row.override_effort ?? row.default_effort;
  const config = {
    ...(row.default_model === null ? {} : { model: row.default_model }),
    ...(row.default_effort === null ? {} : { effort: row.default_effort }),
  };
  const override = row.override_model === null && row.override_effort === null
    ? null
    : {
        ...(row.override_model === null ? {} : { model: row.override_model }),
        ...(row.override_effort === null ? {} : { effort: row.override_effort }),
      };
  return {
    config,
    override,
    effective: {
      ...(effectiveModel === null ? {} : { model: effectiveModel }),
      modelSource: row.override_model === null ? "config" : "override",
      ...(effectiveEffort === null ? {} : { effort: effectiveEffort }),
      effortSource: row.override_effort === null ? "config" : "override",
    },
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
    origin: row.origin === "reply" ? "reply" : "upload",
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

type MonitorWakeProjectionResolver = (deliveryKey: string) => MonitorProjection | undefined;

function appliedMonitorWake(
  event: Extract<AgentStreamEvent, { type: "tool_call_started" | "tool_call_completed" }>,
  resolveMonitorWake: MonitorWakeProjectionResolver | undefined,
): { readonly deliveryKey: string; readonly projection: MonitorProjection } | undefined {
  if (resolveMonitorWake === undefined
    || event.metadata?.liveInput !== true
    || event.metadata?.synthetic !== true
    || typeof event.metadata.inputId !== "string") {
    return undefined;
  }
  const projection = resolveMonitorWake(event.metadata.inputId);
  return projection === undefined
    ? undefined
    : { deliveryKey: event.metadata.inputId, projection };
}

function applyEvent(
  parts: WebMessagePart[],
  event: AgentStreamEvent,
  resolveMonitorWake?: MonitorWakeProjectionResolver,
): void {
  if (event.type === "assistant_thought") {
    appendTextPart(parts, "reasoning", event.text);
    return;
  }
  if (event.type === "tool_call_started") {
    if (appliedMonitorWake(event, resolveMonitorWake) !== undefined) return;
    const historyUpdate = canonicalEventHistoryUpdate(event.history);
    const subagent = subagentOf(event);
    if (subagent !== undefined) {
      const group = ensureSubagentPart(parts, subagent);
      // The bookend only announces the subagent; the group it belongs to is the
      // whole of its contribution here.
      if (event.metadata?.subagentLifecycle === true) {
        replaceSubagentPart(parts, withEventHistoryUpdate({
          ...group,
          ...(event.arguments === undefined ? {} : { args: event.arguments }),
        }, historyUpdate));
        return;
      }
      upsertSubagentCall(parts, group, {
        toolCallId: event.id,
        toolName: subagentToolName(event.name),
        ...(event.arguments === undefined ? {} : { args: event.arguments }),
        status: "running",
      }, historyUpdate);
      return;
    }
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name,
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      status: "running",
    }, historyUpdate);
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
    const monitorWake = appliedMonitorWake(event, resolveMonitorWake);
    if (monitorWake !== undefined) {
      upsertMonitorActivity(parts, monitorWake.projection, monitorWake.deliveryKey);
      return;
    }
    const status = event.isError === true ? "failed" : "complete";
    const historyUpdate = canonicalEventHistoryUpdate(event.history);
    const executionMs = canonicalExecutionMs(event.executionMs);
    const subagent = subagentOf(event);
    if (subagent !== undefined) {
      const group = ensureSubagentPart(parts, subagent);
      if (event.metadata?.subagentLifecycle === true) {
        replaceSubagentPart(parts, withEventHistoryUpdate({
          ...group,
          status,
          ...(executionMs === undefined ? {} : { executionMs }),
          ...(subagent.costUsd === undefined ? {} : { costUsd: subagent.costUsd }),
        }, historyUpdate));
        return;
      }
      upsertSubagentCall(parts, group, {
        toolCallId: event.id,
        toolName: subagentToolName(event.name ?? existingSubagentToolName(group, event.id) ?? "Tool"),
        ...(event.arguments === undefined ? {} : { args: event.arguments }),
        ...(event.content === undefined ? {} : { result: event.content }),
        ...(event.structuredContent === undefined ? {} : { structuredResult: event.structuredContent }),
        ...(executionMs === undefined ? {} : { executionMs }),
        status,
      }, historyUpdate);
      return;
    }
    // The parent `Agent` call completes against the group that replaced its
    // tool-call part, so its answer and outcome are not lost to the conversion.
    const group = findSubagentPart(parts, event.id);
    if (group !== undefined) {
      replaceSubagentPart(parts, withEventHistoryUpdate({
        ...group,
        status,
        ...(event.content === undefined ? {} : { result: event.content }),
        ...(executionMs === undefined ? {} : { executionMs }),
      }, historyUpdate));
      return;
    }
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name ?? existingToolName(parts, event.id) ?? "Tool",
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      ...(event.content === undefined ? {} : { result: event.content }),
      // `result` is the model-facing text and cannot answer "what did this tool
      // actually decide". The AskUser card needs `interactionId`/`answered` to
      // re-render an answered question after a reload, so keep the structured
      // payload beside the prose rather than reparsing the sentence.
      ...(event.structuredContent === undefined ? {} : { structuredResult: event.structuredContent }),
      ...(executionMs === undefined ? {} : { executionMs }),
      status,
    }, historyUpdate);
    return;
  }
  if (event.type === "runtime_telemetry" && event.kind === "context_compaction") {
    upsertContextCompaction(parts, event);
    return;
  }
  parts.push({ type: "telemetry", event: event.type, data: event });
}

type MonitorActivityPart = Extract<WebMessagePart, { readonly type: "monitor-activity" }>;

function upsertMonitorActivity(
  parts: WebMessagePart[],
  projection: MonitorProjection,
  deliveryKey: string,
): boolean {
  const index = parts.findIndex((part) => part.type === "monitor-activity");
  const previous = index < 0 ? undefined : parts[index] as MonitorActivityPart;
  const monitors = previous?.monitors ?? [];
  const monitorIndex = monitors.findIndex((entry) => entry.projection.monitorId === projection.monitorId);
  const prior = monitorIndex < 0 ? undefined : monitors[monitorIndex];
  // The stream receipt and the durable delivery settlement can race. Once an
  // exact key is present, settlement is bookkeeping only: replacing its newer
  // projection with the reservation's older snapshot would make the activity
  // row move backwards and emit a duplicate invalidation.
  if (prior?.deliveryKeys.includes(deliveryKey) === true) return false;
  const deliveryKeys = prior === undefined ? [deliveryKey] : [...prior.deliveryKeys, deliveryKey];
  const entry = { projection, deliveryKeys };
  const nextMonitors = monitorIndex < 0
    ? [...monitors, entry]
    : monitors.map((value, at) => at === monitorIndex ? entry : value);
  const next: MonitorActivityPart = { type: "monitor-activity", monitors: nextMonitors };
  if (index < 0) {
    parts.push(next);
    return true;
  }
  if (isDeepStrictEqual(previous, next)) return false;
  parts[index] = next;
  return true;
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
type SessionToolHistoryMetadata = NonNullable<WebToolCall["history"]>;

interface EventHistoryUpdate {
  readonly value: SessionToolHistoryMetadata | undefined;
}

/**
 * A duration is only worth persisting when it is a finite, non-negative number.
 * The stream wire validates `type` and nothing else, and providers derive this
 * from raw wall-clock subtraction, so a backward clock step or a provider that
 * reports `NaN` would otherwise be written verbatim and then rejected by the
 * read-back validator — permanently refusing to open the store.
 */
function canonicalExecutionMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function canonicalEventHistoryUpdate(value: unknown): EventHistoryUpdate | undefined {
  return value === undefined
    ? undefined
    : { value: canonicalSessionToolHistoryMetadata(value) };
}

function withEventHistoryUpdate<T extends WebToolCall | SubagentPart>(
  value: T,
  update: EventHistoryUpdate | undefined,
): T {
  return update === undefined ? value : withSessionToolHistory(value, update.value);
}

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
  historyUpdate?: EventHistoryUpdate,
): void {
  const index = group.calls.findIndex((call) => call.toolCallId === next.toolCallId);
  const merged = index < 0
    ? next
    : { ...group.calls[index]!, ...next };
  const updated = historyUpdate === undefined
    ? merged
    : withSessionToolHistory(merged, historyUpdate.value);
  const calls = index < 0
    ? [...group.calls, updated]
    : group.calls.map((call, at) => at === index ? updated : call);
  replaceSubagentPart(parts, { ...group, calls });
}

function upsertToolCall(
  parts: WebMessagePart[],
  next: Extract<WebMessagePart, { type: "tool-call" }>,
  historyUpdate?: EventHistoryUpdate,
): void {
  const index = parts.findIndex((part) => part.type === "tool-call" && part.toolCallId === next.toolCallId);
  const previous = index < 0 ? undefined : parts[index];
  const merged = previous?.type === "tool-call" ? { ...previous, ...next } : next;
  const updated = historyUpdate === undefined
    ? merged
    : withSessionToolHistory(merged, historyUpdate.value);
  if (index < 0) {
    parts.push(updated);
    return;
  }
  if (previous?.type === "tool-call") parts[index] = updated;
}

/**
 * Whether a stored part marks a semantic boundary between streamed text runs.
 * Most telemetry remains invisible; compaction and the content-free assistant
 * message marker intentionally keep adjacent provider responses separate.
 */
function separatesStreamedText(part: WebMessagePart): boolean {
  // A Monitor acknowledgement may arrive while the provider is still flushing
  // the preceding message's final text delta. Its compact activity row must not
  // split that word; the explicit message boundary below separates responses.
  if (part.type === "monitor-activity") return false;
  if (part.type !== "telemetry") return true;
  const event = part.data;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  return record.type === "runtime_telemetry"
    && (record.kind === "context_compaction"
      || record.kind === "context_usage"
      || record.kind === "assistant_message_boundary");
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
    if (!separatesStreamedText(part)) continue;
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

/**
 * The ops that turn `prev` into `next`.
 *
 * Parts are compared by REFERENCE, which is sound only because every helper
 * above replaces the slot it touches with a new object instead of editing the
 * one already there — `store.test.ts` freezes a write path's previous parts to
 * keep it that way. A truncate leads, so no later op can name an index the
 * shortened array no longer has; the rest ascend, so a replay that walks them
 * in order only ever extends the array by one slot at a time.
 */
export function diffParts(
  prev: readonly WebMessagePart[],
  next: readonly WebMessagePart[],
): WebMessageDeltaOp[] {
  const ops: WebMessageDeltaOp[] = [];
  if (next.length < prev.length) ops.push({ op: "truncate", length: next.length });
  for (let index = 0; index < next.length; index += 1) {
    const after = next[index];
    if (after === undefined) continue;
    const before = prev[index];
    if (before === after) continue;
    // A streaming answer grows by its tail, which is the whole point of the
    // exercise: sending the delta rather than the message again is what takes
    // a long answer's per-frame cost off the wire.
    if (before !== undefined
      && (after.type === "text" || after.type === "reasoning")
      && before.type === after.type
      && after.text.startsWith(before.text)) {
      const delta = after.text.slice(before.text.length);
      if (delta.length > 0) ops.push({ op: "append", index, delta });
      continue;
    }
    ops.push({ op: "set", index, part: after });
  }
  return ops;
}

/**
 * Replay `ops` onto `parts`, the exact inverse of {@link diffParts}.
 *
 * This is the shared definition of what an op MEANS, so the console can apply a
 * delta without inventing its own reading of one. Anything the ops cannot mean
 * against these parts throws rather than producing a plausible transcript: a
 * client that lands here has missed a write and must re-read the message.
 *
 * The throws are plain `RangeError`/`TypeError` rather than `WebConsoleError`:
 * this is a pure function that runs on both sides of the wire, so it has no
 * request to answer and no HTTP status to pick. Its caller re-reads the message
 * rather than mapping a code.
 */
export function applyDeltaOps(
  parts: readonly WebMessagePart[],
  ops: readonly WebMessageDeltaOp[],
): WebMessagePart[] {
  let next = [...parts];
  for (const op of ops) {
    if (op.op === "truncate") {
      if (!Number.isInteger(op.length) || op.length < 0 || op.length > next.length) {
        throw new RangeError(
          `A message delta truncates to ${String(op.length)} parts, which is out of range for ${String(next.length)}.`,
        );
      }
      next = next.slice(0, op.length);
      continue;
    }
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > next.length) {
      throw new RangeError(
        `A message delta names part ${String(op.index)}, which is out of range for ${String(next.length)}.`,
      );
    }
    if (op.op === "set") {
      next[op.index] = op.part;
      continue;
    }
    const target = next[op.index];
    if (target === undefined || (target.type !== "text" && target.type !== "reasoning")) {
      throw new TypeError(
        `A message delta appends to part ${String(op.index)}, which cannot be appended to.`,
      );
    }
    next[op.index] = { type: target.type, text: `${target.text}${op.delta}` };
  }
  return next;
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

const REPLY_FAILURE_CODES = new Set([
  "app_capability_mismatch",
  "app_connection_closed",
  "app_resource_invalid",
  "artifact_expired",
  "artifact_integrity_failed",
  "artifact_missing",
  "artifact_publish_failed",
  "artifact_too_large",
  "reply_part_too_large",
  "unsupported_destination",
]);

const REPLY_PARTS_TRUNCATED_ID = "web-reply-parts-truncated";
const INVALID_REPLY_PART_ID = "invalid-rich-part";
type DurableWebReplyPart = Extract<WebMessagePart, { type: "attachment" | "mcp_app" | "failure" }>;

/**
 * The SQLite boundary does not trust the operator wire parser. A truncated
 * reply reserves one of the shared outcome slots for a durable diagnostic so
 * every omitted suffix is visible without allowing this completion to take a
 * message beyond the producer/wire limit. Legacy over-cap state is repaired by
 * retaining a deterministic prefix and reserving the final slot for the same
 * bounded diagnostic.
 */
function nextSyntheticReplyPartId(base: string, ids: Set<string>): string {
  let failureId = base;
  for (let suffix = 2; ids.has(failureId); suffix += 1) {
    failureId = `${base}-${suffix}`;
  }
  ids.add(failureId);
  return failureId;
}

function replyPartIds(values: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const id = record(value)?.id;
    if (validRichId(id)) ids.add(id);
  }
  return ids;
}

function replyPartIdCounts(values: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = record(value)?.id;
    if (validRichId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function isDurableWebReplyPart(part: WebMessagePart): part is DurableWebReplyPart {
  return part.type === "attachment" || part.type === "mcp_app" || part.type === "failure";
}

function boundedWebReplyParts(
  input: unknown,
  existingParts: readonly WebMessagePart[],
): WebMessagePart[] {
  const existingReplyParts = existingParts.filter(isDurableWebReplyPart);
  const existingReplyPartCount = existingReplyParts.length;
  const existingIds = replyPartIds(existingReplyParts);
  const ids = new Set(existingIds);
  const claimedIds = new Set(existingIds);
  const availableSlots = Math.max(0, MAX_AGENT_REPLY_PARTS - existingReplyPartCount);
  const inputParts = Array.isArray(input) ? input : undefined;
  const needsDiagnostic = inputParts === undefined
    || existingReplyPartCount > MAX_AGENT_REPLY_PARTS
    || inputParts.length > availableSlots;
  const retainedExistingCount = needsDiagnostic
    ? Math.min(existingReplyPartCount, MAX_AGENT_REPLY_PARTS - 1)
    : existingReplyPartCount;
  let seenExistingReplyParts = 0;
  const retainedExistingParts = existingParts.filter((part) => {
    if (!isDurableWebReplyPart(part)) return true;
    seenExistingReplyParts += 1;
    return seenExistingReplyParts <= retainedExistingCount;
  });

  if (inputParts === undefined) {
    const invalidRecord = record(input);
    const legacyValues = invalidRecord === undefined ? [input] : [input, ...Object.values(invalidRecord)];
    for (const id of replyPartIds(legacyValues)) ids.add(id);
    const omittedExistingCount = existingReplyPartCount - retainedExistingCount;
    return [...retainedExistingParts, {
      type: "failure",
      id: nextSyntheticReplyPartId(REPLY_PARTS_TRUNCATED_ID, ids),
      code: "unsupported_destination",
      message: `The web console retained ${retainedExistingCount} existing rich reply parts, omitted ${omittedExistingCount} existing parts, and rejected an invalid incoming rich reply collection; ${availableSlots} of ${MAX_AGENT_REPLY_PARTS} outcome slots were available before this bounded diagnostic.`,
    }];
  }
  // Object.values visits only populated entries, so a legacy sparse array with
  // a very large length cannot make this collision scan walk every empty slot.
  const populated = Object.values(inputParts);
  const inputIdCounts = replyPartIdCounts(populated);
  for (const id of inputIdCounts.keys()) ids.add(id);
  const retainedCount = Math.min(
    inputParts.length,
    Math.max(0, MAX_AGENT_REPLY_PARTS - retainedExistingCount - (needsDiagnostic ? 1 : 0)),
  );
  const retained = Array.from(
    { length: retainedCount },
    (_, index): DurableWebReplyPart => {
      const converted = toWebReplyPart(inputParts[index], () => {
        const inputId = record(inputParts[index])?.id;
        return validRichId(inputId)
          && !existingIds.has(inputId)
          && inputIdCounts.get(inputId) === 1
          ? inputId
          : nextSyntheticReplyPartId(INVALID_REPLY_PART_ID, ids);
      });
      if (!claimedIds.has(converted.id)) {
        claimedIds.add(converted.id);
        return converted;
      }
      const collision: DurableWebReplyPart = {
        type: "failure",
        id: nextSyntheticReplyPartId(INVALID_REPLY_PART_ID, ids),
        code: "unsupported_destination",
        message: "A rich reply part reused an existing identifier and could not be displayed.",
      };
      claimedIds.add(collision.id);
      return collision;
    },
  );
  const merged = [...retainedExistingParts, ...retained];
  if (!needsDiagnostic) return merged;

  const omittedExistingCount = existingReplyPartCount - retainedExistingCount;
  const omittedIncomingCount = inputParts.length - retainedCount;
  merged.push({
    type: "failure",
    id: nextSyntheticReplyPartId(REPLY_PARTS_TRUNCATED_ID, ids),
    code: "reply_part_too_large",
    message: `The web console retained ${retainedExistingCount} existing and ${retainedCount} incoming rich reply parts, omitted ${omittedExistingCount} existing and ${omittedIncomingCount} incoming parts, and used one diagnostic slot; before reserving it, ${availableSlots} of ${MAX_AGENT_REPLY_PARTS} outcome slots were available to incoming parts.`,
  });
  return merged;
}

function isMcpAppProtocolVersion(value: unknown): value is "2026-01-26" | "2025-11-21" {
  return value === "2026-01-26" || value === "2025-11-21";
}

function toWebReplyPart(input: unknown, syntheticId: () => string): DurableWebReplyPart {
  const part = record(input);
  const failure = (
    code: "artifact_publish_failed" | "artifact_too_large" | "app_resource_invalid",
  ): DurableWebReplyPart => ({
    type: "failure",
    id: syntheticId(),
    code,
    message: code === "artifact_too_large"
      ? "The generated file exceeded the web console attachment limit."
      : code === "app_resource_invalid"
        ? "The MCP App metadata was invalid and could not be displayed."
        : "The generated file metadata was invalid and could not be displayed.",
  });
  if (part?.type === "attachment") {
    const reference = record(part.reference);
    if (
      !validRichId(part.id)
      || reference?.scheme !== "mono-agent-artifact"
      || !validRichId(reference.id)
      || typeof part.name !== "string"
      || part.name.length === 0
      || part.name.length > 255
      || /[\u0000-\u001f\u007f/\\]/u.test(part.name)
      || typeof part.mediaType !== "string"
      || !validReplyMimeType(part.mediaType)
      || !Number.isSafeInteger(part.sizeBytes)
      || Number(part.sizeBytes) < 0
      || typeof part.integrityId !== "string"
      || !/^sha256:[0-9a-f]{64}$/u.test(part.integrityId)
      || !validOptionalDate(part.expiresAt)
    ) return failure("artifact_publish_failed");
    if (Number(part.sizeBytes) > 20 * 1024 * 1024) return failure("artifact_too_large");
    return {
      type: "attachment",
      id: part.id,
      artifactId: reference.id,
      name: part.name,
      mediaType: part.mediaType,
      sizeBytes: part.sizeBytes as number,
      integrityId: part.integrityId,
      ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt as string }),
    };
  }
  if (part?.type === "mcp_app") {
    if (
      !validRichId(part.id)
      || part.invocationId !== part.id
      || !validRichId(part.invocationId)
      || !validRichId(part.connectionId)
      || typeof part.serverName !== "string"
      || typeof part.toolName !== "string"
      || typeof part.resourceUri !== "string"
      || !part.resourceUri.startsWith("ui://")
      || part.mediaType !== "text/html;profile=mcp-app"
      || !isMcpAppProtocolVersion(part.protocolVersion)
      || !validOptionalBoundedText(part.title, 240)
      || !validOptionalBoundedText(part.description, 1_000)
      || !validOptionalDate(part.expiresAt)
    ) return failure("app_resource_invalid");
    return {
      type: "mcp_app",
      id: part.id,
      invocationId: part.invocationId as string,
      connectionId: part.connectionId as string,
      serverName: (part.serverName as string).slice(0, 256),
      toolName: (part.toolName as string).slice(0, 256),
      resourceUri: (part.resourceUri as string).slice(0, 4_096),
      mediaType: "text/html;profile=mcp-app",
      protocolVersion: part.protocolVersion,
      ...(part.title === undefined ? {} : { title: part.title as string }),
      ...(part.description === undefined ? {} : { description: part.description as string }),
      ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt as string }),
    };
  }
  if (
    part?.type === "failure"
    && validRichId(part.id)
    && typeof part.code === "string"
    && REPLY_FAILURE_CODES.has(part.code)
    && typeof part.message === "string"
    && Buffer.byteLength(part.message, "utf8") <= 1_024
    && (part.relatedPartId === undefined || validRichId(part.relatedPartId))
  ) {
    return {
      type: "failure",
      id: part.id,
      code: part.code as Extract<WebMessagePart, { type: "failure" }>["code"],
      message: part.message,
      ...(part.relatedPartId === undefined ? {} : { relatedPartId: part.relatedPartId }),
    };
  }
  return {
    type: "failure",
    id: syntheticId(),
    code: "unsupported_destination",
    message: "A rich reply part used an unsupported format and could not be displayed.",
  };
}

/** Persist only the inert durable projection; browser capabilities are DTO-only. */
function durableMessagePart(part: WebMessagePart): WebMessagePart {
  if (part.type === "attachment") {
    return {
      type: "attachment",
      id: part.id,
      artifactId: part.artifactId,
      name: part.name,
      mediaType: part.mediaType,
      sizeBytes: part.sizeBytes,
      integrityId: part.integrityId,
      ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt }),
    };
  }
  if (part.type === "mcp_app") {
    return {
      type: "mcp_app",
      id: part.id,
      invocationId: part.invocationId,
      connectionId: part.connectionId,
      serverName: part.serverName,
      toolName: part.toolName,
      resourceUri: part.resourceUri,
      mediaType: part.mediaType,
      protocolVersion: part.protocolVersion,
      ...(part.title === undefined ? {} : { title: part.title }),
      ...(part.description === undefined ? {} : { description: part.description }),
      ...(part.expiresAt === undefined ? {} : { expiresAt: part.expiresAt }),
    };
  }
  if (part.type === "failure") {
    return {
      type: "failure",
      id: part.id,
      code: part.code,
      message: part.message,
      ...(part.relatedPartId === undefined ? {} : { relatedPartId: part.relatedPartId }),
    };
  }
  return part;
}

function serializeParts(parts: readonly WebMessagePart[]): string {
  return JSON.stringify(parts.map(durableMessagePart));
}

function validRichId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validReplyMimeType(value: string): boolean {
  return value.length <= 256
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9=._+-]+)*$/iu.test(value);
}

function validOptionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function validOptionalBoundedText(value: unknown, maxBytes: number): boolean {
  return value === undefined || (typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes);
}

function parseParts(value: string): WebMessagePart[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts are not valid JSON.", 500);
  }
  const parts = Array.isArray(parsed)
    ? parsed.map(canonicalizePersistedPartHistory)
    : parsed;
  if (!Array.isArray(parts) || !parts.every(isWebMessagePart)) {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts have an invalid shape.", 500);
  }
  if (parts.filter((part) => part.type === "monitor-activity").length > 1) {
    throw new WebConsoleError("storage_corrupt", "Persisted Monitor activity is duplicated.", 500);
  }
  quoteFromParts(parts);
  return parts;
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
    // Nullish is accepted, not just absent: `JSON.stringify` writes NaN and
    // Infinity as `null`, so a database written before durations were
    // canonicalized can hold one. `validateStorage()` re-parses every message at
    // open, so being strict here would refuse the whole store over a
    // display-only value the renderers already drop.
    && (call.executionMs == null || typeof call.executionMs === "number")
    && (call.history === undefined || isSessionToolHistoryMetadata(call.history));
}

const SESSION_TOOL_HISTORY_TERMINAL_STATES = new Set<
  NonNullable<SessionToolHistoryMetadata["terminalState"]>
>([
  "success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted",
]);

/**
 * Canonicalize the open wire record before it reaches SQLite or rendering.
 * Unknown fields are deliberately omitted so a future/stale producer cannot
 * turn this bounded display record into an unbounded persistence side channel.
 */
function canonicalSessionToolHistoryMetadata(value: unknown): SessionToolHistoryMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const history = value as Record<string, unknown>;
  const valid = (history.persistence === "persisted" || history.persistence === "failed")
    && history.untrusted === true
    && (history.recordId === undefined || boundedHistoryString(history.recordId, 4_096))
    && (history.sequence === undefined || positiveSafeInteger(history.sequence))
    && (history.terminalState === undefined || (
      typeof history.terminalState === "string"
      && SESSION_TOOL_HISTORY_TERMINAL_STATES.has(
        history.terminalState as NonNullable<SessionToolHistoryMetadata["terminalState"]>,
      )
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
  if (!valid) return undefined;

  return {
    persistence: history.persistence as SessionToolHistoryMetadata["persistence"],
    untrusted: true,
    ...(history.recordId === undefined ? {} : { recordId: history.recordId as string }),
    ...(history.sequence === undefined ? {} : { sequence: history.sequence as number }),
    ...(history.terminalState === undefined
      ? {}
      : { terminalState: history.terminalState as NonNullable<SessionToolHistoryMetadata["terminalState"]> }),
    ...(history.truncated === undefined ? {} : { truncated: history.truncated as boolean }),
    ...(history.originalBytes === undefined ? {} : { originalBytes: history.originalBytes as number }),
    ...(history.retainedBytes === undefined ? {} : { retainedBytes: history.retainedBytes as number }),
    ...(history.errorCode === undefined ? {} : { errorCode: history.errorCode as string }),
    ...(history.artifactReferences === undefined
      ? {}
      : {
          artifactReferences: (history.artifactReferences as unknown[]).map((entry) => {
            const artifact = entry as Record<string, unknown>;
            return { id: artifact.id as string, available: artifact.available as boolean };
          }),
        }),
  };
}

function isSessionToolHistoryMetadata(value: unknown): boolean {
  return canonicalSessionToolHistoryMetadata(value) !== undefined;
}

/** An explicitly supplied invalid frame replaces, rather than retaining, stale metadata. */
function withSessionToolHistory<T extends WebToolCall | SubagentPart>(
  value: T,
  history: SessionToolHistoryMetadata | undefined,
): T {
  const { history: _staleHistory, ...withoutHistory } = value;
  return {
    ...withoutHistory,
    ...(history === undefined ? {} : { history }),
  } as T;
}

/**
 * Older builds could persist an unchecked history record. Salvage the otherwise
 * valid message by dropping only that optional record; unrelated corruption
 * remains a storage error.
 */
function canonicalizePersistedPartHistory(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const part = value as Record<string, unknown>;
  if (part.type === "tool-call") return canonicalizePersistedHistoryRecord(part);
  if (part.type !== "subagent") return value;
  const canonicalPart = canonicalizePersistedObjectHistory(part);
  return {
    ...canonicalPart,
    ...(Array.isArray(part.calls)
      ? { calls: part.calls.map((call) => canonicalizePersistedHistoryRecord(call)) }
      : {}),
  };
}

function canonicalizePersistedHistoryRecord(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return canonicalizePersistedObjectHistory(value as Record<string, unknown>);
}

function canonicalizePersistedObjectHistory(record: Record<string, unknown>): Record<string, unknown> {
  const { history: rawHistory, ...withoutHistory } = record;
  const history = canonicalSessionToolHistoryMetadata(rawHistory);
  return {
    ...withoutHistory,
    ...(history === undefined ? {} : { history }),
  };
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

const DURABLE_REPLY_ATTACHMENT_KEYS = new Set([
  "type", "id", "artifactId", "name", "mediaType", "sizeBytes", "integrityId", "expiresAt",
]);
const DURABLE_MCP_APP_KEYS = new Set([
  "type", "id", "invocationId", "connectionId", "serverName", "toolName", "resourceUri",
  "mediaType", "protocolVersion", "title", "description", "expiresAt",
]);
const DURABLE_REPLY_FAILURE_KEYS = new Set([
  "type", "id", "code", "message", "relatedPartId",
]);

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
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
      && (part.executionMs == null || typeof part.executionMs === "number")
      && (part.costUsd === undefined || typeof part.costUsd === "number")
      && (part.history === undefined || isSessionToolHistoryMetadata(part.history))
      && isWebToolCallStatus(part.status)
      && Array.isArray(part.calls)
      && part.calls.every(isWebToolCall);
  }
  if (part.type === "process-job") {
    if (part.responseText !== undefined && (typeof part.responseText !== "string" || part.responseText.length > 8_000)) {
      return false;
    }
    try {
      parseProcessJobProjection(part.job);
      return Object.keys(part).every((key) => key === "type" || key === "job" || key === "responseText")
        && Object.keys(part).length === (part.responseText === undefined ? 2 : 3);
    } catch {
      return false;
    }
  }
  if (part.type === "monitor-activity") {
    if (!hasOnlyKeys(part, new Set(["type", "monitors"]))
      || !Array.isArray(part.monitors)
      || part.monitors.length === 0
      || part.monitors.length > AGENT_LIVE_INPUT_MAX_MESSAGES) {
      return false;
    }
    const monitorIds = new Set<string>();
    let deliveryCount = 0;
    for (const raw of part.monitors) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
      const entry = raw as Record<string, unknown>;
      if (!hasOnlyKeys(entry, new Set(["projection", "deliveryKeys"])) || !Array.isArray(entry.deliveryKeys)) {
        return false;
      }
      let projection: MonitorProjection;
      try {
        projection = parseMonitorProjection(entry.projection);
      } catch {
        return false;
      }
      if (monitorIds.has(projection.monitorId)
        || entry.deliveryKeys.length === 0
        || entry.deliveryKeys.length > AGENT_LIVE_INPUT_MAX_MESSAGES) {
        return false;
      }
      monitorIds.add(projection.monitorId);
      const keys = new Set<string>();
      for (const key of entry.deliveryKeys) {
        if (typeof key !== "string"
          || key.length === 0
          || key.length > 1_024
          || /[\u0000-\u001f\u007f]/u.test(key)
          || keys.has(key)) {
          return false;
        }
        keys.add(key);
      }
      deliveryCount += entry.deliveryKeys.length;
    }
    return deliveryCount <= AGENT_LIVE_INPUT_MAX_MESSAGES;
  }
  if (part.type === "telemetry") return typeof part.event === "string";
  if (part.type === "error") return typeof part.message === "string" && (part.code === undefined || typeof part.code === "string");
  if (part.type === "attachment") {
    return hasOnlyKeys(part, DURABLE_REPLY_ATTACHMENT_KEYS)
      && validRichId(part.id)
      && validRichId(part.artifactId)
      && typeof part.name === "string"
      && part.name.length > 0
      && !/[\u0000-\u001f\u007f/\\]/u.test(part.name)
      && typeof part.mediaType === "string"
      && validReplyMimeType(part.mediaType)
      && Number.isSafeInteger(part.sizeBytes)
      && Number(part.sizeBytes) >= 0
      && Number(part.sizeBytes) <= 20 * 1024 * 1024
      && typeof part.integrityId === "string"
      && /^sha256:[0-9a-f]{64}$/u.test(part.integrityId)
      && validOptionalDate(part.expiresAt);
  }
  if (part.type === "mcp_app") {
    return hasOnlyKeys(part, DURABLE_MCP_APP_KEYS)
      && validRichId(part.id)
      && part.invocationId === part.id
      && validRichId(part.connectionId)
      && typeof part.serverName === "string"
      && typeof part.toolName === "string"
      && typeof part.resourceUri === "string"
      && part.resourceUri.startsWith("ui://")
      && part.mediaType === "text/html;profile=mcp-app"
      && isMcpAppProtocolVersion(part.protocolVersion)
      && validOptionalBoundedText(part.title, 240)
      && validOptionalBoundedText(part.description, 1_000)
      && validOptionalDate(part.expiresAt);
  }
  if (part.type === "failure") {
    return hasOnlyKeys(part, DURABLE_REPLY_FAILURE_KEYS)
      && validRichId(part.id)
      && typeof part.code === "string"
      && REPLY_FAILURE_CODES.has(part.code)
      && typeof part.message === "string"
      && Buffer.byteLength(part.message, "utf8") <= 1_024
      && (part.relatedPartId === undefined || validRichId(part.relatedPartId));
  }
  return false;
}

function processJobPart(
  job: ProcessJobProjection,
  responseText: string | undefined,
): Extract<WebMessagePart, { readonly type: "process-job" }> {
  return {
    type: "process-job",
    job,
    ...(responseText === undefined ? {} : { responseText }),
  };
}

function processJobCardParts(
  job: ProcessJobProjection,
  responseText: string | undefined,
  replyParts: readonly AgentReplyPart[] | undefined,
): WebMessagePart[] {
  const card = processJobPart(job, responseText);
  return replyParts === undefined ? [card] : boundedWebReplyParts(replyParts, [card]);
}

function isTerminalJobState(state: ProcessJobState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "timed_out"
    || state === "cancelled"
    || state === "spawn_failed"
    || state === "queue_expired"
    || state === "interrupted";
}

function assertProcessJobCardTransition(
  previous: ProcessJobProjection,
  next: ProcessJobProjection,
): void {
  if (previous.tool !== next.tool
    || previous.summary !== next.summary
    || previous.origin.conversationId !== next.origin.conversationId
    || previous.origin.channel !== next.origin.channel
    || previous.origin.runId !== next.origin.runId
    || previous.origin.historyBoundary !== next.origin.historyBoundary
    || previous.origin.bucket !== next.origin.bucket
    || previous.timestamps.admittedAt !== next.timestamps.admittedAt
    || previous.timestamps.queueDeadlineAt !== next.timestamps.queueDeadlineAt
    || JSON.stringify(previous.limits) !== JSON.stringify(next.limits)
    || previous.wake.deliveryKey !== next.wake.deliveryKey) {
    throw new WebConsoleError(
      "notification_idempotency_conflict",
      "The process-job projection changed immutable identity fields.",
      409,
    );
  }
  if (!allowedProcessJobTransition(previous.state, next.state)) {
    throw new WebConsoleError(
      "notification_idempotency_conflict",
      `Process-job card lifecycle cannot transition from ${previous.state} to ${next.state}.`,
      409,
    );
  }
  if ((previous.timestamps.startedAt !== null && previous.timestamps.startedAt !== next.timestamps.startedAt)
    || (previous.timestamps.runtimeDeadlineAt !== null
      && previous.timestamps.runtimeDeadlineAt !== next.timestamps.runtimeDeadlineAt)
    || (previous.timestamps.completedAt !== null && previous.timestamps.completedAt !== next.timestamps.completedAt)) {
    throw new WebConsoleError(
      "notification_idempotency_conflict",
      "Process-job card timing changed after becoming durable.",
      409,
    );
  }
  if (next.wake.attempts < previous.wake.attempts
    || (previous.wake.state !== "pending" && previous.wake.state !== next.wake.state)) {
    throw new WebConsoleError(
      "notification_idempotency_conflict",
      "Process-job wake settlement cannot move backwards.",
      409,
    );
  }
}

function allowedProcessJobTransition(previous: ProcessJobState, next: ProcessJobState): boolean {
  if (previous === next) return true;
  if (previous === "queued") {
    // Retained surfaces are sampled; a fast launch/completion may skip one or
    // both internal nonterminal states between card updates.
    return next === "starting" || next === "running" || isTerminalJobState(next);
  }
  if (previous === "starting") {
    return next === "running" || (isTerminalJobState(next) && next !== "queue_expired");
  }
  if (previous === "running") {
    return next === "succeeded" || next === "failed" || next === "timed_out"
      || next === "cancelled" || next === "spawn_failed" || next === "interrupted";
  }
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

/**
 * Malformed stored JSON must degrade to "this agent advertises no providers",
 * never throw: `mapAgent` runs on every bootstrap and discovery read, so a
 * throw here would take the whole console down over one bad row.
 */
function parseProviderSummary(value: string | null): WebAgentSummary["providers"] | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const result: WebAgentProvider[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    result.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : entry.id,
      ...(entry.configured === true ? { configured: true } : {}),
    });
  }
  return result.length === 0 ? undefined : result;
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
