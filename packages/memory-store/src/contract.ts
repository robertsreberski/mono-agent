export interface MemoryBlock {
  readonly kind: "markdown";
  readonly content: string;
  readonly source: string;
  readonly truncated: boolean;
}

export interface MemoryWriteResult {
  readonly conversationId: string;
  readonly source: string;
  readonly bytesWritten: number;
}

export interface MemoryStore {
  /**
   * Prime a turn with relevant memories. `query` is the text to recall against (typically the
   * current user message). When omitted, implementations fall back to a coarse per-conversation
   * seed for backward compatibility.
   */
  load(conversationId: string, query?: string): Promise<MemoryBlock | undefined>;
  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult>;
  /** Enqueue a best-effort intelligent capture of a turn. Returns immediately; never throws. No-op when unsupported. */
  scheduleCapture?(conversationId: string, text: string): void;
  /** Await all queued captures (graceful shutdown / one-shot exit). */
  flush?(): Promise<void>;
}
