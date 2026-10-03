import { describe, expect, it } from "vitest";

import { collectProcessJobParentCalls, type ProcessJobParentCall } from "../process-job-presentation";
import { agentTurn, at, launchCall, manageCall, parentMessage, peerCall, peerStarted, T0 } from "../test/agent-group-fixtures";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection } from "../types";
import { PROCESS_JOB_BUCKETS, type ProcessJobBucket } from "./process-job-display";
import {
  processJobGroupPurpose,
  processJobItemBucket,
  processJobItemCounts,
  processJobItemIsCurrent,
  processJobItemIsIssue,
  processJobItemLead,
  processJobShelfItems,
  processJobShelfPartition,
  type ProcessJobGroupItem,
  type ProcessJobShelfItem,
} from "./process-job-groups";

const entry = (job: ProcessJobProjection) => ({ part: { type: "process-job" as const, job }, job });
const items = (jobs: readonly ProcessJobProjection[], calls: readonly ProcessJobParentCall[] = []) =>
  processJobShelfItems(jobs.map(entry), calls);
const group = (item: ProcessJobShelfItem | undefined): ProcessJobGroupItem => {
  if (item?.kind !== "group") throw new Error("expected an agent group");
  return item;
};
/** The timeline as short readable tokens. */
const outline = (item: ProcessJobShelfItem | undefined) => group(item).steps.map((step) =>
  step.kind === "turn" ? `turn:${step.entry.job.jobId}`
    : step.kind === "question" ? `ask:${step.job.jobId}`
      : `${step.nested ? "  " : ""}${step.label}:${step.call.toolCallId}`);
const command = (jobId: string, state: ProcessJobProjection["state"] = "running") => processJob({
  jobId, state, summary: `Purpose: ${jobId}`,
  ...(state === "running" ? { timestamps: { ...processJob().timestamps, completedAt: null }, exitCode: null, durationMs: null } : {}),
});
const NOW = T0 + 60 * 60_000;
const PEER_JOB_A = "0d6f3a2e-6c1b-4f7e-9a51-3b2c1d0e9f8a";
const PEER_JOB_B = "7e2d9c41-58a3-4b6f-a0c2-9d8e7f6a5b4c";
const CLOSED = (id: string) => `<subagent: helper · instance ${id} · turn 1 · closed>`;

