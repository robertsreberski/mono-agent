import { describe, expect, test } from "vitest";

import type { Session, WebInstance } from "../lib/types";
import { FIXTURE_INSTANCES } from "../lib/fixture";
import { AMBER, DIM, ERROR, OK, TEAL } from "../lib/tokens";
import { buildInstanceCards, memoryInfo } from "./InstancesView";

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
  conversationId: "cron:run-1",
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

  test("formats last-run time in the instance timezone", () => {
    const cards = buildInstanceCards([{ ...instances[0]!, timeZone: "America/New_York" }], [session]);

    expect(cards[0]?.last).toContain("06:00");
  });

  test("labels session-only fallback cards as unknown health", () => {
    const cards = buildInstanceCards([], [session]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.healthLabel).toBe("unknown");
    expect(cards[0]).toMatchObject({ memoryLabel: "memory unknown", memoryColor: DIM });
  });

  test("maps every memory status to an independent label and color", () => {
    expect(memoryInfo({ backend: "bujo", status: "healthy", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory healthy", color: OK });
    expect(memoryInfo({ backend: "bujo", status: "in_progress", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory in progress", color: TEAL });
    expect(memoryInfo({ backend: "bujo", status: "degraded", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory degraded", color: AMBER });
    expect(memoryInfo({ backend: "bujo", status: "unhealthy", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory unhealthy", color: ERROR });
    expect(memoryInfo({ backend: "bujo", status: "unknown", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory unknown", color: DIM });
    expect(memoryInfo({ backend: "none", status: "not_configured", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory off", color: DIM });
  });

  test("keeps process health independent and limits memory title and aria content to stable issue codes", () => {
    const hostile = {
      backend: "bujo",
      status: "degraded",
      checkedAt: "2026-07-12T08:00:00Z",
      issues: ["dead_letters", "arbitrary provider message", "outbox_pending"],
    } as unknown as NonNullable<WebInstance["memoryHealth"]>;
    const [card] = buildInstanceCards(
      [{ ...instances[0]!, health: "running", liveConnected: true, memoryHealth: hostile }],
      [session],
    );

    expect(card).toMatchObject({
      healthLabel: "live",
      healthColor: OK,
      memoryLabel: "memory degraded",
      memoryColor: AMBER,
      memoryTitle: "memory degraded: dead_letters, outbox_pending",
    });
    expect(card?.ariaSummary).toContain("memory degraded: dead_letters, outbox_pending");
    expect(card?.ariaSummary).not.toContain("arbitrary provider message");
  });

  test("ships fixture instances for both configured and disabled memory", () => {
    expect(FIXTURE_INSTANCES.map((instance) => instance.memoryHealth?.status)).toEqual([
      "healthy",
      "not_configured",
    ]);
  });
});
