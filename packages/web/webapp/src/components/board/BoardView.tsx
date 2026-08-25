import { useEffect, useMemo, useState } from "react";
import { useConsoleStore } from "../../console-store";
import type { ThreadSummary } from "../../types";
import { Icon } from "../Icon";
import { relativeTime } from "../time";
import {
  agentCounts,
  boardThreads,
  groupThreads,
  labelColorIndex,
  nextThreadState,
  type BoardGroupBy,
} from "./board-selectors";

type BoardLayout = "kanban" | "list";
const BOARD_LAYOUT_KEY = "mono-agent.web.board.layout";
const BOARD_GROUP_KEY = "mono-agent.web.board.group";
const BOARD_PREVIEW_KEY = "mono-agent.web.board.previews";

export function BoardCard({ thread, showPreview }: { readonly thread: ThreadSummary; readonly showPreview: boolean }) {
  const store = useConsoleStore();
  const agent = store.agents.find((candidate) => candidate.sourceId === thread.sourceId);
  return (
    <article
      className={`board-card${thread.runState.status === "running" ? " is-running" : ""}`}
    >
      <button
        type="button"
        className="board-card-open"
        aria-label={`Open ${thread.title}`}
        onClick={() => store.navigate({ view: "chats", threadId: thread.id })}
      />
      <div className="board-card-agent">
        <span className="agent-initials">{(agent?.label ?? thread.sourceId).slice(0, 2).toUpperCase()}</span>
        <span>{agent?.label ?? thread.sourceId}</span>
        {thread.pinnedAt !== null && <Icon name="star" size={13} />}
      </div>
      <h3>{thread.title}</h3>
      {showPreview && <p>{thread.lastMessagePreview ?? `${String(thread.messageCount)} messages`}</p>}
      <div className="board-card-footer">
        <button
          type="button"
          className={`state-chip is-${thread.state}`}
          onClick={(event) => {
            event.stopPropagation();
            void store.setThreadState(thread.id, nextThreadState(thread.state));
          }}
          aria-label={`Move ${thread.title} to ${nextThreadState(thread.state)}`}
        >
          {thread.runState.status === "running" && <i />}
          {thread.state === "todo" ? "To do" : thread.state === "doing" ? "In progress" : "Done"}
        </button>
        {thread.stateSource === "agent" && <span className="board-agent-state" title="State set by agent"><Icon name="agent" size={12} /></span>}
        <span className="board-labels">
          {thread.labels.slice(0, 2).map((label) => (
            <span key={label} style={{ "--label-color": `var(--cat-${String(labelColorIndex(label) + 1)})` } as React.CSSProperties}>{label}</span>
          ))}
        </span>
        {thread.project !== undefined && <span className="board-project">{thread.project}</span>}
        <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
      </div>
    </article>
  );
}

export function BoardView() {
  const store = useConsoleStore();
  const [layout, setLayout] = useState<BoardLayout>(() => localStorage.getItem(BOARD_LAYOUT_KEY) === "list" ? "list" : "kanban");
  const [groupBy, setGroupBy] = useState<BoardGroupBy>(() => {
    const value = localStorage.getItem(BOARD_GROUP_KEY);
    return value === "agent" || value === "label" || value === "project" ? value : "state";
  });
  const [showPreviews, setShowPreviews] = useState(() => localStorage.getItem(BOARD_PREVIEW_KEY) !== "0");
  const [query, setQuery] = useState("");
  const [agentIds, setAgentIds] = useState<Set<string>>(() => new Set());

  useEffect(() => { void store.loadBoardThreads().catch(() => undefined); }, [store.loadBoardThreads]);
  const counts = useMemo(() => agentCounts(store.threads), [store.threads]);
  const totalCount = useMemo(() => [...counts.values()].reduce((sum, count) => sum + count, 0), [counts]);
  const filtered = useMemo(() => boardThreads(store.threads, query, agentIds), [agentIds, query, store.threads]);
  const groups = useMemo(() => {
    const present = groupThreads(filtered, layout === "kanban" ? "state" : groupBy, store.agents);
    if (layout === "list") return present;
    const byState = new Map(present.map((group) => [group.id, group]));
    return [
      byState.get("todo") ?? { id: "todo", label: "To do", threads: [] },
      byState.get("doing") ?? { id: "doing", label: "In progress", threads: [] },
      byState.get("done") ?? { id: "done", label: "Done", threads: [] },
    ];
  }, [filtered, groupBy, layout, store.agents]);

  return (
    <main className="workspace-view board-view">
      <header className="workspace-header">
        <div><span className="eyebrow">Workspace</span><h1>Conversations</h1></div>
        <label className="workspace-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all conversations" /></label>
        {layout === "list" && (
          <label className="board-group">Group <select value={groupBy} onChange={(event) => { const next = event.target.value as BoardGroupBy; setGroupBy(next); localStorage.setItem(BOARD_GROUP_KEY, next); }}><option value="state">State</option><option value="agent">Agent</option><option value="label">Label</option><option value="project">Project</option></select></label>
        )}
        <div className="segmented-control" aria-label="Board layout">
          {(["kanban", "list"] as const).map((value) => <button key={value} type="button" className={layout === value ? "is-active" : ""} onClick={() => { setLayout(value); localStorage.setItem(BOARD_LAYOUT_KEY, value); }}>{value === "kanban" ? "Kanban" : "List"}</button>)}
        </div>
        <button type="button" className="primary-button workspace-new" onClick={() => window.dispatchEvent(new CustomEvent("mono-agent:new-thread"))}><Icon name="new" size={16} />New</button>
      </header>
      <div className="board-toolbar">
        <button type="button" className={agentIds.size === 0 ? "filter-chip is-active" : "filter-chip"} onClick={() => setAgentIds(new Set())}>All agents <b>{totalCount}</b></button>
        {store.agents.map((agent) => <button key={agent.sourceId} type="button" className={agentIds.has(agent.sourceId) ? "filter-chip is-active" : "filter-chip"} onClick={() => setAgentIds((current) => { const next = new Set(current); if (next.has(agent.sourceId)) next.delete(agent.sourceId); else next.add(agent.sourceId); return next; })}><span className="agent-initials">{agent.label.slice(0, 2).toUpperCase()}</span>{agent.label} <b>{counts.get(agent.sourceId) ?? 0}</b></button>)}
        <label className="preview-toggle"><input type="checkbox" checked={showPreviews} onChange={(event) => { setShowPreviews(event.target.checked); localStorage.setItem(BOARD_PREVIEW_KEY, event.target.checked ? "1" : "0"); }} />Previews</label>
      </div>
      <div className={layout === "kanban" ? "board-kanban" : "board-list"}>
        {groups.map((group) => (
          <section key={group.id || "empty"} className="board-group-section">
            <header><span className={`board-state-dot is-${group.id}`} /><h2>{group.label}</h2><span>{group.threads.length}</span></header>
            <div className="board-group-cards">{group.threads.map((thread) => <BoardCard key={thread.id} thread={thread} showPreview={showPreviews} />)}{group.threads.length === 0 && <p className="board-column-empty">No conversations</p>}</div>
          </section>
        ))}
        {groups.length === 0 && <div className="workspace-empty">No conversations match these filters.</div>}
      </div>
    </main>
  );
}
