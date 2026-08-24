import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  agentRailWidth,
  readAgentRailExpanded,
  writeAgentRailExpanded,
} from "./agent-rail-layout";
import { AgentRail, BrandMark } from "./components/AgentRail";
import { Chat } from "./components/Chat";
import { ConversationWorkspace } from "./components/ConversationWorkspace";
import { Icon, type IconName } from "./components/Icon";
import { useConsoleStore } from "./console-store";
import { applyConsolePresentation } from "./theme";

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: IconName;
  readonly disabled?: boolean;
  readonly run: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useModalFocus(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => {
      initialFocusRef?.current?.focus();
      if (!initialFocusRef?.current) {
        rootRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusable = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        rootRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !rootRef.current.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !rootRef.current.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      if (restore?.isConnected) restore.focus();
      restoreRef.current = null;
    };
  }, [initialFocusRef, onClose, open, rootRef]);
}

function CommandPalette({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const store = useConsoleStore();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus(open, dialogRef, onClose, inputRef);

  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  const actions = useMemo<readonly PaletteAction[]>(
    () => [
      {
        id: "new",
        label: "New conversation",
        hint: "⌘⇧O",
        icon: "new",
        disabled: !store.selectedAgent,
        run: () => void store.createThread().catch(() => undefined),
      },
      {
        id: "rename",
        label: "Rename conversation",
        icon: "threads",
        disabled: !store.selectedThread,
        run: () => {
          if (!store.selectedThread) return;
          const title = window.prompt("Conversation title", store.selectedThread.title)?.trim();
          if (title) {
            void store.renameThread(store.selectedThread.id, title).catch(() => undefined);
          }
        },
      },
      {
        id: "focus",
        label: "Focus message composer",
        hint: "/",
        icon: "threads",
        run: () => document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus(),
      },
      {
        id: "archive-view",
        label: store.showArchived ? "Show active conversations" : "Show archived conversations",
        icon: store.showArchived ? "threads" : "archive",
        run: () => store.setShowArchived(!store.showArchived),
      },
      {
        id: "pin-agent",
        label: store.selectedAgent?.pinned
          ? `Unpin ${store.selectedAgent.label}`
          : `Pin ${store.selectedAgent?.label ?? "agent"}`,
        icon: "star",
        disabled: !store.selectedAgent,
        run: () => {
          const agent = store.selectedAgent;
          if (!agent) return;
          void store.setAgentPinned(agent.sourceId, !agent.pinned).catch(() => undefined);
        },
      },
      ...(store.hiddenOfflineAgentCount > 0
        ? [{
            id: "offline-agents",
            label: store.showOfflineAgents
              ? "Hide offline agents"
              : `Show ${store.hiddenOfflineAgentCount} offline agent${store.hiddenOfflineAgentCount === 1 ? "" : "s"}`,
            icon: (store.showOfflineAgents ? "eye-off" : "eye") as IconName,
            run: () => store.setShowOfflineAgents(!store.showOfflineAgents),
          }]
        : []),
      ...store.visibleAgents.map((agent) => ({
        id: `agent:${agent.sourceId}`,
        label: `Switch to ${agent.label}`,
        hint: agent.status,
        icon: "agent" as const,
        run: () => store.selectAgent(agent.sourceId),
      })),
    ],
    [store],
  );
  const normalized = query.trim().toLowerCase();
  const visible = actions.filter((action) => action.label.toLowerCase().includes(normalized));

  if (!open) return null;
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              const firstAction = visible.find((action) => !action.disabled);
              if (event.key === "Enter" && firstAction) {
                onClose();
                window.requestAnimationFrame(firstAction.run);
              }
            }}
            placeholder="Type a command…"
            aria-label="Search commands"
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" role="listbox">
          {visible.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="option"
              aria-selected={index === 0}
              disabled={action.disabled}
              onClick={() => {
                onClose();
                window.requestAnimationFrame(action.run);
              }}
            >
              <span className="palette-icon"><Icon name={action.icon} size={16} /></span>
              <span>{action.label}</span>
              {action.hint && <kbd>{action.hint}</kbd>}
            </button>
          ))}
          {visible.length === 0 && <p>No matching commands</p>}
        </div>
        <footer>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>⌘K</kbd> toggle</span>
        </footer>
      </section>
    </div>
  );
}

function InitialLoading() {
  return (
    <div className="initial-state" role="status">
      <BrandMark />
      <div className="initial-loader"><span /><span /><span /></div>
      <span>Discovering agents</span>
    </div>
  );
}

