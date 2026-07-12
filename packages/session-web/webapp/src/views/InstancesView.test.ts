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
    expect(memoryInfo({ backend: "bujo", mode: "bujo", status: "healthy", checkedAt: "2026-07-12T08:00:00Z", issues: [] }))
      .toMatchObject({ label: "memory healthy", color: OK });
    expect(memoryInfo({ backend: "bujo", mode: "bujo", status: "in_progress", checkedAt: "2026-07-12T08:00:00Z", issues: ["intake_pending"] }))
      .toMatchObject({ label: "memory in progress", color: TEAL });
    expect(memoryInfo({ backend: "bujo", mode: "bujo", status: "degraded", checkedAt: "2026-07-12T08:00:00Z", issues: ["work_stalled"] }))
      .toMatchObject({ label: "memory degraded", color: AMBER });
    expect(memoryInfo({ backend: "bujo", mode: "bujo", status: "unhealthy", checkedAt: "2026-07-12T08:00:00Z", issues: ["manifest_missing"] }))
      .toMatchObject({ label: "memory unhealthy", color: ERROR });
    expect(memoryInfo({ backend: "bujo", mode: "bujo", status: "unknown", checkedAt: "2026-07-12T08:00:00Z", issues: ["health_check_failed"] }))
      .toMatchObject({ label: "memory unknown", color: DIM });
    expect(memoryInfo({ backend: "none", status: "not_configured", checkedAt: "2026-07-12T08:00:00Z" }))
      .toMatchObject({ label: "memory off", color: DIM });
  });

  test("keeps process health independent and limits memory title and aria content to stable issue codes", () => {
    const hostile = {
      backend: "bujo",
      mode: "bujo",
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
      memoryLabel: "memory unknown",
      memoryColor: DIM,
      memoryTitle: "memory unknown",
    });
    expect(card?.ariaSummary).toContain("memory unknown");
    expect(card?.ariaSummary).not.toContain("arbitrary provider message");
  });

  test("fails contradictory runtime memory input closed instead of rendering green", () => {
    const contradictory = {
      backend: "bujo",
      mode: "bujo",
      status: "healthy",
      checkedAt: "2026-07-12T08:00:00Z",
      issues: ["manifest_missing"],
    } as unknown as NonNullable<WebInstance["memoryHealth"]>;

    expect(memoryInfo(contradictory)).toMatchObject({
      status: "unknown",
      label: "memory unknown",
      color: DIM,
    });
    expect(memoryInfo({
      backend: "bujo",
      mode: "bujo",
      status: "healthy",
      checkedAt: "2026-07-12T08:01:00Z",
      issues: [],
      counts: { pending: 1 },
    })).toMatchObject({ status: "unknown", label: "memory unknown", color: DIM });
  });

  test("rejects unknown, non-string, duplicate, and noncanonical runtime issues without leaking them", () => {
    const candidates = [
      { status: "healthy", issues: ["secret_provider_issue"] },
      { status: "healthy", issues: [{ token: "secret_issue_object" }] },
      { status: "unhealthy", issues: ["manifest_missing", "manifest_missing"] },
      { status: "unhealthy", issues: ["database_missing", "manifest_missing"] },
    ];

    for (const candidate of candidates) {
      const info = memoryInfo({
        backend: "bujo",
        mode: "bujo",
        checkedAt: "2026-07-12T08:00:00Z",
        ...candidate,
      } as unknown as NonNullable<WebInstance["memoryHealth"]>);
      expect(info).toMatchObject({ status: "unknown", label: "memory unknown", color: DIM, title: "memory unknown" });
      expect(JSON.stringify(info)).not.toMatch(/secret_provider_issue|secret_issue_object/u);
    }
  });

  test("mirrors fleet implications for partial runtime counts", () => {
    const contradictions = [
      { mode: "bujo", status: "in_progress", issues: ["intake_pending"], counts: { pending: 0 } },
      { mode: "bujo", status: "healthy", issues: [], counts: { due: 1 } },
      { mode: "bujo", status: "degraded", issues: ["dead_letters"], counts: { dead: 0 } },
      { mode: "bujo", status: "in_progress", issues: ["outbox_pending"], counts: { outbox: 0 } },
      { mode: "bujo", status: "unhealthy", issues: ["temporary_artifacts"], counts: { temporary: 0 } },
      { mode: "lite", status: "unhealthy", issues: ["vector_mismatch"], counts: { missingVectors: 1 } },
      { mode: "lite", status: "healthy", issues: [], counts: { vectors: 1 } },
      { mode: "journal", status: "healthy", issues: [], counts: { missingVectors: 1 } },
      { mode: "journal", status: "healthy", issues: [], counts: { memories: 3, vectors: 2 } },
      { mode: "bujo", status: "healthy", issues: [], counts: { memories: 3, vectors: 2 } },
      { mode: "bujo", status: "healthy", issues: [], counts: { missingVectors: 1 } },
      { mode: "journal", status: "healthy", issues: [], counts: { memories: 2, vectors: 3 } },
      {
        mode: "journal",
        status: "in_progress",
        issues: ["mutation_in_progress"],
        counts: { memories: 3, vectors: 2, missingVectors: 0 },
      },
      { mode: "bujo", status: "healthy", issues: [], counts: "bad" },
      { mode: "bujo", status: "healthy", issues: [], counts: { pending: -1 } },
    ];

    for (const contradiction of contradictions) {
      expect(memoryInfo({
        backend: "bujo",
        checkedAt: "2026-07-12T08:00:00Z",
        ...contradiction,
      } as unknown as NonNullable<WebInstance["memoryHealth"]>)).toMatchObject({
        status: "unknown",
        label: "memory unknown",
        color: DIM,
      });
    }

    expect(memoryInfo({
      backend: "bujo",
      mode: "journal",
      status: "in_progress",
      checkedAt: "2026-07-12T08:01:00Z",
      issues: ["mutation_in_progress", "intake_pending"],
      counts: { due: 1, memories: 3, vectors: 2, secretCount: "not-rendered" },
    } as unknown as NonNullable<WebInstance["memoryHealth"]>)).toMatchObject({
      status: "in_progress",
      label: "memory in progress",
      color: TEAL,
    });
  });

  test("ships fixture instances for both configured and disabled memory", () => {
    expect(FIXTURE_INSTANCES.map((instance) => instance.memoryHealth?.status)).toEqual([
      "healthy",
      "not_configured",
    ]);
  });
});
