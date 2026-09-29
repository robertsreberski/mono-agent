// Fictional background jobs for the shelf stories: a garden, a seed catalog and
// a greenhouse. Every projection is state-correct (no exit code on running
// work, no finish stamp before a job ends) and its stamps hang off page load so
// elapsed figures read like real work. The `example` origin means no story
// card ever polls.
import { processJob } from "../test/fixtures";
import { collectProcessJobParentCalls, type ProcessJobPresentationEntry } from "../process-job-presentation";
import type { MessagePart, ProcessJobProjection, ProcessJobState, ProcessJobSubagentProgress, WebMessage } from "../types";

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1_000).toISOString();
const later = (seconds: number) => new Date(NOW + seconds * 1_000).toISOString();
const base = processJob();
const origin = { ...base.origin, conversationId: "example", historyBoundary: "example" };
const silent = { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null };
const out = (preview: string, bytes = preview.length, truncated = false) => ({ ...silent, stdoutBytes: bytes, preview, truncated });
const pendingWake = { ...base.wake, state: "pending" as const, attempts: 0, lastAttemptAt: null };

type Extra = Record<string, unknown>;
export const activeJob = (jobId: string, state: "queued" | "starting" | "running", summary: string, secondsAgo: number, extra: Extra = {}) =>
  processJob({
    jobId, state, summary, origin,
    timestamps: {
      admittedAt: ago(secondsAgo + 2), queueDeadlineAt: later(300),
      startedAt: state === "running" ? ago(secondsAgo) : null,
      runtimeDeadlineAt: state === "running" ? later(1_800 - secondsAgo) : null, completedAt: null,
    },
    output: silent, wake: pendingWake, exitCode: null, signal: null, durationMs: null, ...extra,
  } as never);
export const settledJob = (jobId: string, state: ProcessJobState, summary: string, durationMs: number | null, extra: Extra = {}) =>
  processJob({
    jobId, state, summary, origin,
    timestamps: { admittedAt: ago(3_600), queueDeadlineAt: ago(3_300), startedAt: ago(3_599),
      runtimeDeadlineAt: ago(1_800), completedAt: ago(3_599 - (durationMs ?? 0) / 1_000) },
    output: silent, exitCode: 0, signal: null, durationMs, ...extra,
  } as never);

export const queued = activeJob("job-queued", "queued", "Purpose: Rebuild the seed catalog search index", 40, { tool: "Bash" });
export const starting = activeJob("job-starting", "starting", "Purpose: Resize the garden photo set", 6);
export const runningTail = activeJob("job-running-tail", "running", "Purpose: Run the planting-calendar test suite", 252, { tool: "Bash",
  output: out("STDOUT:\n✓ beds/north.test.ts (12 tests)\n✓ beds/south.test.ts (9 tests)\n✓ beds/herbs.test.ts (4 tests)\nrunning calendar/frost-dates.test.ts", 4_310) });
export const runningSilent = activeJob("job-running-silent", "running", "Purpose: Download the regional frost-date tables", 1_020, { tool: "Bash" });
export const stopping = activeJob("job-stopping", "running", "Purpose: Re-render every planting map", 95, { tool: "Bash", cancelRequested: true,
  output: out("STDOUT:\nrendered map 14/40\nrendered map 15/40", 2_048) });
export const longSummary = activeJob("job-long", "running", "Purpose: Regenerate every raised-bed planting map for the community garden, re-run the companion-planting checks and publish the refreshed PDF bundle", 3_725, { tool: "Bash",
  output: out(`… [earlier output omitted]\nSTDOUT:\n${Array.from({ length: 40 }, (_, index) => `[${String(index + 21)}/60] bed-${String(index + 21)}: companion check passed, map rendered to maps/bed-${String(index + 21)}.svg`).join("\n")}`, 1_258_291, true) });

export const succeeded = settledJob("job-succeeded", "succeeded", "Purpose: Export the garden plan to PDF", 48_000, { tool: "Bash",
  output: out("STDOUT:\nWrote garden-plan.pdf (3 pages)", 612) });
