import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";
import { createChannelUserCancelReason } from "@mono-agent/agent-contracts";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import { createAgentHarness, createDurableHistoryStore } from "../index.js";

function shard(id: string): number {
  const key = createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
  return Number.parseInt(key.slice(0, 8), 16) % 16;
}

function collidingIds(): [string, string] {
  const seen = new Map<number, string>();
  // Pigeonhole principle: 17 distinct keys must collide in 16 physical shards.
  for (let i = 0; i < 17; i++) {
    const id = `provider-collision-${i}`;
    const prior = seen.get(shard(id));
    if (prior !== undefined) return [prior, id];
    seen.set(shard(id), id);
  }
  throw new Error("Expected a physical shard collision");
}

for (const cancelAt of ["admission", "provider"] as const) {
  it(`publishes cancellation at ${cancelAt} and admits a successor while a colliding provider stays open`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "history-shard-isolation-"));
    const root = join(dir, "history");
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.");
    const [firstId, secondId] = collidingIds();
    expect(firstId).not.toBe(secondId);
    expect(shard(firstId)).toBe(shard(secondId));
    const store = createDurableHistoryStore({ root, retireProviderSession: async () => {} });
    const first = await store.beginProviderSessionTurn(firstId, "long-provider");
    const controller = new AbortController();
    const begin = store.beginProviderSessionTurn.bind(store);
    vi.spyOn(store, "beginProviderSessionTurn").mockImplementation(async (...args) => {
      const pending = begin(...args);
      if (cancelAt === "admission") setImmediate(() => controller.abort(createChannelUserCancelReason("Web")));
      return await pending;
    });
    let calls = 0;
    let successorPrompt = "";
    const harness = createAgentHarness({
      identityPath,
      model: { provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      historyStore: store,
      session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
      piSessionsRoot: join(dir, "pi"),
      runtime: {
        async run(prompt: string, options: RuntimeRunOptions) {
          calls++;
          if (cancelAt === "provider" && calls === 1) {
            options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } });
            controller.abort(createChannelUserCancelReason("Web"));
            return { text: "late answer" };
          }
          successorPrompt = prompt + JSON.stringify(options.messages);
          return { text: "successor answer" };
        },
        async refreshSession() {},
        async disposeSession() { return true; },
        async disposeAllSessions() {},
      },
    });
    let completed = false;
    const flow = (async () => {
      const cancelled = await harness.run({ conversationId: secondId, userMessage: "cancel this request", abortSignal: controller.signal });
      expect(cancelled.failure?.kind).toBe("cancelled");
      const successor = await harness.run({ conversationId: secondId, userMessage: "continue", abortSignal: new AbortController().signal });
      expect(successor.failure).toBeUndefined();
      expect(successorPrompt).toContain("cancel this request");
      expect(successorPrompt).toContain("Run stopped by the operator.");
      expect((await store.load(secondId)).at(-1)?.content).toContain("successor answer");
      completed = true;
    })();
    // Observe rejection now, but always drain admission after releasing the first
    // turn on red. Never leave a lock waiter racing test-directory cleanup.
    void flow.catch(() => {});
    try {
      await expect.poll(() => completed, { timeout: 2_000 }).toBe(true);
      await flow;
      expect(await store.load(firstId)).toEqual([]);
    } finally {
      await first.abort();
      try {
        await flow;
      } finally {
        await harness.dispose?.();
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 15_000);
}
