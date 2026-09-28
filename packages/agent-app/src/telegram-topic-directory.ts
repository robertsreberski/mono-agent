import type { DatabaseSync } from "node:sqlite";

import type {
  TelegramChatObservation,
  TelegramKnownTopicName,
  TelegramTopicNameRecord,
  TelegramTopicNameSource,
} from "@mono-agent/telegram-adapter";

import {
  openOwnedState,
  openOwnedStateReadOnly,
  resolveOwnedStatePaths,
  type OwnedStateHandle,
} from "./owned-state-sqlite.js";

/**
 * Persistent Telegram forum-topic directory (`telegram.topicDirectory`).
 *
 * Telegram's Bot API cannot list a forum's topics, so discovery is passive:
 * the adapter reports what each allowlisted message reveals (topic creation,
 * rename, close/reopen, the creation name quoted by the implicit topic-root
 * reply) and this store remembers it across restarts. Records are namespaced
 * by bot id, chat and topic so another bot or chat never contaminates a
 * lookup. Topic ids stay host-owned: the model addresses topics by name and
 * every model-visible listing carries names and status only.
 */

export const TELEGRAM_TOPIC_DIRECTORY_NAME = "telegram-topics-v1";
export const TELEGRAM_TOPIC_DIRECTORY_LABEL = "Telegram topic directory";
const SCHEMA_VERSION = 1;
/** Per bot; new topics beyond this are not recorded (the listing reports truncation). */
export const TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS = 1_024;
const MAX_CHATS = 256;
/** Refresh last-seen at most this often per chat/topic to keep writes rare. */
const LAST_SEEN_REFRESH_MS = 10 * 60 * 1_000;
const MAX_LABEL_CHARS = 128;
const MAX_ERROR_NAMES = 20;