export const failed = settledJob("job-failed", "failed", "Purpose: Lint the seed catalog", 9_400, { tool: "Bash", exitCode: 1,
  output: { ...out("STDOUT:\nChecking 212 catalog entries\nSTDERR:\nseed-catalog.csv:41 missing sowing month\nseed-catalog.csv:88 duplicate variety \"Early Girl\"\n2 problems found"), stderrBytes: 118 } });
export const timedOut = settledJob("job-timed-out", "timed_out", "Purpose: Crawl the community seed-swap listings", 1_800_000, { exitCode: null, signal: "SIGKILL",
  output: out("… [earlier output omitted]\nSTDOUT:\nfetched listing 811/2400\nfetched listing 812/2400", 88_064, true),
  lastError: { code: "process_job_timeout", message: "The process job exceeded its runtime limit." } });
export const cancelled = settledJob("job-cancelled", "cancelled", "Purpose: Re-render every planting map", 62_000, { tool: "Bash", exitCode: null, signal: "SIGTERM", cancelRequested: true,
  output: out("STDOUT:\nrendered map 31/40", 3_900) });
export const cancelledWake = settledJob("job-cancelled-wake", "cancelled", "Purpose: Rebuild the compost calendar", 12_000, { tool: "Bash", exitCode: null, signal: "SIGTERM", cancelRequested: true,
  wake: { ...base.wake, state: "failed", attempts: 3 }, lastError: { code: "process_job_wake_failed", message: "Process-job wake delivery failed." } });
export const spawnFailed = settledJob("job-spawn-failed", "spawn_failed", "Purpose: Compress last season's photos", null, { exitCode: null, output: out("(no output)", 0),
  timestamps: { admittedAt: ago(4_000), queueDeadlineAt: ago(3_700), startedAt: null, runtimeDeadlineAt: null, completedAt: ago(3_999) },
  lastError: { code: "process_job_spawn_failed", message: "The process job could not be launched." } });
export const queueExpired = settledJob("job-queue-expired", "queue_expired", "Purpose: Rebuild the watering schedule", null, { exitCode: null,
  timestamps: { admittedAt: ago(4_000), queueDeadlineAt: ago(3_700), startedAt: null, runtimeDeadlineAt: null, completedAt: ago(3_700) },
  lastError: { code: "process_job_queue_expired", message: "The process job expired before launch." } });
export const interrupted = settledJob("job-interrupted", "interrupted", "Purpose: Sync the compost log", 14_000, { tool: "Bash", exitCode: null,
  lastError: { code: "process_job_agent_restarted", message: "The process job was interrupted by an agent restart." } });
export const wakeFailed = settledJob("job-wake-failed", "succeeded", "Purpose: Summarise the harvest spreadsheet", 3_200, {
  output: out("STDOUT:\n42 rows summarised", 64), wake: { ...base.wake, state: "failed", attempts: 3 },
  lastError: { code: "process_job_wake_failed", message: "Process-job wake delivery failed." } });
export const redacted = settledJob("job-redacted", "succeeded", "Bash command (content redacted)", 700, { tool: "Bash", output: out("(no output)", 0) });

const calls: ProcessJobSubagentProgress["recent"] = [
  { id: "c1", toolName: "Read", argsSummary: "~/projects/garden-planner/beds/north.md", status: "complete", executionMs: 38 },
  { id: "c2", toolName: "Read", argsSummary: "~/projects/garden-planner/beds/south.md", status: "complete", executionMs: 31 },
  { id: "c3", toolName: "Read", argsSummary: "~/projects/garden-planner/seed-catalog.csv", status: "complete", executionMs: 44 },
  { id: "c4", toolName: "Grep", argsSummary: "frost date", status: "complete", executionMs: 120 },
  { id: "c5", toolName: "Bash", argsSummary: "pnpm test", workdir: "~/projects/garden-planner", status: "complete", executionMs: 8_200 },
  { id: "c6", toolName: "Bash", argsSummary: "pnpm test -- calendar", workdir: "~/projects/garden-planner", status: "failed", executionMs: 3_100 },
  { id: "c7", toolName: "Edit", argsSummary: "~/projects/garden-planner/calendar/spring.ts", status: "complete", executionMs: 22 },
  { id: "c8", toolName: "Bash", argsSummary: "pnpm test -- calendar", workdir: "~/projects/garden-planner", status: "running" },
];
const agentBase = { kind: "internal", tool: "Agent", instanceId: "garden-helper", childStillBusy: false } as const;
export const subagentRunning = activeJob("job-agent-running", "running", "Draft the spring planting plan", 388, { ...agentBase,
  subagentProgress: { revision: 8, profile: "researcher", route: { requested: { model: "atlas/standard", effort: "high" } }, toolCalls: 8, failedCalls: 1, recent: calls } });
