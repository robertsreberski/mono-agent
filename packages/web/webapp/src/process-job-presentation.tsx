import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  mergeProcessJobProjection,
  processJobThreadId,
  TERMINAL_PROCESS_JOB_STATES,
} from "./components/ProcessJob";
import { shouldShowMessageRunAttribution } from "./components/RunAttribution";
import type { MessagePart, ProcessJobProjection, WebMessage } from "./types";

export type ProcessJobPartValue = Extract<MessagePart, { type: "process-job" }>;

export interface ProcessJobPresentationEntry {
  readonly messageId: string;
  readonly part: ProcessJobPartValue;
}

export interface ProcessJobPresentation {
  readonly messages: readonly WebMessage[];
  readonly jobs: readonly ProcessJobPresentationEntry[];
  readonly eventsByMessageId: ReadonlyMap<string, readonly ProcessJobActivityEvent[]>;
  readonly jobsById: ReadonlyMap<string, ProcessJobProjection>;
}

export interface ProcessJobStartReceipt {
  readonly schema: "mono-agent.process-job-start-receipt.v1";
  readonly jobId: string;
  readonly tool: "Exec" | "Bash";
  readonly state: "queued" | "starting" | "running";
  readonly startedAt: string | null;
  readonly maxRuntimeMs?: number;
}

export interface ProcessJobActivityEvent {
  readonly schema: "mono-agent.process-job-activity-event.v1";
  readonly id: string;
  readonly toolCallId: string;
  readonly jobId: string;
  readonly tool: "Exec" | "Bash";
  readonly summary: string;
  readonly phase: "started" | "terminal";
  readonly state: ProcessJobProjection["state"];
  readonly occurredAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
}

export const processJobTerminalEvent = (
  job: ProcessJobProjection,
  toolCallId: string,
): ProcessJobActivityEvent => ({
  schema: "mono-agent.process-job-activity-event.v1",
  id: `process-job:${job.jobId}:terminal`,
  toolCallId,
  jobId: job.jobId,
  tool: job.tool,
  summary: job.summary,
  phase: "terminal",
  state: job.state,
  ...(job.timestamps.completedAt === null ? {} : { occurredAt: job.timestamps.completedAt }),
  ...(job.durationMs === null ? {} : { durationMs: job.durationMs }),
  ...(job.exitCode === null ? {} : { exitCode: job.exitCode }),
  ...(job.signal === null ? {} : { signal: job.signal }),
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const canonicalIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/** Parse only the canonical host receipt on its containing Exec/Bash call. */
export const parseProcessJobStartReceipt = (
  value: unknown,
  containingTool: string,
): ProcessJobStartReceipt | undefined => {
  if (!isPlainRecord(value)) return undefined;
  try {
    const keys = Object.keys(value);
    const allowed = ["schema", "jobId", "tool", "state", "startedAt", "maxRuntimeMs"];
    const required = allowed.slice(0, 5);
    if (!required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || keys.some((key) => !allowed.includes(key))
      || keys.length !== required.length + (Object.prototype.hasOwnProperty.call(value, "maxRuntimeMs") ? 1 : 0)
      || value.schema !== "mono-agent.process-job-start-receipt.v1"
      || (value.tool !== "Exec" && value.tool !== "Bash")
      || value.tool !== containingTool
      || typeof value.jobId !== "string"
      || value.jobId.trim().length === 0
      || value.jobId.length > 256
      || (value.state !== "queued" && value.state !== "starting" && value.state !== "running")
      || (value.startedAt !== null && !canonicalIsoTimestamp(value.startedAt))
      || (Object.prototype.hasOwnProperty.call(value, "maxRuntimeMs")
        && (!Number.isSafeInteger(value.maxRuntimeMs) || Number(value.maxRuntimeMs) <= 0))) return undefined;
    return value as unknown as ProcessJobStartReceipt;
  } catch {
    return undefined;
  }
};

export const isContextCompactionPart = (
  part: Extract<MessagePart, { type: "telemetry" }>,
): boolean => {
  if (part.event === "context_compaction") return true;
  let current = part.data;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.kind === "context_compaction" || record.type === "context_compaction") return true;
    current = record.data;
  }
  return false;
};

