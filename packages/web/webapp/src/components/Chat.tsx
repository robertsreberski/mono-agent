import { ThreadPrimitive } from "@assistant-ui/react";
import { Menu } from "@base-ui/react/menu";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ConnectionState, useConsoleStore } from "../console-store";
import { NotificationBell } from "../notifications";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import { ModelSelector } from "./assistant-ui/ModelSelector";
import { SelectionToolbar } from "./assistant-ui/Quote";
import {
  AskReconciliationProvider,
  AssistantMessage,
  SystemMessage,
  UserMessage,
} from "./Messages";
import { Composer } from "./Composer";
import { CronChannelHeader } from "./CronChannelHeader";
import { Icon } from "./Icon";
import { useRunControls } from "./run-controls";

const runLabel: Record<string, string> = {
  idle: "Ready",
  running: "Working",
  complete: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export const CONNECTION_NOTICE_DELAY_MS = 5_000;
const BOTTOM_TOLERANCE_PX = 1;

function useConversationBottomFollow(selectedThreadId: string | null) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const effectThreadId = selectedThreadId;
    let active = true;
    let frame: number | null = null;
    shouldStickToBottomRef.current = true;

    const rememberGeometry = () => {
      lastScrollTopRef.current = viewport.scrollTop;
      lastScrollHeightRef.current = viewport.scrollHeight;
    };
    const isAtBottom = () =>
      Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
        <= BOTTOM_TOLERANCE_PX;
    const scrollToBottom = () => {
      if (
        !active
        || selectedThreadIdRef.current !== effectThreadId
        || viewportRef.current !== viewport
        || contentRef.current !== content
        || !viewport.isConnected
        || !content.isConnected
        || !shouldStickToBottomRef.current
      ) return;

      viewport.scrollTop = viewport.scrollHeight;
      rememberGeometry();
    };
    const scheduleScrollToBottom = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        scrollToBottom();
      });
    };
    const handleScroll = () => {
      const scrollTop = viewport.scrollTop;
      const scrollHeight = viewport.scrollHeight;
      if (isAtBottom()) {
        shouldStickToBottomRef.current = true;
      } else if (
        // Height changes can clamp scrollTop; only stable geometry proves an upward operator scroll.
        scrollHeight === lastScrollHeightRef.current
        && scrollTop < lastScrollTopRef.current
      ) {
        shouldStickToBottomRef.current = false;
      }
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = scrollHeight;
    };

    rememberGeometry();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        rememberGeometry();
        if (shouldStickToBottomRef.current) scheduleScrollToBottom();
      });
    resizeObserver?.observe(content);
    resizeObserver?.observe(viewport);
    scheduleScrollToBottom();

    return () => {
      active = false;
      viewport.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [selectedThreadId]);

  return { viewportRef, contentRef };
}

export function ConnectionBanner({ connection }: { readonly connection: ConnectionState }) {
  const [visible, setVisible] = useState(connection === "offline");

  useEffect(() => {
    if (connection === "live") {
      setVisible(false);
      return;
    }
    if (connection === "offline") {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), CONNECTION_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connection]);

  if (!visible || connection === "live") return null;
  return (
    <div className="connection-banner" role="status">
      <span className="connection-pulse" />
      {connection === "offline"
        ? "You’re offline. Existing conversations remain readable; you can send again after reconnecting."
        : "Live updates are reconnecting. The agent keeps working on the server."}
    </div>
  );
}

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

  const triggerBadge = selectedThread?.trigger ? (
    <span className="trigger-badge trigger-badge-header" aria-label={`${selectedThread.trigger.kind} notification`}>
      {selectedThread.trigger.kind}
    </span>
  ) : null;

  if (editing && selectedThread) {
    return (
      <div className="conversation-title-group">
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
        {triggerBadge}
      </div>
    );
  }

  return (
    <div className="conversation-title-group">
      <button
        type="button"
        className="conversation-title"
        onClick={() => selectedThread && setEditing(true)}
        disabled={!selectedThread}
        title={selectedThread ? "Rename conversation" : undefined}
      >
        {selectedThread?.title ?? "New conversation"}
      </button>
      {triggerBadge}
    </div>
  );
}