export const subagentDone = settledJob("job-agent-done", "succeeded", "Draft the spring planting plan", 512_000, { ...agentBase, instanceId: "bed-planner", output: silent,
  subagentProgress: { revision: 12, profile: "researcher",
    route: { requested: { model: "atlas/standard", effort: "high" }, executed: { model: "atlas/standard", effort: "high" }, disposition: "requested" },
    toolCalls: 9, failedCalls: 1, costUsd: 0.42,
    recent: [...calls.slice(0, 7), { ...calls[7]!, status: "complete", executionMs: 6_400 }, { id: "c9", toolName: "Write", argsSummary: "~/projects/garden-planner/plans/spring.md", status: "complete", executionMs: 18 }],
    answerHead: "Spring planting plan\n\n- North bed: peas and spinach from mid-March\n- South bed: tomatoes after the last frost\n- Water seedlings every other morning", answerTruncated: false } });
export const subagentAsked = settledJob("job-agent-asked", "succeeded", "Choose the greenhouse heater schedule", 95_000, { ...agentBase, instanceId: "greenhouse", output: silent,
  subagentQuestion: { question: "Should the greenhouse heater run overnight while frost is forecast, or only before sunrise?", options: ["Overnight", "Only before sunrise"] },
  subagentProgress: { revision: 4, profile: "planner", toolCalls: 3, failedCalls: 0, costUsd: 0.06,
    recent: [{ id: "g1", toolName: "Read", argsSummary: "~/projects/greenhouse/heater.md", status: "complete", executionMs: 20 },
      { id: "g2", toolName: "Grep", argsSummary: "frost", status: "complete", executionMs: 90 },
      { id: "g3", toolName: "Read", argsSummary: "~/projects/greenhouse/forecast.csv", status: "complete", executionMs: 25 }] } });
export const childBusy = settledJob("job-agent-busy", "cancelled", "Tidy the greenhouse inventory", 41_000, { ...agentBase, instanceId: "greenhouse", childStillBusy: true, output: silent, exitCode: null, cancelRequested: true });

const peerForm = { type: "object", required: ["question_1"], properties: {
  question_1: { type: "string", title: "Heirloom tomatoes", description: "Reserve 40 packets now?",
    oneOf: [{ const: "reserve", title: "Reserve now" }, { const: "wait", title: "Wait for the vote" }, { const: "__mono_agent_custom__", title: "Other" }] },
  question_1_other: { type: "string", title: "Heirloom tomatoes — Other response" } } };
// The host persists a peer question when the PeerAgent job settles
// (process-jobs-service.ts complete.persist), so a pending question sits on a
// terminal job until it is answered, expires or is interrupted.
export const peerPending = settledJob("job-peer", "succeeded", "Ask the seed-bank agent about heirloom stock", 130_000, {
  kind: "internal", tool: "PeerAgent", instanceId: "seed-bank", childStillBusy: false, output: silent,
  peerQuestion: { state: "awaiting_answer", questionId: "3f6c9a2e-1b4d-4c8e-9a70-2d5e6f7a8b9c", peer: "seed-bank", thread: "spring-orders",
    message: "Before I place the spring order I need a decision.\nShould I reserve the heirloom tomato seeds now or wait for the member vote?",
    requestedSchema: peerForm, expiresAt: later(20 * 60) } });
/** A peer job that failed or was cancelled while its question is still open. */
export const peerFailedPending = { ...peerPending, jobId: "job-peer-failed", state: "failed" as const, exitCode: 1 } as ProcessJobProjection;
export const peerCancelledPending = { ...peerPending, jobId: "job-peer-cancelled", state: "cancelled" as const, cancelRequested: true } as ProcessJobProjection;
export const peerAnswered = settledJob("job-peer-answered", "succeeded", "Ask the seed-bank agent about bulb stock", 64_000, {
  kind: "internal", tool: "PeerAgent", instanceId: "seed-bank", childStillBusy: false, output: silent,
  peerQuestion: { state: "answered", questionId: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", peer: "seed-bank", thread: "autumn-orders",
    message: "Order tulip bulbs before the price change?", requestedSchema: peerForm, expiresAt: ago(600) } });

