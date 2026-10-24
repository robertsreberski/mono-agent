import type { NotifyDeliveryResult } from "../channels/types.js";
import type { DurableProcessJobRecord } from "./process-jobs-store.js";
import { projectProcessJob, PROCESS_JOB_CONVERSATION_BUSY_ATTEMPT_COUNTER_MAX, PROCESS_JOB_CONVERSATION_BUSY_MAX_AGE_MS, PROCESS_JOB_DESTINATION_UNAVAILABLE_ATTEMPTS } from "./process-jobs-store.js";
import type { ProcessJobProjection } from "@mono-agent/contracts";
import type { ProcessJobWakeInput } from "./types.js";
import type { SubagentSalvage } from "../subagents/subagent-salvage.js";
import { consumeSilentProcessJobWake } from "./process-jobs-context.js";
import { boundedSafeDiagnostic, processJobWakePrompt } from "./presentation.js";

export const MAX_WAKE_ATTEMPTS = 3;
const WAKE_RETRY_BASE_MS = 100;

export interface WakeAttempt {
  readonly record: DurableProcessJobRecord | undefined;
  readonly previousDelivery: { readonly attempts: number; readonly lastAttemptAt: string | null } | undefined;
}

export interface WakeDecision {
  readonly conversationBusy: boolean;
  readonly destinationUnavailable: boolean;
  readonly nextConversationBusyAttempts: number;
  readonly conversationBusySinceAt: string;
  readonly conversationBusyExhausted: boolean;
  readonly nextDestinationUnavailableAttempts: number;
  readonly destinationUnavailableExhausted: boolean;
  readonly safeRetry: boolean;
}

export interface ProcessJobWakeOperations {
  beginAttempt(jobId: string): Promise<WakeAttempt>;
  settleAttempt(jobId: string, attempt: WakeAttempt, result: NotifyDeliveryResult, decision: WakeDecision, silent: boolean): Promise<void>;
  readResultReference(record: DurableProcessJobRecord): Promise<string | undefined>;
  readSalvage(record: DurableProcessJobRecord): Promise<SubagentSalvage | undefined>;
  updateSurface(projection: ProcessJobProjection): Promise<void>;
  updateSurfaceById(jobId: string): Promise<void>;
  wake(input: ProcessJobWakeInput): Promise<NotifyDeliveryResult>;
  now(): Date;
  applyRetention(): Promise<void>;
  rearm(jobId: string): void;
  sleep(milliseconds: number): Promise<void>;
  isStopping(): boolean;
}

export async function deliverProcessJobWake(jobId: string, operations: ProcessJobWakeOperations): Promise<void> {
  for (;;) {
    const attemptSnapshot = await operations.beginAttempt(jobId);
    const { record } = attemptSnapshot;
    if (record === undefined) return;
    const projection = projectProcessJob(record);
    await operations.updateSurface(projection);
    const salvage = await operations.readSalvage(record);
    const resultReference = await operations.readResultReference(record);
    const result = await operations.wake({
      projection,
      prompt: processJobWakePrompt(projection, salvage, record.kind === "internal" && record.state === "interrupted"
        && record.subagentOwnership?.disposition?.continuity === "unknown" && record.subagentOwnership.owner.settlement !== "not_started", resultReference),
      conversationId: record.origin.replyToConversationId,
      channel: record.origin.channel,
      deliveryKey: record.wake.deliveryKey,
      chainDepth: record.chainDepth + 1,
      ...(record.wake.admission === undefined ? {} : { wakeRecovery: {
        version: 1 as const, token: record.wake.admission.token, notCrossed: record.wake.notCrossed ?? [],
      } }),
    }).catch((error: unknown): NotifyDeliveryResult => ({
      delivered: false,
      code: "process_job_wake_failed",
      reason: boundedSafeDiagnostic("Process-job wake failed."),
      retryable: false,
      ambiguous: true,
    }));
    const attempt = record.wake.attempts;
    const silent = consumeSilentProcessJobWake(record.wake.deliveryKey);
    const conversationBusy = !result.delivered
      && result.code === "conversation_busy"
      && result.retryable === true
      && result.ambiguous !== true;
    const destinationUnavailable = !result.delivered
      && result.code === "destination_channel_unavailable"
      && result.retryable === true
      && result.ambiguous !== true;
    const retryablePreDispatchRefusal = conversationBusy || destinationUnavailable;
    const busyObservedAt = operations.now();
    const nextConversationBusyAttempts = conversationBusy
      ? Math.min(
        (record.wake.conversationBusyAttempts ?? 0) + 1,
        PROCESS_JOB_CONVERSATION_BUSY_ATTEMPT_COUNTER_MAX,
      )
      : (record.wake.conversationBusyAttempts ?? 0);
    const conversationBusySinceAt = record.wake.conversationBusySinceAt ?? busyObservedAt.toISOString();
    const conversationBusyExhausted = conversationBusy
      && Date.parse(conversationBusySinceAt) + PROCESS_JOB_CONVERSATION_BUSY_MAX_AGE_MS
        <= busyObservedAt.getTime();
    const nextDestinationUnavailableAttempts = (record.wake.destinationUnavailableAttempts ?? 0)
      + (destinationUnavailable ? 1 : 0);
    const destinationUnavailableExhausted = destinationUnavailable
      && nextDestinationUnavailableAttempts >= PROCESS_JOB_DESTINATION_UNAVAILABLE_ATTEMPTS;
    const safeRetry = !result.delivered
      && !retryablePreDispatchRefusal
      && result.retryable === true
      && result.ambiguous !== true
      && attempt < MAX_WAKE_ATTEMPTS;
    await operations.settleAttempt(jobId, attemptSnapshot, result, { conversationBusy, destinationUnavailable, nextConversationBusyAttempts, conversationBusySinceAt, conversationBusyExhausted, nextDestinationUnavailableAttempts, destinationUnavailableExhausted, safeRetry }, silent);
    await operations.updateSurfaceById(jobId);
    const wakeSettled = result.delivered || silent
      || conversationBusyExhausted
      || destinationUnavailableExhausted
      || (!retryablePreDispatchRefusal && !safeRetry);
    if (wakeSettled) {
      await operations.applyRetention();
    }
    if (silent) return;
    if ((conversationBusy && !conversationBusyExhausted)
      || (destinationUnavailable && !destinationUnavailableExhausted)) {
      operations.rearm(jobId);
      return;
    }
    if (!safeRetry) return;
    await operations.sleep(WAKE_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
    if (operations.isStopping()) return;
  }
}
