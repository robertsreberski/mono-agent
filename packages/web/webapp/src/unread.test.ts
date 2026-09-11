import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import {
  createUnreadMarker,
  mergeSeenRevisions,
  readSeenRevisions,
  SEEN_THREAD_LIMIT,
  unreadCountsBySource,
} from "./unread";

const at = (id: string, revision: number, sourceId = "alpha") =>
  thread(id, sourceId, { revision });

describe("createUnreadMarker", () => {
  it("never calls a conversation it has never seen unread", () => {
    const marker = createUnreadMarker();
    const fresh = at("one", 7);

    // First sight SEEDS. The alternative is a console that opens with every
    // conversation in the fleet shouting at the operator.
    expect(marker.unread(fresh)).toBe(false);
    expect(marker.note([fresh])).toBe(true);
    expect(marker.unread(fresh)).toBe(false);
    // And seeding is once: a later pass must not adopt a newer revision.
    expect(marker.note([at("one", 9)])).toBe(false);
    expect(marker.unread(at("one", 9))).toBe(true);
  });

  it("clears only when the revision that is being looked at is recorded", () => {
    const marker = createUnreadMarker();
    marker.note([at("one", 1)]);

    expect(marker.unread(at("one", 4))).toBe(true);
    expect(marker.see(at("one", 4))).toBe(true);
    expect(marker.unread(at("one", 4))).toBe(false);
    // Seeing the same revision again moves nothing, so it owes no write.
    expect(marker.see(at("one", 4))).toBe(false);
    // And the next turn makes it unread again.
    expect(marker.unread(at("one", 5))).toBe(true);
  });

  it("keeps what the device remembered, and hands the same back", () => {
    const marker = createUnreadMarker();
    marker.restore([{ id: "one", revision: 2 }, { id: "two", revision: 5 }]);

    expect(marker.unread(at("one", 3))).toBe(true);
    expect(marker.unread(at("two", 5))).toBe(false);
    expect(marker.entries()).toEqual([
      { id: "one", revision: 2 },
      { id: "two", revision: 5 },
    ]);
  });

  it("forgets a conversation that is gone", () => {
    const marker = createUnreadMarker();
    marker.note([at("one", 1)]);

    expect(marker.forget(["one"])).toBe(true);
    expect(marker.forget(["one"])).toBe(false);
    // Forgotten is not unread: an unknown conversation is seeded on sight.
    expect(marker.unread(at("one", 9))).toBe(false);
  });

  it("drops the least recently touched rather than growing without a bound", () => {
    const marker = createUnreadMarker();
    marker.note(
      Array.from({ length: SEEN_THREAD_LIMIT }, (_item, index) => at(`t${String(index)}`, 1)),
    );
    // Touched, so it is now the NEWEST entry rather than the oldest.
    marker.see(at("t0", 2));
    marker.note([at("overflow", 1)]);

    const kept = marker.entries().map((row) => row.id);
    expect(kept).toHaveLength(SEEN_THREAD_LIMIT);
    expect(kept).toContain("t0");
    expect(kept).toContain("overflow");
    expect(kept).not.toContain("t1");
  });

  it("names the unread ones, and counts them per agent", () => {
    const marker = createUnreadMarker();
    marker.restore([
      { id: "one", revision: 1 },
      { id: "two", revision: 1 },
      { id: "three", revision: 1 },
    ]);
    const threads = [
      at("one", 2),
      at("two", 1),
      at("three", 4, "beta"),
      at("unknown", 9, "beta"),
    ];

    const unread = marker.unreadIds(threads);
    expect([...unread].sort()).toEqual(["one", "three"]);
    expect([...unreadCountsBySource(threads, unread)]).toEqual([["alpha", 1], ["beta", 1]]);
  });
});

describe("mergeSeenRevisions", () => {
  it("keeps the highest revision each conversation was seen at", () => {
    // The stored row is the DEVICE's memory and the held one is a tab's. A tab
    // that hydrated before the others moved must not put their revisions back.
    expect(mergeSeenRevisions(
      [{ id: "one", revision: 4 }, { id: "two", revision: 9 }],
      [{ id: "one", revision: 7 }, { id: "two", revision: 2 }, { id: "three", revision: 1 }],
    )).toEqual([
      { id: "one", revision: 7 },
      { id: "two", revision: 9 },
      { id: "three", revision: 1 },
    ]);
  });

  it("keeps what only the device remembers, least recently touched first", () => {
    // The flushing tab's own order is its recency; a conversation it has never
    // been told about is older than all of them, and goes first out.
    expect(mergeSeenRevisions(
      [{ id: "gone", revision: 2 }],
      [{ id: "held", revision: 3 }],
    )).toEqual([{ id: "gone", revision: 2 }, { id: "held", revision: 3 }]);
  });

  it("bounds the merged row exactly as the marker bounds itself", () => {
    const stored = Array.from({ length: SEEN_THREAD_LIMIT }, (_value, index) =>
      ({ id: `stored-${String(index)}`, revision: 1 }));
    const held = Array.from({ length: 10 }, (_value, index) =>
      ({ id: `held-${String(index)}`, revision: 1 }));

    const merged = mergeSeenRevisions(stored, held);

    expect(merged).toHaveLength(SEEN_THREAD_LIMIT);
    expect(merged.at(0)).toEqual({ id: "stored-10", revision: 1 });
    expect(merged.at(-1)).toEqual({ id: "held-9", revision: 1 });
  });
});

describe("an unread marker adopting another tab's map", () => {
  it("takes a higher revision and refuses a lower one", () => {
    const marker = createUnreadMarker();
    marker.restore([{ id: "one", revision: 4 }, { id: "two", revision: 4 }]);

    // Another tab looked at "one" and is behind on "two". Adoption is upward
    // only, or the tab that last spoke would decide for the device.
    expect(marker.adopt([{ id: "one", revision: 6 }, { id: "two", revision: 2 }])).toBe(true);
    expect(marker.unread(at("one", 6))).toBe(false);
    expect(marker.unread(at("two", 4))).toBe(false);
    expect(marker.unread(at("two", 5))).toBe(true);

    // Nothing left to take, so nothing to redraw for.
    expect(marker.adopt([{ id: "one", revision: 6 }, { id: "two", revision: 1 }])).toBe(false);
  });

  it("takes a conversation it had never been told about", () => {
    const marker = createUnreadMarker();

    expect(marker.adopt([{ id: "elsewhere", revision: 3 }])).toBe(true);
    expect(marker.unread(at("elsewhere", 3))).toBe(false);
    expect(marker.unread(at("elsewhere", 4))).toBe(true);
  });
});

describe("readSeenRevisions", () => {
  it("takes only rows a build can use, and never throws on the rest", () => {
    // Written by this console, so not a trust boundary -- but an interrupted
    // write or a build that shaped the row differently must not take a cold
    // start down with it.
    expect(readSeenRevisions([
      { id: "one", revision: 3 },
      { id: "two", revision: "3" },
      { id: 4, revision: 4 },
      { id: "nan", revision: Number.NaN },
      null,
      "row",
    ])).toEqual([{ id: "one", revision: 3 }]);
    expect(readSeenRevisions(undefined)).toEqual([]);
    expect(readSeenRevisions({ one: 2 })).toEqual([]);
  });
});