export type Job = ProcessJobProjection;

export const entry = (job: Job): ProcessJobPresentationEntry => ({ messageId: `message-${job.jobId}`, part: { type: "process-job", job } });

/** Many agents working at once, for the agents-vs-commands glance. */
export const agentJob = (jobId: string, summary: string, secondsAgo: number, instanceId = "garden-helper") =>
  activeJob(jobId, "running", summary, secondsAgo, { kind: "internal", tool: "Agent", instanceId, childStillBusy: false,
    subagentProgress: { revision: 3, profile: "researcher", toolCalls: 3, failedCalls: 0, recent: calls.slice(0, 2).concat({ ...calls[7]!, id: `${jobId}-run` }) } });

export const busyThread: readonly Job[] = [succeeded, failed, queued, runningTail, peerPending, subagentRunning, timedOut, subagentDone];
export const singleThread: readonly Job[] = [succeeded, runningTail];
export const idleThread: readonly Job[] = [succeeded, subagentDone, cancelled];
/** Nothing current: every settled outcome, for the History glyphs. */
export const finishedThread: readonly Job[] = [succeeded, subagentDone, failed, timedOut, cancelled, spawnFailed, queueExpired, interrupted, peerAnswered];
export const idleWithIssueThread: readonly Job[] = [succeeded, failed, subagentDone];
export const questionOnlyThread: readonly Job[] = [succeeded, peerPending];
export const agentsAndCommandsThread: readonly Job[] = [
  runningTail, subagentRunning, agentJob("job-agent-soil", "Compare soil test results across beds", 140, "soil-analyst"), runningSilent, queued,
];
export const allStatesThread: readonly Job[] = [queued, starting, runningTail, runningSilent, stopping, subagentRunning, peerPending,
  succeeded, failed, timedOut, cancelled, cancelledWake, spawnFailed, queueExpired, interrupted, redacted, wakeFailed, childBusy, subagentDone, subagentAsked, peerAnswered];
export const manyThread: readonly Job[] = [queued, starting, runningTail, runningSilent, stopping, subagentRunning, longSummary, peerPending, succeeded, failed];

// ── Agent groups: every detached child is one shelf row. Three subagent
// instances started by Agent and continued, steered, stopped or closed by
// AgentManage, a single-turn instance, a long-lived one, and a peer. The
// transcript messages carry the same launch receipts and arguments the
// console receives, so the parent's calls come from the real collector.
type Internal = Extract<ProcessJobProjection, { kind: "internal" }>;
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;

/** A turn that started `secondsAgo`: running when `durationS` is null, else settled. */
const turn = (jobId: string, state: ProcessJobState, summary: string, secondsAgo: number, durationS: number | null, extra: Extra) => processJob({
  jobId, state, summary, origin,
  timestamps: { admittedAt: ago(secondsAgo + 1), queueDeadlineAt: ago(secondsAgo - 300), startedAt: ago(secondsAgo),
    runtimeDeadlineAt: later(1_800 - secondsAgo), completedAt: durationS === null ? null : ago(secondsAgo - durationS) },
  output: silent, wake: durationS === null ? pendingWake : base.wake,
  exitCode: durationS === null || state !== "succeeded" ? null : 0, signal: null, durationMs: durationS === null ? null : durationS * 1_000, ...extra,
} as never) as Internal;
const step = (id: string, toolName: string, argsSummary: string, status: "running" | "complete" | "failed" = "complete", executionMs?: number) =>
  ({ id, toolName, argsSummary, status, ...(executionMs === undefined ? {} : { executionMs }) });
const plannedRoute = { requested: { model: "atlas/standard", effort: "high" } };
const ranRoute = { ...plannedRoute, executed: { model: "atlas/standard", effort: "high" }, disposition: "requested" as const };
const progressOf = (profile: string, recent: ProcessJobSubagentProgress["recent"], extra: Partial<ProcessJobSubagentProgress> = {}): ProcessJobSubagentProgress =>
  ({ revision: recent.length + 2, profile, route: plannedRoute, toolCalls: recent.length, failedCalls: recent.filter((call) => call.status === "failed").length, recent, ...extra });
