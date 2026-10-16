// Shared structural contract; no host implementation or process runner imports.

/** @typedef {import("../ai/native-journal-types.js").RuntimeNativeJournalAuthority} RuntimeNativeJournalAuthority */

/** Host-owned native turn identity; distinct from terminal-recovery authority. */
/** Physical canonical-history bucket; null for instance-owned execution. */
/** Explicit native evidence preservation; host adoption is separately coordinated. */
/** @typedef {{
 *     readonly kind: "host" | "instance";
 *     readonly ownerKey: string;
 *     readonly historyBucket: string | null;
 *     readonly turnId: string;
 *     readonly handleId: string;
 *     readonly baseRevision: number | null;
 *     readonly reconciliation?: {
 *         readonly version: 1;
 *         readonly purpose: "execution" | "compaction";
 *         readonly fenceDigest: string;
 *         readonly initialInputId: string | null;
 *     };
 * }} RuntimeSessionTurnDescriptor */

/** Exactly one original initial input, plus every native live admission,
   * including cancelled/unconsumed entries; additional fenced host offers are
   * permitted but do not prove native execution. Digests use native formatted
   * content (live guidance, not raw body); replay of the original is initial. */
/** @typedef {{
 *     readonly sessionsRoot: string;
 *     readonly descriptor: RuntimeSessionTurnDescriptor;
 *     readonly purpose: "execution" | "compaction";
 *     readonly expectedModel: {
 *         readonly provider: string;
 *         readonly id: string;
 *         readonly api?: string;
 *     };
 *     readonly expectedBaseTip?: string | null;
 *     readonly expectedInputs: readonly {
 *         readonly id: string;
 *         readonly requestDigest: string;
 *         readonly placement: "initial" | "live";
 *     }[];
 * }} RuntimeSessionTurnReconciliationRequest */


/** @typedef {{
 *     readonly text: string | null;
 *     readonly error: string | null;
 *     readonly failureKind: string | null;
 *     readonly cancelled: boolean;
 *     readonly stopReason: string | null;
 *     readonly turnDisposition?: "silent";
 * }} RuntimeSessionTurnResultSeal */


/** @typedef {{
 *     readonly status: "absent";
 * } | {
 *     readonly status: "mismatch";
 *     readonly reason: string;
 * } | {
 *     readonly status: "matched";
 *     readonly journalId: string;
 *     readonly handleId: string;
 *     readonly turnId: string;
 *     readonly baselineTipId: string | null;
 *     readonly tipId: string | null;
 *     readonly currentTipId: string | null;
 *     readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
 *     readonly seal: {
 *         readonly version: 1;
 *         readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
 *         readonly result: RuntimeSessionTurnResultSeal | null;
 *     } | null;
 *     readonly binding: RuntimeSessionTurnDescriptor & {
 *         readonly version: 1;
 *         readonly model: {
 *             readonly provider: string;
 *             readonly id: string;
 *             readonly api: string;
 *         };
 *     };
 *     readonly inputs: readonly {
 *         readonly id: string;
 *         readonly messageId: string;
 *         readonly requestDigest: string;
 *         readonly placement: "initial" | "replay" | "live";
 *         readonly complete: boolean;
 *     }[];
 *     readonly admittedInputs: readonly {
 *         readonly id: string;
 *         readonly state: "queued" | "cancelled" | "consumed";
 *         readonly placement: "live";
 *         readonly requestDigest: string;
 *     }[];
 *     readonly finalOperationId: string | null;
 *     readonly consumedInputIds: readonly string[];
 *     readonly operations: readonly {
 *         readonly operationId: string;
 *         readonly type: "prompt" | "compaction";
 *         readonly cause: string;
 *         readonly parentOperationId: string | null;
 *         readonly baselineTipId: string | null;
 *         readonly tipId: string | null;
 *         readonly startSeq: number;
 *         readonly endSeq: number | null;
 *         readonly status: "completed" | "failed" | "aborted" | "interrupted" | null;
 *         readonly suspended: boolean;
 *     }[];
 *     readonly commitCandidate?: RuntimeSessionTurnResultSeal;
 *     readonly interruptionEvidence: readonly {
 *         readonly cause: string;
 *         readonly operationIds: readonly string[];
 *         readonly calls: readonly {
 *             readonly callId: string;
 *             readonly name: string;
 *             readonly operationId: string;
 *             readonly messageId: string;
 *             readonly admission: string;
 *             readonly cause: string;
 *         }[];
 *         readonly tipId: string | null;
 *         readonly timestamp: number;
 *     }[];
 * }} RuntimeSessionTurnReconciliationResult */

/** Positive current-handle authority, borrowed from the held canonical owner.
 * assertCurrent must validate ready binding/artifact and reject retired epochs,
 * stale mappings, lost claims and capacity-refused creation. No default opts in. */
/** Pinned dedicated native root; runtime checks normalized path equality.
   * assertCurrent receives that path; host must prove any stronger root identity. */
/** @typedef {{
 *     readonly version: 1;
 *     readonly currentHandleId: string;
 *     readonly sessionsRoot: string;
 *     readonly hostAuthority: RuntimeNativeJournalAuthority;
 *     readonly assertCurrent: (request: {
 *         readonly handleId: string;
 *         readonly action: "open" | "create";
 *         readonly sessionsRoot: string;
 *     }) => Promise<void>;
 * }} RuntimeNativeSessionAuthority */

/** Host-accepted immutable projection. Historical tools remain data; native
 * envelopes are never reused across a model change. */
/** Only the switch/incoming request carries this frozen budget. Later turns
   * may compact normally using the same inherited content/coverage. */
/** @typedef {{
 *     readonly version: 1;
 *     readonly artifact: {
 *         readonly id: string;
 *         readonly hash: string;
 *     };
 *     readonly inherited: {
 *         readonly messages: readonly Record<string, unknown>[];
 *         readonly coverage: {
 *             readonly version: 1;
 *             readonly sources: readonly {
 *                 readonly journalId: string;
 *                 readonly sourceTipId: string | null;
 *                 readonly sourceSeq: number;
 *                 readonly sourceDigest: string;
 *             }[];
 *         };
 *     };
 *     readonly dispatchBudget?: {
 *         readonly policy: "mono-handoff-v1";
 *         readonly contextWindow: number;
 *         readonly outputReserve: number;
 *         readonly inputTokens: number;
 *         readonly hostCap: number;
 *         readonly hostContextDigest: string;
 *         readonly safety: number;
 *         readonly historyAllowance: number;
 *     };
 * }} RuntimeNativeSessionProjection */
