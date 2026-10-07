import { AsyncLocalStorage } from "node:async_hooks";
import { AgentHarnessError, toolHistoryLogicalConversationId, type AgentHarness, type AgentHarnessRequest, type ConversationHistoryStore } from "@mono-agent/agent-harness";
import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

/** APP-private identity seam. The host-stamped Web source carries its committed
 * inbound message ID, not a run ID, request UUID or text hash. Background wakes
 * may dispatch the current chain, but never authorize model-change producers. */
export function persistedWebDeliveryId(request: AgentHarnessRequest): string | undefined {
  if (request.metadata?.source !== "web" || request.continuation !== undefined
    || request.metadata.cron !== undefined || request.metadata.webhook !== undefined
    || request.metadata.processJob !== undefined) return undefined;
  const web = request.metadata.web;
  if (web === null || typeof web !== "object" || Array.isArray(web)) return undefined;
  const id = (web as Record<string, unknown>).userMessageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

const tails = new Map<string, Promise<void>>();
interface Scope { readonly key: string; active: boolean }
const scopes = new AsyncLocalStorage<readonly Scope[]>();
const cancelled = () => new AgentResponseCancelledError("Cancelled before harness admission.");

/** A cancelled waiter rejects immediately and drops its action, but its queue
 * slot still waits for the predecessor before releasing later entries. No
 * caller/claim/resource must wait for that slot during disposal. */
function enqueue<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  let queued: (() => Promise<T>) | undefined = action;
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const abort = () => { queued = undefined; signal.removeEventListener("abort", abort); reject(cancelled()); };
  signal.addEventListener("abort", abort, { once: true });
  const previous = tails.get(key) ?? Promise.resolve();
  const tail = previous.then(async () => {
    const admitted = queued; queued = undefined;
    signal.removeEventListener("abort", abort);
    if (!admitted) return;
    try { resolve(await admitted()); } catch (error) { reject(error); }
  }).finally(() => { if (tails.get(key) === tail) tails.delete(key); });
  tails.set(key, tail);
  return result;
}

const forwardedKeys = {
  compactConversation: true, liveInputOwnership: true, run: true, submit: true,
  offerLiveInput: true, cancel: true, resetConversation: true,
  appendVerbatimTurn: true, importContext: true, dispose: true,
} satisfies Record<keyof AgentHarness, true>;
void forwardedKeys;

/** Staging-only per-logical-conversation gate shared across responder instances.
 * Other conversations can run/mutate concurrently. Root bootstrap contention is
 * handled by the store's try/check + typed busy refusal, not a root-wide wait.
 * submit shares this gate because APP responders prefer it; the harness's own
 * queue is instance-local and cannot protect cross-responder owner admission or
 * detect nested callbacks before they wait on their own durable claim. */
export function serializeNativeSwitchHarness(harness: AgentHarness, root: string, store: ConversationHistoryStore, rollover?: "none" | "daily"): AgentHarness {
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>(); // Admitted operations only.
  const turns = new Map<AbortController, string>();
  const keyFor = (id: string) => JSON.stringify([root, toolHistoryLogicalConversationId(id, rollover)]);
  const mutation = <T>(id: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const key = keyFor(id);
    if (disposed) return Promise.reject(cancelled());
    if (scopes.getStore()?.some((scope) => scope.active && scope.key === key)) return Promise.reject(new AgentHarnessError(
      "native_switch_busy", "A nested operation cannot wait on its own conversation claim.", { retryable: true }));
    const abortSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
    return enqueue(key, abortSignal, async () => {
      if (disposed || abortSignal.aborted) throw cancelled();
      const scope: Scope = { key, active: true };
      const inherited = scopes.getStore() ?? [];
      const operation = Promise.resolve().then(() => {
        if (disposed || abortSignal.aborted) throw cancelled();
        return scopes.run([...inherited, scope], action);
      });
      pending.add(operation);
      try { return await operation; }
      finally { scope.active = false; pending.delete(operation); }
    });
  };
  const run = async (request: AgentHarnessRequest, submit: boolean) => {
    const controller = new AbortController(); turns.set(controller, request.conversationId);
    const abortSignal = AbortSignal.any([request.abortSignal, controller.signal]);
    try {
      return await mutation(request.conversationId, async () => {
        const response = await (submit && harness.submit ? harness.submit({ ...request, abortSignal }) : harness.run({ ...request, abortSignal }));
        if (response.failure?.kind === "native_switch_busy") {
          // Only after run() has released its claims; bounded drain skips active
          // owners and try-acquires inactive ones. Never replay this request.
          try { await store.drainPendingProviderSessionTurns?.({ limit: 32 }); }
          catch { return { ...response, failure: { ...response.failure, details: { retryable: true, drain: "failed" } } }; }
        }
        return response;
      }, abortSignal);
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
    ...(harness.compactConversation === undefined ? {} : { compactConversation: (...args: Parameters<NonNullable<AgentHarness["compactConversation"]>>) => mutation(args[0], () => harness.compactConversation!(...args), args[2]) }),
    ...(harness.resetConversation === undefined ? {} : { resetConversation: (id: string) => mutation(id, () => harness.resetConversation!(id)) }),
    ...(harness.appendVerbatimTurn === undefined ? {} : { appendVerbatimTurn: (...args: Parameters<NonNullable<AgentHarness["appendVerbatimTurn"]>>) => mutation(args[0], () => harness.appendVerbatimTurn!(...args)) }),
    ...(harness.importContext === undefined ? {} : { importContext: (...args: Parameters<NonNullable<AgentHarness["importContext"]>>) => mutation(args[0], () => harness.importContext!(...args)) }),
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      lifetime.abort("Configured harness disposed.");
      for (const controller of turns.keys()) controller.abort("Configured harness disposed.");
      disposal = (async () => {
        try { await harness.dispose?.(); }
        finally { await Promise.allSettled([...pending]); }
      })();
      return disposal;
    },
  };
}
