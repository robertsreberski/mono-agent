import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { processJobSupersedes, TERMINAL_PROCESS_JOB_STATES } from "./components/ProcessJob";
import { shouldShowMessageRunAttribution } from "./components/RunAttribution";
import type { MessagePart, WebMessage } from "./types";

export type ProcessJobPartValue = Extract<MessagePart, { type: "process-job" }>;

export interface ProcessJobPresentationEntry {
  readonly messageId: string;
  readonly part: ProcessJobPartValue;
}

export interface ProcessJobPresentation {
  readonly messages: readonly WebMessage[];
  readonly jobs: readonly ProcessJobPresentationEntry[];
}

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
 * Split the currently loaded conversation into assistant-ui messages and one
 * stable chronological set of background jobs. Monitor shaping deliberately
 * runs before this function so a job remains a boundary between Monitor wakes.
 */
export const projectProcessJobPresentation = (
  messages: readonly WebMessage[],
  selectedModel?: string | null,
): ProcessJobPresentation => {
  const projectedMessages: WebMessage[] = [];
  const jobs: ProcessJobPresentationEntry[] = [];
  const jobIndexes = new Map<string, number>();

  for (const message of messages) {
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
      const job = processJobSupersedes(existing.part.job, part.job)
        ? part.job
        : existing.part.job;
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
    if (messageHasTranscriptPresentation(projected, selectedModel)) {
      projectedMessages.push(projected);
    }
  }

  return { messages: projectedMessages, jobs };
};

interface DisclosureState {
  readonly open: boolean;
  readonly touched: boolean;
}

interface ProcessJobPresentationContextValue extends ProcessJobPresentation {
  readonly threadId: string | null;
  readonly historyIsBounded: boolean;
  readonly stackOpen: boolean;
  readonly setStackOpen: (open: boolean) => void;
}

const EMPTY_PRESENTATION: ProcessJobPresentationContextValue = {
  threadId: null,
  messages: [],
  jobs: [],
  historyIsBounded: false,
  stackOpen: false,
  setStackOpen: () => undefined,
};

const ProcessJobPresentationContext = createContext<ProcessJobPresentationContextValue>(EMPTY_PRESENTATION);

export function ProcessJobPresentationProvider({
  children,
  threadId,
  messages,
  jobs,
  historyIsBounded,
}: ProcessJobPresentation & {
  readonly children: ReactNode;
  readonly threadId: string | null;
  readonly historyIsBounded: boolean;
}) {
  // This provider sits above Chat's thread-keyed viewport. Only this disclosure
  // preference survives A -> B -> A; every card and poller still remounts with
  // the selected viewport and therefore keeps thread/job lifecycle isolation.
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, DisclosureState>>(
    () => new Map(),
  );
  const hasActiveJob = jobs.some(({ part }) => !TERMINAL_PROCESS_JOB_STATES.has(part.job.state));
  const disclosure = threadId === null ? undefined : disclosures.get(threadId);
  const stackOpen = disclosure?.open ?? hasActiveJob;

  useEffect(() => {
    if (threadId === null || jobs.length === 0) return;
    setDisclosures((current) => {
      const previous = current.get(threadId);
      if (previous !== undefined && (previous.touched || previous.open || !hasActiveJob)) return current;
      const next = new Map(current);
      next.set(threadId, { open: hasActiveJob, touched: false });
      return next;
    });
  }, [hasActiveJob, jobs.length, threadId]);

  const setStackOpen = useCallback((open: boolean) => {
    if (threadId === null) return;
    setDisclosures((current) => {
      const next = new Map(current);
      next.set(threadId, { open, touched: true });
      return next;
    });
  }, [threadId]);

  const value = useMemo<ProcessJobPresentationContextValue>(() => ({
    threadId,
    messages,
    jobs,
    historyIsBounded,
    stackOpen,
    setStackOpen,
  }), [historyIsBounded, jobs, messages, setStackOpen, stackOpen, threadId]);

  return (
    <ProcessJobPresentationContext.Provider value={value}>
      {children}
    </ProcessJobPresentationContext.Provider>
  );
}

export const useProcessJobPresentation = (): ProcessJobPresentationContextValue =>
  useContext(ProcessJobPresentationContext);
