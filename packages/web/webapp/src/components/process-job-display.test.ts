import { describe, expect, it } from "vitest";

import { backgroundSubagentJob } from "../test/background-subagent-fixtures";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection, ProcessJobState } from "../types";
import type { ProcessJobMark, ProcessJobTone } from "./process-job-display";
import {
  nextPeerQuestionDeadline,
  peerQuestionExpiryLabel,
  pendingPeerQuestion,
  processJobCallOutcomes,
  processJobCallOutcomesLabel,
  processJobDisplayState,
  processJobDisplayTitle,
  processJobGroupName,
  processJobIsCurrent,
  processJobIsIssue,
  processJobActiveMark,
  processJobKind,
  processJobMarkIsSettled,
  processJobOutputIsEmpty,
  processJobPreview,
  processJobStackAnnouncement,
  processJobStackSummaryParts,
  PROCESS_JOB_BUCKETS,
  processJobBucketIsCurrent,
  processJobCountWords,
  processJobFinishedWords,
  processJobFitCount,
} from "./process-job-display";
import { processJobItemCounts, processJobShelfItems } from "./process-job-groups";

/** Command jobs are single rows, so item counts are job counts here. */
const processJobStackCounts = (jobs: readonly ProcessJobProjection[], now: number) =>
  processJobItemCounts(processJobShelfItems(jobs.map((job) => ({ part: { type: "process-job" as const, job }, job })), []), now);

const NOW = Date.parse("2026-07-17T10:00:00.000Z");
const base = processJob();
const active = (state: "queued" | "starting" | "running", overrides: Partial<Extract<ProcessJobProjection, { tool: "Exec" | "Bash" }>> = {}) => processJob({
  state,
  timestamps: { ...base.timestamps, startedAt: state === "running" ? base.timestamps.startedAt : null, completedAt: null },
  wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
  exitCode: null,
  durationMs: null,
  ...overrides,
});
const peer = (state: ProcessJobState, question: "awaiting_answer" | "answered", expiresAt = "2026-07-17T10:20:00.000Z") => processJob({
  state, tool: "PeerAgent", kind: "internal", instanceId: "seed-bank", childStillBusy: false,
  peerQuestion: { state: question, questionId: "q-1", peer: "seed-bank", thread: "spring-orders",
    message: "Before I order:\nReserve the heirloom seeds now?", requestedSchema: {}, expiresAt },
});

