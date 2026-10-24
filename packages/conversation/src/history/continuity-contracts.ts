import type { RuntimeDurableCompactionCheckpoint } from "@mono-agent/turn/host/types";
import type { HistoryMessage } from "../context/types.js";

export interface CanonicalContinuityState {
  /** Stable digest of the validated canonical representation; null means absent. */
  readonly digest: string | null;
  readonly messages: readonly HistoryMessage[];
  readonly epoch?: string;
  readonly revision?: number;
  readonly settlement?: { readonly turnId: string; readonly outcome: string };
}
export interface OwnedContinuityContext {
  readonly conversationId: string;
  /** Borrow the existing owner. Never acquire/release a second conversation lease. */
  readonly assertOwned: () => Promise<void>;
}
export interface OwnedContinuityMutation extends OwnedContinuityContext {
  readonly before: CanonicalContinuityState;
  readonly after: CanonicalContinuityState;
  readonly action: "publish" | "reset" | "delete";
}
export interface PreparedContinuityPublication {
  /** Called only after canonical file and directory durability, before owner release. */
  commit(current: CanonicalContinuityState): Promise<void>;
}
/** Optional participant; absent means exactly the legacy path, including OFF mode. */
export interface ConversationHistoryContinuityParticipant {
  checkpoint(context: OwnedContinuityContext & { readonly current: CanonicalContinuityState; readonly runId: string;
    readonly phase: "prepare" | "committed"; readonly evidence: RuntimeDurableCompactionCheckpoint }): Promise<void>;
  recoverCheckpoint(context: OwnedContinuityContext & { readonly current: CanonicalContinuityState; readonly evidence?: RuntimeDurableCompactionCheckpoint }): Promise<void>;
  reconcile(context: OwnedContinuityContext & { readonly current: CanonicalContinuityState }): Promise<void>;
  prepare(mutation: OwnedContinuityMutation): Promise<PreparedContinuityPublication | undefined>;
  /** Prepared physical owners and non-summary reference pins protect retention.
   * Summary pins alone never lease canonical files against age/quota eviction. */
  protectedConversations(): Promise<readonly string[]>;
  /** Called under the existing whole-logical-conversation reset owner. */
  resetLogical(context: OwnedContinuityContext): Promise<void>;
}
