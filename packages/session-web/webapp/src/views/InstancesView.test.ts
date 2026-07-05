import { describe, expect, test } from "vitest";

import type { Session, WebInstance } from "../lib/types";
import { buildInstanceCards } from "./InstancesView";

const instances: WebInstance[] = [
  {
    sourceId: "agent-a",
    label: "Agent",
    cwd: "/Users/example/agent-a",
    artifactDir: "/Users/example/agent-a/.mono-agent/runs",
    health: "ok",
    liveConnected: false,
    counts: { runs: 1 },
  },
  {
    sourceId: "agent-b",
    label: "Agent",
    cwd: "/Users/example/agent-b",
    artifactDir: "/Users/example/agent-b/.mono-agent/runs",
    health: "ok",
    liveConnected: false,
    counts: { runs: 0 },
  },
];

const session: Session = {
  id: "run-1",
  sourceId: "agent-a",
  cwd: "/Users/example/agent-a",
  instance: "Agent",
  source: "cron",
  title: "Run",
  instr: "Run",
  startTs: "2026-07-04T10:00:00.000Z",
  durMs: 1000,
  outcome: "notified",
  hasRecall: false,
  finalText: "",
  status: "succeeded",
  totals: { asst: 1, tcalls: 2, think: 3, tokIn: 40, tokOut: 5, tokCache: 0, cost: 0.12, steps: 1 },
  toolCounts: {},
  steps: [],
};

describe("buildInstanceCards", () => {
  test("renders discovered instances by sourceId, including zero-run duplicates by label", () => {
    const cards = buildInstanceCards(instances, [session]);

    expect(cards.map((card) => [card.sourceId, card.name, card.count])).toEqual([
      ["agent-a", "Agent", 1],
      ["agent-b", "Agent", 0],
    ]);
    expect(cards[1]?.last).toBe("no runs");
  });

  test("surfaces live and stale instance health instead of a hardcoded green state", () => {
    const cards = buildInstanceCards(
      [
        { ...instances[0]!, health: "stale", liveConnected: false },
        { ...instances[1]!, health: "failed", liveConnected: true },
      ],
      [session],
    );

    expect(cards.map((card) => [card.sourceId, card.healthLabel])).toEqual([
      ["agent-a", "stale"],
      ["agent-b", "live"],
    ]);
  });

  test("labels session-only fallback cards as unknown health", () => {
    const cards = buildInstanceCards([], [session]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.healthLabel).toBe("unknown");
  });
});
