import type { AgentContextImportRequest, AgentContextImportResult } from "@mono-agent/contracts";
import type { RuntimeSessionTurnDescriptor, RuntimeSessionTurnReconciliationResult, RuntimeNativeJournalAuthority } from "@mono-agent/turn/host/types";
import type { HistoryMessage } from "../context/types.js";
import type { PendingTurnInput, PendingTurnCandidate, PendingTurnPayload } from "./pending-turn/contract.js";
import type { ModelSwitchState, ModelSwitchFence, SummaryAttempt, NativeTurnHistory, HandoffReference, CanonicalJournalDescriptor } from "./model-switch/contract.js";

/** A validated history replacement prepared before the turn commit boundary. */
export interface PreparedHistoryAppend {
  /** Atomically publish the prepared history. Idempotent after success. */
  commit(): Promise<void>;
  /** Remove unpublished staging bytes. Idempotent and a no-op after commit. */
  abort(): Promise<void>;
}

export interface ProviderSessionTurnCommitOptions {
  /** Whether the provider durably synchronized the completed turn into this session. */
  readonly providerSessionSynced: boolean;
}

/** Storage-only native inspection request. The configured owner supplies its root/model. */
export interface ConversationHistoryTurnInspection {
  readonly descriptor: RuntimeSessionTurnDescriptor;
  readonly purpose: "execution" | "compaction";
  readonly modelKey: string;
  readonly expectedInputs: readonly { readonly id: string; readonly requestDigest: string; readonly placement: "initial" | "live" }[];
}
export interface ConversationHistoryTurnRecovery {
  readonly status: "clean" | "recovered" | "interrupted";
  readonly turnId?: string;
  readonly outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  readonly providerSessionId?: string;
  readonly providerSessionRevision?: number;
}
export interface ConversationHistoryTurnReconciliation {
  /** Native fsync/matching proof populated by prepareCommit; canonical commit still required. */
  readonly settlement?: { readonly nativeReusable: boolean } | undefined;
  readonly descriptor: RuntimeSessionTurnDescriptor;
  /** Immutable generation durable before dispatch/native live admission. */
  admit(input: PendingTurnInput): Promise<void>;
  claim(disposition: PendingTurnPayload["disposition"], candidate?: PendingTurnCandidate): Promise<void>;
}
export type ConversationHistoryTurnInspector = (request: ConversationHistoryTurnInspection) => Promise<RuntimeSessionTurnReconciliationResult>;

export interface ProviderSessionTurnBinding {
  readonly modelKey: string;
  /** Manual compaction only: reject an existing different binding without retiring it. */
  readonly skipModelRotation?: boolean;
  /** Host dispatch selected the original path and cannot borrow native authority. */
  readonly unpreparedNativeDispatch?: true;
  readonly reconciliation?: {
    readonly ownerKey: string;
    readonly purpose: "execution" | "compaction";
    readonly initial?: { readonly persistText: string; readonly timestamp: string; readonly senderLabel?: string };
  };
}

/** A conversation-exclusive provider turn owned by durable history state. */
export interface ConversationHistoryProviderSessionTurn {
  readonly reconciliation?: ConversationHistoryTurnReconciliation;
  readonly recovery?: ConversationHistoryTurnRecovery;
  readonly modelKey?: string;
  readonly previousModelKey?: string;
  /** A pre-model-binding provider record was replaced without guessing its model owner. */
  readonly previousModelWasUnbound?: boolean;
  /** The unreadable canonical record was set aside (never deleted); this turn starts from empty history. */
  readonly historySetAside?: true;
  /** Epoch-derived, filesystem-safe provider session id for this turn. */
  readonly providerSessionId: string;
  /** Durable transcript revision present before this turn starts. */
  readonly providerSessionRevision: number;
  /**
   * Stage history and provider-session cleanliness as one atomic replacement.
   * The turn lock remains held until the returned append commits or aborts.
   */
  prepareCommit(
    messages: readonly HistoryMessage[],
    options: ProviderSessionTurnCommitOptions,
  ): Promise<PreparedHistoryAppend>;
  /** Leave the durable session dirty and release the exclusive turn lock. */
  abort(): Promise<void>;
}

