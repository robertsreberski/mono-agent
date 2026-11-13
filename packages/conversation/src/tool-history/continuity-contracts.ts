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
  /** Legacy chronological search remains the default, including AND queries. */
  readonly mode?: "chronological" | "relevance";
  readonly continuation?: ContinuityRelevanceContinuation;
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

export interface ContinuityPreviewRange {
  readonly start: number;
  readonly end: number;
  readonly clippedBefore: boolean;
  readonly clippedAfter: boolean;
  /** Present when the matched span itself exceeds the UTF-8 preview window. */
  readonly matchClipped?: true;
  /** The transport response cap shortened this window, possibly removing the hit. */
  readonly responseClipped?: true;
  /** A preview never witnesses completed recovery, even for a short record. */
  readonly complete: false;
}
export interface ContinuityRelevanceContinuation {
  readonly version: 2;
  readonly rankingVersion: 1 | 2 | 3;
  readonly query: string;
  readonly limit: number;
  readonly watermark: number;
  readonly manifest: string;
  readonly anchor: { readonly recordId: string; readonly ordinal: number; readonly score: number };
}
export interface ContinuitySearchScan {
  readonly complete: boolean;
  readonly records: number;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly maxBatchMs: number;
  readonly metadataPages: number;
  readonly textBatches: number;
}
export interface ContinuityPreview {
  readonly preview: string;
  readonly previewRange: ContinuityPreviewRange;
}
export interface ContinuitySearchPage {
  readonly available: boolean;
  readonly items: readonly (ContinuityRecordMetadata & { readonly preview: string; readonly previewRange?: ContinuityPreviewRange; readonly additionalPreviews?: readonly ContinuityPreview[] })[];
  readonly next?: number;
  readonly mode?: "chronological" | "relevance" | "literal";
  readonly rankingVersion?: 1 | 2 | 3;
  readonly continuation?: ContinuityRelevanceContinuation;
  /** One boundary per emitted item, index-aligned with items on every relevance
   * page (including the final page). When more results exist, continuation equals
   * the last boundary. A transport-limited prefix can resume at its last item. */
  readonly resumeAfter?: readonly ContinuityRelevanceContinuation[];
  readonly degradedReason?: "scan_capacity" | "source_changed" | "invalid_cursor" | "purge_pending";
  readonly scan?: ContinuitySearchScan;
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

export interface LedgerCursor { readonly ordinal: number; readonly offset: number; readonly digest: string; readonly watermark: number }
export interface LedgerOffer { readonly key: string; readonly ordinal: number; readonly digest: string; readonly start: number; readonly end: number }
/** Cursor is a proposed upper bound: the writer advances only a verified
 * contiguous offered/oversized prefix. Caller keys cannot override source geometry. */
export interface LedgerProgress { readonly cursor: LedgerCursor; readonly spans: readonly LedgerOffer[] }

/** Bounded legacy pack snapshot or independently paged ranked upkeep scan. */
export interface ContinuitySnapshotInput extends ContinuityScope {
  readonly selection?: "upkeep";
  /** Already validated current-ledger citations, excluded before fairness queues. */
  readonly priorCovered?: readonly string[] | undefined;
  /** Internal test/preflight ceilings; may only lower the fixed runtime limits. */
  readonly scanBudget?: Partial<{ rows: number; bytes: number; windows: number; ms: number }>;
  readonly historyBoundary?: string;
}
/** Host publication identity, not native-session admission authority. Serialized
 * bindings must always be resolved again under the current owner's scope. */
export interface RetainedSummaryBinding {
  readonly version: 1;
  readonly logicalConversationId: string;
  readonly conversationId: string;
  readonly generationId: string;
  readonly recordId: string;
  readonly sha256: string;
  readonly retainedBytes: number;
  readonly sourceEpoch: string;
  readonly sourceRevision: number;
  readonly publication: {
    readonly journalId: string;
    readonly operationId: string;
    readonly sourceDigest: string;
    readonly summaryDigest: string;
  };
}

/** Only an owner-held lookup of committed checkpoint state supplies this proof.
 * It contains retained bytes only; it grants no native admission or protection. */
export interface RetainedSummaryProof {
  readonly binding: RetainedSummaryBinding;
  readonly text: string;
}

/** Untrusted renderer location: last renderer output, not injected, not admitted.
 * Never publication or admission authority. The supplier's lastRenderedSummary()
 * is shared mutable state, not bound to any attempt's injected messages. UTF-8
 * offsets delimit the complete rendered entry (including its trailing newline). */
export interface RetainedSummarySelection {
  readonly recordId: string;
  readonly generationId: string;
  readonly sha256: string;
  readonly retainedBytes: number;
  readonly packSha256: string;
  readonly entry: { readonly startByte: number; readonly endByte: number; readonly sha256: string };
}

export interface ContinuitySnapshotRecord extends ContinuityRecordMetadata {
  readonly text: string;
  readonly tool?: { readonly name: string; readonly state: string; readonly arguments: string; readonly invocationId: string; readonly resultId?: string };
}
export interface ContinuitySnapshot {
  readonly records: readonly ContinuitySnapshotRecord[];
  readonly omitted: number;
  readonly gaps: number;
  readonly upkeep?: { readonly cursor?: LedgerCursor | undefined; readonly watermark: number; readonly excluded: readonly string[];
    readonly candidates?: readonly { key: string; ordinal: number; start: number; end: number; score: number; offers: number; source?: string }[];
    readonly scan?: { limits?: { rows: number; bytes: number; windows: number; ms: number }; complete: boolean; rows: number; bytes: number; windows: number; pages: number; bindingQueries: number; bindings: number; elapsedMs: number; diversity?: { templates: number; repeated: number; templateSuppressed: number; recordSuppressed: number; sources: number }; excluded: number; materializationSkipped: number; deadline: number } };
  readonly degradedReason?: "unavailable" | "purge_pending" | "boundary_unavailable" | "snapshot_bounds" | "source_unavailable" | "source_changed" | "scan_capacity";
}
