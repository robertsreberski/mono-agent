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

/** Optional host context for one memory read. Existing stores may ignore it. */
export interface MemoryLoadOptions {
  /** Stable id for one provider turn, used only to deduplicate reads within that turn. */
  readonly turnId?: string;
}

export interface MemoryStore {
  /**
   * Prime a turn with relevant memories. `query` is the text to recall against (typically the
   * current user message). When omitted, implementations fall back to a coarse per-conversation
   * seed for backward compatibility.
   */
  load(conversationId: string, query?: string, options?: MemoryLoadOptions): Promise<MemoryBlock | undefined>;
  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult>;
  /** Enqueue a best-effort intelligent capture of a turn. Returns immediately; never throws. No-op when unsupported. */
  scheduleCapture?(conversationId: string, text: string): void;
  /** Await all queued captures (graceful shutdown / one-shot exit). */
  flush?(): Promise<void>;
  /** Optional host lifecycle hook for dropping per-turn read caches. */
  releaseTurn?(turnId: string): void | Promise<void>;
}
