import { ThreadListPrimitive } from "@assistant-ui/react";
import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";

/**
 * Who this console is, which agent it is pointed at, and the two things an
 * operator does most: change that agent's defaults, or start talking to it.
 *
 * The command palette keeps its shortcut (⌘K) and has no button here; the
 * connection state is announced, not drawn.
 */
export function DashboardHeader({ onNavigate }: { readonly onNavigate?: () => void }) {
  const {
    bootstrap,
    connection,
    creatingThread,
    selectedAgent,
    selectionError,
    selectionLoading,
  } = useConsoleStore();
  const consoleName = bootstrap?.console.displayName ?? "mono-agent";

  return (
    <header className="dashboard-header">
      <div className="dashboard-utility">
        <span className="dashboard-brand eyebrow" title={consoleName}>{consoleName}</span>
        {/* Spoken, not drawn: the conversation's banner already shows trouble,
            and a light that is green all day is decoration. */}
        <span className="sr-only" role="status" aria-label={`Console connection: ${connection}`} />
      </div>
      <div className="dashboard-title-row">
        <h1 className="dashboard-agent-name">{selectedAgent?.label ?? "No agent"}</h1>
        <div className="dashboard-header-actions">
          <button
            type="button"
            className="agent-settings-button"
            aria-label="Agent settings"
            title="Agent settings"
            disabled={!selectedAgent}
            onClick={() => {
              onNavigate?.();
              window.dispatchEvent(new CustomEvent("mono-agent:agent-settings"));
            }}
          >
            <Icon name="settings" size={17} />
          </button>
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
              : <Icon name="new" size={18} />}
          </ThreadListPrimitive.New>
        </div>
      </div>
    </header>
  );
}
