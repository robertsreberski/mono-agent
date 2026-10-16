// Canonical administrative storage contracts; no runtime imports.

/** @typedef {import("./policy.js").RuntimeCompactionPolicy} RuntimeCompactionPolicy */

/** Host-only storage authority; never a model-facing run option.
 * @typedef {{
  readonly version: 1;
  readonly rootId: string;
  readonly authorityId: string;
  readonly ownerKey: string;
  readonly historyBucket: string;
}} RuntimeNativeJournalAuthority */

/** @typedef {{
  readonly hostAuthority: RuntimeNativeJournalAuthority;
  readonly disposition: "C" | "D";
  readonly assertOwned: () => Promise<void>;
}} RuntimeNativeJournalDeletion */

/** @typedef {{
  readonly journalId: string; readonly epoch: string; readonly handleId: string;
  readonly ownerKey: string; readonly historyBucket: string;
  readonly sourceTipId: string | null; readonly sourceSeq: number; readonly sourceDigest: string;
  readonly provenance: { readonly provider: string; readonly api: string; readonly model: string; readonly account: string | null };
}} RuntimeNativeJournalDescriptor */

/** @typedef {{ readonly handleId: string; readonly journalId: string }} RuntimeNativeJournalRef */

/** @typedef {{
  readonly hostAuthority: RuntimeNativeJournalAuthority;
  readonly assertOwned: () => Promise<void>;
  readonly targetHandleId: string; readonly timestamp: number;
}} RuntimeNativeEpochContext */

/** Administrative storage; callers hold host authority for publication/deletion.
 * @typedef {{
  createEpoch(context: RuntimeNativeEpochContext): Promise<void>;
  deletionBlocked(journals: readonly RuntimeNativeJournalRef[], authority: RuntimeNativeJournalAuthority): Promise<boolean>;
  deleteJournals(journals: readonly RuntimeNativeJournalRef[], context: RuntimeNativeJournalDeletion): Promise<void>;
  freeze(coordinates: Omit<RuntimeNativeJournalDescriptor, "journalId" | "sourceTipId" | "sourceSeq" | "sourceDigest" | "provenance"> & { readonly provenance?: RuntimeNativeJournalDescriptor["provenance"] }): Promise<RuntimeNativeJournalDescriptor>;
  inventory(managedJournalIds?: readonly string[], unreadableOwners?: { readonly rootId: string; readonly conversationKeys: readonly string[] }): Promise<{ readonly bytes: number; readonly stagedBytes: number; readonly journals: Readonly<Record<string, { readonly retainedBytes: number; readonly stagedBytes: number; readonly damaged?: true }>> }>;
  inspectCurrentJournal?(coordinates: { readonly handleId: string; readonly journalId?: string }): Promise<RuntimeNativeJournalPresence>;
}} RuntimeNativeJournalStorage */

/** @typedef {{ readonly status: "present" | "missing" } | { readonly status: "unreadable"; readonly reason: string }} RuntimeNativeJournalPresence */

/** Complete immutable evidence; cloned JSON loses validation identity.
 * @typedef {{
  readonly version: 1; readonly ownerKey: string; readonly historyBucket: string;
  readonly gaps: readonly Record<string, unknown>[];
  readonly prior: Readonly<Record<string, unknown>> | null;
  readonly segments: readonly { readonly descriptor: Omit<RuntimeNativeJournalDescriptor, "epoch">;
    readonly header: Readonly<Record<string, unknown>>; readonly records: readonly Readonly<Record<string, unknown>>[];
    readonly entries: readonly Readonly<Record<string, unknown>>[]; readonly repairs: readonly Readonly<Record<string, unknown>>[];
    readonly turns: readonly Readonly<Record<string, unknown>>[]; readonly allCalls: readonly Readonly<Record<string, unknown>>[];
    readonly calls: readonly Readonly<Record<string, unknown>>[]; readonly inputs: readonly Readonly<Record<string, unknown>>[] }[];
}} RuntimeNativeEvidenceView */

