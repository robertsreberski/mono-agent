import { describe, expect, it } from "vitest";
import { createThreadCache } from "./thread-cache";
import { mergeModelTransitions, readModelTransitions } from "./model-transitions";
import { thread } from "./test/fixtures";
import type { ModelTransition, WebMessage } from "./types";

const transition = (id: number, afterMessageId: string | null): ModelTransition => ({
  id, afterMessageId, turnId: "turn", before: { model: "provider/sol", effort: "low" },
  after: { model: "provider/astra", effort: "high" }, createdAt: "2026-09-12T00:00:00Z",
});
const message = (id: string): WebMessage => ({
  id, threadId: "t", turnId: id, role: "assistant", parts: [], attachments: [],
  status: "complete", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
});

describe("model transition sidecars", () => {
  it("merges by identity and retains reference for repeated pages", () => {
    const held = [transition(1, "m"), transition(2, "m")];
    expect(mergeModelTransitions(held, [transition(2, "m")])).toBe(held);
    expect(mergeModelTransitions(held, [transition(3, "m")])).toHaveLength(3);
  });
  it("retains older sidecars across latest refreshes and device restore", () => {
    const cache = createThreadCache();
    const summary = thread("t", "a");
    cache.upsertFull({ thread: summary, messages: [message("new")], modelTransitions: [transition(3, "new")], messagesNextCursor: "older" });
    cache.prependOlder("t", { messages: [message("old")], modelTransitions: [transition(1, "old"), transition(2, "old")] });
    cache.upsertFull({ thread: summary, messages: [message("new")], modelTransitions: [transition(3, "new")], messagesNextCursor: "older" });
    expect(cache.get("t")?.modelTransitions?.map((item) => item.id)).toEqual([1, 2, 3]);
    const restored = createThreadCache();
    restored.restore(cache.get("t")!);
    expect(restored.get("t")?.modelTransitions).toEqual(cache.get("t")?.modelTransitions);
    restored.restore({ thread: thread("legacy", "a"), messages: [] });
    expect(restored.get("legacy")?.modelTransitions).toEqual([]);
  });
  it("rejects malformed device sidecars", () => {
    expect(readModelTransitions(undefined)).toEqual([]);
    expect(readModelTransitions([
      null,
      {},
      { ...transition(1, "m"), after: { effort: "high" } },
      { ...transition(4, "m"), before: null },
      transition(2, "m"),
    ])).toEqual([transition(2, "m")]);
  });
});
