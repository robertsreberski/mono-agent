import { describe, expect, it } from "vitest";
import { rankDeliberateRecallHits } from "../recency.js";
import type { MemoryLabelHit } from "../../store/db-labels.js";

const now = "2032-07-01T12:00:00.000Z";
const hit = (id: string, score: number, days: number, type = "event") => ({ score, record: { id, text: id, type,
  createdAt: new Date(Date.parse(now) - days * 86_400_000).toISOString() } });
const label = (id: string, kind: "fact" | "preference" | "lesson"): MemoryLabelHit => ({
  memoryId: id, ordinal: 0, label: kind === "fact" ? { v: 1, kind, entityId: "person:owner", attribution: "user-stated" }
    : kind === "preference" ? { v: 1, kind, scope: "agent", attribution: "user-stated" } : { v: 1, kind, scope: "agent", verified: true },
  text: id, status: "open", createdAt: now, active: true, conflict: false,
});
describe("bounded deliberate recency", () => {
  it("orders relevance-qualified transient hits only, without altering base scores or membership", () => {
    const hits = [hit("older", 0.80, 120), hit("newer", 0.79, 0), hit("below-window", 0.649, 0), hit("below-floor", 0.64, 0)];
    const ranked = rankDeliberateRecallHits(hits, [], now);
    expect(ranked.map((hit) => hit.record.id)).toEqual(["newer", "older", "below-window", "below-floor"]);
    expect(ranked).toEqual([hits[1], hits[0], hits[2], hits[3]]); expect(hits[0]!.record.id).toBe("older");
  });
  it("has a 30-day half-life and a maximum 0.02 secondary term", () => {
    expect(rankDeliberateRecallHits([hit("old", 0.8, 1000), hit("day30", 0.791, 30)], [], now)[0]!.record.id).toBe("day30");
    expect(rankDeliberateRecallHits([hit("old", 0.8, 1000), hit("day60", 0.791, 60)], [], now)[0]!.record.id).toBe("old");
    expect(rankDeliberateRecallHits([hit("old", 0.82, 1000), hit("fresh", 0.799, 0)], [], now)[0]!.record.id).toBe("old");
  });
  it("never applies to facts/preferences, labelled notes, tasks, missing or future recording instants", () => {
    for (const kind of ["fact", "preference"] as const) {
      const hits = [hit("old", 0.8, 1000), hit("durable", 0.79, 0)];
      expect(rankDeliberateRecallHits(hits, [label("durable", kind)], now)).toEqual(hits);
    }
    for (const type of ["task", "note"]) {
      const hits = [hit("old", 0.8, 1000), hit("other", 0.79, 0, type)];
      expect(rankDeliberateRecallHits(hits, type === "note" ? [label("other", "lesson")] : [], now)).toEqual(hits);
    }
    const hits = [hit("old", 0.8, 1000), hit("future", 0.79, -1), { score: 0.79, record: { id: "unknown", type: "event" } }];
    expect(rankDeliberateRecallHits(hits, [], now)).toEqual(hits);
    expect(rankDeliberateRecallHits([hit("old", 0.64, 1000), hit("fresh", 0.63, 0)], [], now).map((hit) => hit.record.id)).toEqual(["old", "fresh"]);
  });
  it("also ranks unlabelled notes, not just events", () => {
    expect(rankDeliberateRecallHits([hit("old", 0.8, 1000, "note"), hit("fresh", 0.79, 0, "note")], [], now)[0]!.record.id).toBe("fresh");
  });
});
