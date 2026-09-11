import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";
import { agentInitials, agentShortLabel } from "./dashboard-model";

/**
 * Every agent as one square, on one horizontally scrolling line.
 *
 * Selecting an agent deliberately does NOT leave the Dashboard: the operator
 * has chosen where to look, not what to look at, and the list they need next
 * is directly underneath.
 *
 * Pinning is not on the strip. It is the selected agent's setting, in the
 * agent settings dialog behind the header's gear and in the command palette;
 * a control hanging off a square's corner was neither discoverable on a phone
 * nor reachable without clipping.
 */
export function AgentStrip({
  runningCounts,
}: {
  /** Conversations with work in flight, per agent; drawn as a badge. */
  readonly runningCounts?: ReadonlyMap<string, number>;
} = {}) {
  const {
    visibleAgents,
    hiddenOfflineAgentCount,
    selectedAgentId,
    showOfflineAgents,
    selectAgent,
    setShowOfflineAgents,
  } = useConsoleStore();

  return (
    <nav className="agent-strip" aria-label="Agents">
      <div className="agent-strip-scroll" role="list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          const selected = selectedAgentId === agent.sourceId;
          const running = runningCounts?.get(agent.sourceId) ?? 0;
          return (
            <div className={`agent-chip${selected ? " is-selected" : ""}`} role="listitem" key={agent.sourceId}>
              <button
                type="button"
                className={`agent-chip-square is-${agent.status}${selected ? " is-active" : ""}`}
                aria-pressed={selected}
                aria-label={`${agent.label}, ${agent.status}${pinned ? ", pinned" : ""}${running > 0 ? `, ${String(running)} running` : ""}`}
                title={`${agent.label} · ${agent.status}`}
                onClick={() => selectAgent(agent.sourceId)}
              >
                <span className="agent-chip-initials">{agentInitials(agent.label)}</span>
                {running > 0 && (
                  <span className="agent-chip-badge" aria-hidden="true">{running}</span>
                )}
              </button>
              <span className="agent-chip-label" title={agent.label}>{agentShortLabel(agent.label)}</span>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <p className="agent-strip-empty">
            No agents discovered. Running agents will appear automatically.
          </p>
        )}
      </div>
      {hiddenOfflineAgentCount > 0 && (
        <button
          type="button"
          className={`agent-strip-offline${showOfflineAgents ? " is-active" : ""}`}
          aria-pressed={showOfflineAgents}
          aria-label={showOfflineAgents
            ? "Hide offline agents"
            : `Show ${hiddenOfflineAgentCount} offline agent${hiddenOfflineAgentCount === 1 ? "" : "s"}`}
          title={showOfflineAgents ? "Hide offline agents" : `Show ${hiddenOfflineAgentCount} offline`}
          onClick={() => setShowOfflineAgents(!showOfflineAgents)}
        >
          <Icon name={showOfflineAgents ? "eye-off" : "eye"} size={15} />
          <span className="agent-strip-offline-count">{hiddenOfflineAgentCount}</span>
        </button>
      )}
    </nav>
  );
}