describe("processJobShelfItems", () => {
  it("makes every subagent instance and every peer one group, keyed by family and id, and leaves commands alone", () => {
    const list = items([
      agentTurn("a1", "seed-bank", 0, { durationMinutes: 2 }),
      command("cmd"),
      agentTurn("p1", "seed-bank", 3, { tool: "PeerAgent", durationMinutes: 1 }),
      agentTurn("a2", "seed-bank", 5, { tool: "AgentManage" }),
      agentTurn("legacy", "helper", 6, { tool: "AgentSend", durationMinutes: 1 }),
    ]);
    expect(list.map((item) => item.key)).toEqual(["cmd", "peer:seed-bank", "agent:seed-bank", "agent:helper"]);
    expect(group(list[2]).turns.map((turn) => turn.job.jobId)).toEqual(["a1", "a2"]);
    expect(group(list[1]).family).toBe("peer");
    // Always a group, even for one turn.
    expect(group(list[3]).turns).toHaveLength(1);
  });

  it("puts a group where its newest turn sits, so nothing else moves", () => {
    const list = items([
      agentTurn("a1", "researcher-1", 0, { durationMinutes: 2 }),
      command("first"),
      agentTurn("b1", "planner", 2),
      command("second"),
      agentTurn("a2", "researcher-1", 4, { tool: "AgentManage" }),
    ]);
    expect(list.map((item) => item.key)).toEqual(["first", "agent:planner", "second", "agent:researcher-1"]);
  });

  it("interleaves the parent's calls with the turns they started, in transcript order", () => {
    const t1 = agentTurn("t1", "researcher-1", 0, { durationMinutes: 4, extra: { subagentQuestion: { question: "Use the county guide?" } } });
    const t2 = agentTurn("t2", "researcher-1", 10, { tool: "AgentManage", durationMinutes: 3 });
    const t3 = agentTurn("t3", "researcher-1", 20, { tool: "AgentManage" });
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(t1, { prompt: "Find the frost dates." })]),
      parentMessage("m2", 6, [{ type: "subagent", toolCallId: "fg", name: "researcher", status: "complete", calls: [],
        args: { id: "researcher-1", message: "Yes, the county guide." } }]),
      parentMessage("m3", 10, [launchCall(t2, { id: "researcher-1", message: "Compare five years." })]),
      parentMessage("m4", 20, [launchCall(t3, { id: "researcher-1", message: "Summarise the windows." })]),
      parentMessage("m5", 21, [
        manageCall("steer", { id: "researcher-1", steer: "One page only." }, { jobId: "t3", status: "applied" }),
        manageCall("stop", { id: "researcher-1", stop: true }, { jobId: "t3", status: "stopped" }),
      ]),
    ], "thread");
    const [researcher] = items([t1, t2, t3], calls);
    expect(outline(researcher)).toEqual([
      "brief:call-t1", "turn:t1", "ask:t1",
      // The foreground message answers the child's question: it reads as a reply, with no turn under it.
      "reply:fg",
      "message:call-t2", "turn:t2",
      "message:call-t3", "turn:t3",
      "  steer:steer", "  stop:stop",
    ]);
    expect(group(researcher).closed).toBe(false);
    expect(group(researcher).task).toBe("Summarise the windows.");
  });

  it("places a turn whose launch is not loaded before the first call made after it was admitted", () => {
    const early = agentTurn("early", "researcher-1", 0, { durationMinutes: 2 });
    const later = agentTurn("later", "researcher-1", 10, { tool: "AgentManage" });
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 5, [manageCall("fg", { id: "researcher-1", message: "Quick question." })]),
      parentMessage("m2", 10, [launchCall(later, { id: "researcher-1", message: "Keep going." })]),
    ], "thread");
    expect(outline(items([early, later], calls)[0])).toEqual(["turn:early", "message:fg", "message:call-later", "turn:later"]);
  });

  it("keeps a reused id as one group, showing the close before the new brief, and reopens it", () => {
    const first = agentTurn("first", "helper", 0, { durationMinutes: 2 });
    const second = agentTurn("second", "helper", 10);
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(first, { prompt: "Tidy the shed list.", id: "helper", persist: true })]),
      parentMessage("m2", 5, [manageCall("close", { id: "helper", close: true }, CLOSED("helper"))]),
      parentMessage("m3", 10, [launchCall(second, { prompt: "Plan the compost bays.", id: "helper", persist: true })]),
    ], "thread");
    const list = items([first, second], calls);
    expect(list).toHaveLength(1);
    expect(outline(list[0])).toEqual(["brief:call-first", "turn:first", "close:close", "brief:call-second", "turn:second"]);
    expect(group(list[0]).closed).toBe(false);
  });

  it("marks an instance closed only after a close the host confirmed", () => {
    const stopped = agentTurn("s1", "soil-analyst", 0, { state: "cancelled", durationMinutes: 3 });
    const closedAfter = (...parts: Parameters<typeof manageCall>[]) => group(items([stopped], collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(stopped, { prompt: "Compare the soil tests.", id: "soil-analyst", persist: true })]),
      ...parts.map((call, index) => parentMessage(`m${String(index + 2)}`, 5 + index, [manageCall(...call)])),
    ], "thread"))[0]).closed;

    expect(closedAfter(["close", { id: "soil-analyst", close: true }, CLOSED("soil-analyst")])).toBe(true);
    // Rejected (the instance was busy), unanswered, or answered by anything but the host's header: not closed.
    expect(closedAfter(["close", { id: "soil-analyst", close: true }, "Error: instance \"soil-analyst\" is busy.", { status: "failed" }])).toBe(false);
    expect(closedAfter(["close", { id: "soil-analyst", close: true }, undefined, { status: "running" }])).toBe(false);
    expect(closedAfter(["close", { id: "soil-analyst", close: true }, "I closed it."])).toBe(false);
    // A confirmed close, then a foreground recreation that answered, reopens it; a failed one does not.
    expect(closedAfter(
      ["close", { id: "soil-analyst", close: true }, CLOSED("soil-analyst")],
      ["again", { id: "soil-analyst", message: "Start over with the new samples." }, "<subagent: analyst · instance soil-analyst · turn 1 · ok · 3 calls · 20s>\nStarted."],
    )).toBe(false);
    expect(closedAfter(
      ["close", { id: "soil-analyst", close: true }, CLOSED("soil-analyst")],
      ["again", { id: "soil-analyst", message: "Start over." }, "Error: unknown, closed or expired instance \"soil-analyst\".", { status: "failed" }],
    )).toBe(true);
  });

  it("does not claim a close a detached message only asked for", () => {
    const last = agentTurn("l1", "helper", 0, { tool: "AgentManage", durationMinutes: 2 });
    const closing = collectProcessJobParentCalls([parentMessage("m1", 0, [launchCall(last, { id: "helper", message: "Finish up.", close: true })])], "thread");
    expect(group(items([last], closing)[0]).closed).toBe(false);
  });

  it("never moves or repeats another child's turn, whatever a call's receipt claims", () => {
    const a = agentTurn(PEER_JOB_A, "seed-bank", 0, { tool: "PeerAgent" });
    const b = agentTurn(PEER_JOB_B, "bulb-club", 2, { tool: "PeerAgent", durationMinutes: 1 });
    const calls = collectProcessJobParentCalls([
      // Peer B's detached thread returns a well-formed receipt that names A's job
      // (the only claim on it, so the collector cannot tell it is wrong).
      parentMessage("m1", 1, [peerCall("b-send", { action: "send", peer: "bulb-club", thread: "autumn", message: "Tulip stock?", background: true },
        peerStarted("bulb-club", "autumn", PEER_JOB_A))]),
    ], "thread");
    expect(calls[0]).toMatchObject({ instanceId: "bulb-club", launchedJobId: PEER_JOB_A });
    const list = items([a, b], calls);
    // B's row stays in B's group without a turn; A's turn is in A's group once, unpaired.
    expect(outline(list.find((item) => item.key === "peer:seed-bank"))).toEqual([`turn:${PEER_JOB_A}`]);
    expect(outline(list.find((item) => item.key === "peer:bulb-club"))).toEqual(["message:b-send", `turn:${PEER_JOB_B}`]);
    const turns = list.flatMap((item) => item.kind === "group" ? group(item).steps.flatMap((step) => step.kind === "turn" ? [step.entry.job.jobId] : []) : []);
    expect(turns).toHaveLength(new Set(turns).size);
  });

  it("pairs a launch only with a turn of its own tool", () => {
    const managed = agentTurn("m1", "helper", 1, { tool: "AgentManage" });
    const calls = collectProcessJobParentCalls([
      // An Agent receipt naming an AgentManage job is a conflict: no pairing,
      // so the turn is placed by its own admission time, before the call.
      parentMessage("m1", 5, [launchCall({ ...managed, tool: "Agent" }, { prompt: "Brief", id: "helper", persist: true })]),
    ], "thread");
    expect(outline(items([managed], calls)[0])).toEqual(["turn:m1", "brief:call-m1"]);
  });

  it("never joins a call to another family's group with the same id", () => {
    const peerTurn = agentTurn("p1", "seed-bank", 0, { tool: "PeerAgent" });
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [manageCall("fg", { id: "seed-bank", message: "Subagent message." })])], "thread");
    expect(outline(items([peerTurn], calls)[0])).toEqual(["turn:p1"]);
  });
});

