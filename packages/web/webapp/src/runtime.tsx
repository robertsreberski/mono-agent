import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type CompleteAttachment,
  type ExternalThreadQueueAdapter,
  type QuoteInfo,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebUploadAttachmentAdapter } from "./attachment-adapter";
import { canSendInConsole, canUploadInConsole } from "./capabilities";
import { clusterToolCalls } from "./activity-clustering";
import { useConsoleStore, useUploadLimits } from "./console-store";
import type {
  MessagePart,
  ToolCall,
  ToolCallArtifact,
  WebAttachment,
  WebMessage,
  WebQuote,
} from "./types";

export { canSendInConsole, canUploadInConsole } from "./capabilities";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

interface ComposerRecovery {
  readonly id: number;
  readonly text: string;
  readonly attachments: readonly CompleteAttachment[];
  readonly quote?: WebQuote;
  readonly agentId: string | null;
  readonly threadId: string | null;
}

const mergeComposerText = (recovered: string, current: string): string => {
  if (!recovered) return current;
  if (!current || current === recovered) return recovered;
  return `${recovered}\n\n${current}`;
};

const canRestoreRecovery = (
  recovery: ComposerRecovery,
  selection: { readonly agentId: string | null; readonly threadId: string | null },
): boolean =>
  recovery.agentId === selection.agentId &&
  recovery.threadId === selection.threadId;

const quoteFromMetadata = (value: unknown): WebQuote | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const quote = value as Partial<QuoteInfo>;
  return typeof quote.text === "string" && quote.text.trim().length > 0 &&
    typeof quote.messageId === "string" && quote.messageId.trim().length > 0
    ? { text: quote.text, messageId: quote.messageId }
    : undefined;
};

const formatLiveInput = (text: string, quote: WebQuote | undefined): string => {
  if (quote === undefined) return text;
  const blockquote = quote.text
    .trim()
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");
  return `Quoted context:\n${blockquote}\n\n${text}`;
};

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value === undefined ? null : String(value);
};

const jsonObject = (value: unknown): JsonObject => {
  const normalized = jsonValue(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized;
  }
  return value === undefined ? {} : { value: normalized };
};

const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

const isContextCompactionPart = (part: Extract<MessagePart, { type: "telemetry" }>): boolean => {
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

type ConvertedPart = Exclude<ThreadMessageLike["content"], string>[number];

/**
 * Per-tool-call metadata the console renders but assistant-ui cannot type: the durable
 * history record, and an MCP tool's structuredContent. Both ride in the part's single
 * `artifact` slot, so they are wrapped rather than fighting over it. Returns undefined
 * when neither is present, keeping ordinary tool calls unchanged.
 */
const toolCallArtifact = (part: ToolCall): ToolCallArtifact | undefined =>
  part.history === undefined && part.structuredResult === undefined && part.executionMs === undefined
    ? undefined
    : {
        ...(part.history === undefined ? {} : { history: part.history }),
        ...(part.structuredResult === undefined ? {} : { structuredResult: part.structuredResult }),
        ...(part.executionMs === undefined ? {} : { executionMs: part.executionMs }),
      };

const convertPart = (part: MessagePart): ConvertedPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: jsonObject(part.args),
        argsText: jsonText(part.args),
        result: part.result,
        isError: part.status === "failed",
        // assistant-ui's tool-call part types no slot for our own per-call metadata,
        // so `artifact` carries an envelope of it. Omitted entirely when empty so a
        // plain tool call stays byte-identical to what it was before.
        ...(toolCallArtifact(part) === undefined ? {} : { artifact: toolCallArtifact(part) }),
      };
    case "subagent":
      // A delegation owns its children, so it cannot be an assistant-ui
      // tool-call part (those carry no nested calls). A named data part keeps
      // the whole group intact and lets it render as one disclosure.
      return { type: "data-subagent", data: jsonObject(part) };
    case "process-job":
      return { type: "data-process-job", data: jsonObject(part) };
    case "telemetry":
      // Most telemetry remains store-only for chrome such as ContextDisplay.
      // Compaction is user-visible activity, so expose that one canonical kind
      // as a named data part that can join reasoning/tools without leaking raw
      // provider diagnostics into the transcript.
      if (isContextCompactionPart(part)) {
        return { type: "data-context-compaction", data: jsonObject(part.data) };
      }
      return part.event === "cron_run"
        ? { type: "data-cron-run", data: jsonObject(part.data) }
        : null;
    case "error":
      return { type: "data-error", data: { code: part.code, message: part.message } };
    case "attachment":
      return { type: "data-reply-attachment", data: jsonObject(part) };
    case "mcp_app":
      return { type: "data-mcp-app", data: jsonObject(part) };
    case "failure":
      return { type: "data-reply-failure", data: jsonObject(part) };
  }
};

