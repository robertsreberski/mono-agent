import { describe, expect, it } from "vitest";
import { ApiError } from "../../api";
import {
  definitionFromDraft, describeDraft, describeNextFire, describeWakeError, draftFromDefinition, isDraftDirty,
  newDraft, nextTimeSlot, normalizeTimeZone, onceHasElapsed, onceLooksPast, tomorrowAtNine, utf8Bytes, validateDraft, wakeStatusText,
  type WakeDraft,
} from "./wake-schedule-model";

const weekly: WakeDraft = { kind: "weekly", timezone: "UTC", date: "", time: "09:00", days: [3, 1], times: ["14:30", "09:00"], message: "" };
const mondayFirst = [1, 2, 3, 4, 5, 6, 0];

describe("wake schedule draft rules", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
    expect(validateDraft({ ...weekly, message: "a".repeat(996) + "😀" }).message).toBeUndefined();
    expect(validateDraft({ ...weekly, message: "a".repeat(997) + "😀" }).message).toMatch(/^1 bytes over/u);
  });

  it("normalizes zones like the server and rejects unknown ones", () => {
    expect(normalizeTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("Mars/Olympus")).toBeNull();
    expect(validateDraft({ ...weekly, timezone: "Nowhere/Else" }).timezone).toBeDefined();
  });

  it("requires days, filled distinct times and a complete once date", () => {
    expect(validateDraft({ ...weekly, days: [] }).days).toBe("Pick at least one day.");
    expect(validateDraft({ ...weekly, times: ["09:00", "09:00"] })).toMatchObject({ badTimes: [1], times: "Each time can be used only once." });
    expect(validateDraft({ ...weekly, times: ["09:00", ""] }).times).toMatch(/Enter every time/u);
    expect(validateDraft({ ...weekly, kind: "once", date: "", time: "09:00" }).when).toBeDefined();
    expect(validateDraft({ ...weekly, kind: "once", date: "2031-05-14", time: "09:00" })).toEqual({});
  });

  it("finds the next distinct hourly slot, keeping minutes and wrapping at midnight", () => {
    expect(nextTimeSlot(["09:00", "14:30"])).toBe("15:30");
    expect(nextTimeSlot(["23:15"])).toBe("00:15");
    expect(nextTimeSlot(["09:00", "10:00", "11:00"])).toBe("12:00");
    expect(nextTimeSlot(["10:00", "09:00"])).toBe("11:00");
  });

  it("computes tomorrow at 09:00 on the zone's calendar, across month and year ends", () => {
    expect(tomorrowAtNine("UTC", new Date("2030-12-31T12:00:00Z"))).toEqual({ date: "2031-01-01", time: "09:00" });
    // 23:30 UTC on 31 Jan is already 1 Feb in Tokyo.
    expect(tomorrowAtNine("Asia/Tokyo", new Date("2031-01-31T23:30:00Z"))).toEqual({ date: "2031-02-02", time: "09:00" });
    expect(newDraft("UTC", new Date("2031-05-13T10:00:00Z"))).toMatchObject({ kind: "once", date: "2031-05-14", time: "09:00" });
  });

  it("treats order, zone case and an absent message as unchanged", () => {
    const saved = definitionFromDraft(weekly);
    expect(saved).toEqual({ kind: "weekly", timezone: "UTC", days: [1, 3], times: ["14:30", "09:00"] });
    expect(isDraftDirty({ ...weekly, days: [1, 3], times: ["09:00", "14:30"] }, definitionFromDraft({ ...weekly, times: ["09:00", "14:30"] }))).toBe(false);
    expect(isDraftDirty({ ...weekly, timezone: "utc" }, saved)).toBe(false);
    expect(isDraftDirty({ ...weekly, date: "2040-01-01" }, saved)).toBe(false);
    expect(isDraftDirty({ ...weekly, message: " " }, saved)).toBe(true);
    expect(isDraftDirty(weekly, null)).toBe(true);
    const once = draftFromDefinition({ kind: "once", timezone: "UTC", localAt: "2031-05-14T09:00", message: "Hi" });
    expect(definitionFromDraft(once)).toEqual({ kind: "once", timezone: "UTC", localAt: "2031-05-14T09:00", message: "Hi" });
  });

  it("treats a saved one-off as elapsed on the zone's plain wall clock, with no grace", () => {
    expect(onceHasElapsed("2031-05-14T09:00", "UTC", new Date("2031-05-14T09:01:00Z"))).toBe(true);
    expect(onceHasElapsed("2031-05-14T09:00", "UTC", new Date("2031-05-14T09:59:00Z"))).toBe(true);
    expect(onceHasElapsed("2031-05-14T09:00", "UTC", new Date("2031-05-14T09:00:00Z"))).toBe(true);
    expect(onceHasElapsed("2031-05-14T09:00", "UTC", new Date("2031-05-14T08:59:00Z"))).toBe(false);
    expect(onceHasElapsed("2031-05-14T09:00", "Asia/Tokyo", new Date("2031-05-14T00:30:00Z"))).toBe(true);
    // New York fall-back 2026-11-01: during the first 01:xx pass, 01:30 has plainly elapsed at 01:45.
    expect(onceHasElapsed("2026-11-01T01:30", "America/New_York", new Date("2026-11-01T05:45:00Z"))).toBe(true);
    // During the repeated hour (second 01:10) the wall clock reads earlier; the server decides.
    expect(onceHasElapsed("2026-11-01T01:30", "America/New_York", new Date("2026-11-01T06:10:00Z"))).toBe(false);
    expect(onceHasElapsed("not-a-time", "UTC", new Date())).toBe(false);
  });

  it("only hints at a past one-off when it is clearly past", () => {
    const now = new Date("2031-05-14T12:00:00Z");
    expect(onceLooksPast({ date: "2031-05-14", time: "09:00", timezone: "UTC" }, now)).toBe(true);
    expect(onceLooksPast({ date: "2031-05-14", time: "11:30", timezone: "UTC" }, now)).toBe(false);
    expect(onceLooksPast({ date: "2031-05-15", time: "09:00", timezone: "UTC" }, now)).toBe(false);
  });
});

