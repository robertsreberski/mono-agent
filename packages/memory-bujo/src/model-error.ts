/** Which memory AI model failed: the chat LLM (distill/classify/entities) or the embedding provider. */
export type MemoryModelKind = "llm" | "embedding";

/**
 * A failure from one of the memory AI models during capture. Distinct from a per-item *data* error
 * (a malformed candidate, a missing daily file): those are tolerated/isolated, whereas a model
 * outage is systemic and must surface so the capture boundary can log it. Carries the underlying
 * cause and the pipeline stage so the log line tells "the model failed" apart from "nothing to capture".
 */
export class MemoryModelError extends Error {
  readonly kind: MemoryModelKind;
  readonly stage: string;

  constructor(kind: MemoryModelKind, stage: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`memory capture ${kind} failure at ${stage}: ${detail}`, { cause });
    this.name = "MemoryModelError";
    this.kind = kind;
    this.stage = stage;
  }
}
