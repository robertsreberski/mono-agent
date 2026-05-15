import { createHash } from "node:crypto";
import { mkdir, readFile, stat, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { MarkdownMemoryScope, MarkdownMemoryStoreOptions, MemoryBlock, MemoryStore, MemoryWriteResult } from "./types.js";

export type MarkdownMemoryErrorCode = "invalid_memory_options" | "invalid_conversation_id" | "invalid_memory_summary" | "memory_read_failed" | "memory_write_failed";

export class MarkdownMemoryError extends Error {
  readonly code: MarkdownMemoryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MarkdownMemoryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MarkdownMemoryError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export class MarkdownMemoryStore implements MemoryStore {
  private readonly rootPath: string;
  private readonly maxBytes: number;
  private readonly scope: MarkdownMemoryScope;
  private readonly clock: () => Date;

  constructor(options: MarkdownMemoryStoreOptions) {
    if (typeof options.path !== "string" || options.path.trim().length === 0) {
      throw new MarkdownMemoryError("invalid_memory_options", "Memory path must be a non-empty string.");
    }
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new MarkdownMemoryError("invalid_memory_options", "maxBytes must be a positive integer.");
    }
    const scope = options.scope ?? "single-file";
    if (scope !== "single-file" && scope !== "per-conversation") {
      throw new MarkdownMemoryError("invalid_memory_options", "Memory scope must be single-file or per-conversation.");
    }

    this.rootPath = resolve(options.path);
    this.maxBytes = options.maxBytes;
    this.scope = scope;
    this.clock = options.clock ?? (() => new Date());
  }

  async load(conversationId: string): Promise<MemoryBlock | undefined> {
    const source = this.resolveMemoryPath(conversationId);
    let fileStat;
    try {
      fileStat = await stat(source);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw new MarkdownMemoryError("memory_read_failed", "Unable to inspect memory file.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!fileStat.isFile()) {
      throw new MarkdownMemoryError("memory_read_failed", "Memory path must resolve to a file.", { source });
    }

    try {
      const buffer = await readFile(source);
      const truncated = buffer.byteLength > this.maxBytes;
      const content = truncated
        ? `<!-- memory truncated to last ${this.maxBytes} bytes -->\n${buffer.subarray(buffer.byteLength - this.maxBytes).toString("utf8")}`
        : buffer.toString("utf8");
      return {
        kind: "markdown",
        content,
        source,
        truncated,
      };
    } catch (error) {
      throw new MarkdownMemoryError("memory_read_failed", "Unable to read memory file.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const source = this.resolveMemoryPath(conversationId);
    const normalizedSummary = normalizeSummary(summary);
    const timestamp = this.clock().toISOString();
    const entry = `\n\n## Host Summary — ${timestamp}\n\nConversation: \`${conversationId}\`\n\n${normalizedSummary}\n`;
    try {
      await mkdir(dirname(source), { recursive: true });
      await appendFile(source, entry, "utf8");
      return {
        conversationId,
        source,
        bytesWritten: Buffer.byteLength(entry, "utf8"),
      };
    } catch (error) {
      throw new MarkdownMemoryError("memory_write_failed", "Unable to append memory summary.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveMemoryPath(conversationId: string): string {
    assertConversationId(conversationId);
    if (this.scope === "single-file") {
      return this.rootPath;
    }
    return join(this.rootPath, `${safeConversationFileName(conversationId)}.memory.md`);
  }
}

export function createMarkdownMemoryStore(options: MarkdownMemoryStoreOptions): MarkdownMemoryStore {
  return new MarkdownMemoryStore(options);
}

export function safeConversationFileName(conversationId: string): string {
  assertConversationId(conversationId);
  const hash = createHash("sha256").update(conversationId).digest("hex").slice(0, 10);
  const base = conversationId
    .trim()
    .toLowerCase()
    .replace(/\.+/gu, "-")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `${base.length === 0 ? "conversation" : base}-${hash}`;
}

function normalizeSummary(summary: string): string {
  if (typeof summary !== "string") {
    throw new MarkdownMemoryError("invalid_memory_summary", "Memory summary must be a string.");
  }
  const normalized = summary.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw new MarkdownMemoryError("invalid_memory_summary", "Memory summary must not be empty.");
  }
  return normalized;
}

function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new MarkdownMemoryError("invalid_conversation_id", "Conversation id must be a non-empty string.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
