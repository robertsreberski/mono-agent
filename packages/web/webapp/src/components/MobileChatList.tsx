import { useMemo, useState } from "react";
import { useConsoleStore } from "../console-store";
import { Icon } from "./Icon";
import { relativeTime } from "./time";

export function MobileChatList({ onOpenDefaults }: { readonly onOpenDefaults: () => void }) {
  const store = useConsoleStore();
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const threads = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return [...store.threads]
      .filter((thread) => thread.archivedAt === null && (agentId === null || thread.sourceId === agentId))
      .filter((thread) => normalized.length === 0 || thread.title.toLocaleLowerCase().includes(normalized) || thread.lastMessagePreview?.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [agentId, query, store.threads]);
  const pinned = threads.filter((thread) => thread.pinnedAt !== null);
  const recent = threads.filter((thread) => thread.pinnedAt === null);
  const counts = useMemo(() => {
    const next = new Map<string, number>();
    for (const thread of store.threads) {
      if (thread.archivedAt === null) next.set(thread.sourceId, (next.get(thread.sourceId) ?? 0) + 1);
    }
    return next;
  }, [store.threads]);
  const row = (thread: (typeof threads)[number]) => {
    const agent = store.agents.find((candidate) => candidate.sourceId === thread.sourceId);
    return (
      <div key={thread.id} className="mobile-chat-row">
        <button type="button" className="mobile-chat-open" aria-label={`Open ${thread.title}`} onClick={() => store.navigate({ view: "chats", threadId: thread.id })}>
          <span className="mobile-chat-copy"><span><strong>{thread.title}</strong><time>{relativeTime(thread.updatedAt)}</time></span><small>{thread.runState.status === "running" && <i />}{thread.lastMessagePreview ?? "New conversation"}</small><em>{agent?.label ?? thread.sourceId}</em></span>
        </button>
        <button type="button" className={`mobile-pin${thread.pinnedAt !== null ? " is-pinned" : ""}`} aria-label={thread.pinnedAt === null ? `Pin ${thread.title}` : `Unpin ${thread.title}`} onClick={() => { void store.setThreadPinned(thread.id, thread.pinnedAt === null); }}><Icon name="star" size={18} /></button>
      </div>
    );
  };
  return (
    <main className="mobile-chat-list">
      <header><div><span className="eyebrow">Workspace</span><h1>Chats</h1></div><button type="button" className="icon-button" onClick={onOpenDefaults} aria-label="Agent defaults"><Icon name="settings" size={19} /></button><button type="button" className="new-thread-button" onClick={() => window.dispatchEvent(new CustomEvent("mono-agent:new-thread"))} aria-label="New conversation"><Icon name="new" size={19} /></button></header>
      <label className="thread-search"><Icon name="search" size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /></label>
      <div className="mobile-agent-chips"><button type="button" className={agentId === null ? "is-active" : ""} onClick={() => setAgentId(null)}>All <b>{[...counts.values()].reduce((sum, count) => sum + count, 0)}</b></button>{store.agents.map((agent) => <button key={agent.sourceId} type="button" className={agentId === agent.sourceId ? "is-active" : ""} onClick={() => setAgentId(agent.sourceId)}>{agent.label} <b>{counts.get(agent.sourceId) ?? 0}</b></button>)}</div>
      <div className="mobile-chat-scroll">{pinned.length > 0 && <section><h2>Pinned</h2>{pinned.map(row)}</section>}<section><h2>Recent</h2>{recent.map(row)}{threads.length === 0 && <p className="workspace-empty">No conversations found.</p>}</section></div>
    </main>
  );
}
