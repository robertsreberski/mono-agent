import { CronExpressionParser } from "cron-parser";

import type { WebWakeScheduleDefinition } from "./contracts.js";
import { WebConsoleError } from "./errors.js";

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/u;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function invalid(field: string, message: string): never {
  throw new WebConsoleError("invalid_wake_schedule", `${field}: ${message}`, 400);
}

export function localFields(date: Date, timezone: string): string {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (kind: string) => fields.find((field) => field.type === kind)!.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function next(expression: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(expression, { tz: timezone, currentDate: after }).next().toDate();
}

/** Resolve one wall-clock slot. Cron's timezone semantics shift weekly spring gaps forward. */
export function nextWakeOccurrence(definition: WebWakeScheduleDefinition, after: Date): Date | null {
  if (definition.kind === "once") {
    const match = LOCAL.exec(definition.localAt);
    if (!match) invalid("localAt", "Enter a local date and time (YYYY-MM-DDTHH:mm).");
    const [, year, month, day, hour, minute] = match;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31
      || new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
      invalid("localAt", "Enter a valid calendar date.");
    }
    // Restrict the month and day as well as the year: cron's day/month matching
    // otherwise repeats annually, even though a one-off cannot repeat.
    const expression = `${Number(minute)} ${Number(hour)} ${Number(day)} ${Number(month)} *`;
    const anchor = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)) - 48 * 60 * 60 * 1_000);
    let candidate = next(expression, definition.timezone, anchor);
    if (localFields(candidate, definition.timezone).slice(0, 10) !== `${year}-${month}-${day}` && candidate < new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))) {
      candidate = next(expression, definition.timezone, candidate);
    }
    if (localFields(candidate, definition.timezone) !== definition.localAt) {
      invalid("localAt", "This local time does not exist in the selected timezone (daylight-saving gap).");
    }
    return candidate > after ? candidate : null;
  }
  let earliest: Date | null = null;
  for (const day of definition.days) {
    for (const time of definition.times) {
      const match = TIME.exec(time)!;
      const expression = `${Number(match[2])} ${Number(match[1])} * * ${day}`;
      let candidate = next(expression, definition.timezone, after);
      // On an overlap, cron can yield the same wall-clock slot twice. The
      // first candidate from before the local day is canonical; discard later copies.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const dayStart = new Date(candidate.getTime() - 36 * 60 * 60 * 1_000);
        const first = next(expression, definition.timezone, dayStart);
        if (localFields(first, definition.timezone) !== localFields(candidate, definition.timezone)
          || first.getTime() === candidate.getTime()) break;
        candidate = next(expression, definition.timezone, candidate);
      }
      if (earliest === null || candidate < earliest) earliest = candidate;
    }
  }
  return earliest;
}

export function parseWakeDefinition(value: unknown, now = new Date()): WebWakeScheduleDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("schedule", "Expected an object.");
  const body = value as Record<string, unknown>;
  const kind = body.kind;
  const keys = kind === "once" ? ["kind", "timezone", "localAt", "message", "compactFirst"]
    : kind === "weekly" ? ["kind", "timezone", "days", "times", "message", "compactFirst"] : [];
  if (keys.length === 0) invalid("kind", "Choose once or weekly.");
  for (const key of Object.keys(body)) if (!keys.includes(key)) invalid(key, "Unknown field for this schedule kind.");
  if (typeof body.timezone !== "string" || body.timezone.length > 128) invalid("timezone", "Enter an IANA timezone.");
  let timezone: string;
  try { timezone = new Intl.DateTimeFormat("en", { timeZone: body.timezone }).resolvedOptions().timeZone; }
  catch { invalid("timezone", "Enter a valid IANA timezone."); }
  if (body.message !== undefined && (typeof body.message !== "string" || Buffer.byteLength(body.message, "utf8") > 1000)) {
    invalid("message", "Must be at most 1000 UTF-8 bytes.");
  }
  if (body.compactFirst !== undefined && typeof body.compactFirst !== "boolean") {
    invalid("compactFirst", "Must be a boolean.");
  }
  const compaction = body.compactFirst === undefined ? {} : { compactFirst: body.compactFirst as boolean };
  const message = body.message as string | undefined;
  if (kind === "once") {
    if (typeof body.localAt !== "string" || !LOCAL.test(body.localAt)) invalid("localAt", "Enter a local date and time (YYYY-MM-DDTHH:mm).");
    const definition: WebWakeScheduleDefinition = { kind: "once", timezone, localAt: body.localAt, ...compaction, ...(message === undefined ? {} : { message }) };
    if (nextWakeOccurrence(definition, now) === null) invalid("localAt", "Choose a future local date and time.");
    return definition;
  }
  if (!Array.isArray(body.days) || body.days.length < 1 || body.days.length > 7
    || !body.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    || new Set(body.days).size !== body.days.length) invalid("days", "Select 1–7 distinct weekdays (0=Sunday).");
  if (!Array.isArray(body.times) || body.times.length < 1 || body.times.length > 8
    || !body.times.every((time) => typeof time === "string" && TIME.test(time))
    || new Set(body.times).size !== body.times.length) invalid("times", "Select 1–8 distinct HH:mm times.");
  return { kind: "weekly", timezone, days: [...body.days].sort() as number[], times: [...body.times].sort() as string[],
    ...compaction, ...(message === undefined ? {} : { message }) };
}
