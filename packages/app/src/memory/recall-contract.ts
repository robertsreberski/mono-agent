import type { MemoryLoadOptions } from "@mono-agent/contracts";
import type { MemoryDb, MemoryType, MemoryStatus, EntityRecord } from "@mono-agent/memory/store";
type MemoryLabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
type LabelHit = MemoryLabelHit;
export interface MemoryRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly type?: MemoryType;
    readonly status?: MemoryStatus;
    readonly isInsight?: boolean;
    readonly createdAt?: string;
    readonly validFrom?: string;
    readonly validTo?: string;
    readonly dueAt?: string;
    readonly supersededBy?: string;
  };
}

export interface MemoryRecallOutcome {
  readonly hits: readonly MemoryRecallHit[];
  readonly retrievalMode: "hybrid" | "lexical_only";
  readonly degradation?: { readonly code: "embedding_unavailable" };
}

/** Read-only recall surface the MCP server formats. Both backend stores satisfy it structurally. */
export interface RecallCapableStore extends LabelRecallStore {
  intentExpiryEnabled?(): boolean;
  recencyEnabled?(): boolean;
  rankDeliberateRecall?(hits: readonly MemoryRecallHit[]): readonly MemoryRecallHit[];
  labelSections?(request: LabelSectionRequest, candidates: readonly MemoryRecallHit[], observation?: LabelContext): LabelSections | undefined;
  recall(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<readonly MemoryRecallHit[]>;
  /** Optional local capability. Array-only backends keep their strict behavior. */
  recallWithOutcome?(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<MemoryRecallOutcome>;
  /**
   * App-owned per-logical-turn capability. Standalone and capability-free
   * programmatic stores omit it, so they never advertise an original-query mode
   * they cannot fulfill.
   */
  recallOriginalWithOutcome?(options?: { readonly topK?: number }): Promise<
    | { readonly available: true; readonly query: string; readonly outcome: MemoryRecallOutcome }
    | {
        readonly available: false;
        readonly reason: "not_loaded" | "empty" | "lookup_failed" | "replaced";
      }
  >;
  /** Optional deterministic one-hop expansion, used only by the explicit tool. */
  expandGraph?(
    query: string,
    directHits: readonly MemoryRecallHit[],
    options?: { readonly topK?: number },
  ): readonly MemoryRecallHit[] | Promise<readonly MemoryRecallHit[]>;
  /** Explicit capability check for stores whose graph method is tier-dependent. */
  supportsGraphExpansion?(): boolean;
  /** Record only the final hits actually served by the tool. */
  recordAccess?(ids: readonly string[]): void;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryRecallRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}
export interface LabelRecallStore {
  labelsForEntity?(id: string, date?: string): readonly MemoryLabelHit[];
  guidanceForScope?(scope: string): readonly MemoryLabelHit[];
  findMemoryEntitiesByNames?(names: readonly string[]): readonly EntityRecord[];
  /** Labels on these memory ids: attribution and deliberate label sections. */
  labelsForMemories?(memoryIds: readonly string[]): readonly MemoryLabelHit[];
}
export type LabelKind = "fact" | "preference" | "lesson";

export interface LabelSectionRequest {
  readonly query: string;
  readonly kind?: LabelKind;
  readonly about?: string;
}

export interface LabelContext extends MemoryLoadOptions { readonly conversationId?: string }

export interface FactSheetEntry {
  readonly entityId: string;
  readonly name: string;
  readonly key?: string;
  readonly value?: Extract<LabelHit["label"], { kind: "fact" }>["value"];
  /** The stored line itself is the only claim carried by a coarse fact. */
  readonly text?: string;
  readonly attribution: string;
  readonly recordedAt: string;
  readonly current: boolean;
  readonly conflict: boolean;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
}

export interface GuidanceEntry {
  readonly kind: "preference" | "lesson";
  readonly scope: string;
  readonly text: string;
  readonly recordedAt: string;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
}

export interface LabelSections {
  readonly factSheet?: readonly FactSheetEntry[];
  readonly factSheetTruncated?: boolean;
  readonly preferencesAndLessons?: readonly GuidanceEntry[];
  readonly preferencesAndLessonsTruncated?: boolean;
  readonly text: string;
}
