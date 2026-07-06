import { describe, expect, test } from "vitest";

import { dateStr, dayKey, timeStr } from "./format";

describe("timezone formatting", () => {
  test("falls back to viewer timezone when an instance timezone is invalid", () => {
    const ts = "2026-07-04T10:00:00.000Z";

    expect(timeStr(ts, "Not/A_Zone")).toBe(timeStr(ts));
    expect(dateStr(ts, "Not/A_Zone")).toBe(dateStr(ts));
    expect(dayKey(ts, "Not/A_Zone")).toBe(dayKey(ts));
  });
});
