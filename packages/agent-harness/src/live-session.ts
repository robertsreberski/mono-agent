import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

import type { AgentHarnessRequest, AgentHarnessResponse } from "./types.js";

/**
 * Serializes turns per conversation while letting different conversations run
 * concurrently. A second message for a conversation whose turn is in flight is
 * *queued* and answered after the current turn finishes (queue-after-turn),
 * rather than rejected or run in parallel.
 *
 * The queue is deliberately decoupled from provider-session lifetime: it owns
 * only turn ordering. Whether a turn resumes a warm provider session or replays
 * history is decided by the runner (`MonoAgentHarness.run`) on each turn, so a
 * session that dies/evicts mid-queue simply demotes the next turn to a fresh
 * run — queued follow-ups are never silently dropped.
 */
export interface LiveSessionManager {
  /** Enqueue a turn; resolves when *this* turn completes (after any ahead of it). */
  enqueue(conversationId: string, request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /** Abort the in-flight turn and reject every queued turn for the conversation. */
  cancel(conversationId: string, reason?: unknown): void;
  /** Number of turns queued behind the active one. */
  pendingCount(conversationId: string): number;
  /** Abort everything and refuse further work (graceful shutdown). */
  dispose(): void;
}

export interface LiveSessionManagerOptions {
  /** Executes a single turn — typically `MonoAgentHarness.run`. */
  readonly run: (request: AgentHarnessRequest) => Promise<AgentHarnessResponse>;
}

interface QueuedTurn {
  readonly request: AgentHarnessRequest;
  readonly resolve: (response: AgentHarnessResponse) => void;
  readonly reject: (error: unknown) => void;
}

interface ConversationQueue {
  readonly pending: QueuedTurn[];
  draining: boolean;
  activeController: AbortController | undefined;
  activeTurn: QueuedTurn | undefined;
}

export function createLiveSessionManager(options: LiveSessionManagerOptions): LiveSessionManager {
  const conversations = new Map<string, ConversationQueue>();
  let disposed = false;

  function queueFor(conversationId: string): ConversationQueue {
    let queue = conversations.get(conversationId);
    if (queue === undefined) {
      queue = { pending: [], draining: false, activeController: undefined, activeTurn: undefined };
      conversations.set(conversationId, queue);
    }
    return queue;
  }

  function linkAbort(parent: AbortSignal, controller: AbortController): void {
    if (parent.aborted) {
      controller.abort(parent.reason);
      return;
    }
    parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  }

  async function drain(conversationId: string, queue: ConversationQueue): Promise<void> {
    if (queue.draining) {
      return;
    }
    queue.draining = true;
    try {
      while (queue.pending.length > 0) {
        const turn = queue.pending.shift() as QueuedTurn;
        const controller = new AbortController();
        linkAbort(turn.request.abortSignal, controller);
        queue.activeController = controller;
        queue.activeTurn = turn;
        try {
          const result = await options.run({ ...turn.request, abortSignal: controller.signal });
          turn.resolve(result);
        } catch (error) {
          turn.reject(error);
        } finally {
          queue.activeController = undefined;
          queue.activeTurn = undefined;
        }
      }
    } finally {
      queue.draining = false;
      // Forget the conversation once fully idle so the map does not grow
      // unbounded. Safe: this runs synchronously after the while-exit, so no
      // enqueue can interleave between the empty check and the delete.
      if (queue.pending.length === 0 && queue.activeController === undefined && conversations.get(conversationId) === queue) {
        conversations.delete(conversationId);
      }
    }
  }

  return {
    enqueue(conversationId: string, request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
      if (disposed) {
        return Promise.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
      }
      const queue = queueFor(conversationId);
      const promise = new Promise<AgentHarnessResponse>((resolve, reject) => {
        queue.pending.push({ request, resolve, reject });
      });
      void drain(conversationId, queue);
      return promise;
    },
    cancel(conversationId: string, reason?: unknown): void {
      const queue = conversations.get(conversationId);
      if (queue === undefined) {
        return;
      }
      queue.activeController?.abort(reason);
      const dropped = queue.pending.splice(0);
      for (const turn of dropped) {
        turn.reject(new AgentResponseCancelledError("Cancelled while queued.", { reason }));
      }
    },
    pendingCount(conversationId: string): number {
      return conversations.get(conversationId)?.pending.length ?? 0;
    },
    dispose(): void {
      disposed = true;
      for (const [conversationId, queue] of conversations) {
        queue.activeController?.abort();
        // Shutdown does not wait for a runner to honor the abort — settle the
        // in-flight turn's promise directly so callers never hang. A later
        // resolve/reject from the drain loop is a no-op on a settled promise.
        queue.activeTurn?.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
        const dropped = queue.pending.splice(0);
        for (const turn of dropped) {
          turn.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
        }
        conversations.delete(conversationId);
      }
    },
  };
}
