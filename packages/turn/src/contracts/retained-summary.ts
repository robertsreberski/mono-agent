/** Host-only retained publication identity; never native admission by itself. */
export interface RuntimeRetainedSummaryBinding {
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
export interface RuntimeRetainedSummarySelection {
  readonly recordId: string;
  readonly generationId: string;
  readonly sha256: string;
  readonly retainedBytes: number;
  readonly packSha256: string;
  readonly entry: { readonly startByte: number; readonly endByte: number; readonly sha256: string };
}
export interface RuntimeRetainedSummaryCandidate {
  readonly binding: RuntimeRetainedSummaryBinding;
  readonly selection: RuntimeRetainedSummarySelection;
}
export interface RuntimeRetainedSummaryReceipt extends RuntimeRetainedSummaryCandidate {
  readonly version: 1;
  readonly destination: { readonly logicalConversationId: string; readonly conversationId: string; readonly epoch: string; readonly handleId: string; readonly journalId: string };
  readonly seed: { readonly entryId: string; readonly messageDigest: string };
}
/** Independent reseed carry: no assertion that the seed quotes the source. */
export type RuntimeReseedPredecessorReceipt = Omit<RuntimeRetainedSummaryReceipt, "selection">;
/** Positive canonical-owner capability, not request/plugin supplied. An absent
 * source is revocation, not permission to recover native/original source bytes. */
export interface RuntimeRetainedSummaryAccess {
  readonly destination: Omit<RuntimeRetainedSummaryReceipt["destination"], "journalId">;
  eligibleForReseed?(): Promise<RuntimeRetainedSummaryBinding | undefined>;
  assertCurrent(): Promise<void>;
  resolve(binding: RuntimeRetainedSummaryBinding): Promise<{ readonly text: string } | undefined>;
}
