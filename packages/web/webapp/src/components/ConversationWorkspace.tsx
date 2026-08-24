import {
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  collectionName,
  groupWorkspaceThreads,
  isAutomationThread,
  WORKFLOW_COLUMNS,
  workspaceThreadMatches,
  type WorkspaceCollectionId,
  type WorkspaceKind,
} from "../conversation-workspace";
import { effortLevelsForAgentModel, useConsoleStore } from "../console-store";
import type {
  AgentSummary,
  ThreadListGroupBy,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
  WebRunPreference,
  WebWorkflowStatus,
} from "../types";
import { BrandMark } from "./AgentRail";
import { Icon } from "./Icon";

type WorkspaceView = "list" | "kanban";
type WorkspaceQueryType = Exclude<ThreadQuery["type"], undefined>;

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

const relativeTime = (date: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(date));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${days}d`
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(date));
};

const threadQuery = (
  collectionId: WorkspaceCollectionId,
  sourceIds: readonly string[] | undefined,
  type: ThreadQuery["type"],
  q: string,
  groupBy: ThreadListGroupBy,
): ThreadQuery => ({
  ...(sourceIds === undefined ? {} : { sourceIds }),
  archived: collectionId === "archive",
  type,
  ...(collectionId === "pinned" ? { pinned: true } : {}),
  ...(collectionId === "unfiled" ? { collectionId: "unfiled" } : {}),
  ...(collectionId.startsWith("collection:")
    ? { collectionId: collectionId.slice("collection:".length) }
    : {}),
  ...(q.trim() ? { q: q.trim() } : {}),
  groupBy,
  limit: 200,
});

const mergePages = (pages: readonly ThreadPage[]): ThreadPage => {
  const threads = new Map<string, ThreadSummary>();
  for (const page of pages) {
    for (const thread of page.threads) threads.set(thread.id, thread);
  }
  return {
    threads: [...threads.values()].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
  };
};

function AgentPreferencesDialog({
  agent,
  onClose,
}: {
  readonly agent: AgentSummary;
  readonly onClose: () => void;
}) {
  const store = useConsoleStore();
  const current = store.agentPreferences[agent.sourceId];
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void store.loadAgentPreferences(agent.sourceId).catch(() => undefined);
  }, [agent.sourceId, store.loadAgentPreferences]);

  useEffect(() => {
    if (current === undefined) return;
    setModel(current?.model ?? "");
    setEffort(current?.effort ?? "");
  }, [current]);

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      prior?.focus();
    };
  }, [onClose]);

  const effectiveModel = model || agent.defaultModel || agent.models?.[0] || "";
  const efforts = effortLevelsForAgentModel(agent, effectiveModel);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const preference: WebRunPreference = {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    setSaving(true);
    void store.setAgentRunPreference(
      agent.sourceId,
      Object.keys(preference).length > 0 ? preference : null,
    ).then(onClose).catch(() => undefined).finally(() => setSaving(false));
  };

  return (
    <div className="dialog-layer workspace-dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="agent-preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-preferences-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Agent preference</span>
            <h2 id="agent-preferences-title">{agent.label}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close agent preferences">
            <Icon name="close" size={17} />
          </button>
        </header>
        <form onSubmit={submit}>
          <p>New and inherited conversations use these settings. A conversation can override either value independently.</p>
          <label>
            <span>Model</span>
            <select value={model} onChange={(event) => {
              const nextModel = event.target.value;
              setModel(nextModel);
              const nextEffectiveModel = nextModel || agent.defaultModel || agent.models?.[0] || "";
              if (
                effort
                && !effortLevelsForAgentModel(agent, nextEffectiveModel).includes(effort)
              ) setEffort("");
            }}>
              <option value="">Default · {agent.defaultModel ?? "Provider default"}</option>
              {(agent.models ?? []).map((reference) => (
                <option key={reference} value={reference}>
                  {agent.modelOptions?.[reference]?.label ?? reference}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Effort</span>
            <select value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">Default · {agent.defaultEffort ?? "Provider default"}</option>
              {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <div className="preference-effective" role="status">
            Effective for inherited conversations: <strong>{effectiveModel || "Provider default"}</strong>
            {effort ? ` · ${effort}` : agent.defaultEffort ? ` · ${agent.defaultEffort}` : ""}
          </div>
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving || current === undefined}>
              {saving ? "Saving…" : "Save preference"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function AgentFilter({
  selected,
  onChange,
  onPreferences,
}: {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly onPreferences: (agent: AgentSummary) => void;
}) {
  const store = useConsoleStore();
  const visible = store.agents.filter((agent) =>
    agent.status !== "offline"
    || agent.pinned
    || store.showOfflineAgents
    || selected.has(agent.sourceId)
    || agent.sourceId === store.selectedAgentId);
  const hiddenCount = store.hiddenOfflineAgentCount;
  return (
    <details className="agent-filter">
      <summary>
        <Icon name="agent" size={15} />
        {selected.size === 0 ? "All agents" : `${selected.size} agent${selected.size === 1 ? "" : "s"}`}
        <Icon name="chevron" size={13} />
      </summary>
      <div className="agent-filter-popover">
        <header>
          <strong>Filter agents</strong>
          {selected.size > 0 && <button type="button" onClick={() => onChange(new Set())}>Clear</button>}
        </header>
        {visible.map((agent) => (
          <div className="agent-filter-row" key={agent.sourceId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(agent.sourceId)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(agent.sourceId)) next.delete(agent.sourceId);
                  else next.add(agent.sourceId);
                  onChange(next);
                }}
              />
              <span className={`workspace-agent-dot is-${agent.status}`} />
              <span>{agent.label}</span>
              {agent.pinned && <Icon name="star" size={12} fill="currentColor" />}
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`Preferences for ${agent.label}`}
              onClick={() => onPreferences(agent)}
            >
              <Icon name="settings" size={14} />
            </button>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="offline-filter-toggle"
            onClick={() => store.setShowOfflineAgents(!store.showOfflineAgents)}
          >
            <Icon name={store.showOfflineAgents ? "eye-off" : "eye"} size={14} />
            {store.showOfflineAgents ? "Hide offline agents" : `Show ${hiddenCount} offline`}
          </button>
        )}
      </div>
    </details>
  );
}

function ThreadCard({
  thread,
  draggable = false,
  onDragStart,
}: {
  readonly thread: ThreadSummary;
  readonly draggable?: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLElement>, threadId: string) => void;
}) {
  const store = useConsoleStore();
  const agent = store.agents.find(({ sourceId }) => sourceId === thread.sourceId);
  const automation = isAutomationThread(thread);
  const open = () => store.selectSearchMatch(thread.id, thread.searchMatch?.messageId);
  return (
    <article
      className={`workspace-thread-card${store.selectedThreadId === thread.id ? " is-active" : ""}`}
      draggable={draggable && thread.runState.status !== "running"}
      onDragStart={(event) => onDragStart?.(event, thread.id)}
      aria-label={thread.title}
    >
      <button type="button" className="workspace-thread-open" onClick={open}>
        <span className="workspace-thread-title-line">
          <strong>{thread.title}</strong>
          {thread.pinned && <Icon name="star" size={12} fill="currentColor" />}
          <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
        </span>
        <span className="workspace-thread-meta">
          <span>{agent?.label ?? thread.sourceId}</span>
          <span>{automation ? thread.trigger?.kind ?? "Automation" : collectionName(thread.collectionId, store.collections)}</span>
        </span>
        {thread.searchMatch ? (
          <span className="workspace-search-snippet">{thread.searchMatch.snippet}</span>
        ) : (
          <span className="workspace-thread-preview">
            {thread.lastMessagePreview || (thread.messageCount ? `${thread.messageCount} messages` : "New conversation")}
          </span>
        )}
      </button>
      {!automation && !thread.archivedAt && (
        <div className="workspace-card-actions" role="group" aria-label={`Actions for ${thread.title}`}>
          <button
            type="button"
            aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
            aria-pressed={thread.pinned}
            onClick={() => void store.updateThreadWorkspace(thread.id, { pinned: !thread.pinned }).catch(() => undefined)}
          >
            <Icon name="star" size={14} fill={thread.pinned ? "currentColor" : "none"} />
          </button>
          <label>
            <span className="sr-only">Collection for {thread.title}</span>
            <select
              aria-label={`Collection for ${thread.title}`}
              value={thread.collectionId ?? ""}
              onChange={(event) => void store.updateThreadWorkspace(thread.id, {
                collectionId: event.target.value || null,
              }).catch(() => undefined)}
            >
              <option value="">Unfiled</option>
              {store.collections.map((collection) => (
                <option key={collection.id} value={collection.id}>{collection.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Workflow status for {thread.title}</span>
            <select
              aria-label={`Workflow status for ${thread.title}`}
              disabled={thread.runState.status === "running"}
              title={thread.runState.status === "running" ? "Active conversations stay In progress" : undefined}
              value={thread.workflowStatus ?? "todo"}
              onChange={(event) => void store.updateThreadWorkspace(thread.id, {
                workflowStatus: event.target.value as WebWorkflowStatus,
              }).catch(() => undefined)}
            >
              {WORKFLOW_COLUMNS.map((column) => (
                <option key={column.id} value={column.id}>{column.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label={`Archive ${thread.title}`}
            onClick={() => void store.archiveThread(thread.id).catch(() => undefined)}
          >
            <Icon name="archive" size={14} />
          </button>
        </div>
      )}
      {thread.archivedAt && (
        <div className="workspace-card-actions is-archive">
          <button type="button" onClick={() => void store.unarchiveThread(thread.id).catch(() => undefined)}>
            <Icon name="restore" size={14} /> Restore
          </button>
        </div>
      )}
    </article>
  );
}

export function ConversationWorkspace() {
  const store = useConsoleStore();
  const [activeCollection, setActiveCollection] = useState<WorkspaceCollectionId>("all");
  const [kind, setKind] = useState<WorkspaceKind>("interactive");
  const [view, setView] = useState<WorkspaceView>("list");
  const [groupBy, setGroupBy] = useState<ThreadListGroupBy>("none");
  const [query, setQuery] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState<ThreadPage | null>(null);
  const [cursorByType, setCursorByType] = useState<Partial<Record<WorkspaceQueryType, string>>>({});
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [mobileStatus, setMobileStatus] = useState<WebWorkflowStatus>("todo");
  const [preferencesAgent, setPreferencesAgent] = useState<AgentSummary | null>(null);
  const requestId = useRef(0);
  const newMenuRef = useRef<HTMLDetailsElement>(null);
  const filterPanelRef = useRef<HTMLElement>(null);
  const filterOpenRef = useRef<HTMLButtonElement>(null);
  const filterCloseRef = useRef<HTMLButtonElement>(null);
  const filtersWereOpen = useRef(false);
  const closePreferences = useCallback(() => setPreferencesAgent(null), []);

  useEffect(() => {
    if (mobileFilters) {
      filtersWereOpen.current = true;
      filterCloseRef.current?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setMobileFilters(false);
          return;
        }
        if (event.key !== "Tab" || filterPanelRef.current === null) return;
        const focusable = [...filterPanelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }
    if (filtersWereOpen.current) {
      filtersWereOpen.current = false;
      filterOpenRef.current?.focus();
    }
    return undefined;
  }, [mobileFilters]);

  const sourceIds = useMemo(() => {
    if (selectedAgents.size > 0) return [...selectedAgents];
    return undefined;
  }, [selectedAgents]);

  useEffect(() => {
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      setQueryLoading(true);
      setQueryError(null);
      setCursorByType({});
      const base = (type: ThreadQuery["type"]) => threadQuery(
        activeCollection,
        sourceIds,
        type,
        query,
        view === "list" && kind !== "automation" ? groupBy : "none",
      );
      const request = kind === "interactive"
        ? store.queryWorkspaceThreads(base("interactive")).then((next) => ({
            page: next,
            cursors: next.nextCursor ? { interactive: next.nextCursor } : {},
          }))
        : Promise.all([
            store.queryWorkspaceThreads(base("cron")),
            store.queryWorkspaceThreads(base("webhook")),
          ]).then(([cron, webhook]) => ({
            page: mergePages([cron, webhook]),
            cursors: {
              ...(cron.nextCursor ? { cron: cron.nextCursor } : {}),
              ...(webhook.nextCursor ? { webhook: webhook.nextCursor } : {}),
            },
          }));
      void request.then((next) => {
        if (requestId.current === id) {
          setPage(next.page);
          setCursorByType(next.cursors);
          setQueryError(null);
        }
      }).catch((error: unknown) => {
        if (requestId.current !== id) return;
        setPage({ threads: [] });
        setCursorByType({});
        setQueryError(error instanceof Error ? error.message : "Could not load conversations.");
      }).finally(() => {
        if (requestId.current === id) setQueryLoading(false);
      });
    }, query.trim() ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [
    activeCollection,
    groupBy,
    kind,
    query,
    sourceIds,
    store.queryWorkspaceThreads,
    store.workspaceRevision,
    view,
  ]);

  useEffect(() => {
    if (kind === "automation" || activeCollection === "archive") setView("list");
  }, [activeCollection, kind]);

  const resultThreads = useMemo(() => {
    const source = page?.threads ?? store.threads;
    const live = new Map(store.threads.map((thread) => [thread.id, thread]));
    return source
      .map((thread) => {
        const current = live.get(thread.id);
        if (!current) return thread;
        const { searchMatch: _staleSearchMatch, ...durable } = current;
        return { ...durable, ...(thread.searchMatch ? { searchMatch: thread.searchMatch } : {}) };
      })
      .filter((thread) => workspaceThreadMatches(thread, {
        collectionId: activeCollection,
        sourceIds: new Set(sourceIds ?? []),
        kind,
      }));
  }, [activeCollection, kind, page?.threads, sourceIds, store.threads]);
  const effectiveGroupBy = kind === "automation" ? "none" : groupBy;
  const groups = groupWorkspaceThreads(resultThreads, effectiveGroupBy, store.collections, store.agents);

  const chooseCollection = (collectionId: WorkspaceCollectionId) => {
    setActiveCollection(collectionId);
    setMobileFilters(false);
  };
  const createCollection = () => {
    const name = window.prompt("Collection name")?.trim();
    if (!name) return;
    void store.createCollection(name).then((collection) => {
      setActiveCollection(`collection:${collection.id}`);
    }).catch(() => undefined);
  };
  const loadMore = () => {
    const entries = Object.entries(cursorByType) as Array<[WorkspaceQueryType, string]>;
    if (entries.length === 0 || queryLoading) return;
    const id = requestId.current;
    setQueryLoading(true);
    setQueryError(null);
    const requests = entries.map(async ([type, before]) => ({
      type,
      page: await store.queryWorkspaceThreads({
        ...threadQuery(
          activeCollection,
          sourceIds,
          type,
          query,
          view === "list" && kind !== "automation" ? groupBy : "none",
        ),
        before,
      }),
    }));
    void Promise.all(requests).then((next) => {
      if (requestId.current !== id) return;
      setPage((current) => mergePages([
        ...(current === null ? [] : [current]),
        ...next.map(({ page: nextPage }) => nextPage),
      ]));
      setCursorByType(Object.fromEntries(next.flatMap(({ page: nextPage, type }) =>
        nextPage.nextCursor ? [[type, nextPage.nextCursor]] : [])));
    }).catch((error: unknown) => {
      if (requestId.current === id) {
        setQueryError(error instanceof Error ? error.message : "Could not load more conversations.");
      }
    }).finally(() => {
      if (requestId.current === id) setQueryLoading(false);
    });
  };
  const dropOn = (status: WebWorkflowStatus, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const threadId = event.dataTransfer.getData("text/mono-agent-thread");
    const thread = store.threads.find(({ id }) => id === threadId);
    if (thread?.runState.status === "running") return;
    if (threadId) void store.updateThreadWorkspace(threadId, { workflowStatus: status }).catch(() => undefined);
  };

  return (
    <section className="conversation-workspace" aria-label="Conversation workspace">
      <aside ref={filterPanelRef} id="conversation-filters" className={`workspace-navigation${mobileFilters ? " is-mobile-open" : ""}`} aria-label="Conversation collections">
        <header className="workspace-brand">
          <BrandMark />
          <div><span className="eyebrow">mono-agent</span><strong>Conversations</strong></div>
          <button ref={filterCloseRef} type="button" className="icon-button workspace-filter-close" onClick={() => setMobileFilters(false)} aria-label="Close filters">
            <Icon name="close" size={17} />
          </button>
        </header>
        <nav>
          {(["all", "pinned", "unfiled"] as const).map((id) => (
            <button key={id} type="button" aria-current={activeCollection === id ? "page" : undefined} className={activeCollection === id ? "is-active" : ""} onClick={() => chooseCollection(id)}>
              <Icon name={id === "pinned" ? "star" : id === "unfiled" ? "file" : "threads"} size={15} />
              {id === "all" ? "All" : id === "pinned" ? "Pinned" : "Unfiled"}
            </button>
          ))}
        </nav>
        <div className="workspace-collection-heading">
          <span>Collections</span>
          <button type="button" onClick={createCollection} aria-label="New collection"><Icon name="new" size={14} /></button>
        </div>
        <nav className="custom-collections">
          {store.collections.map((collection) => (
            <div key={collection.id} className="custom-collection-row">
              <button
                type="button"
                aria-current={activeCollection === `collection:${collection.id}` ? "page" : undefined}
                className={activeCollection === `collection:${collection.id}` ? "is-active" : ""}
                onClick={() => chooseCollection(`collection:${collection.id}`)}
              >
                <span className="collection-swatch" />{collection.name}
              </button>
              <button
                type="button"
                className="collection-action"
                aria-label={`Rename ${collection.name}`}
                onClick={() => {
                  const name = window.prompt("Collection name", collection.name)?.trim();
                  if (name) void store.renameCollection(collection.id, name).catch(() => undefined);
                }}
              ><Icon name="settings" size={12} /></button>
              <button
                type="button"
                className="collection-action"
                aria-label={`Delete ${collection.name}`}
                onClick={() => {
                  if (!window.confirm(`Delete ${collection.name}? Its conversations will become Unfiled.`)) return;
                  void store.deleteCollection(collection.id).then(() => setActiveCollection("unfiled")).catch(() => undefined);
                }}
              ><Icon name="trash" size={12} /></button>
            </div>
          ))}
          {store.collectionsLoading && <span className="workspace-nav-status">Loading collections…</span>}
        </nav>
        <nav className="workspace-archive-nav">
          <button type="button" onClick={() => store.openMemory()} disabled={store.selectedAgentId === null}>
            <Icon name="memory" size={15} />Memory
          </button>
          <button type="button" aria-current={activeCollection === "archive" ? "page" : undefined} className={activeCollection === "archive" ? "is-active" : ""} onClick={() => chooseCollection("archive")}>
            <Icon name="archive" size={15} />Archive
          </button>
        </nav>
      </aside>
      {mobileFilters && <button type="button" className="workspace-filter-scrim" onClick={() => setMobileFilters(false)} aria-label="Close filters" />}
      <div className="workspace-browser">
        <header className="workspace-toolbar">
          <div className="workspace-toolbar-title">
            <button ref={filterOpenRef} type="button" className="icon-button workspace-filter-open" aria-expanded={mobileFilters} aria-controls="conversation-filters" onClick={() => setMobileFilters(true)} aria-label="Open filters">
              <Icon name="menu" size={18} />
            </button>
            <div>
              <span className="eyebrow">Workspace</span>
              <h1>{activeCollection === "archive" ? "Archive" : kind === "automation" ? "Automations" : activeCollection === "all" ? "All conversations" : activeCollection === "pinned" ? "Pinned" : activeCollection === "unfiled" ? "Unfiled" : collectionName(activeCollection.slice("collection:".length), store.collections)}</h1>
            </div>
          </div>
          <details ref={newMenuRef} className="new-thread-menu">
            <summary className="new-workspace-thread" aria-label="New conversation">
              <Icon name="new" size={15} /> New
            </summary>
            <div role="menu" aria-label="Choose agent for new conversation">
              <strong>Start with</strong>
              {store.agents.map((agent) => (
                <button
                  key={agent.sourceId}
                  type="button"
                  role="menuitem"
                  disabled={agent.status === "offline"}
                  onClick={() => {
                    newMenuRef.current?.removeAttribute("open");
                    void store.createThread(agent.sourceId).catch(() => undefined);
                  }}
                >
                  <span className={`workspace-agent-dot is-${agent.status}`} />
                  <span>{agent.label}</span>
                  {agent.sourceId === store.selectedAgentId && <Icon name="check" size={13} />}
                </button>
              ))}
            </div>
          </details>
        </header>
        <div className="workspace-controls">
          <label className="workspace-search">
            <Icon name="search" size={15} />
            <span className="sr-only">Search all messages</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages" />
            {queryLoading && <span className="workspace-search-progress" aria-label="Searching" />}
          </label>
          <AgentFilter selected={selectedAgents} onChange={setSelectedAgents} onPreferences={setPreferencesAgent} />
          <label className="workspace-kind-filter">
            <span className="sr-only">Conversation type</span>
            <select value={kind} onChange={(event) => {
              const next = event.target.value as WorkspaceKind;
              setKind(next);
              if (next === "automation") {
                setActiveCollection(activeCollection === "archive" ? "archive" : "all");
                setGroupBy("none");
              }
            }}>
              <option value="interactive">Interactive</option>
              <option value="automation">Automations</option>
            </select>
          </label>
        </div>
        <div className="workspace-viewbar">
          <div role="group" aria-label="Conversation view">
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
            <button type="button" aria-pressed={view === "kanban"} disabled={kind === "automation" || activeCollection === "archive"} onClick={() => setView("kanban")}>Kanban</button>
          </div>
          {view === "list" && (
            <label>
              <span>Group</span>
              <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as ThreadListGroupBy)}>
                <option value="none">None</option>
                <option value="collection" disabled={kind === "automation"}>Collection</option>
                <option value="agent">Agent</option>
              </select>
            </label>
          )}
        </div>
        <div className={`workspace-results is-${view}`} aria-busy={queryLoading}>
          {queryError !== null && (
            <div className="workspace-query-error" role="alert">{queryError}</div>
          )}
          {view === "list" ? (
            groups.map((group) => (
              <section
                className="workspace-list-group"
                key={group.id}
                role="group"
                aria-labelledby={groupBy === "none" ? undefined : `group-${group.id}`}
              >
                {groupBy !== "none" && <h2 id={`group-${group.id}`}>{group.label}<span>{group.threads.length}</span></h2>}
                <div>{group.threads.map((thread) => <ThreadCard key={thread.id} thread={thread} />)}</div>
              </section>
            ))
          ) : (
            <>
              <div className="kanban-mobile-tabs" role="tablist" aria-label="Workflow status">
                {WORKFLOW_COLUMNS.map((column) => (
                  <button
                    key={column.id}
                    type="button"
                    role="tab"
                    id={`kanban-tab-${column.id}`}
                    aria-selected={mobileStatus === column.id}
                    aria-controls={`kanban-${column.id}`}
                    tabIndex={mobileStatus === column.id ? 0 : -1}
                    onClick={() => setMobileStatus(column.id)}
                    onKeyDown={(event) => {
                      const current = WORKFLOW_COLUMNS.findIndex(({ id }) => id === column.id);
                      const target = event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? WORKFLOW_COLUMNS.length - 1
                          : event.key === "ArrowLeft"
                            ? (current + WORKFLOW_COLUMNS.length - 1) % WORKFLOW_COLUMNS.length
                            : event.key === "ArrowRight"
                              ? (current + 1) % WORKFLOW_COLUMNS.length
                              : -1;
                      if (target < 0) return;
                      event.preventDefault();
                      const next = WORKFLOW_COLUMNS[target]!;
                      setMobileStatus(next.id);
                      document.getElementById(`kanban-tab-${next.id}`)?.focus();
                    }}
                  >
                    {column.label}<span>{resultThreads.filter((thread) => thread.workflowStatus === column.id).length}</span>
                  </button>
                ))}
              </div>
              <div className="kanban-board">
                {WORKFLOW_COLUMNS.map((column) => {
                  const items = resultThreads.filter((thread) => (thread.workflowStatus ?? "todo") === column.id);
                  return (
                    <section
                      key={column.id}
                      id={`kanban-${column.id}`}
                      role="tabpanel"
                      className={`kanban-column${mobileStatus === column.id ? " is-mobile-active" : ""}`}
                      aria-labelledby={`kanban-tab-${column.id}`}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => dropOn(column.id, event)}
                    >
                      <h2 id={`kanban-title-${column.id}`}>{column.label}<span>{items.length}</span></h2>
                      <div>
                        {items.map((thread) => (
                          <ThreadCard
                            key={thread.id}
                            thread={thread}
                            draggable
                            onDragStart={(event, threadId) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/mono-agent-thread", threadId);
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {!queryLoading && queryError === null && resultThreads.length === 0 && (
            <div className="workspace-empty" role="status">
              <Icon name={query ? "search" : activeCollection === "archive" ? "archive" : "threads"} size={22} />
              <strong>{query ? "No matching conversations" : "No conversations here"}</strong>
              <span>{query ? "Try a different search or filter." : kind === "automation" ? "Cron and webhook conversations appear here." : "Start a conversation or choose another collection."}</span>
            </div>
          )}
          {Object.keys(cursorByType).length > 0 && (
            <button type="button" className="workspace-load-more" disabled={queryLoading} onClick={loadMore}>
              {queryLoading ? "Loading…" : "Load more conversations"}
            </button>
          )}
        </div>
      </div>
      {preferencesAgent && <AgentPreferencesDialog agent={preferencesAgent} onClose={closePreferences} />}
    </section>
  );
}