/** @typedef {Readonly<{
    readonly policy: "mono-handoff-v1"; readonly contextWindow: number;
    readonly outputReserve: number; readonly inputTokens: number;
    readonly hostCap: number; readonly hostContextDigest: string;
    readonly safety: number; readonly historyAllowance: number;
  }>} RuntimeHandoffBudget */

/** @typedef {{
  readonly status: "prepared"; readonly checkpoints: readonly Readonly<Record<string, unknown>>[];
  readonly ledger: readonly Readonly<Record<string, unknown>>[]; readonly recent: readonly Readonly<Record<string, unknown>>[];
  readonly older: readonly Readonly<Record<string, unknown>>[];
  readonly prior: Readonly<Record<string, unknown>> | null;
  readonly coverage: readonly RuntimeNativeEvidenceView["segments"][number]["descriptor"][];
}} RuntimePreparedHandoff */

/** @typedef {Readonly<Record<"intent" | "constraints" | "decisions" | "completedWork" | "failures" | "openWork" | "nextActions" | "references", readonly string[]>>} RuntimeHandoffSummary */

/** @typedef {{ readonly prepared: RuntimePreparedHandoff; readonly outputReserve: number }} RuntimeHandoffProducerRequest */

/** @typedef {{ readonly status: "ready" } | { readonly status: "budget_failure"; readonly reason: string }} RuntimeHandoffFit */

/** @typedef {{ readonly status: "ready"; readonly summary: RuntimeHandoffSummary; readonly usage?: unknown; readonly durationMs?: number }
  | { readonly status: "summary_rejected"; readonly reason: string; readonly usage?: unknown; readonly durationMs?: number }
  | { readonly status: "budget_failure"; readonly reason: string }} RuntimeHandoffProducerResult */

/** @typedef {{
  readonly target: RuntimeNativeJournalDescriptor["provenance"]; readonly budget: RuntimeHandoffBudget;
  readonly timestamp: number; readonly hostContext: Readonly<Record<string, unknown>>;
  readonly summary?: RuntimeHandoffSummary; readonly producer?: "outgoing" | "checkpoint" | "incoming";
}} RuntimeHandoffOptions */

/** @typedef {{ readonly status: "ready"; readonly artifact: Readonly<Record<string, unknown>>;
  readonly contentHash: string; readonly messages: readonly Readonly<Record<string, unknown>>[]; readonly coverage: RuntimePreparedHandoff["coverage"] }
  | { readonly status: "budget_failure" | "summary_rejected"; readonly reason: string }
  | { readonly status: "summary_required"; readonly prepared: RuntimePreparedHandoff }} RuntimeHandoffProposal */

/** @typedef {RuntimeNativeJournalStorage & {
  captureEvidence(source: RuntimeNativeJournalDescriptor | null, context: { readonly ownerKey: string; readonly historyBucket: string;
    readonly hostAuthority?: RuntimeNativeJournalAuthority; readonly assertOwned: () => Promise<void>;
    readonly gaps?: readonly Record<string, unknown>[]; readonly prior?: Readonly<Record<string, unknown>> | null }): Promise<RuntimeNativeEvidenceView>;
  createBudget(input: { readonly contextWindow: number; readonly outputReserve: number; readonly inputTokens: number; readonly hostContext: Readonly<Record<string, unknown>> }): RuntimeHandoffBudget;
  checkInheritedPrefix?(messages: readonly Readonly<Record<string, unknown>>[], model: Readonly<{ provider: string; id: string; api: string; contextWindow: number; maxTokens: number }>, compaction?: Readonly<RuntimeCompactionPolicy>, prefixTokenCap?: number): Promise<RuntimeHandoffFit>;
  prepareHandoff(view: RuntimeNativeEvidenceView, options: RuntimeHandoffOptions): RuntimePreparedHandoff | { readonly status: "budget_failure"; readonly reason: string };
  buildHandoff(view: RuntimeNativeEvidenceView, options: RuntimeHandoffOptions): RuntimeHandoffProposal;
}} RuntimeNativePreparationStorage */

export {};
