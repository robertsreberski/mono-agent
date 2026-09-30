import { useAuth } from "../../auth";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";
import { useSettingsDraft } from "../../settings-drafts";
import { NotificationBell } from "../../notifications";

/**
 * Who this console is, which agent it is pointed at, and the three controls
 * that belong to the console rather than to one conversation: notifications,
 * the agent's defaults, and a new conversation.
 *
 * The command palette keeps its shortcut (⌘K) and has no button here; the
 * connection state is announced, not drawn.
 */
export function DashboardHeader({ onNavigate, settingsOpen = false }: { readonly onNavigate?: () => void; readonly settingsOpen?: boolean }) {
  const {
    bootstrap,
    connection,
    creatingThread,
    selectedAgent,
    selectionError,
    selectionLoading,
  } = useConsoleStore();
  const { admin, multiUser, user } = useAuth();
  const draft = useSettingsDraft(selectedAgent?.sourceId ?? "");
  const saved = selectedAgent?.runSettings.override;
  const hasDraft = draft !== null && (draft.model !== (saved?.model ?? "") || draft.effort !== (saved?.effort ?? ""));
  const consoleName = bootstrap?.console.displayName ?? "mono-agent";

  return (
    <header className="dashboard-header">
      {/* The same band as the conversation header beside it: one row, title
          block left, actions right. */}
      <div className="dashboard-title-block">
        <span className="dashboard-brand eyebrow" title={consoleName}>{consoleName}</span>
        <h1 className="dashboard-agent-name">{selectedAgent?.label ?? "No agent"}</h1>
        {/* Spoken, not drawn: the conversation's banner already shows trouble,
            and a light that is green all day is decoration. */}
        <span className="sr-only" role="status" aria-label={`Console connection: ${connection}`} />
      </div>
      <div className="dashboard-header-actions">
        <NotificationBell />
        {multiUser && <button type="button" className="agent-settings-button" aria-label="Your profile" title={`${user?.displayName ?? "Account"} · Profile`} onClick={() => window.dispatchEvent(new Event("mono-agent:account"))}><Icon name="agent" size={16} /></button>}
        {admin && <button
          type="button"
          className="agent-settings-button"
          aria-label="Agent settings"
          title="Agent settings"
          aria-expanded={settingsOpen}
          disabled={!selectedAgent}
          // The dialog is not a destination: it opens over the screen the
          // operator is on, and closing it leaves them there. Navigating first
          // pushed the phone's conversation underneath it, and popping the
          // dialog revealed a conversation nobody asked for.
          onClick={() => { window.dispatchEvent(new CustomEvent("mono-agent:agent-settings")); }}
        >
          <Icon name="settings" size={16} />
          {hasDraft && <span className="settings-dot" aria-hidden="true" />}
        </button>}
        <ThreadListPrimitive.New
          className="new-thread-button"
          aria-label={creatingThread ? "Creating conversation" : "New conversation"}
          aria-busy={creatingThread || undefined}
          title={creatingThread ? "Creating conversation…" : "New conversation (⌘⇧O)"}
          onClick={onNavigate}
          disabled={!selectedAgent || selectionLoading || selectionError !== null}
        >
          {creatingThread
            ? <span className="new-thread-spinner" aria-hidden="true" />
            : <Icon name="new" size={17} />}
        </ThreadListPrimitive.New>
      </div>
    </header>
  );
}
