/**
 * Deterministic preflight contract shared by the scheduler and the config
 * loaders. A job may declare `preflight` as an explicit argv; a host-supplied
 * executor runs it before the responder and answers with a bounded verdict.
 *
 * Only three things ever cross this boundary: a verdict (`run`/`skip`), a
 * bounded reason string, and stable error codes. Raw gate stdout, stderr,
 * argv, and environment values are never persisted by the adapter or by the
 * host that observes {@link CronPreflightRecord}.
 */

import { CronAdapterError } from "./errors.js";

/** Stable failure codes. Every one of them is fail-open: the job still runs. */
export type CronPreflightErrorCode =
  | "exit_nonzero"
  | "signal"
  | "spawn_failed"
  | "timeout"
  | "invalid_json"
  | "invalid_verdict"
  | "output_overflow"
  | "callback_timeout";

/** Host callback result for one attempted gate. */
export type CronPreflightOutcome =
  | {
      readonly outcome: "run";
      /** Optional agent input appended to the job prompt inside a wrapper block. */
      readonly input?: string;
      readonly reason?: string;
    }
  | {
      readonly outcome: "skip";
      /** Still carried to the prompt when a manual firing overrides `skip`. */
      readonly input?: string;
      readonly reason?: string;
    }
  | { readonly outcome: "error"; readonly code: CronPreflightErrorCode; readonly reason?: string };

/**
 * What actually happened to one attempted gate. `error`, `timeout`, and
 * `cancelled` cover adapter-owned failures a host cannot infer from the
 * subprocess outcome alone; `overridden` marks a manual run that ran anyway.
 */
export type CronPreflightRecordOutcome = "run" | "skip" | "error" | "timeout" | "cancelled" | "overridden";

/** Bounded, code-only audit record. Never raw gate output, argv, or env. */
export interface CronPreflightRecord {
  readonly outcome: CronPreflightRecordOutcome;
  readonly code?: CronPreflightErrorCode;
  readonly reason?: string;
  readonly inputBytes?: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

/** Adapter race timeout when neither a job nor the options set one. */
export const DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS = 5_000;
/** Hard ceiling for any configured preflight timeout. */
export const MAX_CRON_PREFLIGHT_TIMEOUT_MS = 60_000;
/** Decoded `input` ceiling; a larger gate input fails open as `output_overflow`. */
export const MAX_CRON_PREFLIGHT_INPUT_BYTES = 64 * 1024;
/** Reason ceiling; longer reasons are truncated before they are recorded. */
export const MAX_CRON_PREFLIGHT_REASON_BYTES = 512;

const PREFLIGHT_TIMEOUT_MESSAGE =
  `must be a positive integer number of milliseconds no greater than ${String(MAX_CRON_PREFLIGHT_TIMEOUT_MS)}`;

/**
 * Validate a preflight argv from an already-parsed JSON value. A preflight is
 * always an explicit argv: a bare string is never split into arguments.
 */
export function normalizeCronPreflightArgv(
  value: unknown,
  field: string,
  details: Record<string, unknown> = {},
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidConfig(`${field} must be a non-empty array of argument strings.`, details);
  }
  const argv: string[] = [];
  for (const argument of value) {
    if (typeof argument !== "string" || argument.trim().length === 0 || argument.includes("\0")) {
      throw invalidConfig(`${field} must contain only non-empty argument strings without NUL.`, details);
    }
    argv.push(argument);
  }
  return argv;
}

/**
 * Parse the single-line JSON argv form used by
 * `MONO_AGENT_CRON_PREFLIGHT_JSON` and markdown frontmatter. Only a JSON array
 * is accepted, so a shell-looking string can never be silently split.
 */
export function parseCronPreflightArgvJson(
  value: string,
  field: string,
  details: Record<string, unknown> = {},
): readonly string[] {
  const message = `${field} must be a single-line JSON array of argument strings.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidConfig(message, details);
  }
  const argv = normalizeCronPreflightArgv(parsed, field, details);
  if (argv === undefined) {
    throw invalidConfig(message, details);
  }
  return argv;
}

/** Validate an already-numeric preflight timeout (JSON value or adapter option). */
export function normalizeCronPreflightTimeoutMs(
  value: unknown,
  field: string,
  details: Record<string, unknown> = {},
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_CRON_PREFLIGHT_TIMEOUT_MS) {
    throw invalidConfig(`${field} ${PREFLIGHT_TIMEOUT_MESSAGE}.`, details);
  }
  return value;
}

/** Validate a textual preflight timeout (environment variable or frontmatter). */
export function parseCronPreflightTimeoutMs(
  value: string | undefined,
  field: string,
  details: Record<string, unknown> = {},
): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw invalidConfig(`${field} ${PREFLIGHT_TIMEOUT_MESSAGE}.`, details);
  }
  return normalizeCronPreflightTimeoutMs(Number(normalized), field, details);
}

/**
 * Truncate diagnostic text to a byte ceiling without splitting a UTF-8
 * sequence. Bounds are advisory: they never fail a gate.
 */
export function boundCronPreflightText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** Truncate a reason to the shared reason ceiling ({@link MAX_CRON_PREFLIGHT_REASON_BYTES}). */
export function boundCronPreflightReason(value: string): string {
  return boundCronPreflightText(value, MAX_CRON_PREFLIGHT_REASON_BYTES);
}

function invalidConfig(message: string, details: Record<string, unknown>): CronAdapterError {
  return new CronAdapterError("invalid_config", message, details);
}
