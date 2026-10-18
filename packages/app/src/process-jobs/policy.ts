import type { ProcessJobErrorCode, ProcessJobState } from "@mono-agent/contracts";
import type { ProcessJobProcessResult } from "@mono-agent/turn/host/types";
import { PROCESS_JOBS_CAPS, type ProcessJobsSettings } from "./process-jobs-config.js";
import { isTerminalProcessJobState, isProcessJobOriginRecord, type DurableProcessJobRecord, type ProcessJobOriginRecord } from "./process-jobs-store.js";
import { hasSubagentObligation } from "../subagents/subagent-execution-ownership.js";
import { ProcessJobServiceError } from "./errors.js";
import { boundedSafeDiagnostic } from "./presentation.js";
import { isInternal, type ServiceStartRequest } from "./types.js";

export const MAX_IN_MEMORY_RECORDS = PROCESS_JOBS_CAPS.retention.maxRecords
  + PROCESS_JOBS_CAPS.maxQueued
  + PROCESS_JOBS_CAPS.maxConcurrent;

function occupiesRunningSlot(record: DurableProcessJobRecord): boolean {
  return record.state === "starting" || record.state === "running"
    || (isTerminalProcessJobState(record.state) && hasSubagentObligation(record));
}

export function conversationSlotAvailable(records: readonly DurableProcessJobRecord[], candidate: DurableProcessJobRecord, settings: ProcessJobsSettings): boolean {
  const running = records.filter((record) => occupiesRunningSlot(record)
    && record.origin.normalizedReplyTarget === candidate.origin.normalizedReplyTarget);
  // A nested launch must not wait for its own running ancestor to release a slot.
  // Chain-depth and global concurrency/queue limits still bound that exemption.
  return running.length < settings.maxActivePerConversation || (candidate.chainDepth > 0
    && running.some((record) => record.chainDepth < candidate.chainDepth));
}

export function enforceAdmission(records: readonly DurableProcessJobRecord[], normalizedReplyTarget: string, chainDepth: number, settings: ProcessJobsSettings): void {
  const outstandingWakes = records.filter((record) => record.wake.state === "pending").length;
  if (outstandingWakes >= pendingWakeCap(settings)) throw new ProcessJobServiceError("process_job_capacity", undefined,
    { occupancy: outstandingWakes, limit: pendingWakeCap(settings), limitKey: "processJobs.pendingWakeCap" });
  const queued = records.filter((record) => record.state === "queued").length;
  // A full conversation may queue even when global slots remain available.
  if (queued >= settings.maxQueued) {
    const running = records.filter(occupiesRunningSlot);
    const conversation = running.filter((record) => record.origin.normalizedReplyTarget === normalizedReplyTarget);
    const hasSlot = conversation.length < settings.maxActivePerConversation
      || (chainDepth > 0 && conversation.some((record) => record.chainDepth < chainDepth));
    if (running.length >= settings.maxConcurrent || !hasSlot
      || records.some((record) => record.state === "queued" && conversationSlotAvailable(records, record, settings))) throw new ProcessJobServiceError("process_job_queue_full", undefined,
        { occupancy: queued, limit: settings.maxQueued, limitKey: "processJobs.maxQueued",
          ...(!hasSlot ? { conversationOccupancy: conversation.length, conversationLimit: settings.maxActivePerConversation } : {}) });
  }
}

export function pendingWakeCap(settings: ProcessJobsSettings): number {
  return settings.retention.maxRecords + settings.maxConcurrent + settings.maxQueued;
}

export function boundedNewestRecords(
  records: readonly DurableProcessJobRecord[],
): readonly DurableProcessJobRecord[] {
  const sorted = [...records].sort((left, right) =>
    right.admittedAt.localeCompare(left.admittedAt) || left.jobId.localeCompare(right.jobId));
  if (sorted.length <= MAX_IN_MEMORY_RECORDS) return sorted;

  const active = sorted.filter((record) => !isTerminalProcessJobState(record.state) || hasSubagentObligation(record));
  if (active.length > MAX_IN_MEMORY_RECORDS) throw new ProcessJobServiceError("process_job_store_error", "Unresolved ownership exceeds the bounded snapshot capacity.");
  if (active.length === MAX_IN_MEMORY_RECORDS) return active;

  let terminalSlots = MAX_IN_MEMORY_RECORDS - active.length;
  return sorted.filter((record) => {
    if (!isTerminalProcessJobState(record.state) || hasSubagentObligation(record)) return true;
    if (terminalSlots === 0) return false;
    terminalSlots -= 1;
    return true;
  });
}