const child = (tool: Internal["tool"], instanceId: string) => ({ kind: "internal", tool, instanceId, childStillBusy: false }) as const;

export const researcherBrief = settledTurn("job-research-1", "Research frost dates for the allotment", 2_880, 372, "Agent", {
  subagentProgress: progressOf("researcher", [
    step("r1", "Read", "~/garden/data/frost-tables.csv", "complete", 40), step("r2", "WebFetch", "county extension frost guide", "complete", 1_900),
    step("r3", "Grep", "last frost", "complete", 120), step("r4", "Write", "~/garden/notes/frost-dates.md", "complete", 22),
  ], { route: ranRoute, costUsd: 0.18,
    answerHead: "Frost dates (zone 7b)\n\nLast spring frost: 12–18 April (median 15 April)\nFirst autumn frost: 21–28 October", answerTruncated: false }),
});
function settledTurn(jobId: string, summary: string, secondsAgo: number, durationS: number, tool: Internal["tool"], extra: Extra, instanceId = "researcher-1", state: ProcessJobState = "succeeded") {
  return turn(jobId, state, summary, secondsAgo, durationS, { ...child(tool, instanceId), ...extra });
}
export const researcherCompare = settledTurn("job-research-2", "Compare frost dates with five years of weather", 1_800, 220, "AgentManage", {
  subagentProgress: progressOf("researcher", [
    step("r5", "Read", "~/garden/data/weather-2021-2025.csv", "complete", 60), step("r6", "Bash", "python compare_frost.py", "complete", 4_100),
    step("r7", "Write", "~/garden/notes/frost-compare.md", "complete", 18),
  ], { route: ranRoute, costUsd: 0.11,
    answerHead: "Five-year comparison\n\n2022 was the outlier: last frost on 29 April, two weeks late.", answerTruncated: false }),
});
export const researcherWindows = turn("job-research-3", "running", "Summarise the safest sowing windows", 64, null, { ...child("AgentManage", "researcher-1"),
  subagentProgress: progressOf("researcher", [
    step("r8", "Read", "~/garden/notes/frost-compare.md", "complete", 30), step("r9", "Read", "~/garden/data/sowing-guide.csv", "complete", 35),
    step("r10", "Write", "~/garden/plans/sowing-windows.md", "running"),
  ]) });

export const plannerOrder = settledTurn("job-planner-1", "Plan the spring seed order", 2_400, 245, "Agent", {
  subagentQuestion: { question: "Should the order include the heirloom tomatoes that need a greenhouse start, or only direct-sow varieties?", options: ["Include heirlooms", "Direct-sow only"] },
  subagentProgress: progressOf("planner", [step("p1", "Read", "~/garden/seed-catalog.csv", "complete", 50), step("p2", "Grep", "zone 7b", "complete", 90)],
    { route: ranRoute, costUsd: 0.07 }),
}, "seed-planner");
export const plannerPriced = settledTurn("job-planner-2", "Price the order with heirlooms", 1_500, 190, "AgentManage", {
  exitCode: 1, lastError: { code: "process_job_failed", message: "The process job failed." },
  subagentProgress: progressOf("planner", [step("p3", "Read", "~/garden/seed-catalog.csv", "complete", 44), step("p4", "Bash", "python price_order.py --limit 60", "failed", 2_100)],
    { route: ranRoute, costUsd: 0.04 }),
}, "seed-planner", "failed");
export const plannerRetry = turn("job-planner-3", "running", "Finish the seed order under €60", 720, null, { ...child("AgentManage", "seed-planner"),
  subagentProgress: progressOf("planner", [
    step("p5", "Edit", "~/garden/scripts/price_order.py", "complete", 20), step("p6", "Bash", "python price_order.py --limit 60", "complete", 1_900),
    step("p7", "Write", "~/garden/orders/spring-2026.csv", "running"),
  ]) });