const completeAttachment = (attachment: WebAttachment): CompleteAttachment => {
  const contentUrl =
    attachment.contentUrl ??
    `/api/v1/uploads/${encodeURIComponent(attachment.id)}/content`;
  return {
    id: attachment.id,
    type: attachment.kind,
    name: attachment.name,
    contentType: attachment.contentType,
    status: { type: "complete" },
    content:
      attachment.kind === "image"
        ? [{ type: "image", image: contentUrl, filename: attachment.name }]
        : [
            {
              type: "file",
              data: contentUrl,
              mimeType: attachment.contentType,
              filename: attachment.name,
            },
          ],
  };
};

/**
 * Join runs of adjacent text into one part, because each one renders as its own
 * markdown root and would otherwise read as a paragraph break.
 *
 * Every message stored before the runtime stopped splitting text across
 * invisible telemetry carries those splits — frequently mid-word — so this also
 * repairs history rather than only protecting new turns. Concatenation is
 * verbatim: the parts were one continuous stream of deltas.
 */
const joinAdjacentText = (parts: readonly ConvertedPart[]): ConvertedPart[] =>
  parts.reduce<ConvertedPart[]>((joined, part) => {
    const previous = joined.at(-1);
    if (part.type === "text" && previous?.type === "text") {
      joined[joined.length - 1] = { ...previous, text: `${previous.text}${part.text}` };
      return joined;
    }
    joined.push(part);
    return joined;
  }, []);

/** The part types the transcript presents as activity rather than as the answer. */
const ACTIVITY_PART_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "tool-call",
  "data-subagent",
  "data-context-compaction",
  "data-process-job",
]);

const isBlankText = (part: ConvertedPart): boolean =>
  part.type === "text" && part.text.trim().length === 0;

/**
 * Lay a completed assistant turn out as one activity log over one answer.
 *
 * The renderer coalesces only ADJACENT activity parts, so prose the model writes
 * between tool calls splits a turn into alternating bands of answer and
 * activity — which is how a settled message ended up reading as four disclosures
 * wedged into three paragraphs. In a completed turn the last prose IS the answer
 * and everything before it is working-out, so interim prose becomes a `note`
 * (activity, like a tool row) and the whole run closes up.
 *
 * An error part is neither: it stays behind the answer so it cannot split the
 * log, and so does any data part a newer server sends that this bundle cannot
 * place. A turn that produced no prose at all is all activity.
 */
const foldSettledActivity = (parts: readonly ConvertedPart[]): ConvertedPart[] => {
  const visible = parts.filter((part) => !isBlankText(part));
  let answerIndex = -1;
  visible.forEach((part, index) => {
    if (part.type === "text") answerIndex = index;
  });
  if (answerIndex < 0) return visible;

  const activity: ConvertedPart[] = [];
  const afterAnswer: ConvertedPart[] = [];
  visible.forEach((part, index) => {
    if (index === answerIndex) return;
    if (part.type === "text") {
      activity.push({ type: "data-note", data: { text: part.text } });
      return;
    }
    (ACTIVITY_PART_TYPES.has(part.type) ? activity : afterAnswer).push(part);
  });
  return [...activity, visible[answerIndex]!, ...afterAnswer];
};

export const convertWebMessage = (message: WebMessage): ThreadMessageLike => {
  const converted = joinAdjacentText(message.parts.flatMap((part) => {
    // The service worker precaches this bundle, so a console left open across a
    // server upgrade can be handed a part type it does not know yet. `== null`
    // covers that `undefined` too: pushing it into content breaks the whole
    // transcript over one unrecognized row.
    const convertedPart = convertPart(part);
    return convertedPart == null ? [] : [convertedPart];
  }));
  // Only a COMPLETED turn is known to have an answer. Streaming is still
  // writing one, and a cancelled/failed/interrupted turn was stopped with none
  // (the store finalizes all three with no final text), so its last prose is
  // narration: folding would invert the chronology and dress that narration up
  // as the answer. Both keep arrival order.
  const ordered = message.role === "assistant" && message.status === "complete"
    ? foldSettledActivity(converted)
    : converted;
  // Clustering runs after folding so a settled turn and the streaming turn that
  // preceded it cluster the same runs; folding first would regroup the parts
  // underneath an already-built cluster.
  const content = clusterToolCalls(ordered) as typeof ordered;
  const status: ThreadMessageLike["status"] =
    message.status === "running"
      ? { type: "running" }
      : message.status === "complete"
        ? { type: "complete", reason: "stop" }
        : message.status === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : message.status === "failed"
            ? { type: "incomplete", reason: "error", error: "Agent run failed" }
            : { type: "incomplete", reason: "other", error: "Agent run was interrupted" };
  return {
    id: message.id,
    role: message.role,
    content,
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant" ? { status } : {}),
    attachments:
      message.role === "user" ? message.attachments.map(completeAttachment) : undefined,
    metadata: {
      custom: {
        turnId: message.turnId,
        updatedAt: message.updatedAt,
        ...(message.liveInputStatus === undefined ? {} : { liveInputStatus: message.liveInputStatus }),
        ...(message.quote === undefined ? {} : { quote: message.quote }),
      },
    },
  };
};

