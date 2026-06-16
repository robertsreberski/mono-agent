export type MarkdownMemoryScope = "single-file" | "per-conversation";

export type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store";

export interface MarkdownMemoryStoreOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly scope?: MarkdownMemoryScope;
  readonly clock?: () => Date;
}
