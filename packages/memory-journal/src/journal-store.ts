import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store";

import type { EntityDigestProvider, JournalMemoryErrorCode, JournalMemoryStoreOptions } from "./types.js";

export class JournalMemoryError extends Error {
  readonly code: JournalMemoryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: JournalMemoryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "JournalMemoryError";
    this.code = code;
    this.details = { ...details, code };
  }
}

/**
 * Single global brain: the journal store ignores the conversation id and always
 * reads/writes the host-wide daily note. The conversation id is still recorded
 * inside host-summary entries for provenance.
 */
export class JournalMemoryStore implements MemoryStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly entityDigest: EntityDigestProvider | undefined;

  constructor(options: JournalMemoryStoreOptions) {
    if (typeof options.rootDir !== "string" || options.rootDir.trim().length === 0) {
      throw new JournalMemoryError("invalid_journal_options", "Journal rootDir must be a non-empty string.");
    }
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new JournalMemoryError("invalid_journal_options", "maxBytes must be a positive integer.");
    }

    this.rootDir = resolve(options.rootDir);
    this.maxBytes = options.maxBytes;
    this.clock = options.clock ?? (() => new Date());
    this.entityDigest = options.entityDigest;
  }

  /** The journal day (YYYY-MM-DD, host-local) the store currently writes to. */
  today(): string {
    return journalDayFor(this.clock());
  }

  /** Absolute path of a given day's note. */
  dailyPathFor(day: string): string {
    return join(this.rootDir, "daily", `${day}.md`);
  }

  async load(_conversationId: string): Promise<MemoryBlock | undefined> {
    const day = this.today();
    const source = this.dailyPathFor(day);
    const note = await this.readDailyNote(source);
    const digest = this.entityDigest === undefined ? undefined : await this.entityDigest(day);

    const sections: string[] = [];
    if (typeof digest === "string" && digest.trim().length > 0) {
      sections.push(`### Long-term memory (entity digest)\n\n${digest.trim()}`);
    }
    if (note !== undefined) {
      sections.push(note.content);
    }
    if (sections.length === 0) {
      return undefined;
    }

    return {
      kind: "markdown",
      content: sections.join("\n\n"),
      source,
      truncated: note?.truncated ?? false,
    };
  }

  /** Host-driven, deterministic turn log appended after every successful turn. */
  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    assertConversationId(conversationId);
    const normalized = normalizeEntry(summary);
    const timestamp = this.clock().toISOString();
    const entry = `\n\n## Turn — ${timestamp}\n\nConversation: \`${conversationId}\`\n\n${normalized}\n`;
    return this.appendRaw(entry, conversationId);
  }

  /** Free-form journal note written by the agent itself (journal_append tool). */
  async appendEntry(text: string): Promise<MemoryWriteResult> {
    const normalized = normalizeEntry(text);
    const timestamp = this.clock().toISOString();
    const entry = `\n\n## Note — ${timestamp}\n\n${normalized}\n`;
    return this.appendRaw(entry, "global");
  }

  private async appendRaw(entry: string, conversationId: string): Promise<MemoryWriteResult> {
    const source = this.dailyPathFor(this.today());
    try {
      await mkdir(dirname(source), { recursive: true });
      await appendFile(source, entry, "utf8");
      return {
        conversationId,
        source,
        bytesWritten: Buffer.byteLength(entry, "utf8"),
      };
    } catch (error) {
      throw new JournalMemoryError("journal_write_failed", "Unable to append journal entry.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readDailyNote(source: string): Promise<{ readonly content: string; readonly truncated: boolean } | undefined> {
    let fileStat;
    try {
      fileStat = await stat(source);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw new JournalMemoryError("journal_read_failed", "Unable to inspect journal file.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!fileStat.isFile()) {
      throw new JournalMemoryError("journal_read_failed", "Journal path must resolve to a file.", { source });
    }

    try {
      const buffer = await readFile(source);
      if (buffer.byteLength === 0) {
        return undefined;
      }
      const truncated = buffer.byteLength > this.maxBytes;
      const content = truncated
        ? `<!-- journal truncated to last ${this.maxBytes} bytes -->\n${buffer.subarray(buffer.byteLength - this.maxBytes).toString("utf8")}`
        : buffer.toString("utf8");
      return { content, truncated };
    } catch (error) {
      throw new JournalMemoryError("journal_read_failed", "Unable to read journal file.", {
        source,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createJournalMemoryStore(options: JournalMemoryStoreOptions): JournalMemoryStore {
  return new JournalMemoryStore(options);
}

/** Host-local day bucket (YYYY-MM-DD) for a timestamp; the daily-note rollover key. */
export function journalDayFor(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeEntry(text: string): string {
  if (typeof text !== "string") {
    throw new JournalMemoryError("invalid_journal_entry", "Journal entry must be a string.");
  }
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw new JournalMemoryError("invalid_journal_entry", "Journal entry must not be empty.");
  }
  return normalized;
}

function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new JournalMemoryError("invalid_journal_entry", "Conversation id must be a non-empty string.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
