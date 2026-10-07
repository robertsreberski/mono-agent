import type { AgentHarness, AgentHarnessRequest, ConversationHistoryStore } from "@mono-agent/agent-harness";
import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

/** APP-private identity seam. Web stamps this from its committed inbound message,
 * not from a run ID, request UUID or text hash. Do not widen to transport-native
 * IDs without an APP persistence/lifecycle decision. Background wakes never
 * authorize paid generations even if they happen to carry Web metadata. */
export function persistedWebDeliveryId(request: AgentHarnessRequest): string | undefined {
  if (request.continuation !== undefined || request.metadata?.cron !== undefined
    || request.metadata?.webhook !== undefined || request.metadata?.processJob !== undefined
    || request.metadata?.source === "subagent") return undefined;
  const web = request.metadata?.web;
  if (web === null || typeof web !== "object" || Array.isArray(web)) return undefined;
  const id = (web as Record<string, unknown>).userMessageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// Shared across channel responders for this canonical agent root. Queue BEFORE
// harness admission/claims. A failed attempt never re-enters run() automatically.
const tails = new Map<string, Promise<void>>();
async function serialize<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = tails.get(root) ?? Promise.resolve();
  const current = previous.then(action, action);
  const tail = current.then(() => undefined, () => undefined);
  tails.set(root, tail);
  try { return await current; }
  finally { if (tails.get(root) === tail) tails.delete(root); }
}

const forwardedKeys = {
  compactConversation: true, liveInputOwnership: true, run: true, submit: true,
  offerLiveInput: true, cancel: true, resetConversation: true,
  appendVerbatimTurn: true, importContext: true, dispose: true,
} satisfies Record<keyof AgentHarness, true>;
void forwardedKeys;

/** Staging-only root gate. Live input/cancellation must remain immediate, while
 * canonical mutations share the admission gate. Disposal cancels local waiters
 * before draining them, never waits behind a queue with a pinned host claim. */
export function serializeNativeSwitchHarness(harness: AgentHarness, root: string, store: ConversationHistoryStore): AgentHarness {
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const turns = new Map<AbortController, string>();
  const mutation = <T>(action: () => Promise<T>): Promise<T> => {
    const promise = serialize(root, async () => {
      if (disposed) throw new AgentResponseCancelledError("Configured harness is disposed.");
      return await action();
    });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const run = async (request: AgentHarnessRequest, submit: boolean) => {
    const controller = new AbortController(); turns.set(controller, request.conversationId);
    const abortSignal = AbortSignal.any([request.abortSignal, controller.signal]);
    try {
      return await mutation(async () => {
        if (abortSignal.aborted) throw new AgentResponseCancelledError("Cancelled before harness admission.");
        const response = await (submit && harness.submit ? harness.submit({ ...request, abortSignal }) : harness.run({ ...request, abortSignal }));
        if (response.failure?.kind === "native_switch_busy") {
          // run() has returned and released its preparation/conversation claims.
          // The bounded drainer skips active owners and try-acquires inactive
          // ones. Preserve the retryable refusal; never replay this request.
          try { await store.drainPendingProviderSessionTurns?.({ limit: 32 }); }
          catch { return { ...response, failure: { ...response.failure, details: { retryable: true, drain: "failed" } } }; }
        }
        return response;
      });
    } finally { turns.delete(controller); }
  };
  return {
    run: (request) => run(request, false),
    ...(harness.submit === undefined ? {} : { submit: (request: AgentHarnessRequest) => run(request, true) }),
    ...(harness.liveInputOwnership === undefined ? {} : { liveInputOwnership: harness.liveInputOwnership }),
    ...(harness.offerLiveInput === undefined ? {} : { offerLiveInput: harness.offerLiveInput.bind(harness) }),
    cancel(conversationId, reason) {
      for (const [controller, id] of turns) if (id === conversationId) controller.abort(reason);
      harness.cancel?.(conversationId, reason);
    },
    ...(harness.compactConversation === undefined ? {} : { compactConversation: (...args: Parameters<NonNullable<AgentHarness["compactConversation"]>>) => mutation(() => harness.compactConversation!(...args)) }),
    ...(harness.resetConversation === undefined ? {} : { resetConversation: (id: string) => mutation(() => harness.resetConversation!(id)) }),
    ...(harness.appendVerbatimTurn === undefined ? {} : { appendVerbatimTurn: (...args: Parameters<NonNullable<AgentHarness["appendVerbatimTurn"]>>) => mutation(() => harness.appendVerbatimTurn!(...args)) }),
    ...(harness.importContext === undefined ? {} : { importContext: (...args: Parameters<NonNullable<AgentHarness["importContext"]>>) => mutation(() => harness.importContext!(...args)) }),
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const controller of turns.keys()) controller.abort("Configured harness disposed.");
      // Interrupt active dispatch immediately; do not queue disposal behind it.
      disposal = (async () => {
        try { await harness.dispose?.(); }
        finally { await Promise.allSettled([...pending]); }
      })();
      return disposal;
    },
  };
}