describe("agent group state and counts", () => {
  const pendingPeer = (jobId: string, minute: number, expiresMinute: number) => agentTurn(jobId, "seed-bank", minute, {
    tool: "PeerAgent", durationMinutes: 1,
    extra: { peerQuestion: { state: "awaiting_answer", questionId: `q-${jobId}`, peer: "seed-bank", thread: "spring",
      message: "Reserve now?", requestedSchema: {}, expiresAt: at(expiresMinute) } },
  });

  it("decides a group's issue by its newest turn only", () => {
    const failedThenRunning = items([
      agentTurn("f", "planner", 0, { tool: "Agent", state: "failed", durationMinutes: 2 }),
      agentTurn("r", "planner", 5, { tool: "AgentManage" }),
    ])[0]!;
    expect(processJobItemIsIssue(failedThenRunning)).toBe(false);
    const runningThenFailed = items([
      agentTurn("ok", "planner", 0, { durationMinutes: 2 }),
      agentTurn("bad", "planner", 5, { tool: "AgentManage", state: "failed", durationMinutes: 1 }),
    ])[0]!;
    expect(processJobItemIsIssue(runningThenFailed)).toBe(true);
  });

  it("keeps a peer with a pending question current and lets that question speak for the group", () => {
    const [peer] = items([pendingPeer("p1", 0, 90), agentTurn("p2", "seed-bank", 5, { tool: "PeerAgent", durationMinutes: 1 })]);
    expect(processJobItemIsCurrent(peer!, NOW)).toBe(true);
    expect(processJobItemLead(peer!, NOW).jobId).toBe("p1");
    // Past its deadline the same group is finished and its newest turn speaks.
    expect(processJobItemIsCurrent(peer!, T0 + 120 * 60_000)).toBe(false);
    expect(processJobItemLead(peer!, T0 + 120 * 60_000).jobId).toBe("p2");
  });

  it("lets running work speak for a peer whose newest thread already finished", () => {
    const [peer] = items([agentTurn("slow", "seed-bank", 0, { tool: "PeerAgent" }), agentTurn("fast", "seed-bank", 5, { tool: "PeerAgent", durationMinutes: 1 })]);
    expect(processJobItemLead(peer!, NOW).jobId).toBe("slow");
    expect(processJobItemIsCurrent(peer!, NOW)).toBe(true);
  });

  it("counts items, not jobs: a group counts once in every figure", () => {
    const list = items([
      agentTurn("a1", "researcher-1", 0, { durationMinutes: 2 }),
      agentTurn("a2", "researcher-1", 5, { tool: "AgentManage", durationMinutes: 2 }),
      agentTurn("a3", "researcher-1", 10, { tool: "AgentManage" }),
      agentTurn("b1", "planner", 0, { state: "failed", durationMinutes: 1 }),
      pendingPeer("p1", 0, 90),
      pendingPeer("p2", 5, 95),
      command("cmd"),
      command("done", "succeeded"),
    ]);
    expect(processJobItemCounts(list, NOW)).toEqual({ question: 1, active: 2, issue: 1, cancelled: 0, done: 1 });
  });

  it("names a group by its NEWEST task, whichever turn speaks for its status", () => {
    const generic = agentTurn("g", "helper-3", 0, { summary: "Persistent subagent helper-3" });
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [launchCall(generic, { prompt: "Water the\n north beds." })])], "thread");
    const [helper] = items([generic], calls);
    expect(processJobGroupPurpose(group(helper))).toBe("Water the north beds.");

    const peer = agentTurn("p", "seed-bank", 0, { tool: "PeerAgent", summary: "Peer seed-bank thread spring-orders" });
    expect(processJobGroupPurpose(group(items([peer])[0]))).toBe("thread spring-orders");

    // An older pending question speaks for the status; the title stays the newest task.
    const [bank] = items([
      pendingPeer("older", 0, 90),
      agentTurn("newer", "seed-bank", 5, { tool: "PeerAgent", durationMinutes: 1, summary: "Check the bulb order" }),
    ]);
    expect(processJobItemLead(bank!, NOW).jobId).toBe("older");
    expect(processJobGroupPurpose(group(bank))).toBe("Check the bulb order");
  });

  it("names threads only when one peer serves several", () => {
    const one = items([pendingPeer("p1", 0, 90), agentTurn("p2", "seed-bank", 5, { tool: "PeerAgent", durationMinutes: 1 })]);
    expect(group(one[0]).showThreads).toBe(false);
    const calls = collectProcessJobParentCalls([parentMessage("m1", 6, [
      peerCall("autumn", { action: "send", peer: "seed-bank", thread: "autumn", message: "Bulbs?" }, "Plenty."),
    ])], "thread");
    const two = items([pendingPeer("p1", 0, 90)], calls);
    expect(group(two[0]).showThreads).toBe(true);
  });
});