export function WebRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const limits = useUploadLimits();
  const [turnStarting, setTurnStarting] = useState(false);
  const [recoveries, setRecoveries] = useState<readonly ComposerRecovery[]>([]);
  const turnStartingRef = useRef(false);
  const recoveryIdRef = useRef(0);
  const selectionRef = useRef({
    agentId: store.selectedAgentId,
    threadId: store.selectedThreadId,
  });
  selectionRef.current = {
    agentId: store.selectedAgentId,
    threadId: store.selectedThreadId,
  };
  const limitKey = `${limits.maxFileBytes}:${limits.maxFilesPerTurn}:${limits.maxTurnBytes}:${limits.accept.join("|")}`;
  const attachmentAdapter = useMemo(
    () => new WebUploadAttachmentAdapter(limits),
    // The serialized key keeps in-flight adapter state across SSE bootstrap refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [limitKey],
  );
  const attachmentContext = `${store.selectedAgentId ?? "none"}:${store.selectedThreadId ?? "new"}`;
  const previousAttachmentContext = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousAttachmentContext.current !== null &&
      previousAttachmentContext.current !== attachmentContext
    ) {
      attachmentAdapter.disposeUnsent();
    }
    previousAttachmentContext.current = attachmentContext;
  }, [attachmentAdapter, attachmentContext]);
  useEffect(
    () => () => {
      attachmentAdapter.disposeUnsent({ includeRecovering: true });
    },
    [attachmentAdapter],
  );

  const queueRecovery = useCallback(
    (
      text: string,
      attachments: readonly CompleteAttachment[],
      quote: WebQuote | undefined,
      context: { readonly agentId: string | null; readonly threadId: string | null },
    ) => {
      attachmentAdapter.retainForRecovery(attachments);
      setRecoveries((current) => [
        ...current,
        {
          id: ++recoveryIdRef.current,
          text,
          attachments,
          ...(quote === undefined ? {} : { quote }),
          ...context,
        },
      ]);
    },
    [attachmentAdapter],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
          part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      const attachments: readonly CompleteAttachment[] = message.attachments ?? [];
      const quote = quoteFromMetadata(message.metadata?.custom?.quote);
      if (!text && attachments.length === 0) return;

      const submissionContext = {
        agentId: store.selectedAgentId,
        threadId: store.selectedThreadId,
      };
      if (store.selectedThread?.runState.status === "running" && attachments.length === 0) {
        void store.sendLiveInput(formatLiveInput(text, quote)).catch(() => {
          queueRecovery(text, [], quote, submissionContext);
        });
        return;
      }
      if (turnStartingRef.current) {
        queueRecovery(text, attachments, quote, submissionContext);
        return;
      }

      // The ref closes the gap before React publishes isSendDisabled. This must
      // happen before the first await so two same-tick composer sends are atomic.
      turnStartingRef.current = true;
      setTurnStarting(true);
      const attachmentIds = attachmentAdapter.beginSend(attachments);
      void (async () => {
        let resolvedThreadId = submissionContext.threadId;
        try {
          await store.sendTurn(
            {
              text: text || undefined,
              quote,
              attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
              model: store.model || undefined,
              effort: store.effort || undefined,
            },
            (threadId) => {
              resolvedThreadId = threadId;
              if (submissionContext.threadId === null) {
                setRecoveries((current) =>
                  current.map((recovery) =>
                    recovery.agentId === submissionContext.agentId && recovery.threadId === null
                      ? { ...recovery, threadId }
                      : recovery,
                  ),
                );
              }
            },
          );
          attachmentAdapter.completeSend(attachments);
        } catch {
          const recoveryContext = {
            agentId: submissionContext.agentId,
            threadId: resolvedThreadId,
          };
          // Selection state may not have committed yet after createThread.
          // Queue first, then let the post-render recovery effect compare the
          // exact resolved context and either rehydrate or clean it up.
          attachmentAdapter.recoverSend(attachments);
          queueRecovery(text, attachments, quote, recoveryContext);
          // sendTurn owns the visible action error. assistant-ui does not await
          // onNew, so containing the rejection here prevents an unhandled task.
        } finally {
          turnStartingRef.current = false;
          setTurnStarting(false);
        }
      })();
    },
    [attachmentAdapter, queueRecovery, store],
  );

  const threadList = useMemo(
    () => ({
      threadId: store.selectedThreadId ?? undefined,
      isLoading: store.loading,
      threads: store.threads
        .filter(
          (thread) => thread.sourceId === store.selectedAgentId && !thread.archivedAt,
        )
        .map((thread) => ({
          id: thread.id,
          remoteId: thread.id,
          status: "regular" as const,
          title: thread.title,
          custom: { runStatus: thread.runState.status, updatedAt: thread.updatedAt },
        })),
      archivedThreads: store.threads
        .filter(
          (thread) => thread.sourceId === store.selectedAgentId && Boolean(thread.archivedAt),
        )
        .map((thread) => ({
          id: thread.id,
          remoteId: thread.id,
          status: "archived" as const,
          title: thread.title,
          custom: { runStatus: thread.runState.status, updatedAt: thread.updatedAt },
        })),
      onSwitchToNewThread: async () => {
        if (!store.selectedAgent) return;
        await store.createThread().catch(() => undefined);
      },
      onSwitchToThread: (threadId: string) => store.selectThread(threadId),
      onRename: async (threadId: string, title: string) => {
        await store.renameThread(threadId, title).catch(() => undefined);
      },
      onArchive: async (threadId: string) => {
        await store.archiveThread(threadId).catch(() => undefined);
      },
      onUnarchive: async (threadId: string) => {
        await store.unarchiveThread(threadId).catch(() => undefined);
      },
    }),
    [store],
  );

  const selectedCanSend = canSendInConsole(
    store.connection,
    store.selectedAgent,
    store.selectedThread,
  );
  const selectedCanUpload = canUploadInConsole(
    store.connection,
    store.selectedAgent,
    store.selectedThread,
  );
  const isRunning = store.selectedThread?.runState.status === "running";
  const runningSubmissionQueue = useMemo<ExternalThreadQueueAdapter | undefined>(
    () => isRunning
      ? {
          // The web service owns persisted live-input and fallback queue state.
          // This bridge advertises that capability to assistant-ui so its native
          // Send primitive and Enter handling remain usable during a run.
          items: [],
          enqueue: (message) => { void onNew(message); },
          steer: () => undefined,
          remove: () => undefined,
          clear: () => undefined,
        }
      : undefined,
    [isRunning, onNew],
  );

  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: store.detail?.messages ?? [],
    convertMessage: convertWebMessage,
    isLoading: store.detailLoading,
    isRunning,
    isSendDisabled: !selectedCanSend || turnStarting,
    onNew,
    onCancel: store.cancelTurn,
    queue: runningSubmissionQueue,
    unstable_capabilities: { copy: true },
    adapters: {
      threadList,
      attachments: selectedCanUpload ? attachmentAdapter : undefined,
    },
  });

  const previousQuoteContext = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousQuoteContext.current !== null &&
      previousQuoteContext.current !== attachmentContext
    ) {
      runtime.thread.composer.setQuote(undefined);
    }
    previousQuoteContext.current = attachmentContext;
  }, [attachmentContext, runtime]);

  useEffect(() => {
    // Keep queued drafts protected until the admitted request resolves. For a
    // new conversation, sendTurn binds them to the exact created thread before
    // this effect rehydrates them, so the context transition cannot dispose the
    // upload or restore it into a different same-agent conversation.
    if (turnStarting) return;
    const recovery = recoveries[0];
    if (!recovery) return;

    if (!canRestoreRecovery(recovery, selectionRef.current)) {
      setRecoveries((current) => current.filter(({ id }) => id !== recovery.id));
      void attachmentAdapter.failSend(recovery.attachments);
      return;
    }

    const composer = runtime.thread.composer;
    const current = composer.getState();
    if (recovery.text) {
      composer.setText(mergeComposerText(recovery.text, current.text));
    }
    if (recovery.quote && !current.quote) {
      composer.setQuote(recovery.quote);
    }
    if (recovery.attachments.length > 0 && !selectedCanUpload) {
      // Reconnecting/offline stores deliberately remove the runtime adapter.
      // Restore text now, but keep staged files protected until this exact
      // conversation exposes attachment support again.
      if (recovery.text) {
        setRecoveries((items) =>
          items.map((item) => item.id === recovery.id ? { ...item, text: "" } : item),
        );
      }
      return;
    }
    setRecoveries((items) => items.filter(({ id }) => id !== recovery.id));
    const existingIds = new Set(current.attachments.map(({ id }) => id));
    void (async () => {
      try {
        await Promise.all(
          recovery.attachments
            .filter(({ id }) => !existingIds.has(id))
            .map((attachment) =>
              composer.addAttachment(
                attachmentAdapter.prepareRecoveryAttachment(attachment),
              ),
            ),
        );
        attachmentAdapter.releaseRecovery(recovery.attachments);
      } catch {
        await attachmentAdapter.failSend(recovery.attachments);
      }
    })();
  }, [attachmentAdapter, recoveries, runtime, selectedCanUpload, turnStarting]);

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
