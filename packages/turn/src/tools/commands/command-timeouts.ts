// Common timeout facts. Legacy shell semantics stay explicit.

const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/**
 * Legacy Bash timeout normalization. Values up to 600 are seconds; larger
 * values are milliseconds. New callers should use `timeout_ms`.
 */
export function normalizeBashTimeoutMs(value: any, fallback: number = DEFAULT_BASH_TIMEOUT_MS): any {
  const cap = finitePositiveInteger(fallback, DEFAULT_BASH_TIMEOUT_MS);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return cap;
  const floored = Math.floor(n);
  const milliseconds = floored <= 600 ? floored * 1_000 : floored;
  return Math.max(1_000, Math.min(milliseconds, cap));
}

/**
 * Exact millisecond timeout used by Bash.timeout_ms and Exec.timeout_ms.
 */
export function normalizeProcessTimeoutMs(value: any, fallback: number = DEFAULT_BASH_TIMEOUT_MS): any {
  const cap = finitePositiveInteger(fallback, DEFAULT_BASH_TIMEOUT_MS);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return cap;
  return Math.max(1, Math.min(Math.floor(n), cap));
}

/**
 * Background process-job timeout: positive-integer milliseconds with no
 * foreground ceiling. A background budget belongs to the host's `processJobs`
 * settings (`maxRuntimeMs`), which clamp it on their own side; reusing the
 * foreground default as a cap here silently discarded the long runtime a caller
 * deliberately asked for. `undefined` means "no explicit request", leaving the
 * host default in force.
 */
export function normalizeBackgroundTimeoutMs(value: any): number;
export function normalizeBackgroundTimeoutMs(value: any): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.floor(n));
}

/**
 * Legacy Bash `timeout` for a background job: the same seconds-vs-milliseconds
 * heuristic as {@link normalizeBashTimeoutMs}, minus the foreground ceiling.
 */
export function normalizeBackgroundBashTimeoutMs(value: any): number;
export function normalizeBackgroundBashTimeoutMs(value: any): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const floored = Math.floor(n);
  return Math.max(1_000, floored <= 600 ? floored * 1_000 : floored);
}

function finitePositiveInteger(value: any, fallback: any) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
