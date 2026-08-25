import { useConsoleStore } from "../console-store";
import { BottomSheet } from "./sheets/BottomSheet";

export function NewConversationSheet({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const store = useConsoleStore();
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="New conversation">
      <p className="sheet-intro">Choose the agent for this conversation.</p>
      <div className="new-agent-list">{store.agents.map((agent) => <button key={agent.sourceId} type="button" disabled={agent.status === "offline"} onClick={() => { onOpenChange(false); void store.createThread(agent.sourceId); }}><span className="agent-initials">{agent.label.slice(0, 2).toUpperCase()}</span><span><strong>{agent.label}</strong><small>{agent.status === "offline" ? "Offline" : agent.status === "degraded" ? "Degraded · available" : "Online"}</small></span></button>)}</div>
    </BottomSheet>
  );
}
