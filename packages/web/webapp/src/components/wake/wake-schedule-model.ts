import type { WebWakeSchedule, WebWakeScheduleDefinition } from "../../../../src/contracts.js";
import { ApiError } from "../../api";

/**
 * Pure draft, validation and wording rules for the wake-up schedule editor.
 *
 * The server stays authoritative: nothing here resolves an unsaved wall-clock
 * time into an instant. The only instants this module formats are
 * server-computed `nextFireAt` values, always with an explicit time zone.
 */

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MAX_TIMES = 8;
export const MAX_MESSAGE_BYTES = 1000;
/** Show the byte counter from here on; below it the limit is irrelevant. */
export const MESSAGE_COUNTER_FROM = 800;

export type WakeKind = WebWakeScheduleDefinition["kind"];

/** Everything the form edits. Both kinds keep their own fields while switching. */
export interface WakeDraft {
  readonly kind: WakeKind;
  readonly timezone: string;
  /** Once: wall date `YYYY-MM-DD` and time `HH:mm` in `timezone`. */
  readonly date: string;
  readonly time: string;
  /** Weekly: 0=Sunday … 6=Saturday, in the order the operator picked them. */
  readonly days: readonly number[];
  /** Weekly: `HH:mm`, in entry order while editing. */
  readonly times: readonly string[];
  readonly message: string;
}

export interface WakeIssues {
  readonly timezone?: string;
  readonly when?: string;
  readonly days?: string;
  readonly times?: string;
  /** Indexes of the time inputs that are empty or repeated. */
  readonly badTimes?: readonly number[];
  readonly message?: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

/** The server's own check: an identifier `Intl` accepts, in its canonical case. */
export function normalizeTimeZone(zone: string): string | null {
  const trimmed = zone.trim();
  if (trimmed === "" || trimmed.length > 128) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone; }
  catch { return null; }
}

/** Wall-clock `YYYY-MM-DDTHH:mm` of an instant in a zone (Gregorian, Latin digits, 24h). */
export function wallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Tomorrow at 09:00 on the zone's calendar. Called once, for a new schedule only. */
export function tomorrowAtNine(timeZone: string, now: Date): { date: string; time: string } {
  const [year, month, day] = wallClock(now, timeZone).slice(0, 10).split("-").map(Number) as [number, number, number];
  return { date: new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10), time: "09:00" };
}

export function newDraft(timezone: string, now: Date): WakeDraft {
  return { kind: "once", timezone, ...tomorrowAtNine(timezone, now), days: [], times: ["09:00"], message: "" };
}

/** The editable form of a saved definition. The other kind starts empty. */
export function draftFromDefinition(definition: WebWakeScheduleDefinition): WakeDraft {
  const message = definition.message ?? "";
  if (definition.kind === "once") {
    const [date = "", time = ""] = definition.localAt.split("T");
    return { kind: "once", timezone: definition.timezone, date, time, days: [], times: ["09:00"], message };
  }
  return { kind: "weekly", timezone: definition.timezone, date: "", time: "09:00",
    days: [...definition.days], times: [...definition.times], message };
}

/** What Save would send. Days are sorted like the server stores them. */
export function definitionFromDraft(draft: WakeDraft): WebWakeScheduleDefinition {
  const timezone = normalizeTimeZone(draft.timezone) ?? draft.timezone;
  const message = draft.message === "" ? {} : { message: draft.message };
  return draft.kind === "once"
    ? { kind: "once", timezone, localAt: `${draft.date}T${draft.time}`, ...message }
    : { kind: "weekly", timezone, days: [...draft.days].sort((a, b) => a - b), times: [...draft.times], ...message };
}

/** Order-, case- and absence-insensitive identity of a definition. */
function definitionKey(definition: WebWakeScheduleDefinition): string {
  const timezone = normalizeTimeZone(definition.timezone) ?? definition.timezone;
  const message = definition.message ?? "";
  return definition.kind === "once"
    ? JSON.stringify(["once", timezone, definition.localAt, message])
    : JSON.stringify(["weekly", timezone, [...definition.days].sort((a, b) => a - b), [...definition.times].sort(), message]);
}

/** Whether the draft differs from the loaded definition (`null` means there is none). */
export function isDraftDirty(draft: WakeDraft, baseline: WebWakeScheduleDefinition | null): boolean {
  return baseline === null || definitionKey(definitionFromDraft(draft)) !== definitionKey(baseline);
}

/** Blocking problems only. Server-side rules (DST gaps, the past) stay server-side. */
export function validateDraft(draft: WakeDraft): WakeIssues {
  const issues: { -readonly [K in keyof WakeIssues]: WakeIssues[K] } = {};
  if (normalizeTimeZone(draft.timezone) === null) issues.timezone = "Choose a valid timezone, such as Europe/Berlin.";
  if (draft.kind === "once") {
    if (!DATE.test(draft.date) || !TIME.test(draft.time)) issues.when = "Choose a date and a time.";
  } else {
    if (draft.days.length === 0) issues.days = "Pick at least one day.";
    const bad = draft.times.flatMap((time, index) =>
      !TIME.test(time) || draft.times.indexOf(time) !== index ? [index] : []);
    if (bad.length > 0) {
      issues.badTimes = bad;
      issues.times = draft.times.some((time) => !TIME.test(time))
        ? "Enter every time, or remove the empty one."
        : "Each time can be used only once.";
    }
  }
  const bytes = utf8Bytes(draft.message);
  if (bytes > MAX_MESSAGE_BYTES) {
    issues.message = `${String(bytes - MAX_MESSAGE_BYTES)} bytes over the limit. Emoji and accented letters use more than one byte.`;
  }
  return issues;
}

export const hasIssues = (issues: WakeIssues): boolean => Object.keys(issues).length > 0;

