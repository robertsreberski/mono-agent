import {
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentSettingsDialog } from "./components/AgentSettingsDialog";
import { BrandMark } from "./components/BrandMark";
import { Chat } from "./components/Chat";
import { Dashboard } from "./components/dashboard/Dashboard";
import { Icon, type IconName } from "./components/Icon";
import { useConsoleStore } from "./console-store";
import {
  cycleDataModeSetting,
  dataModeLabel,
  markLeanDataModeOffered,
  shouldOfferLeanDataMode,
  useDataMode,
  useDataModeSetting,
  writeDataModeSetting,
} from "./data-mode";
import { hasUnsentComposerDraft } from "./composer-draft";
import { formatDataBytes, useDataUsage } from "./data-usage";
import {
  hasHorizontalScrollAncestor,
  isMobileDrawerSwipe,
  type DrawerGesturePoint,
} from "./mobile-drawer-gesture";
import {
  applyServiceWorkerUpdate,
  useServiceWorkerUpdateWaiting,
} from "./service-worker-update";
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

const DRAWER_SWIPE_EXCLUDED = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='dialog']",
  "[data-slot='composer-trigger-popover']",
  "[data-slot='model-selector-content']",
  ".context-display-popover",
  ".image-row",
  ".markdown-table",
  ".markdown pre",
].join(",");
const MOBILE_DRAWER_MEDIA = "(max-width: 900px)";

/** Whether the shell owes the Dashboard a drawer rather than a column. */
const isMobileViewport = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(MOBILE_DRAWER_MEDIA).matches;

interface DrawerGestureStart extends DrawerGesturePoint {
  readonly intent: "close" | "open-dashboard";
}

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

/**
 * The palette is closed almost all of the time, and while it is closed it has no
 * business subscribing to anything or building a list nobody can see. A shell
 * with no hooks of its own is what makes that early return legal.
 */
