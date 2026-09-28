// Fictional background jobs for the shelf stories: a garden, a seed catalog and
// a greenhouse. Every projection is state-correct (no exit code on running
// work, no finish stamp before a job ends) and its stamps hang off page load so
// elapsed figures read like real work. The `example` origin means no story
// card ever polls.
import { processJob } from "../test/fixtures";
import type { ProcessJobPresentationEntry } from "../process-job-presentation";
import type { ProcessJobProjection, ProcessJobState, ProcessJobSubagentProgress } from "../types";

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
export const subagentDone = settledJob("job-agent-done", "succeeded", "Draft the spring planting plan", 512_000, { ...agentBase, output: silent,
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
