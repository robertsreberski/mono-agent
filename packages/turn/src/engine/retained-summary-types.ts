// Engine-local structural types; host contracts remain outside the engine fence.
/** Host-only retained publication identity; never native admission by itself. */
interface RetainedSummaryBinding {
  readonly version: 1;
  readonly logicalConversationId: string;
  readonly conversationId: string;
  readonly generationId: string;
  readonly recordId: string;
  readonly sha256: string;
  readonly retainedBytes: number;
  readonly sourceEpoch: string;
  readonly sourceRevision: number;
  readonly publication: { readonly journalId: string; readonly operationId: string; readonly sourceDigest: string; readonly summaryDigest: string };
}
interface RetainedSummarySelection {
  readonly recordId: string;
  readonly generationId: string;
  readonly sha256: string;
  readonly retainedBytes: number;
  readonly packSha256: string;
  readonly entry: { readonly startByte: number; readonly endByte: number; readonly sha256: string };
}
interface RetainedSummaryCandidate {
  readonly binding: RetainedSummaryBinding;
  readonly selection: RetainedSummarySelection;
}
export interface RetainedSummaryReceipt extends RetainedSummaryCandidate {
  readonly version: 1;
  readonly destination: { readonly logicalConversationId: string; readonly conversationId: string; readonly epoch: string; readonly handleId: string; readonly journalId: string };
  readonly seed: { readonly entryId: string; readonly messageDigest: string };
}
/** Independent reseed carry: no assertion that the seed quotes the source. */
export type ReseedPredecessorReceipt = Omit<RetainedSummaryReceipt, "selection">;
/** Positive canonical-owner capability, not request/plugin supplied. An absent
 * source is revocation, not permission to recover native/original source bytes. */
export interface RetainedSummaryAccess {
  readonly destination: Omit<RetainedSummaryReceipt["destination"], "journalId">;
  eligibleForReseed?(): Promise<RetainedSummaryBinding | undefined>;
  assertCurrent(): Promise<void>;
  resolve(binding: RetainedSummaryBinding): Promise<{ readonly text: string } | undefined>;
}
