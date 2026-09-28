import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OwnedStateError } from "../owned-state-sqlite.js";
import {
  describeTopicResolutionFailure,
  openTelegramTopicDirectory,
  readTelegramTopicDirectoryChat,
  resolveTelegramTopicDirectoryRoot,
  resolveTopicByName,
  sanitizeTelegramLabel,
  telegramBotIdFromToken,
  telegramTopicListing,
  type TelegramTopicDirectoryStore,
} from "../telegram-topic-directory.js";

const CHAT = -1001;

function named(topic: number, name: string, source: "created" | "edited" | "root_reply", messageId: number) {
  return { chatId: CHAT, chatTitle: "Trips", topic: { messageThreadId: topic, nameRecord: { name, source, messageId } } };
}

describe("Telegram topic directory", () => {
  let dir: string;
  const opened: TelegramTopicDirectoryStore[] = [];
  const open = async (botId = "111", now?: () => Date) => {
    const store = await openTelegramTopicDirectory({ cwd: dir, botId, ...(now === undefined ? {} : { now }) });
    opened.push(store);
    return store;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tg-topics-"));
  });
  afterEach(async () => {
    for (const store of opened.splice(0)) store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists names across restarts and hydrates the adapter cache", async () => {
    const first = await open();
    first.observe(named(77, "Flights", "created", 77));
    first.observe({ chatId: CHAT, chatTitle: "Trips", topic: { messageThreadId: 88 } });
    first.close();

    const second = await open();
    expect(second.knownTopicNames()).toEqual([
      { chatId: String(CHAT), messageThreadId: 77, nameRecord: { name: "Flights", source: "created", messageId: 77 } },
    ]);
    const snapshot = second.chatSnapshot(String(CHAT));
    expect(snapshot.chat?.title).toBe("Trips");
    expect(snapshot.topics.map((topic) => [topic.topicId, topic.name])).toEqual(
      expect.arrayContaining([[77, "Flights"], [88, undefined]]),
    );
  });

  it("keeps an explicit rename when a later message quotes the stale root name", async () => {
    const store = await open();
    store.observe(named(77, "Budapest", "created", 77));
    store.observe(named(77, "Flights", "edited", 120));
    store.observe(named(77, "Budapest", "root_reply", 130));

    const resolution = resolveTopicByName(store.chatSnapshot(String(CHAT)), "flights");
    expect(resolution.kind).toBe("found");
    expect(resolveTopicByName(store.chatSnapshot(String(CHAT)), "Budapest").kind).toBe("missing");
  });

  it("namespaces records by bot and chat", async () => {
    const botA = await open("111");
    botA.observe(named(77, "Flights", "created", 77));
    botA.observe({ chatId: -2002, topic: { messageThreadId: 5, nameRecord: { name: "Hotels", source: "created", messageId: 5 } } });
    botA.close();

    const botB = await open("222");
    expect(botB.chatSnapshot(String(CHAT)).topics).toEqual([]);
    expect(botB.knownTopicNames()).toEqual([]);
    botB.close();

    const again = await open("111");
    expect(resolveTopicByName(again.chatSnapshot(String(CHAT)), "Hotels").kind).toBe("missing");
    expect(resolveTopicByName(again.chatSnapshot("-2002"), "Hotels").kind).toBe("found");
  });

  it("serves fresh reads to another process without the writer lease", async () => {
    const store = await open();
    const root = resolveTelegramTopicDirectoryRoot(dir);
    expect((await readTelegramTopicDirectoryChat(root, "111", String(CHAT))).topics).toEqual([]);
    store.observe(named(77, "Flights", "created", 77));
    const snapshot = await readTelegramTopicDirectoryChat(root, "111", String(CHAT));
    expect(snapshot.topics.map((topic) => topic.name)).toEqual(["Flights"]);
  });

  it("reads an absent directory as empty instead of creating it", async () => {
    const snapshot = await readTelegramTopicDirectoryChat(resolveTelegramTopicDirectoryRoot(dir), "111", "1");
    expect(snapshot).toEqual({ topics: [], truncated: false });
  });

  it("refuses a second live writer", async () => {
    await open();
    await expect(openTelegramTopicDirectory({ cwd: dir, botId: "111" })).rejects.toMatchObject({ kind: "lease_conflict" });
  });

  it("fails closed on insecure permissions", async () => {
    const store = await open();
    store.close();
    opened.length = 0;
    await chmod(resolveTelegramTopicDirectoryRoot(dir), 0o755);
    await expect(openTelegramTopicDirectory({ cwd: dir, botId: "111" })).rejects.toBeInstanceOf(OwnedStateError);
    await expect(readTelegramTopicDirectoryChat(resolveTelegramTopicDirectoryRoot(dir), "111", "1"))
      .rejects.toMatchObject({ kind: "insecure" });
  });

  it("tracks closed and reopened topics", async () => {
    const store = await open();
    store.observe(named(77, "Flights", "created", 77));
    store.observe({ chatId: CHAT, topic: { messageThreadId: 77, state: "closed" } });
    expect(resolveTopicByName(store.chatSnapshot(String(CHAT)), "Flights").kind).toBe("closed");
    store.observe({ chatId: CHAT, topic: { messageThreadId: 77, state: "open" } });
    expect(resolveTopicByName(store.chatSnapshot(String(CHAT)), "Flights").kind).toBe("found");
  });
});