export const soilStopped = settledTurn("job-soil-1", "Compare soil test results across beds", 1_560, 235, "Agent", {
  cancelRequested: true,
  subagentProgress: progressOf("analyst", [step("s1", "Read", "~/garden/soil/north.csv", "complete", 30), step("s2", "Bash", "python soil_summary.py", "complete", 3_300)],
    { route: ranRoute, costUsd: 0.05 }),
}, "soil-analyst", "cancelled");

export const stewardSingle = turn("job-steward-1", "running", "Log this week's compost temperatures", 180, null, { ...child("Agent", "compost-steward"),
  subagentProgress: progressOf("steward", [step("c1", "Read", "~/garden/compost/probe.csv", "complete", 30), step("c2", "Edit", "~/garden/compost/log.md", "running")]) });

const bankForm = { type: "object", required: ["question_1"], properties: {
  question_1: { type: "string", title: "Heirloom tomatoes", description: "Reserve 40 packets now?",
    oneOf: [{ const: "reserve", title: "Reserve now" }, { const: "wait", title: "Wait for the vote" }] } } };
export const bankAsk = settledTurn("4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f601", "Peer seed-bank thread spring-orders", 900, 130, "PeerAgent", {
  peerQuestion: { state: "answered", questionId: "5d2e8f10-3c4b-4a1e-9f2d-6b7c8d9e0f1a", peer: "seed-bank", thread: "spring-orders",
    message: "Which order window do you want: this week or next week?", requestedSchema: bankForm, expiresAt: ago(400) },
}, "seed-bank");
export const bankFollowUp = settledTurn("4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f602", "Peer seed-bank thread spring-orders question continuation", 420, 95, "PeerAgent", {
  peerQuestion: { state: "awaiting_answer", questionId: "3f6c9a2e-1b4d-4c8e-9a70-2d5e6f7a8b9c", peer: "seed-bank", thread: "spring-orders",
    message: "Should I reserve the heirloom tomato seeds now or wait for the member vote?", requestedSchema: bankForm, expiresAt: later(18 * 60) },
}, "seed-bank");

export const groupJobs: readonly Job[] = [
  researcherBrief, succeeded, plannerOrder, plannerPriced, soilStopped, researcherCompare, bankAsk, bankFollowUp, plannerRetry, runningTail, stewardSingle, researcherWindows,
];

const receipt = (job: ProcessJobProjection) => ({
  schema: "mono-agent.process-job-start-receipt.v1", jobId: job.jobId, tool: job.tool, state: "running", startedAt: job.timestamps.startedAt,
});
const launch = (job: ProcessJobProjection, args: Record<string, unknown>, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: "tool-call", toolCallId: `call-${job.jobId}`, toolName: job.tool, status: "complete", args, structuredResult: receipt(job),
  result: "Background subagent started. This conversation will wake on completion or AskParent.", ...extra,
});
const manage = (toolCallId: string, args: Record<string, unknown>, result: unknown): ToolCallPart => ({
  type: "tool-call", toolCallId, toolName: "AgentManage", status: "complete", args, result: typeof result === "string" ? result : JSON.stringify(result),
});
const peerCall = (toolCallId: string, args: Record<string, unknown>, job: ProcessJobProjection): ToolCallPart => ({
  type: "tool-call", toolCallId, toolName: "PeerAgent", status: "complete", args,
  result: [{ type: "text", text: JSON.stringify({ peer: "seed-bank", thread: "spring-orders", jobId: job.jobId, state: "started" }) }],
});
const parent = (id: string, secondsAgo: number, parts: MessagePart[]): WebMessage => ({
  id, threadId: "example", role: "assistant", status: "complete", createdAt: ago(secondsAgo), updatedAt: ago(secondsAgo),
  attachments: [], seq: 1, parts,
});

export const RESEARCH_BRIEF = "Find the average last-frost and first-frost dates for a zone 7b allotment near the river. Use the regional frost tables in ~/garden/data/frost-tables.csv and the county extension guide, and cite each source.\n\nAnswer with a short table: date range, confidence and source for each frost date. Flag anything that disagrees between the two sources rather than averaging it away, and say which one you trust more and why. Keep the answer under a page; I will ask follow-up questions.";
const PLANNER_BRIEF = "Plan the spring seed order for the four raised beds from the 2026 seed catalog (~/garden/seed-catalog.csv). Only choose varieties that suit a zone 7b allotment, list quantities per bed and total the cost.\n\nBed notes:\n- North bed: partial shade after 3 pm, heavy clay.\n- East bed: full sun, raised last autumn, fresh compost.\n- South bed: full sun, sandy, dries out fast.\n- West bed: shared with the herb spiral; keep anything tall to the back.";

