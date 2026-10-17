// A poisoned journal cannot authorize another provider/tool effect or failover.
export class JournalStorageError extends Error {
  declare code: any;
  constructor(cause: any) {
    super(`Native journal storage failed: ${cause?.message ?? String(cause)}`, { cause });
    this.name = "JournalStorageError";
    this.code = cause?.code ?? "MONO_JOURNAL_STORAGE_FAILED";
  }
}
export function isJournalStorageError(error: any) { return error instanceof JournalStorageError; }