describe("processJobDisplayState", () => {
  it.each<[ProcessJobState, ProcessJobTone, ProcessJobMark, string]>([
    ["queued", "waiting", "empty", "Queued"],
    // Starting shares the half mark: a quarter would read as a measured 25 %.
    ["starting", "running", "half", "Starting"],
    ["running", "running", "half", "Running"],
    ["succeeded", "success", "check", "Done"],
    ["failed", "danger", "cross", "Failed"],
    ["timed_out", "danger", "clock", "Timed out"],
    ["spawn_failed", "danger", "cross", "Failed to start"],
    ["queue_expired", "danger", "clock", "Expired in queue"],
    ["interrupted", "danger", "cross", "Interrupted"],
    ["cancelled", "neutral", "stopped", "Cancelled"],
  ])("gives %s a tone, a distinct mark and a word", (state, tone, mark, word) => {
    const job = processJob({ state });
    expect(processJobDisplayState(job, NOW)).toMatchObject({ tone, mark, word });
  });

  it("outlines current work and fills settled outcomes, so shape alone tells them apart", () => {
    const outlined: readonly ProcessJobMark[] = ["empty", "half", "stop", "question"];
    const solid: readonly ProcessJobMark[] = ["check", "cross", "clock", "stopped"];
    for (const mark of outlined) expect(processJobMarkIsSettled(mark)).toBe(false);
    for (const mark of solid) expect(processJobMarkIsSettled(mark)).toBe(true);
    // Every settled state draws a solid disc; every lifecycle-active state a ring.
    for (const state of ["succeeded", "failed", "timed_out", "spawn_failed", "queue_expired", "interrupted", "cancelled"] as const) {
      expect(processJobMarkIsSettled(processJobDisplayState(processJob({ state }), NOW).mark)).toBe(true);
    }
    for (const state of ["queued", "starting", "running"] as const) {
      expect(processJobMarkIsSettled(processJobDisplayState(active(state), NOW).mark)).toBe(false);
    }
    // Stopping (still winding down) and cancelled (settled) share the square, not the fill.
    expect(processJobDisplayState(active("running", { cancelRequested: true }), NOW).mark).toBe("stop");
    expect(processJobDisplayState(processJob({ state: "cancelled" }), NOW).mark).toBe("stopped");
  });

  it("uses the static half mark while a job is starting or running", () => {
    const queued = active("queued", { jobId: "queued" });
    const running = active("running", { jobId: "running" });
    const starting = active("starting", { jobId: "starting" });
    const stopping = active("running", { jobId: "stopping", cancelRequested: true });
    const done = processJob({ jobId: "done" });
    expect(processJobActiveMark([queued, running, done], NOW)).toEqual({ tone: "running", mark: "half" });
    expect(processJobActiveMark([queued, starting], NOW)).toEqual({ tone: "running", mark: "half" });
    // Nothing in progress: a still mark for what the active jobs are doing.
    expect(processJobActiveMark([queued, stopping, done], NOW)).toEqual({ tone: "stopping", mark: "stop" });
    expect(processJobActiveMark([queued, active("queued", { jobId: "queued-2" }), done], NOW)).toEqual({ tone: "waiting", mark: "empty" });
  });

  it("names a stop request on running work, but a terminal state wins", () => {
    expect(processJobDisplayState(active("running", { cancelRequested: true }), NOW))
      .toMatchObject({ tone: "stopping", mark: "stop", word: "Stopping", stopping: true });
    expect(processJobDisplayState(processJob({ state: "cancelled", cancelRequested: true }), NOW))
      .toMatchObject({ word: "Cancelled", stopping: false });
    expect(processJobGroupName(active("running", { cancelRequested: true }))).toBe("Exec background job running (stopping)");
    expect(processJobGroupName(processJob({ state: "timed_out" }))).toBe("Exec background job timed out");
  });

  it("shows a succeeded peer job with an open question as that question, and keeps any other outcome", () => {
    expect(processJobDisplayState(peer("succeeded", "awaiting_answer"), NOW))
      .toMatchObject({ tone: "question", mark: "question", word: "Question pending" });
    const failed = processJobDisplayState(peer("failed", "awaiting_answer"), NOW);
    expect(failed).toMatchObject({ tone: "danger", word: "Failed", pending: "Question pending" });
    expect(processJobDisplayState(peer("succeeded", "answered"), NOW).word).toBe("Done");
    expect(processJobDisplayState(peer("succeeded", "awaiting_answer", "2026-07-17T09:59:00.000Z"), NOW).word).toBe("Done");
  });

  it("gives exit facts to commands only and never says exit 0", () => {
    expect(processJobDisplayState(processJob(), NOW).details).toEqual([]);
    expect(processJobDisplayState(processJob({ state: "failed", exitCode: 1, signal: null }), NOW).details).toEqual(["exit 1"]);
    expect(processJobDisplayState(processJob({ state: "timed_out", exitCode: 137, signal: "SIGKILL" }), NOW).details).toEqual(["exit 137", "SIGKILL"]);
    expect(processJobDisplayState(backgroundSubagentJob(true), NOW).details).toEqual([]);
  });

  it("keeps the exact alert wording and only after settlement", () => {
    const busy = { ...backgroundSubagentJob(true), childStillBusy: true, wake: { ...base.wake, state: "unknown" as const } };
    expect(processJobDisplayState(busy, NOW).alerts).toEqual([
      "child still busy · awaiting actual settlement",
      "wake outcome unknown · replay suppressed",
    ]);
    expect(processJobDisplayState({ ...backgroundSubagentJob(), childStillBusy: true }, NOW).alerts).toEqual([]);
    expect(processJobDisplayState(processJob({ wake: { ...base.wake, state: "failed" } }), NOW).alerts).toEqual(["wake failed"]);
  });

  it("notes a child's question to its parent as a past fact", () => {
    const asked = { ...backgroundSubagentJob(true), subagentQuestion: { question: "Heat the greenhouse?" } };
    expect(processJobDisplayState(asked, NOW).notes).toEqual(["asked the parent agent a question"]);
  });
});

