import { ThreadPrimitive } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConsoleStore } from "../console-store";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";
import { Composer } from "./Composer";
import { Icon } from "./Icon";

const runLabel: Record<string, string> = {
  idle: "Ready",
  running: "Working",
  complete: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

function ConversationTitle() {
  const { selectedThread, renameThread } = useConsoleStore();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(selectedThread?.title ?? "New conversation");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(selectedThread?.title ?? "New conversation");
    setEditing(false);
  }, [selectedThread?.id, selectedThread?.title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (!selectedThread) return;
    const next = title.trim();
    if (!next) {
      setTitle(selectedThread.title);
      return;
    }
    if (next !== selectedThread.title) {
      void renameThread(selectedThread.id, next).catch(() => undefined);
    }
  };

  if (editing && selectedThread) {
    return (
      <input
        ref={inputRef}
        className="title-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setTitle(selectedThread.title);
            setEditing(false);
          }
        }}
        maxLength={120}
        aria-label="Conversation title"
      />
    );
  }

  return (
    <button
      type="button"
      className="conversation-title"
      onClick={() => selectedThread && setEditing(true)}
      disabled={!selectedThread}
      title={selectedThread ? "Rename conversation" : undefined}
    >
      {selectedThread?.title ?? "New conversation"}
    </button>
  );
}

