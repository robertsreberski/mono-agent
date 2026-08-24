import { CodedError } from "./coded-error.js";

/** Built-in memory tiers that can expose authoritative operator state. */
export type MemoryOperatorTier = "lite" | "journal" | "bujo";

export type MemoryOperatorBackend = "builtin" | "supermemory";
export type MemoryOperatorCapabilityStatus = "ready" | "degraded" | "unsupported";
export type MemoryOperatorGraphFidelity = "captured" | "derived" | "unavailable";

/** Additive `/v1/info` capability advertised by an agent-owned memory operator. */
export interface MemoryOperatorCapability {
  readonly schema: 1;
  readonly backend: MemoryOperatorBackend;
  readonly tier?: MemoryOperatorTier;
  readonly status: MemoryOperatorCapabilityStatus;
  readonly read: boolean;
  readonly actions: boolean;
  readonly graph: MemoryOperatorGraphFidelity;
  /** Sanitized operator-facing explanation; never a raw provider error or path. */
  readonly reason?: string;
}

export type MemoryOperatorRecordType = "task" | "event" | "note";
export type MemoryOperatorRecordStatus =
  | "open"
  | "done"
  | "scheduled"
  | "migrated"
  | "dropped"
  | "invalidated";
export type MemoryOperatorLifecycle = "active" | "superseded" | "forgotten";

/** Sanitized canonical record. Filesystem locations and vector payloads are intentionally absent. */
export interface MemoryOperatorRecord {
  readonly id: string;
  /** Stable digest used as the optimistic-concurrency precondition. */
  readonly revision: string;
  readonly lifecycle: MemoryOperatorLifecycle;
  readonly type: MemoryOperatorRecordType;
  readonly status: MemoryOperatorRecordStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly lastAccessedAt?: string;
  readonly accessCount: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly dueAt?: string;
  readonly tags: readonly string[];
  readonly collection?: string;
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  /** Logical conversation provenance only; canonical filenames and line numbers stay private. */
  readonly source?: { readonly conversationId?: string };
}

export interface MemoryOperatorActionHistoryItem {
  readonly id: string;
  readonly action: "edit" | "forget" | "restore";
  readonly status: "succeeded" | "failed";
  readonly recordId: string;
  readonly resultRecordId?: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly errorCode?: string;
}

export interface MemoryOperatorRecordDetail {
  readonly record: MemoryOperatorRecord;
  readonly history: readonly MemoryOperatorActionHistoryItem[];
}

export interface MemoryOperatorOverview {
  readonly generatedAt: string;
  readonly capability: MemoryOperatorCapability;
  readonly counts: {
    readonly total: number;
    readonly active: number;
    readonly superseded: number;
    readonly forgotten: number;
    readonly byType: Readonly<Record<MemoryOperatorRecordType, number>>;
  };
  readonly access: {
    readonly totalCount: number;
    readonly accessedRecords: number;
  };
  readonly embedding?: { readonly model?: string; readonly dimension?: number };
}

export interface MemoryOperatorRecordQuery {
  readonly query?: string;
  readonly lifecycle?: MemoryOperatorLifecycle;
  readonly type?: MemoryOperatorRecordType;
  readonly collection?: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface MemoryOperatorRecordPage {
  readonly records: readonly MemoryOperatorRecord[];
  readonly nextCursor?: string;
}

export type MemoryOperatorGraphNode =
  | {
      readonly kind: "entity";
      readonly id: string;
      readonly label: string;
      readonly entityType?: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "memory";
      readonly id: string;
      readonly label: string;
      readonly lifecycle: MemoryOperatorLifecycle;
      readonly recordType: MemoryOperatorRecordType;
    };

export interface MemoryOperatorGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: "relation" | "association" | "supports" | "supersedes";
  readonly label?: string;
  readonly weight?: number;
}

export interface MemoryOperatorGraph {
  readonly fidelity: MemoryOperatorGraphFidelity;
  readonly nodes: readonly MemoryOperatorGraphNode[];
  readonly edges: readonly MemoryOperatorGraphEdge[];
  readonly truncated?: true;
}

export interface MemoryOperatorGraphQuery {
  readonly focusId?: string;
  readonly includeHistory?: boolean;
  readonly limit?: number;
}

export interface MemoryOperatorSemanticPatch {
  readonly text?: string;
  readonly type?: MemoryOperatorRecordType;
  readonly tags?: readonly string[];
  readonly salience?: number;
  readonly collection?: string | null;
  readonly dueAt?: string | null;
  readonly validFrom?: string | null;
}

export interface MemoryOperatorActionInput {
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly confirmationToken?: string;
}

export interface MemoryOperatorEditInput extends MemoryOperatorActionInput {
  readonly patch: MemoryOperatorSemanticPatch;
}

export interface MemoryOperatorConfirmation {
  readonly token: string;
  readonly expiresAt: string;
  readonly message: string;
}

export type MemoryOperatorErrorCode =
  | "invalid_request"
  | "not_found"
  | "actions_disabled"
  | "revision_conflict"
  | "confirmation_invalid"
  | "idempotency_conflict"
  | "replay_expired"
  | "unavailable";

export interface MemoryOperatorErrorDetails {
  readonly code?: MemoryOperatorErrorCode;
  readonly [key: string]: unknown;
}

/** Stable service-layer error consumed by operator adapters without leaking paths or providers. */
export class MemoryOperatorError extends CodedError<MemoryOperatorErrorCode> {
  declare readonly details: MemoryOperatorErrorDetails;

  constructor(
    code: MemoryOperatorErrorCode,
    message: string,
    details: MemoryOperatorErrorDetails = {},
  ) {
    super(code, message, details);
  }
}

export type MemoryOperatorMutationAdmission =
  | { readonly kind: "confirmation_required"; readonly confirmation: MemoryOperatorConfirmation }
  | { readonly kind: "queued"; readonly operation: MemoryOperatorOperation };

export type MemoryOperatorOperationStatus =
  | "queued"
  | "draining"
  | "applying"
  | "succeeded"
  | "failed";

export interface MemoryOperatorOperation {
  readonly id: string;
  readonly action: "edit" | "forget" | "restore";
  readonly recordId: string;
  readonly status: MemoryOperatorOperationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultRecordId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** Narrow agent-owned operator surface; independent from the runtime MemoryStore contract. */
export interface MemoryOperatorService {
  capability(): MemoryOperatorCapability | Promise<MemoryOperatorCapability>;
  overview(): MemoryOperatorOverview | Promise<MemoryOperatorOverview>;
  records(query: MemoryOperatorRecordQuery): MemoryOperatorRecordPage | Promise<MemoryOperatorRecordPage>;
  record(id: string): MemoryOperatorRecordDetail | Promise<MemoryOperatorRecordDetail>;
  graph(query: MemoryOperatorGraphQuery): MemoryOperatorGraph | Promise<MemoryOperatorGraph>;
  edit(id: string, input: MemoryOperatorEditInput): MemoryOperatorMutationAdmission | Promise<MemoryOperatorMutationAdmission>;
  forget(id: string, input: MemoryOperatorActionInput): MemoryOperatorMutationAdmission | Promise<MemoryOperatorMutationAdmission>;
  restore(id: string, input: MemoryOperatorActionInput): MemoryOperatorMutationAdmission | Promise<MemoryOperatorMutationAdmission>;
  operation(id: string): MemoryOperatorOperation | Promise<MemoryOperatorOperation>;
}
