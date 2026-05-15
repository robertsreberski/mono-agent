export type MarkdownMemoryScope = "single-file" | "per-conversation";

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
  load(conversationId: string): Promise<MemoryBlock | undefined>;
  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult>;
}

export interface MarkdownMemoryStoreOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly scope?: MarkdownMemoryScope;
  readonly clock?: () => Date;
}
