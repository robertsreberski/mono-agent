const CANONICAL_DAILY_SOURCE_PATTERN = /^(?:daily\/)?(\d{4}-\d{2}-\d{2})\.md$/u;

/** Whether a value names a canonical daily Markdown source without traversal or aliases. */
export function isCanonicalDailySourcePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CANONICAL_DAILY_SOURCE_PATTERN.exec(value);
  if (match === null) return false;
  const day = match[1]!;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
