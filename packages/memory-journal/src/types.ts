export type JournalMemoryErrorCode =
  | "invalid_journal_options"
  | "invalid_journal_entry"
  | "journal_read_failed"
  | "journal_write_failed";

/**
 * Provides a compact long-term entity digest to fold into the always-in-context
 * block, keyed by the journal day (YYYY-MM-DD). Absent in the journaling-only
 * configuration; wired once the entity graph exists.
 */
export type EntityDigestProvider = (day: string) => Promise<string | undefined>;

export interface JournalMemoryStoreOptions {
  /** Memory root directory; daily notes live under `<rootDir>/daily/<day>.md`. */
  readonly rootDir: string;
  /** Hard cap on the bytes of today's note injected into context. */
  readonly maxBytes: number;
  /** Injectable clock for deterministic days and timestamps. */
  readonly clock?: () => Date;
  /** Optional long-term entity digest prepended to the always-in-context block. */
  readonly entityDigest?: EntityDigestProvider;
}
