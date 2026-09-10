import { ThreadListPrimitive } from "@assistant-ui/react";
import { useConsoleStore } from "../../console-store";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

/**
 * Who this console is, which agent it is pointed at, and the two things an
 * operator does most: change that agent's defaults, or start talking to it.
 *
 * The utility row above carries what used to sit at the foot of the agent rail
 * -- the connection light and the command palette -- because there is no rail
 * any more and both belong to the console rather than to the agent.
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
        <span className="dashboard-brand" title={consoleName}>
          <BrandMark />
          <span className="eyebrow">{consoleName}</span>
        </span>
        <button
          type="button"
          className="dashboard-command"
          aria-label="Open command palette"
          title="Command palette (⌘K)"
          onClick={() => window.dispatchEvent(new Event("mono-agent:command"))}
        >
          <Icon name="command" size={16} />
        </button>
        <span
          className={`dashboard-connection is-${connection}`}
          aria-label={`Console connection: ${connection}`}
          title={`Console ${connection}`}
        />
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