/**
 * A conservative hint only: the wall time has clearly passed in its zone.
 * Around a daylight-saving overlap the server decides; this never blocks Save.
 */
export function onceLooksPast(draft: Pick<WakeDraft, "date" | "time" | "timezone">, now: Date): boolean {
  const zone = normalizeTimeZone(draft.timezone);
  if (zone === null || !DATE.test(draft.date) || !TIME.test(draft.time)) return false;
  return `${draft.date}T${draft.time}` < wallClock(new Date(now.getTime() - 60 * 60 * 1000), zone);
}

/** The next distinct hourly slot after the last time, keeping its minutes. */
export function nextTimeSlot(times: readonly string[]): string {
  const last = [...times].reverse().find((time) => TIME.test(time)) ?? "08:00";
  const [hour, minute] = last.split(":").map(Number) as [number, number];
  for (let step = 1; step <= 24; step += 1) {
    const candidate = `${String((hour + step) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (!times.includes(candidate)) return candidate;
  }
  // Unreachable below 24 distinct times; the editor caps the list at eight.
  return last;
}

/** Days in the locale's week order (Monday first when the platform cannot say). */
export function weekOrder(locale?: string): number[] {
  let first = 1;
  try {
    const info = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number };
    };
    first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1;
  } catch { first = 1; }
  const start = first % 7;
  return Array.from({ length: 7 }, (_, index) => (start + index) % 7);
}

const list = (items: readonly string[]): string => items.length <= 1
  ? items.join("")
  : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;

/** A wall time (`HH:mm`) in the reader's 12/24-hour convention, without any zone math. */
export function formatWallTime(time: string, locale?: string): string {
  const match = TIME.exec(time);
  if (!match) return time;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
}

/** A wall date (`YYYY-MM-DD`) as the calendar date it names, without any zone math. */
export function formatWallDate(date: string, locale?: string): string {
  const match = DATE.exec(date);
  if (!match) return date;
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dayPhrase(days: readonly number[], order: readonly number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "Every weekday";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Every Saturday and Sunday";
  return `Every ${list(order.filter((day) => set.has(day)).map((day) => WEEKDAY_SHORT[day]!))}`;
}

/** One sentence for what the draft will do, or `null` while it is incomplete. */
export function describeDraft(draft: WakeDraft, options: { locale?: string; order?: readonly number[] } = {}): string | null {
  if (draft.kind === "once") {
    if (!DATE.test(draft.date) || !TIME.test(draft.time)) return null;
    return `${formatWallDate(draft.date, options.locale)} at ${formatWallTime(draft.time, options.locale)}`;
  }
  const times = draft.times.filter((time, index) => TIME.test(time) && draft.times.indexOf(time) === index);
  if (draft.days.length === 0 || times.length === 0) return null;
  const days = dayPhrase(draft.days, options.order ?? weekOrder(options.locale));
  const sorted = [...times].sort();
  return sorted.length > 3
    ? `${days}, ${String(sorted.length)} times on each selected day`
    : `${days} at ${list(sorted.map((time) => formatWallTime(time, options.locale)))}`;
}

/** A server instant, spelled out unambiguously; `timeZone` omitted means this device. */
export function formatInstant(iso: string, timeZone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

/** The saved next wake-up in the schedule's zone, plus this device's reading when it differs. */
export function describeNextFire(iso: string, scheduleZone: string, deviceZone: string, locale?: string): { scheduled: string; local: string | null } {
  const scheduled = formatInstant(iso, scheduleZone, locale);
  const same = normalizeTimeZone(scheduleZone) === normalizeTimeZone(deviceZone);
  const local = same ? null : formatInstant(iso, deviceZone, locale);
  return { scheduled, local: local === scheduled ? null : local };
}

export type WakeOutcome = NonNullable<WebWakeSchedule["lastOutcome"]>;
export const OUTCOME_COPY: Readonly<Record<WakeOutcome, { readonly text: string; readonly tone: "success" | "warning" | "danger" | "muted" }>> = {
  fired: { text: "Last wake-up ran.", tone: "success" },
  skipped: { text: "Last wake-up was skipped because it was more than an hour late.", tone: "warning" },
  failed: { text: "Last wake-up started but its turn failed.", tone: "danger" },
  uncertain: { text: "Last wake-up started; its result isn't confirmed yet.", tone: "muted" },
};

export const STATE_LABEL: Readonly<Record<WebWakeSchedule["state"], string>> = {
  active: "Active", paused: "Paused", completed: "Completed",
};

type WakeSummary = NonNullable<import("../../types").ThreadSummary["wakeSchedule"]>;

/** The conversation menu's one-line status, in this device's time (the summary has no zone). */
export function wakeStatusText(summary: WakeSummary, locale?: string): string {
  const kind = summary.kind === "once" ? "Once" : "Weekly";
  if (summary.state === "paused") return `${kind} · paused`;
  if (summary.state === "completed") return `${kind} · completed`;
  return summary.nextFireAt === null ? `${kind} · active` : `${kind} · next ${formatInstant(summary.nextFireAt, undefined, locale)}`;
}

/** Humanized server failures. Field prefixes (`localAt: …`) are the server's own validator shape. */
export function describeWakeError(cause: unknown): { readonly message: string; readonly conflict: boolean } {
  if (cause instanceof ApiError && cause.code === "wake_revision_conflict") {
    return { message: "This schedule changed since you opened it.", conflict: true };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof ApiError && cause.code === "invalid_wake_schedule") {
    const field = /^(?:localAt|timezone|days|times|message|kind|state|schedule|expectedRevision): (.+)$/u.exec(message);
    if (field) return { message: field[1]!, conflict: false };
  }
  return { message, conflict: false };
}
