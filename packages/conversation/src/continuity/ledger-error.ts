const CODES = ["upkeep_repeat_suppressed","output_json", "output_schema", "covered_invalid", "unknown_source", "identifier_not_in_span", "value_bounds", "entry_bounds", "request_not_outcome", "owner_span", "source_changed", "publish_cas", "publish_quota", "publish_bounds", "publish_source_changed", "publish_cancelled", "publish_unavailable"] as const;
export type LedgerFailure = typeof CODES[number];
/** Stable diagnostics only: never attach values, source IDs or raw exceptions. */
export class LedgerError extends Error {
  constructor(readonly code: LedgerFailure) { super(code); this.name = "LedgerError"; }
}
/** Also recognizes the allowlisted code after the writer-worker RPC boundary. */
export function ledgerFailure(error: unknown, fallback: LedgerFailure): LedgerFailure {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (CODES as readonly string[]).includes(code) ? code as LedgerFailure : fallback;
}
