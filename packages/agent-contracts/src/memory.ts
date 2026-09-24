export interface MemoryBlock {
  readonly kind: "markdown";
  readonly content: string;
  readonly source: string;
  readonly truncated: boolean;
}

/**
 * One successfully completed provider turn, ready for idempotent memory admission.
 *
 * `runId` is the retry key. A store must treat repeated inputs carrying the same
 * run id as the same completed turn rather than creating another logical record.
 * `summary` is the host's deterministic compact projection; `captureText`, when
 * present, is the complete host-approved turn text for richer extraction.
 */
export type MemoryCaptureSpeakerKind = "human-turn" | "trigger" | "unknown";

export interface MemoryCaptureEvidence {
  /** Host-owned outer message (not parsed from model-visible captureText). */
  readonly userText: string;
  /** Stable host-derived opaque sender token; absent when no sender id was verified. */
  readonly senderToken?: string;
  /** Host-confirmed owner/operator turn; omitted for channels and legacy intake. */
  readonly ownerTurn?: true;
  readonly toolOutcomes: readonly { readonly category: "read" | "write" | "edit" | "execute" | "search";
    readonly outcome: "failed" | "succeeded" }[];
}

export interface MemoryCompletedTurn {
  readonly runId: string;
  readonly conversationId: string;
  readonly summary: string;
  readonly captureText?: string;
  /**
   * Host-verified outer-turn origin, not derived from captureText or display metadata.
   * Omission means unknown (including legacy/direct callers). A channel may set
   * human-turn only after verifying its own sender; operator turns count when
   * authorized by an owner key or bound loopback-only. Automation using that
   * owner interface is consequently attributed as the owner. This is not a
   * proof of assertions in the turn or of any third-party quoted content.
   */
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly captureEvidence?: MemoryCaptureEvidence;
}

export type MemoryCompletedTurnAdmissionStatus = "admitted" | "duplicate";

/** Proof that a completed turn reached the store's idempotent admission boundary. */
export interface MemoryCompletedTurnResult {
  /** Stable store identifier for this logical completed turn. */
  readonly id: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly source: string;
  readonly bytesWritten: number;
  /** `duplicate` means the same run was already admitted; both states are successful. */
  readonly admissionStatus: MemoryCompletedTurnAdmissionStatus;
}

/** Optional host context for one memory read. Existing stores may ignore it. */
export interface MemoryLoadOptions {
  /** Stable id for one provider turn, used only to deduplicate reads within that turn. */
  readonly turnId?: string;
  /** Host-stamped token matching capture's identified human speaker; never model text. */
  readonly senderToken?: string;
  /** Host observation date (UTC, matching capture's ISO timestamp). */
  readonly hostDate?: string;
}

export interface MemoryStore {
  /**
   * Prime a turn with relevant memories. `query` is the text to recall against (typically the
   * current user message). When omitted, implementations fall back to a coarse per-conversation
   * seed for backward compatibility.
   */
  load(conversationId: string, query?: string, options?: MemoryLoadOptions): Promise<MemoryBlock | undefined>;
  /**
   * Strong completed-turn write. Resolves only after the store has accepted the
   * stable run id at its durable or remote idempotent admission boundary, and
   * rejects when admission fails. Optional for read-only stores; hosts enabling
   * memory writes require this method.
   */
  persistCompletedTurn?(turn: MemoryCompletedTurn): Promise<MemoryCompletedTurnResult>;
  /** Await admitted background writes and indexing (graceful shutdown / one-shot exit). */
  flush?(): Promise<void>;
  /** Optional host lifecycle hook for dropping per-turn read caches. */
  releaseTurn?(turnId: string): void | Promise<void>;
}
