import { describe, expect, it } from "vitest";

import { createInMemoryHistoryStore } from "../history.js";

describe("InMemoryConversationHistoryStore", () => {
  it("preserves the explicit public maxMessages zero semantics", async () => {
    const store = createInMemoryHistoryStore({ maxMessages: 0 });
    await store.append("conversation", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ]);

    await expect(store.load("conversation")).resolves.toEqual([]);
  });
});