describe("groups and counts", () => {
  it("counts issues without counting what was asked for", () => {
    expect(processJobIsIssue(processJob({ state: "failed" }))).toBe(true);
    expect(processJobIsIssue(processJob({ state: "cancelled" }))).toBe(false);
    expect(processJobIsIssue(processJob({ state: "cancelled", wake: { ...base.wake, state: "failed" } }))).toBe(true);
    expect(processJobIsIssue(processJob({ wake: { ...base.wake, state: "unknown" } }))).toBe(true);
    expect(processJobIsIssue({ ...backgroundSubagentJob(true), childStillBusy: true })).toBe(true);
    expect(processJobIsIssue(active("running"))).toBe(false);
  });

  it("keeps a pending question current until its own deadline", () => {
    const job = peer("succeeded", "awaiting_answer");
    expect(pendingPeerQuestion(job, NOW)).toBe(true);
    expect(processJobIsCurrent(job, NOW)).toBe(true);
    expect(processJobIsCurrent(job, Date.parse("2026-07-17T10:20:00.000Z"))).toBe(false);
    expect(nextPeerQuestionDeadline([job, active("running")], NOW)).toBe(Date.parse("2026-07-17T10:20:00.000Z"));
    expect(nextPeerQuestionDeadline([job], Date.parse("2026-07-17T10:21:00.000Z"))).toBeUndefined();
  });

  it("counts each row once: a question before its outcome, never inside the active count", () => {
    const counts = processJobStackCounts([active("running"), active("queued"), peer("succeeded", "awaiting_answer"), processJob({ state: "failed" }), processJob()], NOW);
    expect(counts).toEqual({ question: 1, active: 2, issue: 1, cancelled: 0, done: 1 });
    expect(processJobStackSummaryParts(counts)).toEqual(["1 question awaiting the agent", "2 active", "1 issue", "1 done"]);
    expect(processJobStackAnnouncement(counts)).toBe("Background jobs: 1 question awaiting the agent, 2 active, 1 issue, 1 done.");
  });

  it("names only the buckets that hold rows, in the chips' order, and never a word for what is absent", () => {
    const counts = processJobStackCounts([processJob({ jobId: "done" }), processJob({ jobId: "stopped", state: "cancelled" })], NOW);
    expect(counts).toEqual({ question: 0, active: 0, issue: 0, cancelled: 1, done: 1 });
    expect(processJobStackAnnouncement(counts)).toBe("Background jobs: 1 cancelled, 1 done.");
    expect(processJobStackSummaryParts({ question: 2, active: 0, issue: 2, cancelled: 0, done: 0 }))
      .toEqual(["2 questions awaiting the agent", "2 issues"]);
    expect(processJobStackAnnouncement({ question: 0, active: 0, issue: 0, cancelled: 0, done: 0 })).toBe("Background jobs: none.");
    expect(PROCESS_JOB_BUCKETS).toEqual(["question", "active", "issue", "cancelled", "done"]);
    expect(PROCESS_JOB_BUCKETS.filter(processJobBucketIsCurrent)).toEqual(["question", "active"]);
    // No bounded wording anywhere: counts count what is loaded.
    for (const bucket of PROCESS_JOB_BUCKETS) {
      expect(processJobCountWords[bucket](1)).not.toMatch(/shown|finished/u);
    }
    expect(processJobFinishedWords(6)).toBe("6 finished");
  });
});

describe("the closed bar's named list", () => {
  // Entry widths include the dot in front of every entry but the first; "· +n" is 26 px.
  const more = () => 26;
  it("shows every entry that fits, and no \"+n\" when all of them do", () => {
    expect(processJobFitCount([100, 80, 80], more, 260)).toBe(3);
    expect(processJobFitCount([100, 80, 80], more, 259.6)).toBe(3);
  });

  it("keeps room for \"+n\" and shows the most whole entries that fit beside it", () => {
    // 100 + 80 + 26 = 206 fits; 100 + 80 + 80 = 260 does not.
    expect(processJobFitCount([100, 80, 80], more, 230)).toBe(2);
    expect(processJobFitCount([100, 80, 80], more, 205)).toBe(1);
    expect(processJobFitCount([100, 80, 80, 80, 80, 80, 80], more, 390)).toBe(4);
  });

  it("always shows one entry, even when a single name is too long for the bar", () => {
    expect(processJobFitCount([400, 80], more, 120)).toBe(1);
    expect(processJobFitCount([400], more, 120)).toBe(1);
    expect(processJobFitCount([], more, 120)).toBe(0);
  });

  it("measures \"+n\" for the number it will show", () => {
    const wide = (rest: number) => rest >= 10 ? 34 : 26;
    const widths = [60, ...Array.from({ length: 11 }, () => 50)];
    // Nine entries leave three: "+3" (26 px) beside 460 px of entries.
    expect(processJobFitCount(widths, wide, 486)).toBe(9);
    expect(processJobFitCount(widths, wide, 485)).toBe(8);
  });
});