/** Short-transaction exclusive turn used outside durable provider-session mode. */
export interface ConversationHistoryExclusiveTurn {
  readonly history: readonly HistoryMessage[];
  /** Opaque, non-empty UTF-8 token capped by CONVERSATION_HISTORY_VERSION_MAX_BYTES. */
  readonly historyVersion: string;
  prepareCommit(messages: readonly HistoryMessage[]): Promise<{
    readonly append: PreparedHistoryAppend;
    /** Opaque version for the record that `append.commit()` will publish. */
    readonly committedHistoryVersion: string;
  }>;
  abort(): Promise<void>;
}

export interface ConversationHistoryContextImport {
  readonly version: 1;
  readonly maxTextBytes: number;
  readonly providerState: "absent" | "retire-fail-closed";
  /** Cancel ownership acquisition only; an already-started mutation finishes. */
  beginExclusiveTurn(conversationId: string, signal?: AbortSignal): Promise<ConversationHistoryExclusiveTurn>;
  prepareImport(
    conversationId: string,
    request: AgentContextImportRequest & { readonly timestamp: string },
  ): Promise<{
    readonly result: AgentContextImportResult;
    readonly append?: PreparedHistoryAppend;
  }>;
}

export interface ConversationHistoryTurnDrainOptions {
  /** Per-pass inactive physical-owner bound; defaults to and never exceeds 32. */
  readonly limit?: number;
  readonly cursor?: { readonly mtimeMs: number; readonly conversationKey: string };
}
export interface ConversationHistoryTurnDrainResult {
  readonly settled: number;
  readonly busy: number;
  readonly unresolved: number;
  readonly remaining: boolean;
  readonly cursor?: { readonly mtimeMs: number; readonly conversationKey: string };
}

export interface ConversationHistoryStore {
  /** Positive owned preparation contract; signal cancels acquisition only.
   * Does not acknowledge stopped older writers. */
  beginProviderSessionPreparation?(conversationId: string, runId: string, signal?: AbortSignal): Promise<ManagedProviderSessionPreparation>;
  /** Opted-in owner-held, storage-only native turn settlement. load() stays read-only. */
  readonly providerSessionReconciliation?: "v1" | undefined;
  recoverProviderSessionTurn?(conversationId: string): Promise<ConversationHistoryTurnRecovery>;
  drainPendingProviderSessionTurns?(options?: ConversationHistoryTurnDrainOptions): Promise<ConversationHistoryTurnDrainResult>;
  /**
   * Present only when epoch rotation/retention can fail closed while removing
   * provider-owned durable transcripts that canonical history supersedes.
   */
  readonly providerSessionRetirement?: "fail-closed" | undefined;
  /** Positive v1 support contract; legacy append existence does not imply support. */
  readonly contextImport?: ConversationHistoryContextImport | undefined;
  load(conversationId: string): Promise<readonly HistoryMessage[]>;
  append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void>;
  /**
   * Replace one conversation's canonical history with an empty, fresh provider
   * epoch. Stores that support interactive session resets implement this
   * atomically; unrelated conversations are never touched.
   */
  reset?(conversationId: string): Promise<void>;
  /**
   * Reset every canonical message bucket owned by one logical conversation.
   * Daily-rollover hosts require this capability so reset cannot leave prior
   * day buckets visible while clearing logical tool history.
   */
  resetLogicalConversation?(logicalConversationId: string): Promise<void>;
  /**
   * Optional transactional path used by the harness to validate and fsync a
   * turn before it marks the conversation committed. Stores that omit it keep
   * the legacy append contract; the harness still appends before warming a
   * provider session and retires that session on failure.
   */
  prepareAppend?(
    conversationId: string,
    messages: readonly HistoryMessage[],
  ): Promise<PreparedHistoryAppend>;
  /**
   * Optional crash-safe provider-session transaction. Durable stores mark the
   * session dirty before returning and serialize this conversation across
   * processes until commit or abort.
   */
  beginProviderSessionTurn?(
    conversationId: string,
    runId: string,
    binding?: ProviderSessionTurnBinding,
    /** Acquisition only; publication and cleanup are not interrupted. */
    signal?: AbortSignal,
  ): Promise<ConversationHistoryProviderSessionTurn>;
  /**
   * Optional read-only view of the provider-session model binding, without
   * taking the turn lock or marking the session dirty. `native` is a routing
   * hint only; dispatch still requires an owned current-journal proof. Manual compaction uses
   * it to decline a conversation bound to another model instead of rotating it.
   */
  readProviderSessionBinding?(conversationId: string): Promise<{ readonly modelKey?: string; readonly revision: number; readonly native?: true } | undefined>;
}

export interface InMemoryHistoryStoreOptions {
  readonly maxMessages?: number;
}

