import { describe, expect, it } from "vitest";

import { nextWakeOccurrence, parseWakeDefinition } from "../wake-schedule.js";

describe("scheduled wake wall-clock policy", () => {
  it("shifts a weekly spring gap and takes the earlier fall overlap once", () => {
    const definition = parseWakeDefinition({ kind: "weekly", timezone: "Europe/Berlin", days: [0], times: ["02:30"] });
    expect(nextWakeOccurrence(definition, new Date("2026-03-28T00:00:00Z"))?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(nextWakeOccurrence(definition, new Date("2026-10-24T00:00:00Z"))?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextWakeOccurrence(definition, new Date("2026-10-25T00:45:00Z"))?.toISOString()).toBe("2026-11-01T01:30:00.000Z");
  });

  it("rejects a one-off gap, accepts a leap date and resolves an overlap to the first instant", () => {
    expect(() => parseWakeDefinition({ kind: "once", timezone: "Europe/Berlin", localAt: "2027-03-28T02:30" }, new Date("2026-01-01")))
      .toThrow(/localAt.*does not exist/u);
    const overlap = parseWakeDefinition({ kind: "once", timezone: "Europe/Berlin", localAt: "2026-10-25T02:30" }, new Date("2026-01-01"));
    expect(nextWakeOccurrence(overlap, new Date("2026-01-01"))?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextWakeOccurrence(overlap, new Date("2026-10-25T00:31:00Z"))).toBeNull();
    expect(nextWakeOccurrence(parseWakeDefinition({ kind: "once", timezone: "Asia/Kathmandu", localAt: "2028-02-29T12:00" }, new Date("2026-01-01")), new Date("2026-01-01"))?.toISOString())
      .toBe("2028-02-29T06:15:00.000Z");
  });

  it("stores the canonical IANA zone spelling", () => {
    expect(parseWakeDefinition({ kind: "weekly", timezone: "europe/berlin", days: [1], times: ["09:00"] }).timezone)
      .toBe("Europe/Berlin");
  });

  it("enforces strict fields and bounded distinct slots", () => {
    expect(() => parseWakeDefinition({ kind: "weekly", timezone: "UTC", days: [0], times: ["10:00", "10:00"] })).toThrow(/times/u);
    expect(() => parseWakeDefinition({ kind: "weekly", timezone: "UTC", days: [0], times: ["10:00"], arbitrary: true })).toThrow(/arbitrary/u);
    expect(() => parseWakeDefinition({ kind: "once", timezone: "UTC", localAt: "2028-02-30T12:00" })).toThrow(/calendar/u);
  });
});

it("accepts optional boolean compactFirst for both kinds and rejects other values", () => {
  const now = new Date("2027-01-01T00:00:00Z");
  for (const definition of [{ kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00" },
    { kind: "weekly", timezone: "UTC", days: [1], times: ["10:00"] }]) {
    expect(parseWakeDefinition(definition, now).compactFirst).toBeUndefined();
    for (const compactFirst of [true, false]) expect(parseWakeDefinition({ ...definition, compactFirst }, now).compactFirst).toBe(compactFirst);
    for (const compactFirst of [null, 1, "true", {}, []]) expect(() => parseWakeDefinition({ ...definition, compactFirst }, now)).toThrow(/compactFirst/u);
  }
});
