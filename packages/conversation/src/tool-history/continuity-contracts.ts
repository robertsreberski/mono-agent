/** Continuity extends the existing sidecar; opening an ordinary writer stays v2. */
export const CONTINUITY_USER_VERSION = 3;
export const CONTINUITY_RECORD_MAX_BYTES = 1024 * 1024;
export const CONTINUITY_CHUNK_MAX_BYTES = 8 * 1024;
export const CONTINUITY_GENERATION_MAX_RECORDS = 128;
export const CONTINUITY_GENERATION_MAX_BYTES = 16 * 1024 * 1024;

export type ContinuityKind = "owner" | "user" | "other-user" | "imported" | "assistant" | "summary" | "tool";
export type ContinuityProvenance = "host-owner" | "other-user" | "assistant" | "generated" | "tool" | "unknown";

export interface ContinuitySource {
  readonly epoch?: string;
  readonly revision?: number;
  readonly journalId?: string;
  readonly operationId?: string;
  /** Host-attested identity, staged before the corresponding input is admitted. */
  readonly attestation?: { readonly inputId: string; readonly requestDigest: string };
}

export interface ContinuitySummary {
  readonly model: string;
  readonly operationId: string;
  readonly trigger: "manual" | "pre-turn" | "reactive" | "mid-run";
  readonly coverage: {
    readonly sourceDigest: string;
    readonly firstRecordId?: string;
    readonly lastRecordId?: string;
  };
}

export interface ContinuityRecordInput {
  readonly recordId: string;
  readonly runId: string;
  readonly inputId?: string;
  readonly kind: ContinuityKind;
  readonly sequence: number;
  readonly text: string;
  readonly provenance: ContinuityProvenance;
  readonly source?: ContinuitySource;
  readonly summary?: ContinuitySummary;
}

/** Called only while the canonical conversation owner is held. */
export interface ContinuityPreparation {
  readonly generationId: string;
  readonly conversationId: string;
  readonly logicalConversationId: string;
  /** Canonical digest (null when absent). The internal lifecycle worker uses a
   * finalized receipt target only for its atomic, already-committed tool rows. */
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly action?: "publish" | "reset" | "delete" | "checkpoint";
  readonly records: readonly ContinuityRecordInput[];
  readonly latestSummaryRecordId?: string;
}

export type ContinuityCheckpointProof = { readonly status: "published"; readonly journalId: string; readonly operationId: string; readonly sourceDigest: string; readonly summaryDigest: string } | { readonly status: "absent" };

export interface ContinuityPublication {
  readonly checkpoint?: ContinuityCheckpointProof;
  readonly conversationId: string;
  readonly generationId: string;
  readonly canonicalDigest: string | null;
}

export interface ContinuityReconciliation {
  readonly checkpoint?: ContinuityCheckpointProof;
  readonly conversationId: string;
  readonly canonicalDigest: string | null;
}

export interface ContinuityReceipt {
  readonly generationId: string;
  readonly recordIds: readonly string[];
  readonly status: "prepared" | "committed";
}

export interface ContinuityReconciliationResult {
  readonly status: "clean" | "committed" | "discarded" | "abandoned" | "checkpoint_pending";
  readonly generationId?: string;
}

export type ContinuityPinOwner = "ledger" | "summary" | "checkpoint" | "handoff";
export interface ContinuityPin {
  readonly logicalConversationId: string;
  readonly recordId: string;
  readonly ownerKind: ContinuityPinOwner;
  readonly ownerId: string;
}

export interface ContinuityScope {
  readonly logicalConversationId: string;
  readonly currentConversationId: string;
  readonly currentRunId: string;
}

export interface ContinuitySearchInput extends ContinuityScope {
  readonly query?: string;
  readonly limit?: number;
  /** Stable descending sequence across physical rollover buckets. */
  readonly before?: number;
}

export interface ContinuityRecordMetadata {
  readonly recordId: string;
  readonly generationId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly inputId?: string;
  readonly kind: ContinuityKind;
  readonly sequence: number;
  readonly ordinal: number;
  readonly sha256: string;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly provenance: ContinuityProvenance;
  readonly source: ContinuitySource;
  readonly summary?: ContinuitySummary;
  readonly untrusted: true;
}

export interface ContinuitySearchPage {
  readonly available: boolean;
  readonly items: readonly (ContinuityRecordMetadata & { readonly preview: string })[];
  readonly next?: number;
}

export interface ContinuityGetInput extends ContinuityScope {
  readonly recordId: string;
  readonly chunkBytes?: number;
  readonly chunkOffset?: number;
}

export interface ContinuityGetResult {
  readonly status: "available" | "tombstoned" | "unavailable";
  readonly record?: ContinuityRecordMetadata;
  readonly chunk?: string;
  readonly nextOffset?: number;
  readonly tombstone?: { readonly recordId: string; readonly reason: string; readonly removedAtMs: number };
  readonly untrusted: true;
}

export interface ContinuityStats {
  readonly records: number;
  readonly generations: number;
  readonly prepared: number;
  readonly pins: number;
  readonly tombstones: number;
  readonly retainedBytes: number;
  readonly degraded: boolean;
  readonly coverageGaps: number;
}

export interface ContinuityCoverageGap {
  readonly generationId: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly observedDigest: string | null;
  readonly detectedAtMs: number;
  readonly reason: ContinuityGapReason;
}

export type ContinuityGapReason = "canonical_advanced_past_preparation" | "capture_bounds" | "capture_quota" | "sidecar_unavailable";
/** Content-free diagnostic. Never carries skipped messages or raw error text. */
export interface ContinuityGapInput {
  readonly generationId: string;
  readonly conversationId: string;
  readonly logicalConversationId: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly reason: ContinuityGapReason;
}

/** Bounded, one-transaction pack source; no search previews or derived storage. */
export interface ContinuitySnapshotInput extends ContinuityScope {
  readonly historyBoundary?: string;
}
export interface ContinuitySnapshotRecord extends ContinuityRecordMetadata {
  readonly text: string;
  readonly tool?: { readonly name: string; readonly state: string; readonly arguments: string; readonly invocationId: string; readonly resultId?: string };
}
export interface ContinuitySnapshot {
  readonly records: readonly ContinuitySnapshotRecord[];
  readonly omitted: number;
  readonly gaps: number;
  readonly degradedReason?: "unavailable" | "purge_pending" | "boundary_unavailable" | "snapshot_bounds" | "source_unavailable" | "source_changed";
}
