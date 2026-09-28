import { describe, expect, it } from "vitest";

import { backgroundSubagentJob } from "../test/background-subagent-fixtures";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection, ProcessJobState } from "../types";
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
  processJobKind,
  processJobOutputIsEmpty,
  processJobPreview,
  processJobStackAnnouncement,
  processJobStackCounts,
  processJobStackSummaryParts,
} from "./process-job-display";

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
  it.each<[ProcessJobState, string, string, string]>([
    ["queued", "waiting", "clock", "Queued"],
    ["starting", "running", "ring", "Starting"],
    ["running", "running", "ring", "Running"],
    ["succeeded", "success", "check", "Done"],
    ["failed", "danger", "close", "Failed"],
    ["timed_out", "danger", "clock", "Timed out"],
    ["spawn_failed", "danger", "close", "Failed to start"],
    ["queue_expired", "danger", "clock", "Expired in queue"],
    ["interrupted", "danger", "close", "Interrupted"],
    ["cancelled", "neutral", "stop", "Cancelled"],
  ])("gives %s a tone, a distinct mark and a word", (state, tone, mark, word) => {
    const job = processJob({ state });
    expect(processJobDisplayState(job, NOW)).toMatchObject({ tone, mark, word });
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

  it("never lets a question inflate the active count", () => {
    const counts = processJobStackCounts([active("running"), active("queued"), peer("succeeded", "awaiting_answer"), processJob({ state: "failed" }), processJob()], NOW);
    expect(counts).toEqual({ active: 2, finished: 2, issues: 1, questions: 1 });
    expect(processJobStackSummaryParts(counts, false)).toEqual(["2 active", "2 finished", "1 issue", "1 question awaiting the agent"]);
    expect(processJobStackAnnouncement(counts, false)).toBe("Background jobs: 2 active, 2 finished, 1 issue, 1 question awaiting the agent.");
  });

  it("says when nothing is active and scopes a bounded count", () => {
    const counts = processJobStackCounts([processJob(), processJob({ state: "cancelled" })], NOW);
    expect(processJobStackSummaryParts(counts, true)).toEqual(["No active jobs", "2 finished shown"]);
    expect(processJobStackSummaryParts({ active: 0, finished: 0, issues: 2, questions: 2 }, false))
      .toEqual(["No active jobs", "2 issues", "2 questions awaiting the agent"]);
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