describe("wake schedule wording", () => {
  it("describes weekly drafts in plain language", () => {
    expect(describeDraft(weekly, { locale: "en-GB", order: mondayFirst })).toBe("Every Mon and Wed at 09:00 and 14:30");
    expect(describeDraft({ ...weekly, days: [1, 2, 3, 4, 5] }, { locale: "en-GB", order: mondayFirst })).toBe("Every weekday at 09:00 and 14:30");
    expect(describeDraft({ ...weekly, days: [0, 1, 2, 3, 4, 5, 6], times: ["06:00"] }, { locale: "en-GB", order: mondayFirst })).toBe("Every day at 06:00");
    expect(describeDraft({ ...weekly, times: ["06:00", "08:00", "10:00", "12:00"] }, { locale: "en-GB", order: mondayFirst }))
      .toBe("Every Mon and Wed, 4 times on each selected day");
    expect(describeDraft({ ...weekly, days: [] })).toBeNull();
  });

  it("describes a once draft as its wall date and time, without zone math", () => {
    expect(describeDraft({ ...weekly, kind: "once", date: "2031-05-14", time: "09:00" }, { locale: "en-GB" })).toBe("Wed, 14 May 2031 at 09:00");
  });

  it("formats a saved instant in the schedule zone and adds this device's time only when it differs", () => {
    const next = describeNextFire("2031-05-12T12:30:00Z", "America/Chicago", "Europe/Lisbon", "en-GB");
    expect(next.scheduled).toBe("Mon 12 May, 07:30");
    // Same calendar day in both zones: only the time is repeated.
    expect(next.local).toBe("13:30");
    // Different calendar days: the device reading carries its own date.
    expect(describeNextFire("2031-05-12T23:30:00Z", "America/Chicago", "Asia/Tokyo", "en-GB").local).toBe("Tue 13 May, 08:30");
    expect(describeNextFire("2031-05-12T12:30:00Z", "UTC", "Etc/UTC", "en-GB").local).toBeNull();
    // Different zones with the same wall time at that instant add nothing.
    expect(describeNextFire("2031-01-12T12:30:00Z", "Europe/Lisbon", "UTC", "en-GB").local).toBeNull();
  });

  it("gives the menu one status line per state", () => {
    expect(wakeStatusText({ state: "active", kind: "weekly", revision: 1, nextFireAt: "2031-05-12T12:30:00Z" }, "en-GB")).toMatch(/^Weekly · next /u);
    expect(wakeStatusText({ state: "active", kind: "once", revision: 1, nextFireAt: null })).toBe("Once · active");
    expect(wakeStatusText({ state: "paused", kind: "weekly", revision: 1, nextFireAt: null })).toBe("Weekly · paused");
    expect(wakeStatusText({ state: "completed", kind: "once", revision: 1, nextFireAt: null })).toBe("Once · completed");
  });

  it("humanizes conflicts and field-prefixed validation errors only", () => {
    expect(describeWakeError(new ApiError("Schedule changed; reload and retry.", 409, "wake_revision_conflict"))).toMatchObject({ message: "This schedule changed since you opened it.", conflict: true });
    expect(describeWakeError(new ApiError("No schedule exists for this conversation.", 404, "wake_schedule_not_found"))).toMatchObject({ message: "This schedule was deleted elsewhere.", conflict: true });
    expect(describeWakeError(new ApiError("This conversation already has a schedule.", 409, "wake_schedule_exists"))).toMatchObject({ conflict: true });
    expect(describeWakeError(new ApiError("localAt: Choose a future local date and time.", 400, "invalid_wake_schedule")).message).toBe("Choose a future local date and time.");
    expect(describeWakeError(new ApiError("thread_archived: nope", 409, "thread_archived")).message).toBe("thread_archived: nope");
    expect(describeWakeError(new Error("Offline.")).message).toBe("Offline.");
  });
});