export const isAssistantMessageBoundaryPart = (
  part: Extract<MessagePart, { type: "telemetry" }>,
): boolean => {
  let current = part.data;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    // context_usage was the only reliable message-end marker retained by older
    // Pi runs. Keep it as a read-time compatibility boundary; new runs carry
    // the explicit content-free marker even when usage is unavailable.
    if (record.kind === "assistant_message_boundary" || record.kind === "context_usage") return true;
    current = record.data;
  }
  return false;
};

const partHasTranscriptPresentation = (part: MessagePart): boolean => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.trim().length > 0;
    case "telemetry":
      return part.event === "cron_run" || isContextCompactionPart(part);
    case "process-job":
      return false;
    case "process-job-wake":
      return true;
    case "steer":
      return true;
    case "cron-reply-context":
      return true;
    case "tool-call":
    case "subagent":
    case "monitor-activity":
    case "error":
    case "attachment":
    case "mcp_app":
    case "failure":
      return true;
  }
};

const messageHasTranscriptPresentation = (
  message: WebMessage,
  selectedModel: string | null | undefined,
): boolean => {
  if (message.role !== "assistant") return true;
  if (message.attachments.length > 0) return true;
  if (message.status === "failed" || message.status === "interrupted") {
    return true;
  }
  if (shouldShowMessageRunAttribution(message.attribution, selectedModel)) return true;
  return message.parts.some(partHasTranscriptPresentation);
};

const nonEmptyResponse = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

/**
 * Drop the standalone bubble of an applied steer while its inline marker is
 * loaded. Presentation-only: the rows, the search index, counts and quotes
 * keep resolving the user message. When the marker's assistant message is
 * paged out the standalone bubble stays, so the transcript degrades to
 * today's rendering rather than a hole. Marker presence alone decides: the
 * marker exists only for an applied steer, and the user row's `applied` flip
 * can arrive one write after the marker without briefly showing both.
 */
export const suppressInlineSteers = (
  messages: readonly WebMessage[],
): readonly WebMessage[] => {
  const steeredMessageIds = new Set(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "steer" ? [part.messageId] : [])));
  if (steeredMessageIds.size === 0) return messages;
  return messages.filter(
    (message) => message.role !== "user" || !steeredMessageIds.has(message.id),
  );
};

/**
 * A follow-up sent into a running turn is stored INSIDE that turn, and the
 * store orders every turn-bound user row before that turn's assistant row. So
 * the composer shows the new bubble at the bottom of the transcript, where it
 * was written, and the reconciled list then jumps it up to sit under the
 * message that opened the turn — above all the work it is steering, which
 * reads as if the operator had said it first.
 *
 * Keep it where it was sent: after the last loaded message of the turn it is
 * aimed at, which is the bottom of the transcript exactly while that turn is
 * the running one. Applied steers are rendered in place by their inline marker
 * instead (see {@link suppressInlineSteers}); the bubble that survives here is
 * the one still waiting, or one whose marker is not loaded, and it holds this
 * same position through every status change rather than jumping again.
 *
 * A live input whose turn has no other loaded message — paged out, or an
 * unparented row — keeps its server position, so the transcript degrades to
 * today's rendering rather than to a bubble floated somewhere arbitrary.
 */
export const orderLiveInputsAfterTheirTurn = (
  messages: readonly WebMessage[],
): readonly WebMessage[] => {
  /** The turn a still-standalone follow-up bubble belongs below, if any. */
  const steeredTurnId = (message: WebMessage): string | undefined =>
    message.role === "user" && message.liveInputStatus !== undefined ? message.turnId : undefined;
  if (!messages.some((message) => steeredTurnId(message) !== undefined)) return messages;

  const anchorByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.turnId === undefined || steeredTurnId(message) !== undefined) return;
    anchorByTurn.set(message.turnId, index);
  });

  const anchored = new Map<number, WebMessage[]>();
  const moved = new Set<string>();
  for (const message of messages) {
    const turnId = steeredTurnId(message);
    if (turnId === undefined) continue;
    const anchor = anchorByTurn.get(turnId);
    if (anchor === undefined) continue;
    anchored.set(anchor, [...(anchored.get(anchor) ?? []), message]);
    moved.add(message.id);
  }
  if (anchored.size === 0) return messages;

  const ordered: WebMessage[] = [];
  messages.forEach((message, index) => {
    if (!moved.has(message.id)) ordered.push(message);
    for (const live of anchored.get(index) ?? []) ordered.push(live);
  });
  return ordered;
};

