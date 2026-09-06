import { describe, expect, it } from "vitest";
import { formatCronSchedule } from "./cron-schedule";

describe("formatCronSchedule", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["0 * * * *", "Every hour at :00 (UTC)"],
    ["59 * * * *", "Every hour at :59 (UTC)"],
    ["0 0 * * *", "Every day at 00:00 (UTC)"],
    ["59 23 * * *", "Every day at 23:59 (UTC)"],
    ["5 9 * * 1-5", "Weekdays at 09:05 (UTC)"],
    ["  05   09 * * *  ", "Every day at 09:05 (UTC)"],
  ])("formats %s", (expression, expected) => {
    expect(formatCronSchedule(expression)).toBe(expected);
  });

  it.each(Array.from({ length: 60 }, (_, step) => step))("bounds uniform minute step %i", (step) => {
    const expression = `*/${step} * * * *`;
    expect(formatCronSchedule(expression)).toBe(step > 0 && 60 % step === 0
      ? step === 1 ? "Every minute" : `Every ${step} minutes`
      : `${expression} (UTC)`);
  });

  it.each(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    .map((name, index) => [index, name] as const))("names weekday %i", (index, name) => {
    expect(formatCronSchedule(`7 8 * * ${index}`, "Europe/Amsterdam"))
      .toBe(`Every ${name} at 08:07 (Europe/Amsterdam)`);
  });

  it.each([
    "60 * * * *", "-1 * * * *", "1.5 * * * *", "0 24 * * *", "0 -1 * * *",
    "0 0 * * 8", "0 0 * * -1", "*/60 * * * *", "*/1.5 * * * *", "*/-5 * * * *",
    "*/45 * * * *", "*/90 * * * *", "*/ * * * *", "H * * * *", "@daily",
    "0,30 * * * *", "0 9 * * MON", "0 9 * JAN *", "0 9 * * 1-6", "0 9 * * 0,6",
    "0 9 1 * *", "0 9 * 1 *", "* 9 * * *", "0 */2 * * *", "* * * * 1-5",
    "0 9 * *", "0 0 9 * * *", "000 9 * * *", "not a cron expression", "0 9 * * ?",
  ])("retains unsupported expression %s", (expression) => {
    expect(formatCronSchedule(expression, "Asia/Tokyo")).toBe(`${expression} (Asia/Tokyo)`);
  });

  it("normalizes raw whitespace and defaults an empty timezone", () => {
    expect(formatCronSchedule("  0,30   * * * * ", " ")).toBe("0,30 * * * * (UTC)");
    expect(formatCronSchedule("0 * * * *", " Asia/Kolkata ")).toBe("Every hour at :00 (Asia/Kolkata)");
  });

  it.each([undefined, "", "  \n "])("handles missing expression %s", (expression) => {
    expect(formatCronSchedule(expression)).toBe("Schedule unavailable");
  });
});