function FatalError() {
  const { error, retry } = useConsoleStore();
  return (
    <div className="fatal-state">
      <BrandMark />
      <span className="eyebrow">Console unavailable</span>
      <h1>Couldn’t reach the mono-agent service.</h1>
      <p>{error ?? "The local web service did not respond."}</p>
      <button type="button" className="primary-button" onClick={retry}>Try again</button>
      <small>No sign-in is required. Check that <code>mono-agent web start</code> or <code>mono-agent web run</code> is running on this machine.</small>
    </div>
  );
}

export function App() {
  const {
    loading,
    bootstrap,
    error,
    actionError,
    clearActionError,
    conversationDetailOpen,
    openConversationIndex,
  } = useConsoleStore();
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agentRailExpanded, setAgentRailExpanded] = useState(readAgentRailExpanded);
  const detailWasOpen = useRef(false);
  const appStyle = {
    "--agent-rail-width": `${agentRailWidth(agentRailExpanded)}px`,
  } as CSSProperties;
  const toggleAgentRail = useCallback(() => {
    setAgentRailExpanded((current) => {
      const next = !current;
      writeAgentRailExpanded(next);
      return next;
    });
  }, []);
  const closePalette = useCallback(() => setPalette(false), []);
  const togglePalette = useCallback(() => {
    setPalette((current) => !current);
  }, []);

  useEffect(() => {
    const onCommand = () => togglePalette();
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setNotice(detail.message);
    };
    window.addEventListener("mono-agent:command", onCommand);
    window.addEventListener("mono-agent:notice", onNotice);
    return () => {
      window.removeEventListener("mono-agent:command", onCommand);
      window.removeEventListener("mono-agent:notice", onNotice);
    };
  }, [togglePalette]);

  useEffect(() => {
    if (!notice && !actionError) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
      clearActionError();
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [actionError, clearActionError, notice]);

  useEffect(() => {
    if (!bootstrap) return;
    return applyConsolePresentation(bootstrap.console);
  }, [bootstrap]);

  useEffect(() => {
    const wasOpen = detailWasOpen.current;
    detailWasOpen.current = conversationDetailOpen;
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 900px)");
    let timer: number | undefined;
    const focusSurface = (enteringMobile = false) => {
      if (!media.matches) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (conversationDetailOpen) {
          document.querySelector<HTMLButtonElement>(".mobile-conversation-back")?.focus();
        } else if (wasOpen || enteringMobile) {
          const destination = document.querySelector<HTMLButtonElement>(
            ".workspace-thread-card.is-active .workspace-thread-open",
          ) ?? document.querySelector<HTMLElement>(".workspace-search input, .workspace-filter-open");
          destination?.focus();
        }
      }, 0);
    };
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches) focusSurface(true);
    };
    focusSurface();
    media.addEventListener?.("change", onBreakpointChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      media.removeEventListener?.("change", onBreakpointChange);
    };
  }, [conversationDetailOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const modalOpen = Boolean(document.querySelector(
        '[role="dialog"][aria-modal="true"]:not([aria-hidden="true"]), [data-slot="model-selector-content"]',
      ));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (palette) {
          setPalette(false);
          return;
        }
        if (modalOpen) return;
        togglePalette();
        return;
      }
      if (modalOpen) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("mono-agent:new-thread"));
        return;
      }
      if (!typing && event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus();
      }
      if (event.key === "Escape") {
        setPalette(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [palette, togglePalette]);

  const store = useConsoleStore();
  useEffect(() => {
    const onNewThread = () => {
      if (store.selectedAgent) void store.createThread().catch(() => undefined);
    };
    window.addEventListener("mono-agent:new-thread", onNewThread);
    return () => window.removeEventListener("mono-agent:new-thread", onNewThread);
  }, [store]);

  if (loading && !bootstrap) return <InitialLoading />;
  if (error && !bootstrap) return <FatalError />;

  return (
    <div
      className={`app-shell conversation-layout${conversationDetailOpen ? " has-conversation-detail" : ""}`}
      style={appStyle}
    >
      <div className="desktop-agent-rail">
        <AgentRail expanded={agentRailExpanded} onToggleExpanded={toggleAgentRail} />
      </div>
      <div className="conversation-master"><ConversationWorkspace /></div>
      <div className="conversation-detail">
        <Chat onBackToWorkspace={openConversationIndex} />
      </div>

      <CommandPalette open={palette} onClose={closePalette} />
      {(notice || actionError) && (
        <div className="toast" role="alert">
          <span>{notice ?? actionError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setNotice(null);
              clearActionError();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
