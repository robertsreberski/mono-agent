import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import type { HistoryMessage } from "@mono-agent/context";

export interface SqliteHistoryStoreOptions {
  /** SQLite file path, or ":memory:" for an ephemeral store. */
  readonly path: string;
  /** Max messages returned by {@link SqliteConversationHistoryStore.load}; 0 = unbounded (default). */
  readonly maxMessages?: number;
  /** Injectable clock for default timestamps; defaults to the system clock. */
  readonly clock?: () => Date;
}

/** One row of the per-conversation summary used by `mono-agent conversations list`. */
export interface ConversationSummary {
  readonly conversationId: string;
  readonly messageCount: number;
  readonly lastTimestamp: string | undefined;
  readonly lastRole: string | undefined;
  readonly lastSnippet: string;
}

interface RawRow {
  readonly role: string;
  readonly content: string;
  readonly name: string | null;
  readonly source: string | null;
  readonly timestamp: string | null;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS conversation_history (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  name TEXT,
  source TEXT,
  timestamp TEXT,
  PRIMARY KEY (conversation_id, seq)
);`;

/**
 * Durable, per-conversation chat history over SQLite. Implements the structural
 * `ConversationHistoryStore` contract (`load`/`append` keyed by `conversationId`)
 * used by the agent harness, so it can be injected in place of the in-memory
 * default. Rows are keyed by the channel-prefixed conversationId, so it is a
 * shared *substrate*, not a cross-channel merge: a harness only ever loads its
 * own conversationIds.
 */
export class SqliteConversationHistoryStore {
  private readonly db: Database;
  private readonly maxMessages: number;
  private readonly clock: () => Date;

  constructor(options: SqliteHistoryStoreOptions) {
    const maxMessages = options.maxMessages ?? 0;
    if (!Number.isInteger(maxMessages) || maxMessages < 0) {
      throw new TypeError("maxMessages must be a non-negative integer.");
    }
    this.maxMessages = maxMessages;
    this.clock = options.clock ?? (() => new Date());
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new BetterSqlite3(options.path);
    // WAL gives concurrent readers + a single writer across processes (the main
    // app store and the send-tool subprocess open the same db); better-sqlite3
    // defaults busy_timeout to 5000ms so a blocked writer retries instead of
    // throwing SQLITE_BUSY.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_TABLE);
  }

  async load(conversationId: string): Promise<readonly HistoryMessage[]> {
    const key = normalizeConversationId(conversationId);
    const rows = (this.maxMessages === 0
      ? this.db
          .prepare(
            "SELECT role, content, name, source, timestamp FROM conversation_history WHERE conversation_id = ? ORDER BY seq ASC",
          )
          .all(key)
      : this.db
          .prepare(
            "SELECT role, content, name, source, timestamp FROM (SELECT role, content, name, source, timestamp, seq FROM conversation_history WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
          )
          .all(key, this.maxMessages)) as RawRow[];
    return rows.map(toHistoryMessage);
  }

  async append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const key = normalizeConversationId(conversationId);
    const insert = this.db.prepare(
      "INSERT INTO conversation_history (conversation_id, seq, role, content, name, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const maxSeq = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM conversation_history WHERE conversation_id = ?",
    );
    const tx = this.db.transaction((items: readonly HistoryMessage[]) => {
      let seq = (maxSeq.get(key) as { maxSeq: number }).maxSeq;
      for (const message of items) {
        seq += 1;
        insert.run(
          key,
          seq,
          message.role,
          message.content,
          message.name ?? null,
          message.source ?? null,
          message.timestamp ?? this.clock().toISOString(),
        );
      }
    });
    tx(messages);
  }

  /** Distinct conversations with message count, last activity, and a short snippet (CLI discovery). */
  listConversations(): readonly ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT h.conversation_id AS conversationId,
                cnt.n AS messageCount,
                h.timestamp AS lastTimestamp,
                h.role AS lastRole,
                h.content AS lastContent
         FROM conversation_history h
         JOIN (SELECT conversation_id, COUNT(*) AS n, MAX(seq) AS maxSeq
               FROM conversation_history GROUP BY conversation_id) cnt
           ON cnt.conversation_id = h.conversation_id AND cnt.maxSeq = h.seq
         ORDER BY h.timestamp DESC`,
      )
      .all() as Array<{
      conversationId: string;
      messageCount: number;
      lastTimestamp: string | null;
      lastRole: string | null;
      lastContent: string;
    }>;
    return rows.map((row) => ({
      conversationId: row.conversationId,
      messageCount: row.messageCount,
      lastTimestamp: row.lastTimestamp ?? undefined,
      lastRole: row.lastRole ?? undefined,
      lastSnippet: snippet(row.lastContent),
    }));
  }

  /** All (or the last `limit`) messages for one conversation, chronological (CLI `show`). */
  showConversation(conversationId: string, limit?: number): readonly HistoryMessage[] {
    const key = normalizeConversationId(conversationId);
    const rows = (limit === undefined
      ? this.db
          .prepare(
            "SELECT role, content, name, source, timestamp FROM conversation_history WHERE conversation_id = ? ORDER BY seq ASC",
          )
          .all(key)
      : this.db
          .prepare(
            "SELECT role, content, name, source, timestamp FROM (SELECT role, content, name, source, timestamp, seq FROM conversation_history WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
          )
          .all(key, limit)) as RawRow[];
    return rows.map(toHistoryMessage);
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteHistoryStore(options: SqliteHistoryStoreOptions): SqliteConversationHistoryStore {
  return new SqliteConversationHistoryStore(options);
}

/**
 * Append a local-date bucket (`#YYYY-MM-DD`) to a conversationId under the
 * "daily" rollover policy, mirroring the harness responder's bucketing so a
 * recorded send lands in the same thread the next live turn reads. Idempotent;
 * a passthrough when rollover is off.
 */
export function bucketConversationId(
  conversationId: string,
  rollover: string | undefined,
  timezone: string | undefined,
  now: () => Date,
): string {
  if (rollover !== "daily") {
    return conversationId;
  }
  const suffix = `#${formatRolloverDay(now(), timezone)}`;
  return conversationId.endsWith(suffix) ? conversationId : `${conversationId}${suffix}`;
}

function formatRolloverDay(date: Date, timezone: string | undefined): string {
  // en-CA renders as YYYY-MM-DD. Fall back to system-local on an invalid tz.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

function toHistoryMessage(row: RawRow): HistoryMessage {
  return {
    role: row.role as HistoryMessage["role"],
    content: row.content,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.timestamp === null ? {} : { timestamp: row.timestamp }),
  };
}

function snippet(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function normalizeConversationId(conversationId: string): string {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
  return conversationId.trim();
}
