import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import {
  createUnreadMarker,
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
