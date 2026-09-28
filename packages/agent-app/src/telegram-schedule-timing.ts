import { validateCronExpression } from "@mono-agent/cron-adapter";

/**
 * Timing rules for agent-managed Telegram schedules. Recurring schedules reuse
 * the cron adapter's parser (same five-field syntax, DST handling via
 * cron-parser) but always require an explicit IANA timezone: "every morning at
 * 8" means nothing without one, and the server's zone is never assumed.
 */

export type TelegramScheduleTiming =
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone: string };

export class TelegramScheduleTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramScheduleTimingError";
  }
}

/** A one-off must be at least this far ahead when created or updated. */
export const TELEGRAM_SCHEDULE_ONCE_MIN_LEAD_MS = 60_000;
const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Validate a model-supplied timing and return its normalized form. Throws
 * {@link TelegramScheduleTimingError} with a model-readable reason.
 */
export function validateTelegramScheduleTiming(
  timing: TelegramScheduleTiming,
  options: { readonly now: Date; readonly minIntervalMinutes: number },
): TelegramScheduleTiming {
  if (timing.kind === "once") {
    const raw = timing.at.trim();
    if (!RFC3339_WITH_OFFSET.test(raw)) {
      throw new TelegramScheduleTimingError(
        "schedule.at must be an RFC 3339 timestamp with an explicit offset, e.g. 2026-10-01T08:00:00+02:00.",
      );
    }
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw new TelegramScheduleTimingError("schedule.at is not a valid date.");
    }
    if (at.getTime() - options.now.getTime() < TELEGRAM_SCHEDULE_ONCE_MIN_LEAD_MS) {
      throw new TelegramScheduleTimingError("schedule.at must be at least one minute in the future.");
    }
    return { kind: "once", at: at.toISOString() };
  }
  const timezone = timing.timezone.trim();
  if (timezone.length === 0 || !isValidTimeZone(timezone)) {
    throw new TelegramScheduleTimingError(
      "schedule.timezone must be an IANA timezone such as Europe/Budapest. Ask the user if you do not know it.",
    );
  }
  const expression = timing.expression.trim().replace(/\s+/gu, " ");
  const fields = expression.split(" ");
  if (fields.length !== 5) {
    throw new TelegramScheduleTimingError("schedule.expression must have exactly five cron fields (minute hour day month weekday).");
  }
  if (fields.some((field, index) => (index === 4 ? field.replace(/THU/giu, "") : field).includes("H"))) {
    throw new TelegramScheduleTimingError("schedule.expression cannot use hashed H fields.");
  }
  const parsed = validateCronExpression(expression, { currentDate: options.now, timezone });
  if (!parsed.ok) {
    throw new TelegramScheduleTimingError(
      parsed.code === "invalid" ? `schedule.expression is invalid: ${parsed.reason}` : "schedule.expression is invalid.",
    );
  }
  const gap = minimumMinuteGap(fields[0]!);
  if (gap === undefined) {
    throw new TelegramScheduleTimingError(
      "schedule.expression minute field must use numbers, *, ranges, steps or lists.",
    );
  }
  if (gap < options.minIntervalMinutes) {
    throw new TelegramScheduleTimingError(
      `schedule.expression can run more often than every ${String(options.minIntervalMinutes)} minutes (the configured minimum).`,
    );
  }
  return { kind: "cron", expression, timezone };
}

/**
 * The next occurrence strictly after `after`, or undefined for a one-off whose
 * time is not after `after`.
 */
export function nextTelegramScheduleOccurrence(timing: TelegramScheduleTiming, after: Date): Date | undefined {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  const next = validateCronExpression(timing.expression, { currentDate: after, timezone: timing.timezone });
  return next.ok ? next.nextDate : undefined;
}

/**
 * Smallest circular gap (minutes) between the minute values a cron minute
 * field selects. It is a conservative lower bound on the real gap between two
 * firings: restricting hours, days or weekdays can only widen it, so some
 * sparse expressions that would be safe are rejected. Undefined when the field
 * uses syntax this check does not understand.
 */
export function minimumMinuteGap(field: string): number | undefined {
  const minutes = new Set<number>();
  for (const part of field.split(",")) {
    const expanded = expandMinutePart(part);
    if (expanded === undefined) return undefined;
    for (const minute of expanded) minutes.add(minute);
  }
  const sorted = [...minutes].sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return 60;
  let gap = 60 - sorted[sorted.length - 1]! + sorted[0]!;
  for (let index = 1; index < sorted.length; index += 1) {
    gap = Math.min(gap, sorted[index]! - sorted[index - 1]!);
  }
  return gap;
}

function expandMinutePart(part: string): number[] | undefined {
  const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/u.exec(part);
  if (match === null) return undefined;
  const [, base, stepRaw] = match;
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1 || step > 59) return undefined;
  let start: number;
  let end: number;
  if (base === "*") {
    start = 0;
    end = 59;
  } else if (base!.includes("-")) {
    const [from, to] = base!.split("-").map(Number);
    start = from!;
    end = to!;
  } else {
    start = Number(base);
    // `5/15` means from 5 every 15 to the end of the hour.
    end = stepRaw === undefined ? start : 59;
  }
  if (start < 0 || end > 59 || start > end) return undefined;
  const values: number[] = [];
  for (let minute = start; minute <= end; minute += step) values.push(minute);
  return values;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
