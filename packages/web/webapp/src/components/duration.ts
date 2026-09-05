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

/**
 * Wall-clock elapsed for the Activity header. Whole seconds: the figure ticks
 * live while a turn runs, and a decimal that jumps once a second reads as noise
 * rather than precision. Minutes and hours keep a long turn readable.
 */
export const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};