export interface NativeHistoryAuthorityLease {
  readonly status: "owned";
  readonly authority: RuntimeNativeJournalAuthority;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/** Administrative storage only; never a dispatch/capability advertisement. */
export interface ManagedModelSwitchStorageLease {
  readonly status: "owned";
  read(): Promise<{ readonly state: ModelSwitchState; readonly fence: ModelSwitchFence } | undefined>;
  admit(producer: SummaryAttempt["producer"]): Promise<ModelSwitchState>;
  finish(producer: SummaryAttempt["producer"], outcome: "unknown" | "rejected"): Promise<ModelSwitchState>;
  advanceUnfit(): Promise<ModelSwitchState>;
  assertMessageUnconsumed(messageDigest: string): Promise<void>;
  authorizeMessage(messageDigest: string): Promise<ModelSwitchState>;
  accept(artifact: Record<string, unknown>): Promise<HandoffReference>;
  recoverArtifact(): Promise<HandoffReference | undefined>;
  /** Releases the claim, never the durable fence or evidence. */
  release(): Promise<void>;
}
export interface ManagedProviderSessionPreparation {
  readonly recovery: ConversationHistoryTurnRecovery;
  read(): Promise<ProviderSessionPreparationSnapshot>;
  /** Caller-supplied provenance is used only for a legacy source's API/model;
   * its account is explicitly null, never inferred from current credentials.
   * A definitively missing current journal captures canonical history instead. */
  captureNativeEvidence(legacyProvenance?: import("@mono-agent/turn/host/types").RuntimeNativeJournalDescriptor["provenance"]): Promise<{
    readonly source: CanonicalJournalDescriptor | null; readonly view: import("@mono-agent/turn/host/types").RuntimeNativeEvidenceView;
  }>;
  readHandoff(switchId: string, reference: HandoffReference): Promise<{ readonly artifact: Readonly<Record<string, unknown>>;
    readonly budget: import("@mono-agent/turn/host/types").RuntimeHandoffBudget }>;
  assertOwned(): Promise<void>;
  acquireNativeHistoryAuthority(): Promise<ModelSwitchStorageSupport | NativeHistoryAuthorityLease>;
  beginModelSwitchStorage(state: ModelSwitchState): Promise<ModelSwitchStorageSupport | ManagedModelSwitchStorageLease>;
  rollForwardModelSwitch(switchId: string, options?: { readonly onPhase?: (phase: string) => Promise<void> }): Promise<{ readonly status: "pending" | "committed" | "absent" }>;
  /** Storage-only release of a non-ready intent (no target journal exists yet).
   * Its billing state stays retained and charged; no producer or provider runs. */
  abandonModelSwitch(switchId: string): Promise<void>;
  /** missingCurrentEpoch is owner-approved recovery of an externally missing current
   * journal: when that exact epoch is still canonical, admission first rotates it
   * through the existing same-model cold path (v3 retire/new epoch, v5 durable C).
   * Every model change goes through the structured switch; there is no cold one. */
  admit(binding: ProviderSessionTurnBinding, options?: { readonly missingCurrentEpoch?: string }): Promise<ConversationHistoryProviderSessionTurn & { readonly native?: NativeTurnHistory["native"]; assertOwned(): Promise<void> }>;
  /** @internal Read-only probe of the canonical current journal under this owner.
   * `absent` means no current journal is expected yet (or no probe capability). */
  inspectCurrentJournal?(): Promise<CurrentJournalPresence>;
  abort(): Promise<void>;
}
export type CurrentJournalPresence = { readonly status: "absent" | "present" }
  | { readonly status: "missing"; readonly epoch: string }
  | { readonly status: "unreadable"; readonly reason: string };
export interface ProviderSessionPreparationSnapshot {
  readonly history: readonly HistoryMessage[];
  readonly source: ModelSwitchStorageSource;
  readonly native?: NativeTurnHistory["native"];
  readonly lastSwitch?: NativeTurnHistory["lastSwitch"];
  readonly pending?: ModelSwitchState;
}
export type ModelSwitchStorageSupport = { readonly status: "unsupported"; readonly reason: "id_limit" | "unbound" };

export type ModelSwitchStorageSource = ModelSwitchStorageSupport | {
  readonly status: "supported"; readonly sourceCanonicalDigest: string; readonly sourceRevision: number;
  readonly fromModelKey: string; readonly sourceEpoch: string; readonly ownerKey: string;
};
