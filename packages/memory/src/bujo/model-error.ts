/** Which memory AI model failed: the chat LLM (distill/classify/entities) or the embedding provider. */
export type MemoryModelKind = "llm" | "embedding";

/**
 * A failure from one of the memory AI models. Distinct from a per-item *data* error (a malformed
 * candidate, a missing daily file): those are tolerated/isolated, whereas a model outage is systemic
 * and must surface so the calling boundary can log it. Thrown from both the per-turn capture pipeline
 * (distill/entities/classify/findSimilar) and the rituals (reflect insights, migrate), so the message
 * is scope-neutral — the `stage` distinguishes the source and the surrounding log prefix (e.g.
 * "bujo capture failed" / 'Memory ritual "reflect" failed') supplies the feature context.
 */
export class MemoryModelError extends Error {
  readonly kind: MemoryModelKind;
  readonly stage: string;

  constructor(kind: MemoryModelKind, stage: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`memory ${kind} failure at ${stage}: ${detail}`, { cause });
    this.name = "MemoryModelError";
    this.kind = kind;
    this.stage = stage;
  }
}
