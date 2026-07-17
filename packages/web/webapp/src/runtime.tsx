import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type CompleteAttachment,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebUploadAttachmentAdapter } from "./attachment-adapter";
import { canSendInConsole, canUploadInConsole } from "./capabilities";
import { useConsoleStore, useUploadLimits } from "./console-store";
import type {
  MessagePart,
  WebAttachment,
  WebMessage,
} from "./types";

export { canSendInConsole, canUploadInConsole } from "./capabilities";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

interface ComposerRecovery {
  readonly id: number;
  readonly text: string;
  readonly attachments: readonly CompleteAttachment[];
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

const convertPart = (
  part: MessagePart,
): Exclude<ThreadMessageLike["content"], string>[number] => {
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
      };
    case "telemetry":
      return { type: "data-telemetry", data: { event: part.event, data: part.data } };
    case "error":
      return { type: "data-error", data: { code: part.code, message: part.message } };
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

export const convertWebMessage = (message: WebMessage): ThreadMessageLike => {
  const content = message.parts.map(convertPart);
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
      custom: { turnId: message.turnId, updatedAt: message.updatedAt },
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
      context: { readonly agentId: string | null; readonly threadId: string | null },
    ) => {
      attachmentAdapter.retainForRecovery(attachments);
      setRecoveries((current) => [
        ...current,
        {
          id: ++recoveryIdRef.current,
          text,
          attachments,
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
      if (!text && attachments.length === 0) return;

      const submissionContext = {
        agentId: store.selectedAgentId,
        threadId: store.selectedThreadId,
      };
      if (turnStartingRef.current) {
        queueRecovery(text, attachments, submissionContext);
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
          queueRecovery(text, attachments, recoveryContext);
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

  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: store.detail?.messages ?? [],
    convertMessage: convertWebMessage,
    isLoading: store.detailLoading,
    isRunning: store.selectedThread?.runState.status === "running",
    isSendDisabled: !selectedCanSend || turnStarting,
    onNew,
    onCancel: store.cancelTurn,
    unstable_capabilities: { copy: true },
    adapters: {
      threadList,
      attachments: selectedCanUpload ? attachmentAdapter : undefined,
    },
  });

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