export const groupMessages: readonly WebMessage[] = [
  parent("m1", 2_900, [{ type: "text", text: "I'll start a researcher on the frost dates." },
    launch(researcherBrief, { prompt: RESEARCH_BRIEF, name: "researcher", persist: true, background: true, description: researcherBrief.summary })]),
  parent("m2", 2_420, [launch(plannerOrder, { prompt: PLANNER_BRIEF, name: "planner", id: "seed-planner", persist: true, background: true, description: plannerOrder.summary },
    { argsTruncated: true, argsBytes: 5_214 })]),
  // A foreground follow-up: answered inside the conversation, no detached turn.
  parent("m3", 2_200, [{ type: "subagent", toolCallId: "call-research-ask", name: "researcher", status: "complete", calls: [],
    args: { id: "researcher-1", message: "Which of the two sources do you trust more for the April dates, and why?" },
    result: "The county guide: its stations sit on the river flats like the allotment." }]),
  parent("m4", 1_510, [launch(plannerPriced, { id: "seed-planner", message: "Include the heirloom tomatoes, but keep the whole order under €60.", background: true, description: plannerPriced.summary })]),
  parent("m5", 1_570, [launch(soilStopped, { prompt: "Compare the soil test results for all four beds (~/garden/soil/*.csv): pH, nitrogen, phosphorus, potassium and organic matter. Recommend amendments per bed for the spring.", name: "analyst", id: "soil-analyst", persist: true, background: true, description: soilStopped.summary })]),
  parent("m6", 1_460, [manage("call-soil-steer", { id: "soil-analyst", steer: "Skip the south bed; its sample is being re-tested this week." },
    { instanceId: "soil-analyst", jobId: "job-soil-1", status: "applied", applied: true, delivery: "consumed" })]),
  parent("m7", 1_330, [manage("call-soil-stop", { id: "soil-analyst", stop: true },
    { instanceId: "soil-analyst", jobId: "job-soil-1", status: "stopped", instanceStatus: "idle", turns: 1, disposition: "cancelled", stopRequested: true, childStillBusy: false, resumable: true })]),
  parent("m8", 1_300, [manage("call-soil-close", { id: "soil-analyst", close: true }, "<subagent: analyst · instance soil-analyst · turn 1 · closed>")]),
  parent("m9", 1_810, [launch(researcherCompare, { id: "researcher-1", message: "Also compare those dates with the last five years of local weather records and flag any year where the last frost came more than a week late.", background: true, description: researcherCompare.summary })]),
  parent("m10", 905, [peerCall("call-bank-1", { action: "send", peer: "seed-bank", thread: "spring-orders", message: "Ask whether the heirloom tomato packets can be reserved for the spring order.", background: true }, bankAsk)]),
  parent("m11", 425, [peerCall("call-bank-2", { action: "answer", peer: "seed-bank", thread: "spring-orders", questionId: "5d2e8f10-3c4b-4a1e-9f2d-6b7c8d9e0f1a", answers: { question_1: "next-week" }, background: true }, bankFollowUp)]),
  parent("m12", 725, [launch(plannerRetry, { id: "seed-planner", message: "The pricing script failed on the heirloom rows. Retry with the cached price list and keep the €60 limit.", background: true, description: plannerRetry.summary })]),
  parent("m13", 185, [launch(stewardSingle, { prompt: "Log this week's compost temperatures from ~/garden/compost/probe.csv and say whether the pile is heating.", name: "steward", id: "compost-steward", persist: true, background: true, description: stewardSingle.summary })]),
  parent("m14", 70, [launch(researcherWindows, { id: "researcher-1", message: "Good. Now summarise the three safest sowing windows for peas, broad beans and squash as a one-page table I can print and pin to the shed door.", background: true, description: researcherWindows.summary })]),
].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
export const groupParentCalls = collectProcessJobParentCalls(groupMessages, "example");