function CommandPalette({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  if (!open) return null;
  return <OpenCommandPalette onClose={onClose} />;
}

function OpenCommandPalette({ onClose }: { readonly onClose: () => void }) {
  const store = useConsoleStore();
  const dataModeSetting = useDataModeSetting();
  const dataMode = useDataMode();
  const dataUsage = useDataUsage();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus(true, dialogRef, onClose, inputRef);

  const actions = useMemo<readonly PaletteAction[]>(
    () => [
      {
        id: "new",
        label: "New conversation",
        hint: "⌘⇧O",
        icon: "new",
        disabled: !store.selectedAgent || store.selectionLoading || store.selectionError !== null,
        run: () => void store.createThread().catch(() => undefined),
      },
      {
        id: "agent-settings",
        label: `Agent settings${store.selectedAgent ? ` · ${store.selectedAgent.label}` : ""}`,
        icon: "settings",
        disabled: !store.selectedAgent,
        run: () => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings")),
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
      {
        id: "data-mode",
        // The setting AND what it resolves to, because on the phone this
        // console is installed on those two are never the same thing.
        label: `Data: ${dataModeLabel(dataModeSetting, dataMode)}`,
        // `~` where the console is estimating rather than reading a measurement.
        hint: `${dataUsage.measured ? "" : "~"}${formatDataBytes(dataUsage.bytes)}`,
        icon: "activity",
        run: () => { cycleDataModeSetting(); },
      },
      {
        id: "clear-cache",
        label: "Clear cached data",
        icon: "trash",
        run: () => {
          void store.clearCachedData().then(() => {
            window.dispatchEvent(new CustomEvent("mono-agent:notice", {
              detail: { message: "Cleared the conversations this browser had stored." },
            }));
          }).catch(() => undefined);
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
    [dataMode, dataModeSetting, dataUsage.bytes, dataUsage.measured, store],
  );
  const normalized = query.trim().toLowerCase();
  const visible = actions.filter((action) => action.label.toLowerCase().includes(normalized));

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
    clearError,
    hasServerSnapshot,
    hasRunningThread,
    retry,
  } = useConsoleStore();
  const [drawer, setDrawer] = useState(false);
  const [mobile, setMobile] = useState(isMobileViewport);
  const [palette, setPalette] = useState(false);
  const [agentSettings, setAgentSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [leanOffer, setLeanOffer] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const dashboardRef = useRef<HTMLDivElement>(null);
  const agentSettingsRef = useRef<HTMLElement>(null);
  const drawerGestureRef = useRef<DrawerGestureStart | null>(null);

  const closeDrawer = useCallback(() => setDrawer(false), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const closeAgentSettings = useCallback(() => setAgentSettings(false), []);
  const togglePalette = useCallback(() => {
    closeDrawer();
    setPalette((current) => !current);
  }, [closeDrawer]);
  const openDashboard = useCallback(() => {
    setPalette(false);
    setDrawer(true);
  }, []);

  const startDrawerGesture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    drawerGestureRef.current = null;
    if (
      event.touches.length !== 1
      || typeof window.matchMedia !== "function"
      || !window.matchMedia(MOBILE_DRAWER_MEDIA).matches
    ) return;

    const touch = event.touches[0];
    if (!touch) return;
    const target = event.target instanceof Element ? event.target : null;
    const selection = window.getSelection();
    const excluded = target?.closest(DRAWER_SWIPE_EXCLUDED) ?? null;
    // The exclusions apply in BOTH directions now that there is one drawer to
    // swipe across: its agent strip is a native horizontal scroller and its
    // options popover is a control, and a swipe meant for either of those was
    // dismissing the drawer under the operator's thumb. The drawer's own root
    // matches `[role="dialog"]` and is the one thing exempted -- a dialog
    // nested INSIDE it is still excluded, because it owns that gesture.
    if (excluded !== null && excluded !== dashboardRef.current) return;
    if (
      hasHorizontalScrollAncestor(target, event.currentTarget)
      || (selection !== null && !selection.isCollapsed)
    ) return;

    drawerGestureRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      intent: drawer ? "close" : "open-dashboard",
    };
  }, [drawer]);

  const finishDrawerGesture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const start = drawerGestureRef.current;
    drawerGestureRef.current = null;
    if (!start || event.touches.length > 0) return;

    const touch = event.changedTouches[0];
    if (!touch) return;
    const end = { x: touch.clientX, y: touch.clientY };
    const direction = start.intent === "open-dashboard" ? "right" : "left";
    if (!isMobileDrawerSwipe(start, end, direction)) return;

    event.preventDefault();
    if (start.intent === "open-dashboard") openDashboard();
    else closeDrawer();
  }, [closeDrawer, openDashboard]);

  const cancelDrawerGesture = useCallback(() => {
    drawerGestureRef.current = null;
  }, []);

  // The Dashboard is a modal drawer only while it IS one. On desktop it is the
  // left column of the shell, and trapping focus in a column nobody opened
  // would take the keyboard away from the conversation.
  useModalFocus(mobile && drawer, dashboardRef, closeDrawer);
  useModalFocus(agentSettings, agentSettingsRef, closeAgentSettings);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobileDrawerViewport = window.matchMedia(MOBILE_DRAWER_MEDIA);
    const onChange = (event: MediaQueryListEvent) => {
      setMobile(event.matches);
      // Crossing back to desktop turns the drawer into the column it always
      // was; leaving `drawer` true would reopen it on the next narrow render.
      if (!event.matches) closeDrawer();
    };
    setMobile(mobileDrawerViewport.matches);
    mobileDrawerViewport.addEventListener("change", onChange);
    return () => mobileDrawerViewport.removeEventListener("change", onChange);
  }, [closeDrawer]);

  useEffect(() => {
    const onCommand = () => togglePalette();
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setNotice(detail.message);
    };
    const onAgentSettings = () => {
      closeDrawer();
      setPalette(false);
      setAgentSettings(true);
    };
    window.addEventListener("mono-agent:command", onCommand);
    window.addEventListener("mono-agent:notice", onNotice);
    window.addEventListener("mono-agent:agent-settings", onAgentSettings);
    return () => {
      window.removeEventListener("mono-agent:command", onCommand);
      window.removeEventListener("mono-agent:notice", onNotice);
      window.removeEventListener("mono-agent:agent-settings", onAgentSettings);
    };
  }, [closeDrawer, togglePalette]);

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

  /**
   * Whether the ordinary shell is what is on screen.
   *
   * The two states below return before any toast is rendered, so an offer made
   * while one of them is up is marked as offered and never seen -- and, being
   * once per install, never made again. It waits for a console that can show it.
   */
  const shellReady = Boolean(bootstrap) || (!loading && !error);

  // A home-screen install whose browser cannot describe the network is the one
  // case Auto cannot answer, so the console says so -- once, and only once,
  // marked as offered before it is shown so a reload cannot nag.
  useEffect(() => {
    if (!shellReady || !shouldOfferLeanDataMode()) return;
    markLeanDataModeOffered();
    setLeanOffer(true);
  }, [shellReady]);

  // The offer is about Auto. An operator who set the mode -- from the palette,
  // from the sidebar, or by taking the offer -- has answered it, and a notice
  // still on screen after that is stale.
  const dataModeSetting = useDataModeSetting();
  useEffect(() => {
    if (dataModeSetting !== "auto") setLeanOffer(false);
  }, [dataModeSetting]);

  /**
   * A staged build takes over on the next quiet moment, not on arrival.
   *
   * Read from a ref at the event rather than depended on: what matters is what
   * is true WHEN the operator comes back, and re-arming the listener on every
   * status change would be a listener per streamed frame. Kept current in an
   * effect rather than during render, because a render is not allowed to write
   * to a ref another render might read.
   */
  const busyRef = useRef(hasRunningThread);
  useEffect(() => {
    busyRef.current = hasRunningThread;
  }, [hasRunningThread]);
  const updateWaiting = useServiceWorkerUpdateWaiting();
  useEffect(() => {
    if (!updateWaiting) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // A reload takes the page apart. Two things it would destroy, and neither
      // is recoverable: a turn this tab is WATCHING -- any held conversation,
      // not just the listed ones, because the listing is one agent's one
      // bucket -- and whatever the operator has typed or staged in the composer,
      // which lives only in assistant-ui's in-memory runtime.
      //
      // Either one defers it. The notice stays on screen throughout, so an
      // operator who would rather have the new build now still can.
      if (busyRef.current || hasUnsentComposerDraft()) return;
      applyServiceWorkerUpdate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [updateWaiting]);

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
        closeDrawer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, palette, togglePalette]);

  const store = useConsoleStore();
  useEffect(() => {
    const onNewThread = () => {
      if (store.selectedAgent && !store.selectionLoading && store.selectionError === null) {
        void store.createThread().catch(() => undefined);
      }
    };
    window.addEventListener("mono-agent:new-thread", onNewThread);
    return () => window.removeEventListener("mono-agent:new-thread", onNewThread);
  }, [store]);

  if (loading && !bootstrap) return <InitialLoading />;
  if (error && !bootstrap) return <FatalError />;

  return (
    <div
      className="app-shell"
      onTouchStart={startDrawerGesture}
      onTouchEnd={finishDrawerGesture}
      onTouchCancel={cancelDrawerGesture}
    >
      {/*
        * ONE Dashboard, mounted once. It is the desktop left column and the
        * mobile drawer, and the difference between them is these attributes --
        * remounting it per breakpoint would throw away a query mid-typing and
        * a list mid-scroll on every rotation.
        */}
      <div
        ref={dashboardRef}
        className={`dashboard-panel${drawer ? " is-open" : ""}`}
        tabIndex={-1}
        {...(mobile
          ? {
              role: "dialog",
              "aria-modal": true,
              "aria-label": "Dashboard",
              "aria-hidden": !drawer,
              inert: !drawer,
            }
          : { role: "navigation", "aria-label": "Dashboard" })}
      >
        <Dashboard onNavigate={closeDrawer} />
      </div>
      {/* Inert, not hidden: the conversation stays on screen behind the scrim,
          and tabbing must not walk into it. */}
      <div className="chat-region" inert={mobile && drawer}>
        <Chat onOpenDashboard={openDashboard} />
      </div>

      {drawer && (
        <button className="drawer-scrim" type="button" onClick={closeDrawer} aria-label="Close navigation" />
      )}

      {/*
        * The console draws before anything is asked for now, so a snapshot that
        * FAILED no longer reaches the fatal screen -- there is a projection, and
        * it is this browser's copy from the last visit. Persistent and
        * dismissible rather than a toast: it is a state, not an event.
        */}
      {error && (
        <div className="console-error" role="alert">
          <span>
            {hasServerSnapshot
              ? error
              // The one thing the message itself cannot say.
              : `${error} Showing what this browser had stored.`}
          </span>
          <button type="button" className="console-error-retry" onClick={retry}>Try again</button>
          <button type="button" aria-label="Dismiss error" onClick={clearError}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {leanOffer && (
        <div className="toast is-offer" role="status">
          <span>
            This browser can’t report the connection, so Auto stays on Full.
            Lean loads pictures and apps only when you tap them.
          </span>
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              writeDataModeSetting("lean");
              setLeanOffer(false);
            }}
          >
            Use Lean
          </button>
          <button
            type="button"
            aria-label="Dismiss data mode suggestion"
            onClick={() => setLeanOffer(false)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {/*
        * One offer row at a time: `.toast.is-offer` has its own place above an
        * ordinary toast, and two of them would sit on top of each other. The
        * data-mode offer is shown once per install and clears itself.
        */}
      {updateWaiting && !updateDismissed && !leanOffer && (
        <div className="toast is-offer" role="status">
          <span>A new version of the console is ready.</span>
          <button
            type="button"
            className="toast-action"
            onClick={applyServiceWorkerUpdate}
          >
            Reload now
          </button>
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => setUpdateDismissed(true)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <CommandPalette open={palette} onClose={closePalette} />
      <AgentSettingsDialog open={agentSettings} onClose={closeAgentSettings} dialogRef={agentSettingsRef} />
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