describe("row text", () => {
  it("strips only the host's Purpose prefix and only for commands", () => {
    expect(processJobDisplayTitle(processJob({ summary: "Purpose: Water the beds" }))).toBe("Water the beds");
    expect(processJobDisplayTitle(processJob({ summary: "Purpose: Purpose: twice" }))).toBe("Purpose: twice");
    expect(processJobDisplayTitle({ ...backgroundSubagentJob(), summary: "Purpose: plan" })).toBe("Purpose: plan");
    expect(processJobKind(processJob())).toBe("command");
    expect(processJobKind(backgroundSubagentJob())).toBe("agent");
  });

  it("previews a command's last output line, labelled, skipping the host's markers", () => {
    const preview = "… [earlier output omitted]\nSTDOUT:\nfetched 41\nfetched 42\nSTDERR:\n  retrying bed 7  \n";
    expect(processJobPreview(active("running", { output: { ...base.output, preview } }), NOW))
      .toEqual({ label: "Output", text: "retrying bed 7", mono: true });
    expect(processJobPreview(active("running", { output: { ...base.output, preview: "" } }), NOW))
      .toEqual({ label: "", text: "No output yet", mono: false });
    expect(processJobPreview(active("queued"), NOW)).toBeUndefined();
    expect(processJobPreview(processJob({ output: { ...base.output, preview: "(no output)" } }), NOW)).toBeUndefined();
    expect(processJobOutputIsEmpty("(no output)")).toBe(true);
    expect(processJobOutputIsEmpty("STDOUT:\nx")).toBe(false);
  });

  it("previews an agent's current call, its report, or a pending question", () => {
    const runningPreview = processJobPreview(backgroundSubagentJob(), NOW);
    expect(runningPreview?.label).toBe("Grep");
    expect(processJobPreview(backgroundSubagentJob(true), NOW)).toEqual({ label: "Report", text: "Synthetic report", mono: false });
    expect(processJobPreview(peer("succeeded", "awaiting_answer"), NOW))
      .toEqual({ label: "Asks", text: "Reserve the heirloom seeds now?", mono: false });
  });

  it("keeps the last eight call outcomes as categories, with words for them", () => {
    const outcomes = processJobCallOutcomes(backgroundSubagentJob());
    expect(outcomes).toHaveLength(8);
    expect(processJobCallOutcomesLabel(outcomes)).toBe("Last 8 tool calls: 7 complete, 1 running");
    expect(processJobCallOutcomesLabel(["failed"])).toBe("Last 1 tool call: 0 complete, 1 failed");
    expect(processJobCallOutcomes(processJob())).toEqual([]);
  });

  it("never calls a live question expired because of rounding", () => {
    expect(peerQuestionExpiryLabel("2026-07-17T10:00:59.000Z", NOW)).toBe("expires in <1 min");
    expect(peerQuestionExpiryLabel("2026-07-17T10:00:00.000Z", NOW)).toBe("past its expiry time");
    expect(peerQuestionExpiryLabel("2026-07-17T10:20:30.000Z", NOW)).toBe("expires in 20 min");
    expect(peerQuestionExpiryLabel("2026-07-17T12:05:00.000Z", NOW)).toBe("expires in 2 h 5 min");
    expect(peerQuestionExpiryLabel("not a date", NOW)).toBe("");
  });
});

it("keeps a terminal AskParent question current through reload and grouping without inventing receipt", () => {
  const base = backgroundSubagentJob(true);
  const job = { ...base, subagentQuestion: { question: "Which approach?" },
    wake: { ...base.wake, state: "pending", attempts: 1 } };
  const reloaded = JSON.parse(JSON.stringify(job)) as ProcessJobProjection;
  expect(processJobIsCurrent(reloaded, NOW)).toBe(true);
  expect(processJobDisplayState(reloaded, NOW).notes).toContain("Child question waiting for parent");
  expect(processJobStackCounts([reloaded], NOW).question).toBe(1);
  expect(processJobIsCurrent({ ...reloaded, wake: { ...reloaded.wake, state: "unknown" } }, NOW)).toBe(false);
  expect(processJobDisplayState({ ...reloaded, wake: { ...reloaded.wake, state: "unknown" } }, NOW).alerts)
    .toContain("wake outcome unknown · replay suppressed");
});
