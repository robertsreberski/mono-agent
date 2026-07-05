import { describe, expect, test } from "vitest";

import type { Session } from "./types";
import { ApiError } from "./api";
import { FIXTURE_SESSIONS } from "./fixture";
import { applySessionOps, sessionStoreKey, shouldUseFixtureFallback } from "./store";

const baseSession: Session = {
  id: "run-1",
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
  totals: { asst: 0, tcalls: 0, think: 0, tokIn: 0, tokOut: 0, tokCache: 0, cost: 0, steps: 0 },
  toolCounts: {},
  steps: [],
};

function session(
  sourceId: string,
  title: string,
  overrides: Omit<Partial<Session>, "totals"> & { totals?: Partial<Session["totals"]> } = {},
): Session {
  return {
    ...baseSession,
    sourceId,
    cwd: `/Users/example/${sourceId}`,
    title,
    ...overrides,
    totals: { ...baseSession.totals, ...overrides.totals },
  };
}

describe("session store identity", () => {
  test("uses sourceId and runId as the browser session key", () => {
    expect(sessionStoreKey(session("agent-a", "A"))).toBe("agent-a::run-1");
    expect(sessionStoreKey(session("agent-b", "B"))).toBe("agent-b::run-1");
  });

  test("upserts and removes sessions by sourceId plus runId", () => {
    const agentA = session("agent-a", "A");
    const agentB = session("agent-b", "B");

    const afterUpsert = applySessionOps([], [
      { type: "upsert", session: agentA },
      { type: "upsert", session: agentB },
    ]);

    expect(afterUpsert.map((item) => item.title)).toEqual(["A", "B"]);

    const afterRemove = applySessionOps(afterUpsert, [
      { type: "remove", sourceId: "agent-a", runId: "run-1" },
    ]);

    expect(afterRemove.map((item) => item.title)).toEqual(["B"]);
  });

  test("keeps richer same-run detail when a sparse upsert arrives later", () => {
    const rich = session("agent-a", "Rich", {
      finalText: "live answer",
      status: "running",
      totals: { asst: 1, steps: 1, tokIn: 12, tokOut: 7 },
      steps: [
        {
          k: "assistant",
          ts: "2026-07-04T10:00:01.000Z",
          think: [],
          calls: [],
          text: "live answer",
        },
      ],
    });
    const sparse = session("agent-a", "Sparse", {
      finalText: "",
      outcome: "silent",
      status: "succeeded",
      totals: { asst: 0, steps: 0, tokIn: 12, tokOut: 7 },
      steps: [],
    });

    const [merged] = applySessionOps([rich], [{ type: "upsert", session: sparse }]);

    expect(merged).toMatchObject({
      title: "Sparse",
      status: "succeeded",
      outcome: "notified",
      finalText: "live answer",
      totals: expect.objectContaining({ asst: 1, steps: 1, tokIn: 12, tokOut: 7 }),
    });
    expect(merged?.steps).toEqual(rich.steps);
  });

  test("allows a richer terminal same-run upsert to replace live detail", () => {
    const live = session("agent-a", "Live", {
      finalText: "live answer",
      status: "running",
      totals: { asst: 1, steps: 1 },
      steps: [
        {
          k: "assistant",
          ts: "2026-07-04T10:00:01.000Z",
          think: [],
          calls: [],
          text: "live answer",
        },
      ],
    });
    const terminal = session("agent-a", "Disk", {
      finalText: "disk answer",
      status: "succeeded",
      totals: { asst: 1, steps: 2 },
      steps: [
        ...live.steps,
        {
          k: "assistant",
          ts: "2026-07-04T10:00:02.000Z",
          think: [],
          calls: [],
          text: "disk answer",
        },
      ],
    });

    const [merged] = applySessionOps([live], [{ type: "upsert", session: terminal }]);

    expect(merged).toMatchObject({
      title: "Disk",
      status: "succeeded",
      finalText: "disk answer",
      totals: expect.objectContaining({ steps: 2 }),
    });
    expect(merged?.steps).toEqual(terminal.steps);
  });

  test("keeps opened detail when a summary reconnect upsert arrives later", () => {
    const detailed = session("agent-a", "Detailed", {
      finalText: "full answer",
      status: "succeeded",
      totals: { asst: 1, tcalls: 1, think: 0, steps: 3 },
      toolCounts: { Bash: 1 },
      steps: [
        { k: "prompt", ts: "2026-07-04T10:00:00.000Z", text: "Run" },
        {
          k: "assistant",
          ts: "2026-07-04T10:00:01.000Z",
          think: [],
          calls: [{ id: "call-1", name: "Bash", dig: "cmd", raw: "{}" }],
          text: "full answer",
        },
        {
          k: "result",
          ts: "2026-07-04T10:00:02.000Z",
          tcid: "call-1",
          tool: "Bash",
          ok: true,
          dig: "ok",
          text: "ok",
        },
      ],
    });
    const summary = session("agent-a", "Summary", {
      finalText: "",
      status: "succeeded",
      totals: { asst: 0, tcalls: 0, think: 0, steps: 3 },
      toolCounts: {},
      steps: [],
    });

    const [merged] = applySessionOps([detailed], [{ type: "upsert", session: summary }]);

    expect(merged).toMatchObject({
      title: "Summary",
      finalText: "full answer",
      totals: expect.objectContaining({ asst: 1, tcalls: 1, steps: 3 }),
      toolCounts: { Bash: 1 },
    });
    expect(merged?.steps).toEqual(detailed.steps);
  });
});

describe("fixture sessions", () => {
  test("keep totals.steps consistent with rendered steps", () => {
    for (const item of FIXTURE_SESSIONS) {
      expect(item.totals.steps, item.id).toBe(item.steps.length);
    }
  });
});

describe("fixture fallback gate", () => {
  test("does not mask JSON backend failures with demo data", () => {
    expect(shouldUseFixtureFallback(new ApiError("/api/instances", "500", { status: 500, contentType: "application/json" }), false)).toBe(false);
  });

  test("allows standalone preview fallback when api routes are missing", () => {
    expect(shouldUseFixtureFallback(new ApiError("/api/instances", "404", { status: 404, contentType: "text/html" }), false)).toBe(true);
  });

  test("does not mask HTML backend failures with demo data in production", () => {
    expect(shouldUseFixtureFallback(new ApiError("/api/instances", "502", { status: 502, contentType: "text/html" }), false)).toBe(false);
    expect(shouldUseFixtureFallback(new ApiError("/api/instances", "401", { status: 401, contentType: "text/html" }), false)).toBe(false);
  });
});