export function ModelControls() {
  const {
    usage, selectorModels, model, effort, setModel, setEffort,
    agentDefaultModel, hasRunOverride, resetRunOverride, disabled, hasSettings,
    catalogStatusByProvider, openCatalog, requestProvider, agentProviders,
  } = useRunControls();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // `openCatalog` closes over the agent's providers and the shortlist, so its
  // identity changes as those load. Reading it through a ref keeps the window
  // listener registered exactly once while still preloading with the current
  // agent's routes.
  const openCatalogRef = useRef(openCatalog);
  useEffect(() => { openCatalogRef.current = openCatalog; }, [openCatalog]);

  // The composer's slash command opens the same picker the header does, so it
  // has to preload the same catalog pages. Opening by setting state directly
  // bypasses `onOpenChange`, and with a single provider the chip row is hidden
  // too -- nothing else would ever trigger the fetch, leaving the operator on
  // the shortlist until they reopened the picker from the header.
  useEffect(() => {
    const openSettings = () => {
      setSettingsOpen(true);
      openCatalogRef.current();
    };
    window.addEventListener("mono-agent:run-settings", openSettings);
    return () => { window.removeEventListener("mono-agent:run-settings", openSettings); };
  }, []);

  return (
    <div className="model-controls" aria-label="Run settings">
      {usage && (
        <ContextDisplay
          context={usage.context}
          processed={usage.processed}
          conversationCost={usage.cost}
        />
      )}
      {hasSettings && (
        <ModelSelector
          models={selectorModels}
          agentProviders={agentProviders}
          value={model}
          effort={effort}
          onValueChange={setModel}
          onEffortChange={setEffort}
          open={settingsOpen}
          onOpenChange={(next) => {
            setSettingsOpen(next);
            // Fetch the shortlist providers' first catalog pages so the groups
            // and chips are useful the moment the picker opens.
            if (next) openCatalog();
          }}
          disabled={disabled}
          conciseValue
          side="top"
          align="end"
          agentDefaultId={agentDefaultModel}
          providerStatus={catalogStatusByProvider}
          onProviderRequest={requestProvider}
          {...(hasRunOverride ? { onReset: resetRunOverride } : {})}
        />
      )}
    </div>
  );
}

function ConversationActions() {
  const { selectedThread, archiveThread, unarchiveThread, deleteThread } = useConsoleStore();
  if (selectedThread === null) return null;
  const archived = selectedThread.archivedAt !== null;
  const canDelete = archived
    && (selectedThread.trigger?.kind !== "cron" || selectedThread.trigger.configured === false);

  return (
    <Menu.Root>
      <Menu.Trigger
        type="button"
        className="icon-button header-more"
        aria-label="Conversation actions"
        title="Conversation actions"
      >
        <Icon name="more" size={19} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="conversation-menu-positioner" side="bottom" align="end" sideOffset={5}>
          <Menu.Popup className="conversation-menu-popup" aria-label="Conversation actions">
            <Menu.Item
              className="conversation-menu-item"
              onClick={() => {
                if (archived) {
                  void unarchiveThread(selectedThread.id).catch(() => undefined);
                  return;
                }
                const confirmed = window.confirm(
                  "Archive this conversation? Empty conversations will be permanently removed. Conversations with messages remain available in Archived.",
                );
                if (confirmed) void archiveThread(selectedThread.id).catch(() => undefined);
              }}
            >
              <Icon name={archived ? "restore" : "archive"} size={16} />
              <span>{archived ? "Restore conversation" : "Archive conversation"}</span>
            </Menu.Item>
            {canDelete && (
              <Menu.Item
                className="conversation-menu-item is-danger"
                onClick={() => {
                  if (!window.confirm("Permanently delete this conversation and its attachments? This cannot be undone.")) return;
                  void deleteThread(selectedThread.id).catch(() => undefined);
                }}
              >
                <Icon name="trash" size={16} />
                <span>Permanently delete</span>
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function EmptyConversation() {
  const { selectedAgent, createThread, selectedThread } = useConsoleStore();
  const cron = selectedThread?.trigger?.kind === "cron";
  return (
    <ThreadPrimitive.Empty>
      <div className="chat-empty">
        <div className="empty-orbit" aria-hidden="true">
          <span />
          <Icon name="spark" size={22} />
        </div>
        <span className="eyebrow">{selectedAgent?.label ?? "mono-agent"}</span>
        <h2>{cron ? "No cron runs recorded yet" : selectedThread ? "What should we work on?" : "Start a new conversation"}</h2>
        <p>
          {cron
            ? "Runs will appear here chronologically after the agent admits them."
            : selectedAgent
            ? "Messages, reasoning, tool calls, and files stay together in this conversation."
            : "No agents have been discovered yet. Start an agent and it will appear here automatically."}
        </p>
        {selectedAgent && !selectedThread && !cron && (
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
    selectedThreadId,
    connection,
    detailLoading,
    unarchiveThread,
    hasOlderMessages,
    loadOlderMessages,
  } = useConsoleStore();
  const { viewportRef, contentRef } = useConversationBottomFollow(selectedThreadId);
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
          <NotificationBell />
          <ConversationActions />
        </div>
      </header>
      <ConnectionBanner connection={connection} />
      <CronChannelHeader />
      <AskReconciliationProvider>
        <ThreadPrimitive.Root className="thread-root">
          <SelectionToolbar />
          <ThreadPrimitive.Viewport
            key={selectedThreadId ?? "no-thread"}
            ref={viewportRef}
            className="thread-viewport"
            autoScroll
          >
            <div ref={contentRef} className="message-column">
              <EmptyConversation />
              {hasOlderMessages && (
                <button
                  type="button"
                  className="message-history-more"
                  onClick={() => void loadOlderMessages().catch(() => undefined)}
                >
                  Load earlier messages
                </button>
              )}
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
              ) : selectedThread?.trigger?.kind === "cron" ? (
                <div className="cron-readonly-footer" role="status">
                  Cron channels are read-only. Open the originating session to continue the conversation.
                </div>
              ) : (
                <Composer runSettings={<ModelControls />} />
              )}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
          {detailLoading && selectedThread && (
            <div className="detail-loading" role="status" aria-label="Loading conversation">
              <span />
            </div>
          )}
        </ThreadPrimitive.Root>
      </AskReconciliationProvider>
    </main>
  );
}
