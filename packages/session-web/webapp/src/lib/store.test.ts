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

function session(sourceId: string, title: string): Session {
  return {
    ...baseSession,
    sourceId,
    cwd: `/Users/example/${sourceId}`,
    title,
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
});