/**
 * Split the currently loaded conversation into assistant-ui messages and one
 * stable chronological set of background jobs. Monitor shaping deliberately
 * runs before this function so a job remains a boundary between Monitor wakes.
 */
export const projectProcessJobPresentation = (
  messages: readonly WebMessage[],
  options: { readonly selectedModel?: string | null; readonly threadId?: string | null } = {},
): ProcessJobPresentation => {
  // The inline steer duplicates its user message; shape the transcript without
  // the duplicate before cards, events and visibility are derived from it, and
  // leave every surviving follow-up bubble below the turn it was sent into.
  const shaped = orderLiveInputsAfterTheirTurn(suppressInlineSteers(messages));
  const projectedMessages: WebMessage[] = [];
  const jobs: ProcessJobPresentationEntry[] = [];
  const jobIndexes = new Map<string, number>();
  const receiptCandidates = new Map<string, Map<string, {
    readonly messageId: string;
    readonly toolCallId: string;
    readonly receipt: ProcessJobStartReceipt;
  }>>();
  const ambiguousReceipts = new Set<string>();
  const wakeJobIds = new Set(shaped.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "process-job-wake" ? [part.jobId] : [])));

  if (options.threadId !== undefined && options.threadId !== null) {
    for (const message of shaped) {
      if (message.role !== "assistant" || message.threadId !== options.threadId) continue;
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        const receipt = parseProcessJobStartReceipt(part.structuredResult, part.toolName);
        if (receipt === undefined) continue;
        const key = `${message.id}\0${part.toolCallId}\0${receipt.jobId}`;
        const candidates = receiptCandidates.get(receipt.jobId) ?? new Map();
        const existing = candidates.get(key);
        if (existing !== undefined && JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
          ambiguousReceipts.add(receipt.jobId);
        } else if (existing === undefined) {
          candidates.set(key, { messageId: message.id, toolCallId: part.toolCallId, receipt });
          receiptCandidates.set(receipt.jobId, candidates);
        }
      }
    }
  }

  for (const message of shaped) {
    let containedJob = false;
    const remainingParts: MessagePart[] = [];

    for (const part of message.parts) {
      if (part.type !== "process-job") {
        remainingParts.push(part);
        continue;
      }
      containedJob = true;
      const existingIndex = jobIndexes.get(part.job.jobId);
      if (existingIndex === undefined) {
        jobIndexes.set(part.job.jobId, jobs.length);
        jobs.push({ messageId: message.id, part });
        continue;
      }

      const existing = jobs[existingIndex]!;
      const job = mergeProcessJobProjection(existing.part.job, part.job);
      const responseText = nonEmptyResponse(part.responseText)
        ?? nonEmptyResponse(existing.part.responseText);
      jobs[existingIndex] = {
        ...existing,
        part: {
          type: "process-job",
          job,
          ...(responseText === undefined ? {} : { responseText }),
        },
      };
    }

    if (!containedJob) {
      projectedMessages.push(message);
      continue;
    }

    const projected = { ...message, parts: remainingParts };
    if (messageHasTranscriptPresentation(projected, options.selectedModel)) {
      projectedMessages.push(projected);
    }
  }

  const eventsByMessageId = new Map<string, ProcessJobActivityEvent[]>();
  if (options.threadId !== undefined && options.threadId !== null) {
    for (const { part } of jobs) {
      const job = part.job;
      const candidates = receiptCandidates.get(job.jobId);
      if (ambiguousReceipts.has(job.jobId)
        || candidates === undefined
        || candidates.size !== 1
        || processJobThreadId(job) !== options.threadId) continue;
      const candidate = [...candidates.values()][0]!;
      if (candidate.receipt.tool !== job.tool) continue;

      const receiptStart = candidate.receipt.startedAt;
      const projectionStart = job.timestamps.startedAt;
      const startConflicts = receiptStart !== null && projectionStart !== null && receiptStart !== projectionStart;
      const startedAt = startConflicts ? undefined : receiptStart ?? projectionStart ?? undefined;
      const admittedAtMs = Date.parse(job.timestamps.admittedAt);
      const validStartedAt = startedAt !== undefined
        && canonicalIsoTimestamp(startedAt)
        && Date.parse(startedAt) >= admittedAtMs
        ? startedAt
        : undefined;
      const events: ProcessJobActivityEvent[] = [];
      if (validStartedAt !== undefined) {
        events.push({
          schema: "mono-agent.process-job-activity-event.v1",
          id: `process-job:${job.jobId}:started`,
          toolCallId: candidate.toolCallId,
          jobId: job.jobId,
          tool: job.tool,
          summary: job.summary,
          phase: "started",
          state: job.state,
          occurredAt: validStartedAt,
        });
      }
      if (TERMINAL_PROCESS_JOB_STATES.has(job.state) && !wakeJobIds.has(job.jobId)) {
        const completedAt = job.timestamps.completedAt;
        const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt);
        const validCompletedAt = completedAt !== null
          && canonicalIsoTimestamp(completedAt)
          && completedAtMs >= admittedAtMs
          && (validStartedAt === undefined || completedAtMs >= Date.parse(validStartedAt))
          ? completedAt
          : undefined;
        events.push({
          ...processJobTerminalEvent({
            ...job,
            timestamps: { ...job.timestamps, completedAt: validCompletedAt ?? null },
          }, candidate.toolCallId),
        });
      }
      if (events.length > 0) {
        const current = eventsByMessageId.get(candidate.messageId) ?? [];
        current.push(...events);
        eventsByMessageId.set(candidate.messageId, current);
      }
    }
  }

  return {
    messages: projectedMessages,
    jobs,
    eventsByMessageId,
    jobsById: new Map(jobs.map(({ part }) => [part.job.jobId, part.job])),
  };
};

