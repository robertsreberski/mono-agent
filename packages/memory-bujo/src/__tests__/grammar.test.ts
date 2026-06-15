import { describe, expect, it } from "vitest";

import { parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "../grammar.js";
import type { Bullet } from "../types.js";

const LINE =
  '- [ ] Ship the P1 substrate.  <!--mem id=01J type=task status=open salience=0.8 isInsight=0 created=2026-06-15T09:12:00.000Z refs=01A,01B-->';

describe("parseBullet/serializeBullet", () => {
  it("parses a task bullet with metadata", () => {
    const b = parseBullet(LINE);
    expect(b).toEqual({
      id: "01J", type: "task", status: "open", text: "Ship the P1 substrate.",
      salience: 0.8, isInsight: false, createdAt: "2026-06-15T09:12:00.000Z", refs: ["01A", "01B"],
    } satisfies Bullet);
  });

  it("round-trips byte-for-byte for task/event/note across statuses", () => {
    const samples = [
      LINE,
      '- [x] Confirmed nomic tag is v1.5.  <!--mem id=01C type=note status=done salience=0.4 isInsight=0 created=2026-06-15T10:00:00.000Z refs=-->',
      '- ◦ Met about memory rituals.  <!--mem id=01D type=event status=open salience=0.5 isInsight=0 created=2026-06-15T11:00:00.000Z refs=-->',
      '- – Robert prefers opt-in, never silent fallback.  <!--mem id=01E type=note status=open salience=0.9 isInsight=1 created=2026-06-15T12:00:00.000Z refs=01C-->',
    ];
    for (const line of samples) {
      const parsed = parseBullet(line);
      expect(parsed).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(serializeBullet(parsed!)).toBe(line);
    }
  });

  it("returns undefined for non-bullet lines", () => {
    expect(parseBullet("## 2026-06-15")).toBeUndefined();
    expect(parseBullet("just prose")).toBeUndefined();
  });
});

describe("parseDailyFile/serializeDailyFile", () => {
  it("round-trips a daily file, preserving non-bullet lines verbatim", () => {
    const file = ["# 2026-06-15", "", LINE, "", "Some freeform note.", ""].join("\n");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(serializeDailyFile(parsed)).toBe(file);
  });
});
