import { describe, expect, it } from "vitest";
import { agent, thread } from "../../test/fixtures";
import type { ThreadSummary } from "../../types";
import {
  agentInitials,
  dashboardKindIcon,
  dashboardThreadKind,
  groupRunningThreads,
  matchesRecentFilter,
  mergeRunningThreads,
  runningThreadCount,
} from "./dashboard-model";

describe("agent initials", () => {
  it.each([
    ["Mono Agent", "MA"],
    ["mono-agent", "MA"],
    ["personal_assistant", "PA"],
    ["Alpha", "AL"],
    ["a", "A"],
    ["Alpha Beta Gamma", "AB"],
  ])("renders %s as %s", (label, expected) => {
    expect(agentInitials(label)).toBe(expected);
  });

  it("never leaves the square empty", () => {
    expect(agentInitials("")).toBe("A");
    expect(agentInitials("   ")).toBe("A");
    expect(agentInitials("-")).toBe("A");
  });
});

describe("conversation kind", () => {
  it("puts trouble ahead of how the conversation started", () => {
    // A cron run that failed is a failure first: the operator has to see it,
    // and the trigger badge on the row still says where it came from.
    const failedCron = thread("failed-cron", "alpha", {
      trigger: { kind: "cron", jobId: "daily" },
      runState: { status: "failed" },
    });
    expect(dashboardThreadKind(failedCron)).toBe("alert");
    expect(dashboardKindIcon("alert")).toBe("alert");
  });

  it("reads the outcome, not the words the status line chose", () => {
    const jobFailure = thread("job", "alpha", {
      runState: { status: "complete", finishedAt: "2026-09-07T10:00:00.000Z" },
      jobActivity: {
        queued: 0,
        starting: 0,
        running: 0,
        latestTerminal: { state: "timed_out", completedAt: "2026-09-07T10:01:00.000Z" },
      },
    });
    expect(dashboardThreadKind(jobFailure)).toBe("alert");
  });

  it("calls a running conversation ordinary, whatever it is retrying", () => {
    expect(dashboardThreadKind(thread("live", "alpha", { runState: { status: "running" } })))
      .toBe("chat");
  });

  it.each([
    [{ kind: "cron" as const, jobId: "daily" }, "cron", "clock"],
    [{ kind: "webhook" as const }, "webhook", "activity"],
  ])("maps %o to %s", (trigger, kind, icon) => {
    const row = thread("triggered", "alpha", { trigger });
    expect(dashboardThreadKind(row)).toBe(kind);
    expect(dashboardKindIcon(dashboardThreadKind(row))).toBe(icon);
  });

  it("falls back to an ordinary conversation", () => {
    expect(dashboardThreadKind(thread("plain", "alpha"))).toBe("chat");
    expect(dashboardKindIcon("chat")).toBe("threads");
  });
});

describe("recent filter", () => {
  const cron = thread("cron", "alpha", { trigger: { kind: "cron", jobId: "daily" } });
  const webhook = thread("hook", "alpha", { trigger: { kind: "webhook" } });
  const plain = thread("plain", "alpha");

  it("passes everything under All, including cron", () => {
    for (const row of [cron, webhook, plain]) {
      expect(matchesRecentFilter(row, "all")).toBe(true);
    }
  });

  it("matches only cron under Cron -- a webhook is a different trigger", () => {
    expect(matchesRecentFilter(cron, "cron")).toBe(true);
    expect(matchesRecentFilter(webhook, "cron")).toBe(false);
    expect(matchesRecentFilter(plain, "cron")).toBe(false);
  });
});

describe("running groups", () => {
  const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
  const running = [
    thread("beta-new", "beta", { updatedAt: "2026-09-07T12:00:00.000Z" }),
    thread("alpha-old", "alpha", { updatedAt: "2026-09-07T09:00:00.000Z" }),
    thread("alpha-new", "alpha", { updatedAt: "2026-09-07T11:00:00.000Z" }),
  ];

  it("keeps the console's agent order and sorts newest first inside each group", () => {
    const groups = groupRunningThreads(running, agents);

    expect(groups.map((group) => group.agent.sourceId)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(["alpha-new", "alpha-old"]);
    expect(runningThreadCount(groups)).toBe(3);
  });

  it("breaks a tie on the identifier so the order cannot flicker", () => {
    const sameInstant = [
      thread("z-thread", "alpha", { updatedAt: "2026-09-07T11:00:00.000Z" }),
      thread("a-thread", "alpha", { updatedAt: "2026-09-07T11:00:00.000Z" }),
    ];
    expect(groupRunningThreads(sameInstant, agents)[0]?.threads.map((item) => item.id))
      .toEqual(["a-thread", "z-thread"]);
    expect(groupRunningThreads([...sameInstant].reverse(), agents)[0]?.threads.map((item) => item.id))
      .toEqual(["a-thread", "z-thread"]);
  });

  it("drops a conversation whose agent has left discovery", () => {
    // The store's projection is the CACHE's set and knows nothing about
    // discovery; a browser can hold conversations for an agent that is gone.
    const groups = groupRunningThreads(running, [agent("alpha", { label: "Alpha" })]);

    expect(groups.map((group) => group.agent.sourceId)).toEqual(["alpha"]);
    expect(groups.flatMap((group) => group.threads.map((item) => item.id)))
      .not.toContain("beta-new");
  });

  it("names no agent that has nothing running", () => {
    expect(groupRunningThreads([], agents)).toEqual([]);
    expect(groupRunningThreads([running[1]!], agents).map((group) => group.agent.sourceId))
      .toEqual(["alpha"]);
  });
});

describe("mergeRunningThreads", () => {
  const base = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
    id, sourceId: "alpha", title: id, archivedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1, messageCount: 0, runState: { status: "idle" }, canSend: true, canUpload: true,
    runModel: null, runEffort: null, ...extra,
  } as ThreadSummary);

  it("adds listed conversations that are active, and only those", () => {
    const merged = mergeRunningThreads([], [
      base("idle"),
      base("working", { runState: { status: "running", id: "t" } }),
    ]);
    expect(merged.map((thread) => thread.id)).toEqual(["working"]);
  });

  it("lets the cache's copy win over the listing's", () => {
    const listed = base("shared", { runState: { status: "running", id: "t" }, title: "listed" });
    const cached = { ...listed, title: "cached" };
    expect(mergeRunningThreads([cached], [listed]).map((thread) => thread.title)).toEqual(["cached"]);
  });
});
