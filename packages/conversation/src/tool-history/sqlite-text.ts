/**
 * node:sqlite before Node 24.16 (including the supported 24.15 floor) decodes
 * TEXT result columns and user-function arguments only up to the first U+0000,
 * although SQLite stores and binds every byte (nodejs/node#61954). Retained
 * continuity text is arbitrary user/tool content, so it is selected as BLOB
 * bytes and decoded here; valid UTF-8 decodes identically to fixed runtimes.
 * JSON columns need no such handling: JSON.stringify escapes U+0000.
 */
export function retainedTextColumn(alias = "r"): string {
  return `CAST(${alias}.retained_text AS BLOB) retained_text`;
}

const RECORD_COLUMNS = [
  "ordinal", "record_id", "generation_id", "run_id", "input_id", "kind", "seq", "finalized", "retained_text", "text_sha256",
  "original_bytes", "retained_bytes", "redacted", "truncated", "provenance", "source_json", "summary_json", "created_at_ms",
  "tombstone_reason", "removed_at_ms",
] as const;

/** Every continuity_records column (the `r.*` shape), with retained_text as
 * bytes so a body is never materialized twice. */
export function continuityRecordColumns(alias = "r"): string {
  return RECORD_COLUMNS.map(column => column === "retained_text" ? retainedTextColumn(alias) : `${alias}.${column}`).join(",");
}

/** Decode UTF-8 bytes from a BLOB-cast TEXT column; other values pass through. */
export function sqliteText(value: unknown): unknown {
  return value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8") : value;
}