interface ProcessJobPresentationContextValue {
  readonly threadId: string | null;
  readonly messages: readonly WebMessage[];
  readonly jobs: readonly ProcessJobPresentationEntry[];
  readonly historyIsBounded: boolean;
  readonly historyOpen: boolean;
  readonly setHistoryOpen: (open: boolean) => void;
}

const EMPTY_PRESENTATION: ProcessJobPresentationContextValue = {
  threadId: null,
  messages: [],
  jobs: [],
  historyIsBounded: false,
  historyOpen: false,
  setHistoryOpen: () => undefined,
};

const ProcessJobPresentationContext = createContext<ProcessJobPresentationContextValue>(EMPTY_PRESENTATION);

export function ProcessJobPresentationProvider({
  children,
  threadId,
  messages,
  jobs,
  historyIsBounded,
}: Pick<ProcessJobPresentation, "messages" | "jobs"> & {
  readonly children: ReactNode;
  readonly threadId: string | null;
  readonly historyIsBounded: boolean;
}) {
  // This provider sits above Chat's thread-keyed viewport. Only this disclosure
  // preference survives A -> B -> A; every card and poller still remounts with
  // the selected viewport and therefore keeps thread/job lifecycle isolation.
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const historyOpen = threadId === null ? false : disclosures.get(threadId) ?? false;

  const setHistoryOpen = useCallback((open: boolean) => {
    if (threadId === null) return;
    setDisclosures((current) => {
      const next = new Map(current);
      next.set(threadId, open);
      return next;
    });
  }, [threadId]);

  const value = useMemo<ProcessJobPresentationContextValue>(() => ({
    threadId,
    messages,
    jobs,
    historyIsBounded,
    historyOpen,
    setHistoryOpen,
  }), [historyIsBounded, historyOpen, jobs, messages, setHistoryOpen, threadId]);

  return (
    <ProcessJobPresentationContext.Provider value={value}>
      {children}
    </ProcessJobPresentationContext.Provider>
  );
}

export const useProcessJobPresentation = (): ProcessJobPresentationContextValue =>
  useContext(ProcessJobPresentationContext);
