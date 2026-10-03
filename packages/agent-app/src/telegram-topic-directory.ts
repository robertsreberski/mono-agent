import type { DatabaseSync } from "node:sqlite";

import type {
  TelegramChatObservation,
  TelegramKnownTopicName,
  TelegramTopicNameRecord,
  TelegramTopicNameSource,
} from "@mono-agent/telegram-adapter";

import { openOwnedState, type OwnedStateHandle } from "./owned-state-sqlite.js";

/**
 * Owner-private observation ledger behind `telegram.projects`.
 *
 * Telegram's Bot API cannot list a forum's topics, so discovery is passive:
 * the adapter reports what each allowlisted message reveals (topic creation,
 * rename, close/reopen, the creation name quoted by the implicit topic-root
 * reply, whether the chat is a forum) and this ledger remembers it across
 * restarts, namespaced by bot id, chat and topic. It is not a project store:
 * the web console owns projects and bindings. The ledger only remembers what
 * was seen and which sightings the console has not acknowledged yet, so they
 * are replayed after the console was unreachable or the agent restarted.
 */

export const TELEGRAM_TOPIC_DIRECTORY_NAME = "telegram-topics-v1";
const TELEGRAM_TOPIC_DIRECTORY_LABEL = "Telegram topic directory";
const SCHEMA_VERSION = 1;
/** Per bot; new topics beyond this are not recorded (and reported as truncated). */
export const TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS = 1_024;
const MAX_CHATS = 256;
/** Refresh last-seen at most this often per chat/topic to keep writes rare. */
const LAST_SEEN_REFRESH_MS = 10 * 60 * 1_000;

/** One remembered forum conversation, ready to report to the web console. */
export interface TelegramDirectoryEntry {
  readonly chatId: string;
  /** Absent for a forum's General (main) conversation. */
  readonly topicId?: number;
  readonly chatTitle?: string;
  readonly topicName?: string;
  readonly state?: "open" | "closed";
  readonly stateAt?: string;
  readonly lastSeenAt: string;
}

/** A batch of unacknowledged entries and the token that acknowledges exactly it. */
export interface TelegramDirectoryPending {
  readonly entries: readonly TelegramDirectoryEntry[];
  /** Pass back to {@link TelegramTopicDirectoryStore.acknowledge} after the console accepted the batch. */
  readonly acknowledgement: readonly { readonly table: "chats" | "topics"; readonly chatId: string; readonly topicId?: number; readonly revision: number }[];
}

export interface TelegramTopicDirectoryStore {
  /** Names to hydrate the adapter's in-memory cache at startup. */
  knownTopicNames(): readonly TelegramKnownTopicName[];
  /** Persist what one allowlisted message revealed. Never throws. Returns true when something changed. */
  observe(observation: TelegramChatObservation): boolean;
  /** True when the chat is known to be a forum. */
  isForum(chatId: string): boolean;
  /** The current entry for a forum conversation; undefined when never seen or not a forum. */
  entry(chatId: string, topicId: number | undefined): TelegramDirectoryEntry | undefined;
  /** Up to `limit` entries the console has not acknowledged at their current revision. */
  pending(limit: number): TelegramDirectoryPending;
  /** Mark exactly the revisions that were sent as acknowledged; later changes stay pending. */
  acknowledge(batch: TelegramDirectoryPending["acknowledgement"]): void;
  /** Replay everything on the next sync (after a restart the console may have been reset). */
  markAllPending(): void;
  /** Let the next sighting of this conversation write through the last-seen throttle. */
  refreshOnNextSighting(chatId: string, topicId: number | undefined): void;
  /** True once the per-bot topic cap refused a new topic. */
  truncated(): boolean;
  close(): void;
}

export interface OpenTelegramTopicDirectoryOptions {
  readonly cwd: string;
  readonly botId: string;
  readonly now?: () => Date;
  readonly logger?: { warn?: (message: string, metadata?: Record<string, unknown>) => void };
}

