import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bucketConversationId, createSqliteHistoryStore, SqliteConversationHistoryStore } from "../index.js";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-history-"));
  dbPath = join(dir, "history.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SqliteConversationHistoryStore", () => {
  it("appends and loads turns in chronological order across appends", async () => {
    const store = createSqliteHistoryStore({ path: dbPath });
    try {
      await store.append("telegram:42", [
        { role: "user", content: "hi", timestamp: "t1" },
        { role: "assistant", content: "hello", timestamp: "t2" },
      ]);
      await store.append("telegram:42", [{ role: "assistant", content: "brief", source: "proactive", timestamp: "t3" }]);

      const loaded = await store.load("telegram:42");
      expect(loaded).toEqual([
        { role: "user", content: "hi", timestamp: "t1" },
        { role: "assistant", content: "hello", timestamp: "t2" },
        { role: "assistant", content: "brief", source: "proactive", timestamp: "t3" },
      ]);
    } finally {
      store.close();
    }
  });

  it("keeps conversations isolated by conversationId (no cross-channel bleed)", async () => {
    const store = createSqliteHistoryStore({ path: dbPath });
    try {
      await store.append("telegram:42", [{ role: "assistant", content: "tg" }]);
      await store.append("slack:C1:ts", [{ role: "assistant", content: "sl" }]);
      expect((await store.load("telegram:42")).map((m) => m.content)).toEqual(["tg"]);
      expect((await store.load("slack:C1:ts")).map((m) => m.content)).toEqual(["sl"]);
    } finally {
      store.close();
    }
  });

  it("returns only the last maxMessages on load, chronological", async () => {
    const store = createSqliteHistoryStore({ path: dbPath, maxMessages: 2 });
    try {
      await store.append("c", [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
      ]);
      expect((await store.load("c")).map((m) => m.content)).toEqual(["2", "3"]);
    } finally {
      store.close();
    }
  });

  it("is durable and visible across a second connection (multi-process)", async () => {
    const writer = createSqliteHistoryStore({ path: dbPath });
    try {
      await writer.append("telegram:42", [
        { role: "assistant", content: "from-writer", source: "proactive", timestamp: "t1" },
      ]);
    } finally {
      writer.close();
    }
    const reader = new SqliteConversationHistoryStore({ path: dbPath });
    try {
      expect(await reader.load("telegram:42")).toEqual([
        { role: "assistant", content: "from-writer", source: "proactive", timestamp: "t1" },
      ]);
    } finally {
      reader.close();
    }
  });

  it("summarizes conversations and shows recent turns", async () => {
    const store = createSqliteHistoryStore({ path: dbPath });
    try {
      await store.append("telegram:42", [
        { role: "user", content: "a", timestamp: "2026-01-01T00:00:00Z" },
        { role: "assistant", content: "the last reply here", timestamp: "2026-01-02T00:00:00Z" },
      ]);
      const summaries = store.listConversations();
      expect(summaries).toEqual([
        {
          conversationId: "telegram:42",
          messageCount: 2,
          lastTimestamp: "2026-01-02T00:00:00Z",
          lastRole: "assistant",
          lastSnippet: "the last reply here",
        },
      ]);
      expect(store.showConversation("telegram:42", 1).map((m) => m.content)).toEqual(["the last reply here"]);
    } finally {
      store.close();
    }
  });

  it("rejects an empty conversationId", async () => {
    const store = createSqliteHistoryStore({ path: dbPath });
    try {
      await expect(store.load("  ")).rejects.toThrow(/non-empty/u);
    } finally {
      store.close();
    }
  });
});

describe("bucketConversationId", () => {
  const at = (iso: string) => () => new Date(iso);

  it("passes through when rollover is off", () => {
    expect(bucketConversationId("telegram:42", undefined, "UTC", at("2026-06-19T10:00:00Z"))).toBe("telegram:42");
  });

  it("appends a local-date bucket under daily rollover and is idempotent", () => {
    const once = bucketConversationId("telegram:42", "daily", "UTC", at("2026-06-19T10:00:00Z"));
    expect(once).toBe("telegram:42#2026-06-19");
    expect(bucketConversationId(once, "daily", "UTC", at("2026-06-19T23:00:00Z"))).toBe("telegram:42#2026-06-19");
  });
});
