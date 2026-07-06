import { describe, expect, test } from "vitest";

import type { Session, WebInstance } from "./types";
import { ApiError } from "./api";
import { FIXTURE_SESSIONS } from "./fixture";
import {
  applyHistoryOps,
  applySessionOps,
  historyStateFor,
  markHistorySessionsLoaded,
  seedHistoryPageStates,
  sessionStoreKey,
  shouldUseFixtureFallback,
} from "./store";

const baseSession: Session = {
  id: "run-1",
  conversationId: "cron:run-1",
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

const webInstances: WebInstance[] = [
  {
    sourceId: "agent-a",
    label: "Agent A",
    cwd: "/Users/example/agent-a",
    artifactDir: "/Users/example/agent-a/.mono-agent/runs",
    health: "ok",
    liveConnected: true,
    counts: { runs: 3 },
  },
  {
    sourceId: "agent-b",
    label: "Agent B",
    cwd: "/Users/example/agent-b",
    artifactDir: "/Users/example/agent-b/.mono-agent/runs",
    health: "ok",
    liveConnected: true,
    counts: { runs: 2 },
  },
];

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

  test("keeps loaded per-turn context when a stripped upsert arrives later", () => {
    const detailed = session("agent-a", "Detailed", {
      finalText: "full answer",
      status: "succeeded",
      totals: { asst: 1, steps: 2 },
      steps: [
        { k: "prompt", ts: "2026-07-04T10:00:00.000Z", text: "Run" },
        { k: "assistant", ts: "2026-07-04T10:00:01.000Z", think: [], calls: [], text: "full answer" },
      ],
      sysPrompt: "Compiled system prompt.",
      sysPromptTr: true,
      ctx: {
        histCount: 1,
        hist: [{ role: "user", text: "prior" }],
        mem: { text: "recalled", src: "bujo" },
      },
    });
    // A stripped SSE list upsert (same run) carries no ctx/sysPrompt.
    const stripped = session("agent-a", "Summary", {
      finalText: "",
      status: "succeeded",
      totals: { asst: 0, steps: 2 },
      steps: [],
    });

    const [merged] = applySessionOps([detailed], [{ type: "upsert", session: stripped }]);

    expect(merged?.sysPrompt).toBe("Compiled system prompt.");
    expect(merged?.sysPromptTr).toBe(true);
    expect(merged?.ctx).toEqual({
      histCount: 1,
      hist: [{ role: "user", text: "prior" }],
      mem: { text: "recalled", src: "bujo" },
    });
  });

  test("lets a richer upsert replace an earlier ctx/sysPrompt", () => {
    const first = session("agent-a", "First", {
      sysPrompt: "old prompt",
      ctx: { histCount: 1, hist: [{ role: "user", text: "old" }] },
    });
    const second = session("agent-a", "Second", {
      sysPrompt: "new prompt",
      ctx: { histCount: 2, hist: [{ role: "user", text: "new" }] },
    });

    const [merged] = applySessionOps([first], [{ type: "upsert", session: second }]);

    expect(merged?.sysPrompt).toBe("new prompt");
    expect(merged?.ctx).toEqual({ histCount: 2, hist: [{ role: "user", text: "new" }] });
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

describe("history pagination state", () => {
  test("seeds per-instance offsets from the first all-instances page", () => {
    const firstPage = [
      session("agent-a", "A1", { id: "a-1" }),
      session("agent-a", "A2", { id: "a-2" }),
    ];

    const states = seedHistoryPageStates(webInstances, firstPage, { offset: 0, total: 5, hasMore: true });

    expect(historyStateFor(states, "all", "live")).toMatchObject({ offset: 2, hasMore: true, total: 5 });
    expect(historyStateFor(states, "agent-a", "live")).toMatchObject({ offset: 2, hasMore: true });
    expect(historyStateFor(states, "agent-b", "live")).toMatchObject({ offset: 0, hasMore: true });
  });

  test("advances the next page offset from SSE-loaded unique sessions", () => {
    const firstPage = [
      session("agent-a", "A1", { id: "a-1" }),
      session("agent-a", "A2", { id: "a-2" }),
    ];
    const states = seedHistoryPageStates(webInstances, firstPage, { offset: 0, total: 5, hasMore: true });
    const loadedAfterStream = [
      ...firstPage,
      session("agent-a", "A3", { id: "a-3" }),
      session("agent-b", "B1", { id: "b-1" }),
    ];

    const afterStream = markHistorySessionsLoaded(states, loadedAfterStream.slice(2), "all");

    expect(historyStateFor(afterStream, "all", "live")).toMatchObject({ offset: 4, hasMore: true });
    expect(historyStateFor(afterStream, "agent-a", "live")).toMatchObject({ offset: 3, hasMore: true });
  });

  test("does not advance all-instances offset from a single-instance page", () => {
    const firstPage = [
      session("agent-a", "A1", { id: "a-1" }),
      session("agent-b", "B1", { id: "b-1" }),
    ];
    const states = seedHistoryPageStates(webInstances, firstPage, { offset: 0, total: 6, hasMore: true });
    const afterInstancePage = markHistorySessionsLoaded(
      states,
      [
        session("agent-a", "A2", { id: "a-2" }),
        session("agent-a", "A3", { id: "a-3" }),
      ],
      "agent-a",
      { offset: 1, total: 3, hasMore: false },
    );

    expect(historyStateFor(afterInstancePage, "agent-a", "live")).toMatchObject({ offset: 3, hasMore: false, total: 3 });
    expect(historyStateFor(afterInstancePage, "all", "live")).toMatchObject({ offset: 2, hasMore: true, total: 6 });
  });

  test("does not offer older history outside a live backend state", () => {
    const states = seedHistoryPageStates(webInstances, [], { offset: 0, total: 0, hasMore: false });

    expect(historyStateFor(states, "agent-b", "fixture").hasMore).toBe(false);
  });

  test("repeated all-instances loadOlder walks past 200 to the oldest run", () => {
    const PAGE = 200;
    const TOTAL = 500;
    const pageOf = (start: number, count: number): Session[] =>
      Array.from({ length: count }, (_, i) => session("agent-a", `run-${start + i}`, { id: `run-${start + i}` }));

    // Initial snapshot: newest 200 of 500.
    let states = seedHistoryPageStates(webInstances, pageOf(0, PAGE), { offset: 0, total: TOTAL, hasMore: true });
    expect(historyStateFor(states, "all", "live")).toMatchObject({ offset: 200, hasMore: true, total: 500 });

    // Load older #1 → rows 200..399.
    states = markHistorySessionsLoaded(states, pageOf(PAGE, PAGE), "all", { offset: PAGE, total: TOTAL, hasMore: true });
    expect(historyStateFor(states, "all", "live")).toMatchObject({ offset: 400, hasMore: true, total: 500 });

    // Load older #2 → rows 400..499, reaching the oldest; hasMore flips false.
    states = markHistorySessionsLoaded(states, pageOf(2 * PAGE, TOTAL - 2 * PAGE), "all", {
      offset: 2 * PAGE,
      total: TOTAL,
      hasMore: false,
    });
    const final = historyStateFor(states, "all", "live");
    expect(final).toMatchObject({ offset: 500, hasMore: false, total: 500 });
  });

  test("keeps paging offset consistent when a genuine removal arrives mid-history", () => {
    const PAGE = 200;
    const TOTAL = 500;
    const pageOf = (start: number, count: number): Session[] =>
      Array.from({ length: count }, (_, i) => session("agent-a", `run-${start + i}`, { id: `run-${start + i}` }));

    // Page in 400 of 500 (still more to load).
    let states = seedHistoryPageStates(webInstances, pageOf(0, PAGE), { offset: 0, total: TOTAL, hasMore: true });
    states = markHistorySessionsLoaded(states, pageOf(PAGE, PAGE), "all", { offset: PAGE, total: TOTAL, hasMore: true });
    expect(historyStateFor(states, "all", "live")).toMatchObject({ offset: 400, hasMore: true, total: 500 });

    // A genuine session_removed (e.g. memory-run suppression / instance removal) for a
    // loaded run must decrement the loaded count without wedging paging or over/under-shooting.
    states = applyHistoryOps(states, [{ type: "remove", sourceId: "agent-a", runId: "run-10" }]);
    const afterRemove = historyStateFor(states, "all", "live");
    expect(afterRemove).toMatchObject({ offset: 399, hasMore: true, total: 500 });

    // Paging still advances toward the oldest after the removal.
    states = markHistorySessionsLoaded(states, pageOf(2 * PAGE, TOTAL - 2 * PAGE), "all", {
      offset: 2 * PAGE,
      total: TOTAL,
      hasMore: false,
    });
    expect(historyStateFor(states, "all", "live")).toMatchObject({ hasMore: false, total: 500 });
  });

  test("repeated per-instance loadOlder walks to that instance's oldest run", () => {
    // Seed both instances from a mixed all-page that still has more history.
    const firstPage = [
      session("agent-a", "A-newest", { id: "a-0" }),
      session("agent-b", "B-newest", { id: "b-0" }),
    ];
    let states = seedHistoryPageStates(webInstances, firstPage, { offset: 0, total: 250, hasMore: true });
    // Per-instance filter is reachable straight away (inherits the all-page hasMore).
    expect(historyStateFor(states, "agent-a", "live").hasMore).toBe(true);

    // First per-instance page learns agent-a's own disk total (3 runs).
    states = markHistorySessionsLoaded(
      states,
      [session("agent-a", "A1", { id: "a-1" }), session("agent-a", "A2", { id: "a-2" })],
      "agent-a",
      { offset: 1, total: 3, hasMore: true },
    );
    expect(historyStateFor(states, "agent-a", "live")).toMatchObject({ offset: 3, hasMore: false, total: 3 });
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