function ModelControls() {
  const {
    model,
    effort,
    modelOptions,
    effortOptions,
    setModel,
    setEffort,
    selectedThread,
    selectedAgent,
    detail,
  } = useConsoleStore();
  const disabled = selectedThread?.runState.status === "running";
  const toggleReasoning = selectedAgent?.modelOptions?.[model]?.reasoningMode === "toggle";
  const metrics = useMemo(() => {
    for (let messageIndex = (detail?.messages.length ?? 0) - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = detail?.messages[messageIndex];
      if (!message) continue;
      for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = message.parts[partIndex];
        if (part?.type !== "telemetry" || part.event !== "usage_update") continue;
        const data = part.data && typeof part.data === "object"
          ? part.data as Record<string, unknown>
          : {};
        const tokens = data.tokens && typeof data.tokens === "object"
          ? data.tokens as Record<string, unknown>
          : data;
        const input = finite(tokens.input ?? tokens.input_tokens ?? tokens.inputTokens);
        const output = finite(tokens.output ?? tokens.output_tokens ?? tokens.outputTokens);
        const cost = finite(data.cumulativeUsd ?? data.totalUsd ?? data.cost_usd);
        if (input === undefined && output === undefined && cost === undefined) return null;
        return { input, output, cost };
      }
    }
    return null;
  }, [detail?.messages]);
  return (
    <div className="model-controls" aria-label="Run settings">
      {metrics && (
        <span className="run-metrics" title="Latest turn usage">
          {metrics.input !== undefined && <span>↑{compactNumber(metrics.input)}</span>}
          {metrics.output !== undefined && <span>↓{compactNumber(metrics.output)}</span>}
          {metrics.cost !== undefined && <span>${metrics.cost.toFixed(metrics.cost < 0.01 ? 4 : 2)}</span>}
        </span>
      )}
      {modelOptions.length > 0 && (
        <label className="compact-select">
          <span className="sr-only">Model</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={disabled}>
            <option value="">Provider default</option>
            {modelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <Icon name="arrow-down" size={13} />
        </label>
      )}
      {effortOptions.length > 0 && (
        <label className="compact-select effort-select">
          <span className="sr-only">Reasoning effort</span>
          <select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={disabled}>
            <option value="">Provider default</option>
            {effortOptions.map((option) => (
              <option key={option} value={option}>
                {toggleReasoning
                  ? option === "none"
                    ? "thinking off"
                    : "thinking on"
                  : option}
              </option>
            ))}
          </select>
          <Icon name="arrow-down" size={13} />
        </label>
      )}
    </div>
  );
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const compactNumber = (value: number): string =>
  value >= 1_000_000
    ? `${Math.round((value / 1_000_000) * 10) / 10}m`
    : value >= 1_000
      ? `${Math.round((value / 1_000) * 10) / 10}k`
      : String(value);

function EmptyConversation() {
  const { selectedAgent, createThread, selectedThread } = useConsoleStore();
  return (
    <ThreadPrimitive.Empty>
      <div className="chat-empty">
        <div className="empty-orbit" aria-hidden="true">
          <span />
          <Icon name="spark" size={22} />
        </div>
        <span className="eyebrow">{selectedAgent?.label ?? "mono-agent"}</span>
        <h2>{selectedThread ? "What should we work on?" : "Start a new conversation"}</h2>
        <p>
          {selectedAgent
            ? "Messages, reasoning, tool calls, and files stay together in this conversation."
            : "No agents have been discovered yet. Start an agent and it will appear here automatically."}
        </p>
        {selectedAgent && !selectedThread && (
          <button
            type="button"
            className="primary-button"
            onClick={() => void createThread().catch(() => undefined)}
          >
            <Icon name="new" size={16} />
            New conversation
          </button>
        )}
      </div>
    </ThreadPrimitive.Empty>
  );
}

export function Chat({
  onOpenAgents,
  onOpenThreads,
}: {
  readonly onOpenAgents: () => void;
  readonly onOpenThreads: () => void;
}) {
  const {
    selectedAgent,
    selectedThread,
    connection,
    detailLoading,
    archiveThread,
    unarchiveThread,
  } = useConsoleStore();
  const runStatus = selectedThread?.runState.status;
  const runNeedsAttention =
    runStatus === "running" ||
    runStatus === "failed" ||
    runStatus === "cancelled" ||
    runStatus === "interrupted";
  const status =
    selectedAgent?.status === "offline"
      ? "Offline"
      : connection === "offline"
        ? "Browser offline"
        : connection === "reconnecting"
          ? "Reconnecting"
          : runNeedsAttention && runStatus
            ? runLabel[runStatus]
            : selectedAgent?.status === "degraded"
              ? "Degraded"
              : selectedThread
                ? runLabel[selectedThread.runState.status]
                : "Ready";
  const statusTone =
    status === "Ready" ? "ready" : status === "Working" ? "working" : status.toLowerCase();

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="mobile-navigation">
          <button type="button" className="icon-button" onClick={onOpenAgents} aria-label="Choose agent">
            <Icon name="agent" size={19} />
          </button>
          <button type="button" className="icon-button" onClick={onOpenThreads} aria-label="Open conversations">
            <Icon name="menu" size={19} />
          </button>
        </div>
        <div className="chat-title-block">
          <ConversationTitle />
          <span className={`chat-status is-${statusTone}`}>
            <i />
            {status}
          </span>
        </div>
        <div className="chat-header-actions">
          <ModelControls />
          {selectedThread && (
            <button
              type="button"
              className="icon-button header-archive"
              aria-label={selectedThread.archivedAt ? "Restore conversation" : "Archive conversation"}
              title={selectedThread.archivedAt ? "Restore conversation" : "Archive conversation"}
              onClick={() => {
                const action = selectedThread.archivedAt
                  ? unarchiveThread(selectedThread.id)
                  : archiveThread(selectedThread.id);
                void action.catch(() => undefined);
              }}
            >
              <Icon name={selectedThread.archivedAt ? "restore" : "archive"} size={17} />
            </button>
          )}
        </div>
      </header>
      {connection !== "live" && (
        <div className="connection-banner" role="status">
          <span className="connection-pulse" />
          {connection === "offline"
            ? "You’re offline. Existing conversations remain readable; you can send again after reconnecting."
            : "Live updates are reconnecting. The agent keeps working on the server."}
        </div>
      )}
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
          <div className="message-column">
            <EmptyConversation />
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
                SystemMessage,
              }}
            />
          </div>
          <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to latest message">
            <Icon name="arrow-down" size={16} />
          </ThreadPrimitive.ScrollToBottom>
          <ThreadPrimitive.ViewportFooter className="thread-footer">
            {selectedThread?.archivedAt ? (
              <div className="archived-footer">
                <span>This conversation is archived.</span>
                <button
                  type="button"
                  onClick={() => void unarchiveThread(selectedThread.id).catch(() => undefined)}
                >
                  Restore to continue
                </button>
              </div>
            ) : (
              <Composer />
            )}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
        {detailLoading && selectedThread && (
          <div className="detail-loading" role="status" aria-label="Loading conversation">
            <span />
          </div>
        )}
      </ThreadPrimitive.Root>
    </main>
  );
}
