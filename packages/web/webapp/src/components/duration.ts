/**
 * Tool durations are read at a glance beside a row's name, so sub-second work
 * stays in whole milliseconds and anything longer collapses to one decimal.
 * Callers pass only durations the runtime actually reported: a missing timing
 * must render as nothing rather than as `0ms`.
 */
export const formatToolDuration = (milliseconds: number): string =>
  milliseconds < 1_000
    ? `${String(Math.round(milliseconds))}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;

/** A reported, non-negative duration, or undefined for anything else. */
export const finiteDuration = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
