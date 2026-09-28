import { describe, expect, it } from "vitest";

import {
  minimumMinuteGap,
  nextTelegramScheduleOccurrence,
  validateTelegramScheduleTiming,
} from "../telegram-schedule-timing.js";

const NOW = new Date("2026-09-28T10:00:00.000Z");
const options = { now: NOW, minIntervalMinutes: 15 };

describe("Telegram schedule timing", () => {
  it("accepts a one-off with an explicit offset at least a minute ahead", () => {
    expect(validateTelegramScheduleTiming({ kind: "once", at: "2026-09-28T12:30:00+02:00" }, options))
      .toEqual({ kind: "once", at: "2026-09-28T10:30:00.000Z" });
    expect(() => validateTelegramScheduleTiming({ kind: "once", at: "2026-09-28T12:30:00" }, options))
      .toThrow(/explicit offset/u);
    expect(() => validateTelegramScheduleTiming({ kind: "once", at: "2026-09-28T10:00:30Z" }, options))
      .toThrow(/one minute in the future/u);
  });

  it("requires a real IANA timezone and five non-hashed fields", () => {
    expect(validateTelegramScheduleTiming({ kind: "cron", expression: "0  8 * * *", timezone: "Europe/Budapest" }, options))
      .toEqual({ kind: "cron", expression: "0 8 * * *", timezone: "Europe/Budapest" });
    expect(() => validateTelegramScheduleTiming({ kind: "cron", expression: "0 8 * * *", timezone: "Mars/Olympus" }, options))
      .toThrow(/IANA timezone/u);
    expect(() => validateTelegramScheduleTiming({ kind: "cron", expression: "0 8 * *", timezone: "UTC" }, options))
      .toThrow(/five cron fields/u);
    expect(() => validateTelegramScheduleTiming({ kind: "cron", expression: "H 8 * * *", timezone: "UTC" }, options))
      .toThrow(/hashed/u);
    expect(validateTelegramScheduleTiming({ kind: "cron", expression: "0 8 * * THU", timezone: "UTC" }, options).kind)
      .toBe("cron");
  });

  it("rejects expressions that can fire more often than the minimum interval", () => {
    expect(() => validateTelegramScheduleTiming({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" }, options))
      .toThrow(/every 15 minutes/u);
    expect(validateTelegramScheduleTiming({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" }, options).kind)
      .toBe("cron");
    expect(() => validateTelegramScheduleTiming({ kind: "cron", expression: "L 8 * * *", timezone: "UTC" }, options))
      .toThrow();
  });

  it("computes circular minute gaps conservatively", () => {
    expect(minimumMinuteGap("0")).toBe(60);
    expect(minimumMinuteGap("*")).toBe(1);
    expect(minimumMinuteGap("0,30")).toBe(30);
    expect(minimumMinuteGap("0,50")).toBe(10);
    expect(minimumMinuteGap("5/20")).toBe(20);
    expect(minimumMinuteGap("10-20/5")).toBe(5);
    expect(minimumMinuteGap("x")).toBeUndefined();
    expect(minimumMinuteGap("61")).toBeUndefined();
  });

  it("follows the zone across a DST change", () => {
    const timing = { kind: "cron" as const, expression: "0 8 * * *", timezone: "Europe/Budapest" };
    // Budapest leaves summer time on 2026-10-25: 08:00 is 06:00Z before and 07:00Z after.
    expect(nextTelegramScheduleOccurrence(timing, new Date("2026-10-24T07:00:00.000Z"))?.toISOString())
      .toBe("2026-10-25T07:00:00.000Z");
    expect(nextTelegramScheduleOccurrence(timing, new Date("2026-10-23T07:00:00.000Z"))?.toISOString())
      .toBe("2026-10-24T06:00:00.000Z");
  });

  it("has no next occurrence for a past one-off", () => {
    expect(nextTelegramScheduleOccurrence({ kind: "once", at: "2026-09-28T09:00:00.000Z" }, NOW)).toBeUndefined();
  });
});
