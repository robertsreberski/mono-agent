// Shared structural contract; no host implementation or process runner imports.

/** Exact native identifiers that can correlate a live follow-up to one provider run. */

/** A handed-off follow-up whose absence from the active provider run cannot be proved. */

/** One live follow-up delivered to a provider bridge. */
/** Trusted host classification; absent/unknown kinds cannot finish silently. */
/**
   * Optional opaque in-process identity shared by fresh callback leases for
   * this same logical message. Later same-id values without this exact object
   * remain invalid duplicate owners.
   */
/** Called after the provider's native queue accepts this exact attempt. */
/** Called only after exact native transcript consumption is proved. */
/** Called when delivery cannot be proved absent and must not be retried. */
/** Per-attempt safe rejection; a later provider attempt may still replay it. */

export type RuntimeLiveInputEvidence = {
  readonly providerEntryId?: string;
  readonly providerRunId?: string;
};

export type RuntimeLiveInputUncertainty = RuntimeLiveInputEvidence & {
  readonly reason: "delivery_uncertain";
};

export type RuntimeLiveInputMessage = {
  readonly body: string;
  readonly kind?: "process_job" | "user";
  readonly id?: string;
  readonly receivedAt?: string;
  readonly logicalOwner?: object;
  readonly accepted?: (evidence?: RuntimeLiveInputEvidence) => unknown;
  readonly acknowledge?: (evidence?: RuntimeLiveInputEvidence) => unknown;
  readonly uncertain?: (details: RuntimeLiveInputUncertainty) => unknown;
  readonly reject?: (reason?: unknown) => unknown;
};
