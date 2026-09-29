import { describe, expect, it } from "vitest";
import { nativeDisplay } from "./WakeWhenFields";

describe("nativeDisplay", () => {
  it("formats a date value as the calendar day it names, whatever the device zone", () => {
    const shown = nativeDisplay("date", "2026-09-30");
    expect(shown).toMatch(/2026/u);
    expect(shown).toMatch(/30/u);
  });
  it("formats a time value as its own wall time", () => {
    expect(nativeDisplay("time", "09:05")).toMatch(/0?9.05/u);
    expect(nativeDisplay("time", "18:30")).toMatch(/(18|6).30/u);
  });
  it("returns null for an empty or malformed value so the field shows its prompt", () => {
    expect(nativeDisplay("date", "")).toBeNull();
    expect(nativeDisplay("time", "")).toBeNull();
    expect(nativeDisplay("date", "30/09/2026")).toBeNull();
  });
});
