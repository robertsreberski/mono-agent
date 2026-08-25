import { useEffect, useState } from "react";
import { useConsoleStore } from "../console-store";
import { setThreadNotificationsMuted, threadNotificationsMuted } from "../thread-notifications";
import { BottomSheet } from "./sheets/BottomSheet";

export function ConversationDetails({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const store = useConsoleStore();
  const thread = store.selectedThread;
  const [title, setTitle] = useState(thread?.title ?? "");
  const [labels, setLabels] = useState(thread?.labels.join(", ") ?? "");
  const [project, setProject] = useState(thread?.project ?? "");
  const [muted, setMuted] = useState(thread ? threadNotificationsMuted(thread.id) : false);
  useEffect(() => {
    setTitle(thread?.title ?? "");
    setLabels(thread?.labels.join(", ") ?? "");
    setProject(thread?.project ?? "");
    setMuted(thread ? threadNotificationsMuted(thread.id) : false);
  }, [thread?.id, thread?.labels, thread?.project, thread?.title]);
  if (thread === null) return null;
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Conversation details">
      <div className="conversation-details-form">
        <label>Title<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() && title.trim() !== thread.title) void store.renameThread(thread.id, title.trim()); }} /></label>
        <label>State<select value={thread.state} onChange={(event) => void store.setThreadState(thread.id, event.target.value as typeof thread.state)}><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option></select></label>
        <label>Labels<input value={labels} placeholder="planning, customer" onChange={(event) => setLabels(event.target.value)} onBlur={() => void store.setThreadLabels(thread.id, labels.split(","))} /><small>Comma-separated, up to 16 labels.</small></label>
        <label>Project<input value={project} maxLength={120} placeholder="No project" onChange={(event) => setProject(event.target.value)} onBlur={() => void store.setThreadProject(thread.id, project.trim() || null)} /></label>
        {thread.trigger?.kind !== "cron" && <button type="button" className="details-row" onClick={() => { onOpenChange(false); window.dispatchEvent(new CustomEvent("mono-agent:run-settings")); }}><span>Model</span><strong>{store.effectiveModel || "Agent default"} · {store.effectiveEffort || "provider"}{store.hasRunOverride ? " · custom" : " · default"}</strong></button>}
        <button type="button" className="details-row" onClick={() => { const next = !muted; setMuted(next); void setThreadNotificationsMuted(thread.id, next); }}><span>Notifications</span><strong>{muted ? "Muted" : "On"}</strong></button>
        <button type="button" className="details-row" onClick={() => void store.setThreadPinned(thread.id, thread.pinnedAt === null)}><span>{thread.pinnedAt === null ? "Pin conversation" : "Unpin conversation"}</span><strong>{thread.pinnedAt === null ? "☆" : "★"}</strong></button>
        <button type="button" className="details-row" onClick={() => void (thread.archivedAt ? store.unarchiveThread(thread.id) : store.archiveThread(thread.id))}><span>{thread.archivedAt ? "Restore conversation" : "Archive conversation"}</span></button>
        {thread.archivedAt && (thread.trigger?.kind !== "cron" || thread.trigger.configured === false) && <button type="button" className="details-row is-danger" onClick={() => { if (window.confirm("Permanently delete this conversation and its attachments?")) { onOpenChange(false); void store.deleteThread(thread.id); } }}><span>Delete permanently</span></button>}
      </div>
    </BottomSheet>
  );
}
