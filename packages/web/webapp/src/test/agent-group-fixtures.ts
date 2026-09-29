import { processJob } from "./fixtures";
import type { MessagePart, ProcessJobProjection, ProcessJobState, WebMessage } from "../types";

/**
 * Synthetic agent-group fixtures: hand-written ids, purposes and messages for
 * detached subagent turns, peer jobs and the parent's calls that launched,
 * steered, stopped or closed them. No recorded session.
 */
type Internal = Extract<ProcessJobProjection, { kind: "internal" }>;
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;

const base = processJob();
const minutes = (value: number) => value * 60_000;
export const T0 = Date.parse("2026-07-17T09:00:00.000Z");
export const at = (minute: number) => new Date(T0 + minutes(minute)).toISOString();

/** One detached turn of `instanceId`, admitted at `minute`; settled when `durationMinutes` is given. */
export const agentTurn = (
  jobId: string,
  instanceId: string,
  minute: number,
  options: {
    readonly tool?: Internal["tool"];
    readonly state?: ProcessJobState;
    readonly summary?: string;
    readonly durationMinutes?: number;
    readonly threadId?: string;
    readonly extra?: Partial<Internal>;
  } = {},
): Internal => {
  const state = options.state ?? (options.durationMinutes === undefined ? "running" : "succeeded");
  const terminal = !["queued", "starting", "running"].includes(state);
  const thread = options.threadId ?? "thread";
  return {
    ...base,
    jobId,
    kind: "internal",
    tool: options.tool ?? "Agent",
    instanceId,
    childStillBusy: false,
    state,
    summary: options.summary ?? `Turn ${jobId}`,
    origin: { ...base.origin, conversationId: `web:${thread}`, historyBoundary: `web:${thread}` },
    timestamps: {
      admittedAt: at(minute),
      queueDeadlineAt: at(minute + 5),
      startedAt: at(minute),
      runtimeDeadlineAt: at(minute + 30),
      completedAt: terminal ? at(minute + (options.durationMinutes ?? 1)) : null,
    },
    output: { ...base.output, stdoutBytes: 0, stderrBytes: 0, preview: "", stdoutRef: null, stderrRef: null },
    wake: terminal ? base.wake : { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
    exitCode: state === "succeeded" ? 0 : state === "failed" ? 1 : null,
    durationMs: terminal ? minutes(options.durationMinutes ?? 1) : null,
    ...options.extra,
  } as Internal;
};

export const receiptFor = (job: ProcessJobProjection) => ({
  schema: "mono-agent.process-job-start-receipt.v1", jobId: job.jobId, tool: job.tool, state: "running", startedAt: job.timestamps.startedAt,
});

/** The Agent/AgentManage call that started `job`, carrying its canonical receipt. */
export const launchCall = (job: ProcessJobProjection, args: unknown, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: "tool-call", toolCallId: `call-${job.jobId}`, toolName: job.tool, status: "complete", args,
  structuredResult: receiptFor(job), ...extra,
});

export const manageCall = (toolCallId: string, args: Record<string, unknown>, result?: unknown, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: "tool-call", toolCallId, toolName: "AgentManage", status: "complete", args,
  ...(result === undefined ? {} : { result: typeof result === "string" ? result : JSON.stringify(result) }), ...extra,
});

export const parentMessage = (id: string, minute: number, parts: MessagePart[], threadId = "thread"): WebMessage => ({
  id, threadId, role: "assistant", status: "complete", createdAt: at(minute), updatedAt: at(minute),
  attachments: [], seq: 1, parts,
});