// ── A long-lived instance: six detached turns fold their older ones.
const STEWARD_ASKS = [
  ["Log compost temperatures", "Log this week's compost temperatures and say whether the pile is heating."],
  ["Turn the pile if it cooled", "Turn it if it stayed under 45 °C for three days, and add the turn to the log."],
  ["Suggest water after the turn", "Check the moisture notes and suggest how much water to add after the turn."],
  ["Recalculate the green/brown ratio", "Add the coffee-grounds delivery to the log and recalculate the green/brown ratio."],
  ["Summarise the month", "Summarise the month for the allotment newsletter in five bullet points."],
  ["Draft next month's compost plan", "Draft next month's compost plan, including when to start the second bay."],
] as const;
export const longLivedJobs: readonly Job[] = STEWARD_ASKS.map(([summary], index) => {
  const last = index === STEWARD_ASKS.length - 1;
  const secondsAgo = last ? 90 : (6 - index) * 3_600;
  const extra = { ...child(index === 0 ? "Agent" : "AgentManage", "compost-keeper"),
    subagentProgress: progressOf("steward", [step(`k${String(index)}a`, "Read", "~/garden/compost/log.md", "complete", 30),
      step(`k${String(index)}b`, "Edit", "~/garden/compost/log.md", last ? "running" : "complete", last ? undefined : 20)],
    last ? {} : { route: ranRoute, costUsd: 0.03, answerHead: `${summary}: done.` }) };
  return last ? turn(`job-keeper-${String(index)}`, "running", summary, secondsAgo, null, extra)
    : turn(`job-keeper-${String(index)}`, index === 2 ? "failed" : "succeeded", summary, secondsAgo, 140, { ...extra, ...(index === 2 ? { exitCode: 1 } : {}) });
});
const longLivedMessages: readonly WebMessage[] = longLivedJobs.map((job, index) => parent(`k${String(index)}`, index === STEWARD_ASKS.length - 1 ? 95 : (6 - index) * 3_600 + 5, [
  launch(job, index === 0
    ? { prompt: STEWARD_ASKS[0][1], name: "steward", id: "compost-keeper", persist: true, background: true, description: job.summary }
    : { id: "compost-keeper", message: STEWARD_ASKS[index]![1], background: true, description: job.summary }),
]));
export const longLivedParentCalls = collectProcessJobParentCalls(longLivedMessages, "example");

// ── One peer, several threads: the oldest thread still awaits an answer, so
// its question stays outside the fold, and every row names its thread.
const threadAsks = [
  ["spring-orders", "Ask whether the heirloom tomato packets can be reserved", 5_400, "Should I reserve the heirloom tomato seeds now or wait for the member vote?"],
  ["autumn-bulbs", "Ask how many tulip bulbs are left", 4_200, undefined],
  ["autumn-bulbs", "Confirm the tulip order", 3_000, undefined],
  ["winter-garlic", "Check the seed garlic stock", 600, undefined],
] as const;
export const peerThreadsJobs: readonly Job[] = threadAsks.map(([thread, summary, secondsAgo, question], index) =>
  settledTurn(`8a7b6c5d-4e3f-4a1b-9c2d-3e4f5a6b7c${String(index).padStart(2, "0")}`, summary, secondsAgo, 110, "PeerAgent", {
    ...(question === undefined ? {} : { peerQuestion: { state: "awaiting_answer", questionId: "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e", peer: "seed-bank", thread,
      message: question, requestedSchema: bankForm, expiresAt: later(25 * 60) } }),
  }, "seed-bank"));
const peerThreadsMessages: readonly WebMessage[] = peerThreadsJobs.map((job, index) => parent(`t${String(index)}`, threadAsks[index]![2] + 5, [
  { ...peerCall(`call-thread-${String(index)}`, { action: "send", peer: "seed-bank", thread: threadAsks[index]![0], message: threadAsks[index]![1], background: true }, job),
    result: [{ type: "text", text: JSON.stringify({ peer: "seed-bank", thread: threadAsks[index]![0], jobId: job.jobId, state: "started" }) }] },
]));
export const peerThreadsParentCalls = collectProcessJobParentCalls(peerThreadsMessages, "example");