export interface TelegramDirectoryTopic {
  readonly chatId: string;
  readonly topicId: number;
  readonly name?: string;
  readonly nameSource?: TelegramTopicNameSource;
  readonly nameMessageId?: number;
  readonly state: "open" | "closed";
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface TelegramDirectoryChat {
  readonly chatId: string;
  readonly title?: string;
  readonly lastSeenAt: string;
}

/** One chat's view of the directory, read fresh for a lookup. */
export interface TelegramDirectoryChatSnapshot {
  readonly chat?: TelegramDirectoryChat;
  readonly topics: readonly TelegramDirectoryTopic[];
  /** True once the per-bot topic cap refused a new topic. */
  readonly truncated: boolean;
}

/** The bot id is the token's public numeric prefix; the secret half is never stored. */
export function telegramBotIdFromToken(botToken: string): string {
  const prefix = botToken.split(":", 1)[0]?.trim() ?? "";
  if (!/^\d{1,20}$/u.test(prefix)) {
    throw new Error("Telegram bot token has no numeric bot id prefix.");
  }
  return prefix;
}

export function resolveTelegramTopicDirectoryRoot(cwd: string): string {
  return resolveOwnedStatePaths(cwd, TELEGRAM_TOPIC_DIRECTORY_NAME).root;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE chats (
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      title TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, chat_id)
    );
    CREATE TABLE topics (
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      topic_id INTEGER NOT NULL CHECK (topic_id > 0),
      name TEXT,
      name_source TEXT CHECK (name_source IN ('created', 'edited', 'root_reply')),
      name_message_id INTEGER,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, chat_id, topic_id)
    );
    CREATE TABLE bot_flags (
      bot_id TEXT PRIMARY KEY,
      truncated INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export interface TelegramTopicDirectoryStore {
  readonly root: string;
  /** Names to hydrate the adapter's in-memory cache at startup. */
  knownTopicNames(): readonly TelegramKnownTopicName[];
  /** Persist what one allowlisted message revealed. Never throws. */
  observe(observation: TelegramChatObservation): void;
  chatSnapshot(chatId: string): TelegramDirectoryChatSnapshot;
  close(): void;
}

export interface OpenTelegramTopicDirectoryOptions {
  readonly cwd: string;
  readonly botId: string;
  readonly now?: () => Date;
  readonly logger?: { warn?: (message: string, metadata?: Record<string, unknown>) => void };
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

  const upsertChat = database.prepare(`
    INSERT INTO chats (bot_id, chat_id, title, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (bot_id, chat_id) DO UPDATE SET
      title = COALESCE(excluded.title, chats.title),
      last_seen_at = excluded.last_seen_at
  `);
  const countChats = database.prepare("SELECT COUNT(*) AS n FROM chats WHERE bot_id = ?");
  const chatExists = database.prepare("SELECT 1 AS present FROM chats WHERE bot_id = ? AND chat_id = ?");
  const selectTopic = database.prepare(
    "SELECT * FROM topics WHERE bot_id = ? AND chat_id = ? AND topic_id = ?",
  );
  const countTopics = database.prepare("SELECT COUNT(*) AS n FROM topics WHERE bot_id = ?");
  const insertTopic = database.prepare(`
    INSERT INTO topics (bot_id, chat_id, topic_id, name, name_source, name_message_id, state, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTopic = database.prepare(`
    UPDATE topics SET name = ?, name_source = ?, name_message_id = ?, state = ?, last_seen_at = ?
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

  function observeUnsafe(observation: TelegramChatObservation): void {
    const chatId = String(observation.chatId);
    const at = now();
    const atIso = at.toISOString();
    const atMs = at.getTime();
    const chatKey = `c:${chatId}`;
    const chatSignature = observation.chatTitle ?? "";
    if (shouldWrite(chatKey, chatSignature, atMs)) {
      const known = chatExists.get(botId, chatId) !== undefined;
      if (known || (countChats.get(botId) as { n: number }).n < MAX_CHATS) {
        upsertChat.run(botId, chatId, observation.chatTitle ?? null, atIso);
      }
      written.set(chatKey, { signature: chatSignature, atMs });
    }
    const topic = observation.topic;
    if (topic === undefined) return;
    const topicKey = `t:${chatId}:${String(topic.messageThreadId)}`;
    const topicSignature = `${topic.nameRecord?.source ?? ""}|${topic.nameRecord?.name ?? ""}|${topic.state ?? ""}`;
    if (!shouldWrite(topicKey, topicSignature, atMs)) return;
    state.transaction(() => {
      const row = selectTopic.get(botId, chatId, topic.messageThreadId) as TopicRow | undefined;
      if (row === undefined) {
        if ((countTopics.get(botId) as { n: number }).n >= TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS) {
          markTruncated.run(botId);
          return;
        }
        insertTopic.run(
          botId,
          chatId,
          topic.messageThreadId,
          topic.nameRecord?.name ?? null,
          topic.nameRecord?.source ?? null,
          topic.nameRecord?.messageId ?? null,
          topic.state ?? "open",
          atIso,
          atIso,
        );
        return;
      }
      const existing = nameRecordOf(row);
      const merged = topic.nameRecord === undefined
        ? existing
        : mergeName(existing, topic.nameRecord);
      updateTopic.run(
        merged?.name ?? null,
        merged?.source ?? null,
        merged?.messageId ?? null,
        topic.state ?? row.state,
        atIso,
        botId,
        chatId,
        topic.messageThreadId,
      );
    });
    written.set(topicKey, { signature: topicSignature, atMs });
  }

  return {
    root: state.paths.root,
    knownTopicNames() {
      const rows = database.prepare(
        "SELECT * FROM topics WHERE bot_id = ? AND name IS NOT NULL ORDER BY last_seen_at DESC LIMIT ?",
      ).all(botId, TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS) as unknown as TopicRow[];
      return rows.flatMap((row) => {
        const nameRecord = nameRecordOf(row);
        return nameRecord === undefined
          ? []
          : [{ chatId: row.chat_id, messageThreadId: row.topic_id, nameRecord }];
      });
    },
    observe(observation) {
      try {
        observeUnsafe(observation);
      } catch (error) {
        options.logger?.warn?.("Telegram topic directory could not record an observation.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    chatSnapshot(chatId) {
      return readChatSnapshot(database, botId, chatId);
    },
    close() {
      state.close();
    },
  };
}

/**
 * Read one chat's directory fresh from disk without the writer lease (the
 * app-owned send-tool child uses this per lookup). Absent state reads empty.
 */
export async function readTelegramTopicDirectoryChat(
  root: string,
  botId: string,
  chatId: string,
): Promise<TelegramDirectoryChatSnapshot> {
  const database = await openOwnedStateReadOnly(root, TELEGRAM_TOPIC_DIRECTORY_LABEL, SCHEMA_VERSION);
  if (database === undefined) {
    return { topics: [], truncated: false };
  }
  try {
    return readChatSnapshot(database, botId, chatId);
  } finally {
    database.close();
  }
}

interface TopicRow {
  readonly chat_id: string;
  readonly topic_id: number;
  readonly name: string | null;
  readonly name_source: TelegramTopicNameSource | null;
  readonly name_message_id: number | null;
  readonly state: "open" | "closed";
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

function readChatSnapshot(database: DatabaseSync, botId: string, chatId: string): TelegramDirectoryChatSnapshot {
  const chatRow = database.prepare(
    "SELECT chat_id, title, last_seen_at FROM chats WHERE bot_id = ? AND chat_id = ?",
  ).get(botId, chatId) as { chat_id: string; title: string | null; last_seen_at: string } | undefined;
  const topicRows = database.prepare(
    "SELECT * FROM topics WHERE bot_id = ? AND chat_id = ? ORDER BY last_seen_at DESC LIMIT ?",
  ).all(botId, chatId, TELEGRAM_TOPIC_DIRECTORY_MAX_TOPICS) as unknown as TopicRow[];
  const flags = database.prepare("SELECT truncated FROM bot_flags WHERE bot_id = ?").get(botId) as
    | { truncated: number }
    | undefined;
  return {
    ...(chatRow === undefined
      ? {}
      : {
          chat: {
            chatId: chatRow.chat_id,
            ...(chatRow.title === null ? {} : { title: chatRow.title }),
            lastSeenAt: chatRow.last_seen_at,
          },
        }),
    topics: topicRows.map((row) => ({
      chatId: row.chat_id,
      topicId: row.topic_id,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.name_source === null ? {} : { nameSource: row.name_source }),
      ...(row.name_message_id === null ? {} : { nameMessageId: row.name_message_id }),
      state: row.state,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
    truncated: flags?.truncated === 1,
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

// --- Name resolution (pure) -------------------------------------------------

/**
 * Exact-match key, derived from the same sanitized label `TelegramListTopics`
 * shows (NFC, control/format characters removed, collapsed whitespace,
 * bounded), then case-folded. A name the model copies from the listing always
 * resolves; raw names that sanitize to the same label are ambiguous.
 */
export function normalizeTopicName(name: string): string {
  return sanitizeTelegramLabel(name).toLowerCase();
}

/**
 * Make an untrusted, user-chosen label safe to show the model: strip control,
 * format and bidi-override characters, collapse whitespace, bound the length.
 */
export function sanitizeTelegramLabel(label: string): string {
  const cleaned = label
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAX_LABEL_CHARS).join("");
}

export type TelegramTopicResolution =
  | { readonly kind: "found"; readonly topic: TelegramDirectoryTopic & { readonly name: string } }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "closed"; readonly topic: TelegramDirectoryTopic & { readonly name: string } };

export function resolveTopicByName(
  snapshot: TelegramDirectoryChatSnapshot,
  requestedName: string,
): TelegramTopicResolution {
  const key = normalizeTopicName(requestedName);
  if (key.length === 0) return { kind: "missing" };
  const matches = snapshot.topics.filter(
    (topic): topic is TelegramDirectoryTopic & { readonly name: string } =>
      topic.name !== undefined && normalizeTopicName(topic.name) === key,
  );
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  const topic = matches[0]!;
  return topic.state === "closed" ? { kind: "closed", topic } : { kind: "found", topic };
}

/** Model-facing explanation for a name that cannot be used. Never includes topic ids. */
export function describeTopicResolutionFailure(
  toolName: string,
  requestedName: string,
  resolution: Exclude<TelegramTopicResolution, { readonly kind: "found" }>,
  snapshot: TelegramDirectoryChatSnapshot,
): string {
  const requested = JSON.stringify(sanitizeTelegramLabel(requestedName));
  const known = knownTopicNamesText(snapshot);
  const discovery = "Topic names are learned passively: send any message in that topic (one the bot can see), then retry. The bot cannot list or create topics.";
  if (resolution.kind === "ambiguous") {
    return `${toolName}: ${String(resolution.count)} known topics are named ${requested}; rename one in Telegram so the name is unique, then retry. ${known}`;
  }
  if (resolution.kind === "closed") {
    return `${toolName}: the topic ${requested} is closed. Reopen it in Telegram (the reopen is observed), then retry. ${known}`;
  }
  return `${toolName}: no known topic is named ${requested} in this chat. ${known} ${discovery}`;
}

export function knownTopicNamesText(snapshot: TelegramDirectoryChatSnapshot): string {
  const names = snapshot.topics
    .filter((topic) => topic.name !== undefined)
    .map((topic) => JSON.stringify(sanitizeTelegramLabel(topic.name!)));
  if (names.length === 0) return "No topic names are known for this chat yet.";
  const shown = names.slice(0, MAX_ERROR_NAMES).join(", ");
  const more = names.length > MAX_ERROR_NAMES ? ` (+${String(names.length - MAX_ERROR_NAMES)} more)` : "";
  return `Known topic names: ${shown}${more}.`;
}

/** The `TelegramListTopics` result for one chat: names and status only, never ids. */
export function telegramTopicListing(snapshot: TelegramDirectoryChatSnapshot): Record<string, unknown> {
  const named = snapshot.topics.filter((topic) => topic.name !== undefined);
  return {
    ...(snapshot.chat?.title === undefined ? {} : { chat_title: sanitizeTelegramLabel(snapshot.chat.title) }),
    topics: named.map((topic) => ({
      name: sanitizeTelegramLabel(topic.name!),
      status: topic.state,
      last_seen_at: topic.lastSeenAt,
    })),
    unnamed_topics_seen: snapshot.topics.length - named.length,
    main_conversation: "Address the chat's main conversation (a forum's General topic) with main: true.",
    incomplete: true,
    ...(snapshot.truncated ? { truncated: true } : {}),
    note: "Only topics the bot has seen are listed; Telegram offers no topic listing. Send a message in a missing topic, then list again.",
  };
}

/** `Chat title › Topic` for schedule results; ids never appear. */
export function telegramDestinationLabel(
  snapshot: TelegramDirectoryChatSnapshot,
  chatId: string,
  topicName: string | undefined,
  main: boolean,
): string {
  const chat = snapshot.chat?.title === undefined ? `chat ${chatId}` : sanitizeTelegramLabel(snapshot.chat.title);
  if (main) return `${chat} › main conversation`;
  return topicName === undefined ? `${chat} › unnamed topic` : `${chat} › ${sanitizeTelegramLabel(topicName)}`;
}