describe("the shelf partition", () => {
  const settled = processJob().wake;
  /** A command job in any state, with state-correct stamps and wake. */
  const job = (jobId: string, state: ProcessJobProjection["state"], extra: Partial<Extract<ProcessJobProjection, { tool: "Exec" | "Bash" }>> = {}) => {
    const terminal = !["queued", "starting", "running"].includes(state);
    return processJob({
      jobId, state, summary: `Purpose: ${jobId}`,
      ...(terminal ? {} : { timestamps: { ...processJob().timestamps, completedAt: null }, exitCode: null, durationMs: null,
        wake: { ...settled, state: "pending", attempts: 0, lastAttemptAt: null } }),
      ...extra,
    });
  };
  const bucketOf = (jobs: readonly ProcessJobProjection[], now = NOW): ProcessJobBucket => {
    const list = items(jobs);
    expect(list).toHaveLength(1);
    return processJobItemBucket(list[0]!, now);
  };
  const peerTurn = (jobId: string, minute: number, state: ProcessJobProjection["state"], expiresMinute?: number) => agentTurn(jobId, "seed-bank", minute, {
    tool: "PeerAgent", state, durationMinutes: 1,
    ...(expiresMinute === undefined ? {} : { extra: { peerQuestion: { state: "awaiting_answer", questionId: `q-${jobId}`, peer: "seed-bank", thread: "spring",
      message: "Reserve now?", requestedSchema: {}, expiresAt: at(expiresMinute) } } }),
  });
  /** The partition's invariants for any list: one bucket per row, sums, lists and order. */
  const expectPartition = (list: readonly ProcessJobShelfItem[], now = NOW) => {
    const partition = processJobShelfPartition(list, now);
    const buckets = list.map((item) => processJobItemBucket(item, now));
    const { counts } = partition;
    expect(PROCESS_JOB_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)).toBe(list.length);
    for (const bucket of PROCESS_JOB_BUCKETS) expect(counts[bucket]).toBe(buckets.filter((value) => value === bucket).length);
    expect(partition.current).toEqual(list.filter((_, index) => buckets[index] === "question" || buckets[index] === "active"));
    expect(partition.finished).toEqual(list.filter((_, index) => buckets[index] !== "question" && buckets[index] !== "active"));
    expect(partition.active).toEqual(list.filter((_, index) => buckets[index] === "active"));
    expect(partition.current.length).toBe(counts.question + counts.active);
    expect(partition.finished.length).toBe(counts.issue + counts.cancelled + counts.done);
    // The rows above History are exactly the current ones.
    for (const item of list) expect(partition.current.includes(item)).toBe(processJobItemIsCurrent(item, now));
    return partition;
  };

  it.each<[ProcessJobProjection["state"], boolean, ProcessJobBucket]>([
    ["queued", false, "active"],
    ["starting", false, "active"],
    ["running", false, "active"],
    // Stopping is still in progress until the host settles it.
    ["running", true, "active"],
    ["succeeded", false, "done"],
    ["failed", false, "issue"],
    ["timed_out", false, "issue"],
    ["spawn_failed", false, "issue"],
    ["queue_expired", false, "issue"],
    ["interrupted", false, "issue"],
    ["cancelled", true, "cancelled"],
  ])("puts a %s command job (stop asked: %s) in exactly one bucket: %s", (state, cancelRequested, bucket) => {
    expect(bucketOf([job("one", state, { cancelRequested })])).toBe(bucket);
  });

  it("counts a wake or child problem as an issue, even on a success or a cancellation", () => {
    expect(bucketOf([job("woke", "succeeded", { wake: { ...settled, state: "failed" } })])).toBe("issue");
    expect(bucketOf([job("unknown", "succeeded", { wake: { ...settled, state: "unknown" } })])).toBe("issue");
    expect(bucketOf([job("stopped", "cancelled", { wake: { ...settled, state: "failed" } })])).toBe("issue");
    expect(bucketOf([agentTurn("busy", "helper", 0, { state: "cancelled", durationMinutes: 1, extra: { childStillBusy: true } })])).toBe("issue");
    // Delivered or still pending wakes are nothing wrong.
    expect(bucketOf([job("fine", "succeeded")])).toBe("done");
  });

  it("puts a pending peer question first, whatever the job's outcome, until its deadline", () => {
    expect(bucketOf([peerTurn("ok", 0, "succeeded", 90)])).toBe("question");
    expect(bucketOf([peerTurn("bad", 0, "failed", 90)])).toBe("question");
    expect(bucketOf([peerTurn("stop", 0, "cancelled", 90)])).toBe("question");
    const late = T0 + 120 * 60_000;
    expect(bucketOf([peerTurn("ok", 0, "succeeded", 90)], late)).toBe("done");
    expect(bucketOf([peerTurn("bad", 0, "failed", 90)], late)).toBe("issue");
    expect(bucketOf([peerTurn("stop", 0, "cancelled", 90)], late)).toBe("cancelled");
  });

  it("decides a settled group by its newest turn, and a current one by any turn still asking or working", () => {
    expect(bucketOf([agentTurn("f", "planner", 0, { state: "failed", durationMinutes: 1 }), agentTurn("r", "planner", 5, { tool: "AgentManage" })])).toBe("active");
    expect(bucketOf([agentTurn("ok", "planner", 0, { durationMinutes: 1 }), agentTurn("bad", "planner", 5, { tool: "AgentManage", state: "failed", durationMinutes: 1 })])).toBe("issue");
    // A later success answers an earlier failure.
    expect(bucketOf([agentTurn("bad", "planner", 0, { state: "failed", durationMinutes: 1 }), agentTurn("ok", "planner", 5, { tool: "AgentManage", durationMinutes: 1 })])).toBe("done");
    expect(bucketOf([agentTurn("ok", "planner", 0, { durationMinutes: 1 }), agentTurn("stop", "planner", 5, { tool: "AgentManage", state: "cancelled", durationMinutes: 1 })])).toBe("cancelled");
    // A peer: an older question outranks newer work; newer work outranks an older failure.
    expect(bucketOf([peerTurn("asks", 0, "succeeded", 90), agentTurn("works", "seed-bank", 5, { tool: "PeerAgent" })])).toBe("question");
    expect(bucketOf([agentTurn("works", "seed-bank", 0, { tool: "PeerAgent" }), peerTurn("bad", 5, "failed")])).toBe("active");
  });

  it("partitions a mixed shelf so the counts add up to its rows, in shelf order", () => {
    const list = items([
      job("queued", "queued"),
      job("running", "running"),
      job("stopping", "running", { cancelRequested: true }),
      agentTurn("a1", "researcher-1", 0, { durationMinutes: 2 }),
      agentTurn("a2", "researcher-1", 5, { tool: "AgentManage" }),
      peerTurn("p1", 0, "failed", 90),
      job("done", "succeeded"),
      job("woke", "succeeded", { wake: { ...settled, state: "failed" } }),
      job("failed", "failed"),
      job("timed-out", "timed_out"),
      job("cancelled", "cancelled"),
      agentTurn("b1", "planner", 0, { state: "failed", durationMinutes: 1 }),
      agentTurn("b2", "planner", 5, { tool: "AgentManage", durationMinutes: 1 }),
    ]);
    const partition = expectPartition(list);
    expect(partition.counts).toEqual({ question: 1, active: 4, issue: 3, cancelled: 1, done: 2 });
    expect(partition.active.map((item) => item.key)).toEqual(["queued", "running", "stopping", "agent:researcher-1"]);
    expect(partition.finished.map((item) => item.key)).toEqual(["done", "woke", "failed", "timed-out", "cancelled", "agent:planner"]);
  });

  it("reads six finished rows with three failures as three issues and three done, never nine", () => {
    const list = items([
      job("export", "succeeded"),
      job("lint", "failed"),
      agentTurn("plan", "bed-planner", 0, { durationMinutes: 8 }),
      job("crawl", "timed_out"),
      agentTurn("bulbs", "seed-bank", 10, { tool: "PeerAgent", durationMinutes: 1 }),
      job("sync", "interrupted"),
    ]);
    const partition = expectPartition(list);
    expect(partition.counts).toEqual({ question: 0, active: 0, issue: 3, cancelled: 0, done: 3 });
    expect(partition.finished).toHaveLength(6);
  });

  it("keeps its invariants at every instant as questions expire", () => {
    const list = items([
      peerTurn("p1", 0, "succeeded", 30),
      job("x", "running"),
      agentTurn("q2", "bulb-club", 0, { tool: "PeerAgent", state: "cancelled", durationMinutes: 1,
        extra: { peerQuestion: { state: "awaiting_answer", questionId: "q-q2", peer: "bulb-club", thread: "autumn", message: "Order?", requestedSchema: {}, expiresAt: at(60) } } }),
    ]);
    const minuteAt = (minute: number) => T0 + minute * 60_000;
    expect(expectPartition(list, minuteAt(10)).counts).toEqual({ question: 2, active: 1, issue: 0, cancelled: 0, done: 0 });
    expect(expectPartition(list, minuteAt(45)).counts).toEqual({ question: 1, active: 1, issue: 0, cancelled: 0, done: 1 });
    expect(expectPartition(list, minuteAt(90)).counts).toEqual({ question: 0, active: 1, issue: 0, cancelled: 1, done: 1 });
  });
});
