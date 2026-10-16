import { expect, it } from "vitest";
import { belongsToLogicalConversation, hasDailyBucketSuffix, stripDailyBucketSuffix } from "../history/conversation-id.js";
import { logicalConversationIdForFence } from "../durable-history.js";
import { toolHistoryLogicalConversationId } from "../tool-history-store.js";
import { bucketConversationId } from "../responder.js";

it("preserves anchored membership for opaque bases and one lexical daily generation", () => {
  const bases = ["morgan", "morgan#note", "a.*[b]$", "", "morgan#2026-01-02", "line\n", "東京"];
  const endings = ["", "#2026-01-02", "#2026-99-99", "#2026-1-02", "#2026-01-02#2026-01-03", "#2026-01-02\n", "\n#2026-01-02", "#note"];
  for (const base of bases) for (const ending of endings) {
    const id = base + ending;
    // Frozen original membership expression; expected behavior is not derived from the new helper.
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expected = id === base || new RegExp(`^${escaped}#\\d{4}-\\d{2}-\\d{2}$`, "u").test(id);
    expect(belongsToLogicalConversation(id, base), JSON.stringify([id, base])).toBe(expected);
  }
  expect(stripDailyBucketSuffix("morgan#note#2026-99-99")).toBe("morgan#note");
  expect(hasDailyBucketSuffix("morgan#2026-1-02")).toBe(false);
});

it("keeps empty-base, normalization and rollover policy with each caller", () => {
  const bare = "#2026-01-02";
  expect(logicalConversationIdForFence(` ${bare} `)).toBe(bare);
  expect(toolHistoryLogicalConversationId(bare, "daily")).toBe("");
  expect(toolHistoryLogicalConversationId(` ${bare} `, "daily")).toBe(` ${bare} `);
  expect(toolHistoryLogicalConversationId(bare, "none")).toBe(bare);
  expect(toolHistoryLogicalConversationId(bare, undefined)).toBe(bare);
  expect(bucketConversationId(bare, "none", "UTC", () => new Date("2026-01-03T12:00:00Z"))).toBe(bare);
  expect(bucketConversationId(bare, "daily", "UTC", () => new Date("2026-01-03T12:00:00Z"))).toBe("#2026-01-03");
  expect(bucketConversationId("morgan#note", "daily", "UTC", () => new Date("2026-01-03T12:00:00Z"))).toBe("morgan#note#2026-01-03");
  expect(() => logicalConversationIdForFence("morgan\0")).toThrow("conversationId must not contain NUL bytes.");
});
