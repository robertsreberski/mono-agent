import { AsyncLocalStorage } from "node:async_hooks";

import type { MemoryDb } from "../store/index.js";

import { hasPendingCaptureIntent, replayCaptureOutbox } from "./capture-outbox.js";
import { canonicalMemoryRoot } from "./generations.js";
import {
  assertNoPendingMigrateDecision,
  recoverPendingMigrateDecision,
} from "./migrate.js";
import type { BujoTier } from "./types.js";

interface MutationContext {
  readonly roots: ReadonlyMap<string, MutationLease>;
}

interface MutationLease {
  active: boolean;
}

export interface SerializedBujoMutation {
  readonly root: string;
  readonly db: MemoryDb;
  readonly tier?: BujoTier;
  readonly abortSignal?: AbortSignal;
}

const MUTATION_CONTEXT = new AsyncLocalStorage<MutationContext>();
const MUTATION_CHAINS = new Map<string, Promise<void>>();

/**
 * Serialize every stateful operation for one canonical memory root. The lock
 * spans provider-backed planning and the complete durable replay boundary, so
 * a second caller can only plan against the first caller's committed result.
 *
 * Capture is intentionally nested (captureTurn -> reconcileBatch). An async
 * context token makes that nesting reentrant while callers from another turn,
 * store queue, or exported surface still wait in FIFO order.
 */
export async function withSerializedBujoMutation<T>(
  options: SerializedBujoMutation,
  run: () => Promise<T>,
): Promise<T> {
  options.abortSignal?.throwIfAborted();
  const root = canonicalMemoryRoot(options.root, true);
  const active = MUTATION_CONTEXT.getStore();
  if (active?.roots.get(root)?.active === true) {
    options.abortSignal?.throwIfAborted();
    return await run();
  }

  const predecessor = MUTATION_CHAINS.get(root) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => mine);
  MUTATION_CHAINS.set(root, tail);

  try {
    await waitForPredecessor(predecessor, options.abortSignal);
    options.abortSignal?.throwIfAborted();
    const lease: MutationLease = { active: true };
    const roots = new Map(active?.roots ?? []);
    roots.set(root, lease);
    return await MUTATION_CONTEXT.run({ roots }, async () => {
      try {
        recoverDurableMutationState(root, options.db, options.tier ?? "bujo");
        options.abortSignal?.throwIfAborted();
        return await run();
      } finally {
        // AsyncLocalStorage is inherited by detached queue timers. Expire the
        // token before releasing the root so those later jobs cannot mistake
        // ancestry for live, awaited reentrancy and bypass serialization.
        lease.active = false;
      }
    });
  } finally {
    release();
    void tail.then(() => {
      if (MUTATION_CHAINS.get(root) === tail) MUTATION_CHAINS.delete(root);
    });
  }
}

/** Recover already-paid state in its one valid order before new planning. */
export function recoverDurableMutationState(root: string, db: MemoryDb, tier: BujoTier): void {
  // Older processes could publish these independent protocols concurrently.
  // Neither protocol carries a shared sequence, so mutating either one first
  // can make the other unreplayable. Detect the dual-pending state entirely
  // through bounded, non-mutating probes and require operator repair.
  if (hasPendingCaptureIntent(root)) {
    try {
      assertNoPendingMigrateDecision(root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        "memory-bujo: capture and migration durable state are both pending; "
        + `refusing unordered recovery before any mutation. ${reason}`,
      );
    }
  }
  if (tier === "bujo") recoverPendingMigrateDecision(root, db);
  else assertNoPendingMigrateDecision(root);
  replayCaptureOutbox(root, db);
}

async function waitForPredecessor(
  predecessor: Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (abortSignal === undefined) {
    await predecessor;
    return;
  }
  abortSignal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(abortSignal.reason);
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([predecessor, aborted]);
    abortSignal.throwIfAborted();
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}
