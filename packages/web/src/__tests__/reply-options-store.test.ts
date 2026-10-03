import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";
import { hasWakeReplyContent, normalizeWakeTerminalReply } from "../wake-reply.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("quick reply persistence", () => {
  it("round-trips one set through completion and reopen without a new table", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([{ sourceId: "one", label: "Demo", status: "online", supportsAttachments: false,
      updatedAt: "2026-09-23T10:00:00.000Z", runSettings: { config: {}, override: null,
        effective: { modelSource: "config", effortSource: "config" } } }]);
    const thread = store.createThread("one");
    const turn = store.beginTurn({ threadId: thread.id, text: "Draft options", attachmentIds: [] });
    const part = { type: "reply_options" as const, id: "choices", options: ["Review draft", "Keep going", "Try another approach"] };
    store.completeTurn(turn.turnId, "What would you like next?", {}, [part, { ...part, id: "extra" }]);
    expect(store.getMessage(turn.assistantMessageId)?.parts).toContainEqual(part);
    expect(store.getMessage(turn.assistantMessageId)?.parts.filter((p) => p.type === "reply_options")).toHaveLength(1);
    const bad = store.beginTurn({ threadId: thread.id, text: "Next", attachmentIds: [] });
    store.completeTurn(bad.turnId, "reply", {}, [{ ...part, id: "bad", options: ["one", "one"] },
      { ...part, id: "forged", url: "https://invalid.example" }] as never);
    expect(store.getMessage(bad.assistantMessageId)?.parts.some((p) => p.type === "reply_options")).toBe(false);
    store.close();
    const reopened = await WebStore.open({ stateDir });
    try { expect(reopened.getMessage(turn.assistantMessageId)?.parts).toContainEqual(part); }
    finally { reopened.close(); }
  });
  it("retains quick replies on web wake completion", () => {
    const parts = [{ type: "reply_options" as const, id: "wake-choices", options: ["Review result", "Continue"] }];
    expect(hasWakeReplyContent(parts)).toBe(true);
    expect(normalizeWakeTerminalReply(parts).parts).toEqual(parts);
  });
});
