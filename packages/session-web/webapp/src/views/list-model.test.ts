import { describe, expect, test } from "vitest";

import type { Session } from "../lib/types";
import {
  activityBucketLimit,
  buildActivityBuckets,
  buildChannelChips,
  clearExcludedChannels,
  DEFAULT_EXCLUDED_CHANNELS,
  filterSessionsForList,
  makeDefaultExcludedChannels,
  toggleExcludedChannel,
} from "./list-model";

const baseSession: Session = {
  id: "run-1",
  cwd: "/Users/example/agent",
  instance: "Agent",
  sourceId: "agent",
  source: "cron",
  title: "Run",
  instr: "Run",
  startTs: "2026-07-04T10:00:00.000Z",
  durMs: 1000,
  outcome: "notified",
  hasRecall: false,
  finalText: "",
  status: "done",
  totals: { asst: 1, tcalls: 0, think: 0, tokIn: 0, tokOut: 0, tokCache: 0, cost: 0.1, steps: 1 },
  toolCounts: {},
  steps: [],
};

function session(overrides: Omit<Partial<Session>, "totals"> & { totals?: Partial<Session["totals"]> }): Session {
  return {
    ...baseSession,
    ...overrides,
    totals: { ...baseSession.totals, ...overrides.totals },
  };
}

describe("session list channel filters", () => {
  test("excludes memory by default while keeping every other present type included", () => {
    const sessions = [
      session({ id: "cron", source: "cron", title: "Cron" }),
      session({ id: "memory", source: "memory", title: "Memory" }),
      session({ id: "custom", source: "custom-hook", title: "Custom" }),
    ];

    const excluded = makeDefaultExcludedChannels();
    expect([...excluded]).toEqual(DEFAULT_EXCLUDED_CHANNELS);

    const filtered = filterSessionsForList(sessions, {
      excludedChannels: excluded,
      outcome: "all",
      instance: "all",
    });

    expect(filtered.map((item) => item.title)).toEqual(["Cron", "Custom"]);

    const chips = buildChannelChips(sessions, {
      excludedChannels: excluded,
      outcome: "all",
      instance: "all",
    });

    expect(chips.find((chip) => chip.key === "memory")?.active).toBe(false);
    expect(chips.find((chip) => chip.key === "cron")?.active).toBe(true);
    expect(chips.find((chip) => chip.key === "custom-hook")?.active).toBe(true);
  });

  test("toggles one type without disturbing the rest of the included set", () => {
    const sessions = [
      session({ id: "cron", source: "cron", title: "Cron" }),
      session({ id: "chat", source: "chat", title: "Chat" }),
      session({ id: "memory", source: "memory", title: "Memory" }),
    ];

    const excluded = toggleExcludedChannel(makeDefaultExcludedChannels(), "cron");
    const filtered = filterSessionsForList(sessions, {
      excludedChannels: excluded,
      outcome: "all",
      instance: "all",
    });

    expect([...excluded].sort()).toEqual(["cron", "memory"]);
    expect(filtered.map((item) => item.title)).toEqual(["Chat"]);
  });

  test("clears exclusions when All is selected", () => {
    const excluded = clearExcludedChannels();

    expect([...excluded]).toEqual([]);
  });
});

describe("activity rhythm buckets", () => {
  test("uses fewer buckets on mobile so rhythm rows remain readable", () => {
    expect(activityBucketLimit(true)).toBe(8);
    expect(activityBucketLimit(false)).toBe(28);
  });

  test("scales bucket intensity by run count rather than total cost", () => {
    const sessions = [
      session({
        id: "expensive",
        source: "cron",
        startTs: "2026-07-04T10:00:00.000Z",
        totals: { cost: 20 },
      }),
      session({
        id: "cheap-1",
        source: "chat",
        startTs: "2026-07-04T11:00:00.000Z",
        totals: { cost: 0.01 },
      }),
      session({
        id: "cheap-2",
        source: "chat",
        startTs: "2026-07-04T11:05:00.000Z",
        totals: { cost: 0.01 },
      }),
    ];

    const buckets = buildActivityBuckets(sessions, { maxBuckets: 2 });

    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.runCount).toBe(1);
    expect(buckets[1]?.runCount).toBe(2);
    expect(buckets[0]?.intensityPct).toBeLessThan(buckets[1]?.intensityPct ?? 0);
    expect(buckets[0]?.costLabel).toBe("$20.00");
  });

  test("selected bucket narrows sessions without changing the type filter", () => {
    const sessions = [
      session({ id: "morning", source: "cron", title: "Morning", startTs: "2026-07-04T10:00:00.000Z" }),
      session({ id: "midday", source: "chat", title: "Midday", startTs: "2026-07-04T12:00:00.000Z" }),
      session({ id: "memory", source: "memory", title: "Memory", startTs: "2026-07-04T12:05:00.000Z" }),
    ];
    const excludedChannels = makeDefaultExcludedChannels();
    const visible = filterSessionsForList(sessions, {
      excludedChannels,
      outcome: "all",
      instance: "all",
    });
    const buckets = buildActivityBuckets(visible, { maxBuckets: 2 });

    const narrowed = filterSessionsForList(sessions, {
      excludedChannels,
      outcome: "all",
      instance: "all",
      selectedBucket: buckets[1],
    });

    expect(narrowed.map((item) => item.title)).toEqual(["Midday"]);
    expect([...excludedChannels]).toEqual(DEFAULT_EXCLUDED_CHANNELS);
  });
});