/** The bot id is the token's public numeric prefix; the secret half is never stored. */
export function telegramBotIdFromToken(botToken: string): string {
  const prefix = botToken.split(":", 1)[0]?.trim() ?? "";
  if (!/^\d{1,20}$/u.test(prefix)) {
    throw new Error("Telegram bot token has no numeric bot id prefix.");
  }
  return prefix;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE chats (
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      title TEXT,
      is_forum INTEGER NOT NULL DEFAULT 0 CHECK (is_forum IN (0, 1)),
      last_seen_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      synced_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, chat_id)
    );
    CREATE TABLE topics (
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      topic_id INTEGER NOT NULL CHECK (topic_id > 0),
      name TEXT,
      name_source TEXT CHECK (name_source IN ('created', 'edited', 'root_reply')),
      name_message_id INTEGER,
      state TEXT CHECK (state IN ('open', 'closed')),
      state_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      synced_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, chat_id, topic_id)
    );
    CREATE TABLE bot_flags (
      bot_id TEXT PRIMARY KEY,
      truncated INTEGER NOT NULL DEFAULT 0
    );
  `);
}

interface ChatRow {
  readonly chat_id: string;
  readonly title: string | null;
  readonly is_forum: number;
  readonly last_seen_at: string;
  readonly revision: number;
}

interface TopicRow {
  readonly chat_id: string;
  readonly topic_id: number;
  readonly name: string | null;
  readonly name_source: TelegramTopicNameSource | null;
  readonly name_message_id: number | null;
  readonly state: "open" | "closed" | null;
  readonly state_at: string | null;
  readonly last_seen_at: string;
  readonly revision: number;
}

/** Open the writer side (exclusive lease). Fails closed on corrupt or insecure state. */
export async function openTelegramTopicDirectory(
  options: OpenTelegramTopicDirectoryOptions,
): Promise<TelegramTopicDirectoryStore> {
  const state: OwnedStateHandle = await openOwnedState({
    cwd: options.cwd,
    name: TELEGRAM_TOPIC_DIRECTORY_NAME,
    label: TELEGRAM_TOPIC_DIRECTORY_LABEL,
    schemaVersion: SCHEMA_VERSION,
    createSchema,
  });
  const now = options.now ?? (() => new Date());
  const { database } = state;
  const botId = options.botId;
  // Last write per key, so an unchanged sighting costs no write.
  const written = new Map<string, { readonly signature: string; readonly atMs: number }>();

  const selectChat = database.prepare("SELECT * FROM chats WHERE bot_id = ? AND chat_id = ?");
  const countChats = database.prepare("SELECT COUNT(*) AS n FROM chats WHERE bot_id = ?");
  const insertChat = database.prepare(`
    INSERT INTO chats (bot_id, chat_id, title, is_forum, last_seen_at) VALUES (?, ?, ?, ?, ?)
  `);
  const updateChat = database.prepare(`
    UPDATE chats SET title = ?, is_forum = ?, last_seen_at = ?, revision = revision + 1 WHERE bot_id = ? AND chat_id = ?
  `);
  // A chat title is part of every topic label, so a title change re-reports them.
  const touchChatTopics = database.prepare("UPDATE topics SET revision = revision + 1 WHERE bot_id = ? AND chat_id = ?");
  const selectTopic = database.prepare("SELECT * FROM topics WHERE bot_id = ? AND chat_id = ? AND topic_id = ?");
  const countTopics = database.prepare("SELECT COUNT(*) AS n FROM topics WHERE bot_id = ?");
  const insertTopic = database.prepare(`
    INSERT INTO topics (bot_id, chat_id, topic_id, name, name_source, name_message_id, state, state_at, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTopic = database.prepare(`
    UPDATE topics SET name = ?, name_source = ?, name_message_id = ?, state = ?, state_at = ?, last_seen_at = ?, revision = revision + 1
    WHERE bot_id = ? AND chat_id = ? AND topic_id = ?
  `);
  const markTruncated = database.prepare(`
    INSERT INTO bot_flags (bot_id, truncated) VALUES (?, 1)
    ON CONFLICT (bot_id) DO UPDATE SET truncated = 1
  `);

  function shouldWrite(key: string, signature: string, atMs: number): boolean {
    const previous = written.get(key);
    return previous === undefined
      || previous.signature !== signature
      || atMs - previous.atMs >= LAST_SEEN_REFRESH_MS;
  }

  function observeUnsafe(observation: TelegramChatObservation): boolean {
    const chatId = String(observation.chatId);
    const at = now();
    const atIso = at.toISOString();
    const atMs = at.getTime();
    let changed = false;
    const chatKey = `c:${chatId}`;
    const chatSignature = `${observation.chatTitle ?? ""}|${observation.isForum === true ? "forum" : ""}`;
    if (shouldWrite(chatKey, chatSignature, atMs)) {
      state.transaction(() => {
        const row = selectChat.get(botId, chatId) as ChatRow | undefined;
        if (row === undefined) {
          if ((countChats.get(botId) as { n: number }).n >= MAX_CHATS) return;
          insertChat.run(botId, chatId, observation.chatTitle ?? null, observation.isForum === true ? 1 : 0, atIso);
          changed = true;
          return;
        }
        const title = observation.chatTitle ?? row.title;
        // Forum-ness is sticky: an update without the flag is not evidence it was removed.
        const isForum = observation.isForum === true || row.is_forum === 1 ? 1 : 0;
        updateChat.run(title, isForum, atIso, botId, chatId);
        if (title !== row.title) touchChatTopics.run(botId, chatId);
        changed = true;
      });
      written.set(chatKey, { signature: chatSignature, atMs });
    }
    const topic = observation.topic;
    if (topic === undefined) return changed;
    const topicKey = `t:${chatId}:${String(topic.messageThreadId)}`;
    const topicSignature = `${topic.nameRecord?.source ?? ""}|${topic.nameRecord?.name ?? ""}|${topic.state ?? ""}`;
    if (!shouldWrite(topicKey, topicSignature, atMs)) return changed;
    state.transaction(() => {
      const row = selectTopic.get(botId, chatId, topic.messageThreadId) as TopicRow | undefined;
      if (row === undefined) {
        if ((countTopics.get(botId) as { n: number }).n >= TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS) {
          markTruncated.run(botId);
          return;
        }
        insertTopic.run(
          botId, chatId, topic.messageThreadId,
          topic.nameRecord?.name ?? null, topic.nameRecord?.source ?? null, topic.nameRecord?.messageId ?? null,
          topic.state ?? null, topic.state === undefined ? null : atIso, atIso, atIso,
        );
        changed = true;
        return;
      }
      const existing = nameRecordOf(row);
      const merged = topic.nameRecord === undefined ? existing : mergeName(existing, topic.nameRecord);
      updateTopic.run(
        merged?.name ?? null, merged?.source ?? null, merged?.messageId ?? null,
        topic.state ?? row.state, topic.state === undefined ? row.state_at : atIso, atIso,
        botId, chatId, topic.messageThreadId,
      );
      changed = true;
    });
    written.set(topicKey, { signature: topicSignature, atMs });
    return changed;
  }

  function entryOf(chat: ChatRow | undefined, topic: TopicRow | undefined, chatId: string): TelegramDirectoryEntry {
    return {
      chatId,
      ...(topic === undefined ? {} : { topicId: topic.topic_id }),
      ...(chat?.title == null ? {} : { chatTitle: chat.title }),
      ...(topic?.name == null ? {} : { topicName: topic.name }),
      ...(topic?.state == null ? {} : { state: topic.state }),
      ...(topic?.state_at == null ? {} : { stateAt: topic.state_at }),
      lastSeenAt: topic?.last_seen_at ?? chat!.last_seen_at,
    };
  }

  return {
    knownTopicNames() {
      const rows = database.prepare(
        "SELECT * FROM topics WHERE bot_id = ? AND name IS NOT NULL ORDER BY last_seen_at DESC LIMIT ?",
      ).all(botId, TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS) as unknown as TopicRow[];
      return rows.flatMap((row) => {
        const nameRecord = nameRecordOf(row);
        return nameRecord === undefined ? [] : [{ chatId: row.chat_id, messageThreadId: row.topic_id, nameRecord }];
      });
    },
    observe(observation) {
      try {
        return observeUnsafe(observation);
      } catch (error) {
        options.logger?.warn?.("Telegram topic directory could not record an observation.", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    isForum(chatId) {
      return (selectChat.get(botId, chatId) as ChatRow | undefined)?.is_forum === 1;
    },
    entry(chatId, topicId) {
      const chat = selectChat.get(botId, chatId) as ChatRow | undefined;
      if (topicId === undefined) return chat?.is_forum === 1 ? entryOf(chat, undefined, chatId) : undefined;
      const topic = selectTopic.get(botId, chatId, topicId) as TopicRow | undefined;
      return topic === undefined ? undefined : entryOf(chat, topic, chatId);
    },
    pending(limit) {
      const topics = database.prepare(
        "SELECT * FROM topics WHERE bot_id = ? AND synced_revision < revision ORDER BY last_seen_at DESC LIMIT ?",
      ).all(botId, limit) as unknown as TopicRow[];
      const chats = database.prepare(
        "SELECT * FROM chats WHERE bot_id = ? AND is_forum = 1 AND synced_revision < revision ORDER BY last_seen_at DESC LIMIT ?",
      ).all(botId, Math.max(0, limit - topics.length)) as unknown as ChatRow[];
      const chatRow = (chatId: string) => selectChat.get(botId, chatId) as ChatRow | undefined;
      return {
        entries: [
          ...topics.map((topic) => entryOf(chatRow(topic.chat_id), topic, topic.chat_id)),
          ...chats.map((chat) => entryOf(chat, undefined, chat.chat_id)),
        ],
        acknowledgement: [
          ...topics.map((topic) => ({ table: "topics" as const, chatId: topic.chat_id, topicId: topic.topic_id, revision: topic.revision })),
          ...chats.map((chat) => ({ table: "chats" as const, chatId: chat.chat_id, revision: chat.revision })),
        ],
      };
    },
    acknowledge(batch) {
      const ackTopic = database.prepare(
        "UPDATE topics SET synced_revision = ? WHERE bot_id = ? AND chat_id = ? AND topic_id = ? AND synced_revision < ?",
      );
      const ackChat = database.prepare(
        "UPDATE chats SET synced_revision = ? WHERE bot_id = ? AND chat_id = ? AND synced_revision < ?",
      );
      state.transaction(() => {
        for (const item of batch) {
          if (item.table === "topics") ackTopic.run(item.revision, botId, item.chatId, item.topicId!, item.revision);
          else ackChat.run(item.revision, botId, item.chatId, item.revision);
        }
      });
    },
    markAllPending() {
      state.transaction(() => {
        database.prepare("UPDATE topics SET synced_revision = 0 WHERE bot_id = ?").run(botId);
        database.prepare("UPDATE chats SET synced_revision = 0 WHERE bot_id = ?").run(botId);
      });
    },
    refreshOnNextSighting(chatId, topicId) {
      written.delete(topicId === undefined ? `c:${chatId}` : `t:${chatId}:${String(topicId)}`);
    },
    truncated() {
      return (database.prepare("SELECT truncated FROM bot_flags WHERE bot_id = ?").get(botId) as { truncated: number } | undefined)?.truncated === 1;
    },
    close() {
      state.close();
    },
  };
}

function nameRecordOf(row: TopicRow): TelegramTopicNameRecord | undefined {
  return row.name === null || row.name_source === null
    ? undefined
    : { name: row.name, source: row.name_source, messageId: row.name_message_id ?? 0 };
}

/**
 * Mirrors the adapter's `mergeTelegramTopicName` (an explicit rename always
 * beats the stale creation name quoted by the topic root). Kept local so this
 * module does not load the Telegram SDK at runtime.
 */
function mergeName(
  existing: TelegramTopicNameRecord | undefined,
  observed: TelegramTopicNameRecord,
): TelegramTopicNameRecord {
  if (existing === undefined) return observed;
  if (observed.source === "edited") {
    return existing.source !== "edited" || observed.messageId >= existing.messageId ? observed : existing;
  }
  if (existing.source === "edited") return existing;
  return observed.source === "created" || (existing.source === "root_reply" && existing.name !== observed.name)
    ? observed
    : existing;
}
