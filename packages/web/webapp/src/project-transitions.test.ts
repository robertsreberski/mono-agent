import { describe, expect, it } from "vitest";
import { createThreadCache } from "./thread-cache";
import { mergeProjectTransitions, readProjectTransitions } from "./project-transitions";
import { thread } from "./test/fixtures";
import type { ProjectTransition, WebMessage } from "./types";

const transition = (id: number, afterMessageId: string | null): ProjectTransition => ({
  id, afterMessageId, turnId: null, before: null,
  after: { id: "p", name: "Project", color: "blue" }, createdAt: "2026-09-12T00:00:00Z",
});
const message = (id: string): WebMessage => ({
  id, threadId: "t", turnId: id, role: "assistant", parts: [], attachments: [],
  status: "complete", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
});

describe("project transition sidecars", () => {
  it("merges by identity and retains reference for repeated pages", () => {
    const held = [transition(1, null), transition(2, "m")];
    expect(mergeProjectTransitions(held, [transition(2, "m")])).toBe(held);
    expect(mergeProjectTransitions(held, [transition(3, "m")])).toHaveLength(3);
  });
  it("retains older sidecars across latest refreshes and device restore", () => {
    const cache = createThreadCache();
    const summary = thread("t", "a");
    cache.upsertFull({ thread: summary, messages: [message("new")], projectTransitions: [transition(3, "new")], messagesNextCursor: "older" });
    cache.prependOlder("t", { messages: [message("old")], projectTransitions: [transition(1, null), transition(2, "old")] });
    cache.upsertFull({ thread: summary, messages: [message("new")], projectTransitions: [transition(3, "new")], messagesNextCursor: "older" });
    expect(cache.get("t")?.projectTransitions?.map((item) => item.id)).toEqual([1, 2, 3]);
    const restored = createThreadCache();
    restored.restore(cache.get("t")!);
    expect(restored.get("t")?.projectTransitions).toEqual(cache.get("t")?.projectTransitions);
    restored.restore({ thread: thread("legacy", "a"), messages: [] });
    expect(restored.get("legacy")?.projectTransitions).toEqual([]);
  });
  it("rejects malformed device sidecars", () => {
    expect(readProjectTransitions(undefined)).toEqual([]);
    expect(readProjectTransitions([null, {}, { ...transition(1, null), after: { color: "url(secret)" } }, transition(2, null)])).toEqual([transition(2, null)]);
  });
});
