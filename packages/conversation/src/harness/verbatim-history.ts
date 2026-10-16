import type { RuntimeSessionStore } from "../sessions/warm-store.js";
import type { ConversationHarnessOptions } from "./contracts.js";

const VERBATIM_DELIVERY_STIMULUS = "[A scheduled or triggered task produced the message below, delivered to you proactively.]";

export async function appendVerbatimHistoryTurn(
  harnessOptions: ConversationHarnessOptions,
  sessionStore: RuntimeSessionStore | undefined,
  conversationId: string,
  text: string,
  appendOptions?: { readonly idempotencyKey?: string },
): Promise<void> {
  const idempotencyKey = appendOptions?.idempotencyKey?.trim();
  if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
    const history = await harnessOptions.historyStore?.load(conversationId) ?? [];
    const prior = history.find((message) => message.idempotencyKey === idempotencyKey);
    if (prior !== undefined) {
      if (prior.role !== "assistant" || prior.content !== text) {
        throw new Error("Verbatim history idempotency key conflicts with existing content.");
      }
      return;
    }
  }
  try {
    await sessionStore?.evict(conversationId, "stale");
  } catch {
    // Eviction is best-effort; the durable history append below is what matters.
  }
  const timestamp = harnessOptions.now?.().toISOString() ?? new Date().toISOString();
  await harnessOptions.historyStore?.append(conversationId, [
    {
      role: "user",
      content: VERBATIM_DELIVERY_STIMULUS,
      timestamp,
    },
    {
      role: "assistant",
      content: text,
      timestamp,
      ...(idempotencyKey === undefined || idempotencyKey.length === 0 ? {} : { idempotencyKey }),
    },
  ]);
}
