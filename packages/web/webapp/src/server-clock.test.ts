import { afterEach, describe, expect, it, vi } from "vitest";
import { recordServerTime, resetServerClock, serverNow } from "./server-clock";

afterEach(() => {
  resetServerClock();
  vi.useRealTimers();
});

describe("server clock", () => {
  it("assumes a synced clock until the server stamps an event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:10.000Z"));
    expect(serverNow()).toBe(Date.parse("2026-09-04T10:00:10.000Z"));
  });

  it("reads the server's clock through the most recent stamped event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:10.000Z"));
    recordServerTime("2026-09-04T10:00:07.000Z"); // the browser runs 3s ahead
    expect(serverNow()).toBe(Date.parse("2026-09-04T10:00:07.000Z"));
    vi.advanceTimersByTime(5_000);
    expect(serverNow()).toBe(Date.parse("2026-09-04T10:00:12.000Z"));
  });

  it("ignores stamps it cannot parse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:10.000Z"));
    recordServerTime("2026-09-04T10:00:07.000Z");
    recordServerTime("not a date");
    recordServerTime(undefined);
    expect(serverNow()).toBe(Date.parse("2026-09-04T10:00:07.000Z"));
  });
});