describe("topic name resolution", () => {
  const snapshot = {
    chat: { chatId: "-1001", title: "Trips", lastSeenAt: "2026-09-28T08:00:00.000Z" },
    topics: [
      { chatId: "-1001", topicId: 77, name: "Flights  ", state: "open" as const, firstSeenAt: "x", lastSeenAt: "y" },
      { chatId: "-1001", topicId: 78, name: "Hotels", state: "open" as const, firstSeenAt: "x", lastSeenAt: "y" },
      { chatId: "-1001", topicId: 79, name: "hotels", state: "open" as const, firstSeenAt: "x", lastSeenAt: "y" },
      { chatId: "-1001", topicId: 80, state: "open" as const, firstSeenAt: "x", lastSeenAt: "y" },
      { chatId: "-1001", topicId: 81, name: "Caf\u00e9", state: "open" as const, firstSeenAt: "x", lastSeenAt: "y" },
    ],
    truncated: false,
  };

  it("matches exactly after normalization and reports ambiguity", () => {
    expect(resolveTopicByName(snapshot, "  FLIGHTS ")).toMatchObject({ kind: "found", topic: { topicId: 77 } });
    expect(resolveTopicByName(snapshot, "Hotels")).toEqual({ kind: "ambiguous", count: 2 });
    expect(resolveTopicByName(snapshot, "Flight")).toEqual({ kind: "missing" });
    // NFC: a decomposed accent matches the precomposed name.
    expect(resolveTopicByName(snapshot, "Cafe\u0301")).toMatchObject({ kind: "found", topic: { topicId: 81 } });
  });

  it("explains failures with known names and passive discovery, never ids", () => {
    const message = describeTopicResolutionFailure("TelegramSendMessage", "Trains", { kind: "missing" }, snapshot);
    expect(message).toContain('"Flights"');
    expect(message).toContain("send any message in that topic");
    expect(message).not.toMatch(/\b(7[789]|8[01])\b/u);
  });

  it("lists names and status only and flags the listing incomplete", () => {
    const listing = telegramTopicListing(snapshot);
    expect(listing).toMatchObject({ chat_title: "Trips", unnamed_topics_seen: 1, incomplete: true });
    expect(JSON.stringify(listing)).not.toMatch(/topic_?id|message_thread_id|"(7[789]|8[01])"|:(7[789]|8[01])\b/u);
  });

  it("sanitizes untrusted labels", () => {
    expect(sanitizeTelegramLabel("Fli\u202eghts\n\tnow\u0000")).toBe("Fli ghts now");
    expect(Array.from(sanitizeTelegramLabel("x".repeat(500)))).toHaveLength(128);
  });

  it("derives the bot namespace from the token's public prefix only", () => {
    expect(telegramBotIdFromToken("123456:secret-part")).toBe("123456");
    expect(() => telegramBotIdFromToken("test-token")).toThrow();
  });
});