export function terminalFromResult(
  record: Readonly<DurableProcessJobRecord>,
  result: ProcessJobProcessResult,
  cleanupError: unknown,
  artifactError: unknown,
): {
  readonly state: Extract<ProcessJobState, "succeeded" | "failed" | "timed_out" | "cancelled" | "spawn_failed">;
  readonly code?: ProcessJobErrorCode;
  readonly message?: string;
} {
  const artifactFailure = artifactError === undefined
    ? ""
    : ` Output artifact publication failed: ${boundedSafeDiagnostic("unknown artifact failure")}`;
  const cleanupFailure = cleanupError === undefined
    ? ""
    : ` Sandbox cleanup failed or was withheld: ${boundedSafeDiagnostic("unknown cleanup failure")}`;
  const operationalCode = cleanupError !== undefined
    ? "process_job_cleanup_incomplete"
    : artifactError !== undefined
      ? "process_job_store_error"
      : undefined;
  if (record.cancelRequested || result.aborted) {
    return {
      state: "cancelled",
      code: operationalCode ?? "process_job_cancelled",
      message: `Process job was cancelled.${artifactFailure}${cleanupFailure}`,
    };
  }
  if (result.timedOut) {
    return {
      state: "timed_out",
      code: operationalCode ?? "process_job_timeout",
      message: `Process job exceeded its maximum runtime.${artifactFailure}${cleanupFailure}`,
    };
  }
  if (result.spawnError !== null) {
    return {
      state: "spawn_failed",
      code: operationalCode ?? "process_job_spawn_failed",
      message: `${boundedSafeDiagnostic("Process spawn failed.")}${artifactFailure}${cleanupFailure}`,
    };
  }
  if (operationalCode !== undefined) {
    return {
      state: "failed",
      code: operationalCode,
      message: `${artifactFailure}${cleanupFailure}`.trim(),
    };
  }
  if (result.code === 0 && result.signal === null && !result.bufferExceeded) return { state: "succeeded" };
  return {
    state: "failed",
    code: "process_job_failed",
    message: result.bufferExceeded
      ? "Process output exceeded the configured byte limit."
      : result.signal === null
        ? `Process exited with code ${String(result.code)}.`
        : `Process exited after signal ${result.signal}.`,
  };
}

function isWakeCapableOrigin(origin: ProcessJobOriginRecord): boolean {
  return origin.replyToConversationId.startsWith(`${origin.channel}:`)
    && (origin.channel !== "web" || origin.replyToConversationId !== "web:new");
}

export function assertAvailable(origin: ProcessJobOriginRecord, chainDepth: number, request: Readonly<ServiceStartRequest>, settings: ProcessJobsSettings, stopping: boolean, storageOperational: boolean): void {
  if (stopping) {
    throw new ProcessJobServiceError("process_job_controller_unavailable", "Process-job controller is stopping.");
  }
  if (!storageOperational) {
    throw new ProcessJobServiceError(
      "process_job_store_error",
      "Process-job storage is degraded after a terminal persistence failure; restart recovery is required.",
    );
  }
  if (!isProcessJobOriginRecord(origin) || !isWakeCapableOrigin(origin)) {
    throw new ProcessJobServiceError(
      "background_unsupported_channel",
      `Background process jobs cannot wake origin channel ${origin.channel}.`,
    );
  }
  if (!Number.isSafeInteger(chainDepth) || chainDepth < 0 || chainDepth >= settings.maxChainDepth) {
    throw new ProcessJobServiceError(
      "process_job_chain_depth_exceeded",
      `Process-job chain depth cannot exceed ${String(settings.maxChainDepth)}.`,
    );
  }
  if ((isInternal(request) ? !["Agent", "AgentManage", "PeerAgent"].includes(request.tool) || typeof request.run !== "function" || typeof request.cleanup !== "function"
    || !/^[a-f0-9-]{36}$/u.test(request.jobId) || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(request.instanceId)
    : (request.tool !== "Exec" && request.tool !== "Bash") || typeof request.launch !== "function")
    || (request.wakeOnCompletion !== undefined && typeof request.wakeOnCompletion !== "boolean")) {
    throw new ProcessJobServiceError("process_job_invalid", "Process-job launch request is invalid.");
  }
  if ((request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0))
    || (request.maxOutputChars !== undefined
      && (!Number.isSafeInteger(request.maxOutputChars) || request.maxOutputChars <= 0))) {
    throw new ProcessJobServiceError("process_job_invalid", "Process-job per-call limits must be positive safe integers.");
  }
}

export function processJobCapacity(records: readonly DurableProcessJobRecord[], normalizedReplyTarget: string, settings: ProcessJobsSettings, observedAt: string) {
  const active = records.filter(occupiesRunningSlot);
  const local = records.filter((record) => record.origin.normalizedReplyTarget === normalizedReplyTarget);
  const running = local.filter(occupiesRunningSlot).length;
  return {
    observedAt,
    perConversation: { running, maxActivePerConversation: settings.maxActivePerConversation,
      queued: local.filter((record) => record.state === "queued").length,
      availableRunningSlots: Math.max(0, settings.maxActivePerConversation - running) },
    global: { running: active.length, maxConcurrent: settings.maxConcurrent,
      queued: records.filter((record) => record.state === "queued").length, maxQueued: settings.maxQueued },
    maxQueueAgeMs: settings.maxQueueAgeMs,
  };
}
