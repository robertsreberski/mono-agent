import { agent, processJob, project, thread } from "../test/fixtures";
import type { ProcessJobProjection, ProcessJobState, TagSummary } from "../types";
export const researchTag: TagSummary = { id: "research", sourceId: "atlas", name: "Research", color: "green", createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z", revision: 1 };

export const atlas = agent("atlas", { label: "Atlas", pinned: true, updatedAt: "2026-01-15T10:00:00Z" });
export const grove = agent("grove", { label: "Grove", status: "offline", updatedAt: "2026-01-15T10:00:00Z" });
export const gardenThread = thread("garden-planner", "atlas", { title: "Garden planner", messageCount: 8, projectId: "garden", tagIds: [researchTag.id], createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z" });
export const runningThread = thread("seed-catalog", "atlas", { title: "Seed catalog", runState: { status: "running" }, messageCount: 3, createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z" });
export const gardenProject = project("garden", "atlas", { name: "Garden planner", color: "blue", conversationCount: 2, createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z" });
export const sampleJob = (state: ProcessJobState, output = "Garden plan ready\n"): Extract<ProcessJobProjection, { tool: "Exec" | "Bash" }> => {
  const baseline = processJob({
    state: state as "succeeded",
    summary: "Generate garden planning notes",
    origin: { conversationId: "example", channel: "web", runId: "example-run", historyBoundary: "example", bucket: null },
    output: { stdoutBytes: output.length, stderrBytes: 0, truncated: false, preview: output, stdoutRef: "examples/stdout.log", stderrRef: "examples/stderr.log" },
    timestamps: { admittedAt: "2026-01-15T10:00:00Z", startedAt: "2026-01-15T10:00:01Z", completedAt: "2026-01-15T10:00:03Z", queueDeadlineAt: "2026-01-15T10:05:00Z", runtimeDeadlineAt: "2026-01-15T10:30:00Z" },
    wake: { state: "delivered", attempts: 1, deliveryKey: "example", lastAttemptAt: "2026-01-15T10:00:04Z" },
    lastError: null,
  });
  return baseline as Extract<ProcessJobProjection, { tool: "Exec" | "Bash" }>;
};
export const jobPart = (state: ProcessJobState, output?: string) => ({ type: "process-job" as const, job: sampleJob(state, output) });
export const fallbackAttribution = {
  requested: { model: "atlas/standard", effort: "high" },
  attempted: { model: "grove/fast", effort: "medium" },
  executed: { model: "grove/fast", effort: "medium" },
  disposition: "fallback" as const,
  transitions: [{ from: "atlas/standard", to: "grove/fast", reason: "temporarily unavailable" }],
  retries: [],
};
