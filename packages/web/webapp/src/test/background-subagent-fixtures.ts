import { processJob } from "./fixtures";
import type { ProcessJobProjection, ProcessJobSubagentProgress, WebMessage } from "../types";

/** Synthetic UI evidence: no prompts, provider data, or real report content. */
export function backgroundSubagentJob(finished = false, tool: "Agent" | "AgentSend" = "Agent"): Extract<ProcessJobProjection, { kind: "internal" }> {
  const base = processJob();
  const recent: ProcessJobSubagentProgress["recent"] = Array.from({ length: 45 }, (_, index) => ({
    id: `synthetic-call-${index}`,
    toolName: index < 6 ? "Bash" : index < 9 ? "Read" : ["Bash", "Read", "Grep"][index % 3]!,
    argsSummary: index < 6 ? "Checking the synthetic fixture" : `src/synthetic/module-${index}.ts`,
    status: index === 10 ? "failed" : !finished && (index === 5 || index === 44) ? "running" : "complete",
    ...(index === 44 && !finished ? {} : { executionMs: 12 + index }),
  }));
  return { ...base, jobId: "synthetic-background-agent", kind: "internal", tool, instanceId: "synthetic-helper", childStillBusy: false,
    summary: "Reviewing the synthetic fixture", state: finished ? "succeeded" : "running",
    origin: { ...base.origin, conversationId: "web:thread", historyBoundary: "web:thread" },
    timestamps: { ...base.timestamps, completedAt: finished ? base.timestamps.completedAt : null },
    durationMs: finished ? 2_000 : null, exitCode: finished ? 0 : null,
    output: { ...base.output, stdoutBytes: 0, stderrBytes: 0, preview: "", stdoutRef: null, stderrRef: null },
    wake: { ...base.wake, state: finished ? "delivered" : "pending", attempts: finished ? 1 : 0 },
    subagentProgress: { revision: finished ? 92 : 90, profile: "implementer", label: "Synthetic fixture review", toolCalls: 45, failedCalls: 1, recent,
      ...(finished ? { answerHead: "Synthetic report\n\nReviewed the fixture and completed the checks.\nNo real provider or user data was used.", answerTruncated: false } : {}) },
  };
}

export function backgroundSubagentMessages(job: Extract<ProcessJobProjection, { kind: "internal" }> = backgroundSubagentJob(true)): WebMessage[] {
  const base: WebMessage = { id: "synthetic-launch", threadId: "thread", role: "assistant", status: "complete",
    createdAt: job.timestamps.admittedAt, updatedAt: job.timestamps.completedAt ?? job.timestamps.admittedAt,
    attachments: [], parts: [
      { type: "tool-call", toolCallId: "before", toolName: "Read", status: "complete" },
      { type: "tool-call", toolCallId: "launch", toolName: job.tool, status: "complete", structuredResult: {
        schema: "mono-agent.process-job-start-receipt.v1", jobId: job.jobId, tool: job.tool, state: "running", startedAt: job.timestamps.startedAt,
      } },
      { type: "tool-call", toolCallId: "after", toolName: "Grep", status: "complete" },
      { type: "text", text: "Synthetic background review launched." },
    ] };
  return [base, { ...base, id: "synthetic-card", parts: [{ type: "process-job", job }] }];
}
