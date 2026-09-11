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
 * nor reachable without clipping. The square still SHOWS it -- a pinned agent
 * sorts first, and a list whose order has a reason nowhere on it is a list that
 * looks shuffled.
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
    unreadCountByAgent,
  } = useConsoleStore();

  return (
    <nav className="agent-strip" aria-label="Agents">
      <div className="agent-strip-scroll" role="list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          const selected = selectedAgentId === agent.sourceId;
          const running = runningCounts?.get(agent.sourceId) ?? 0;
          // Work in flight WINS the corner. Both at once would be two numbers
          // in one 16-pixel circle, and what is happening right now is the more
          // urgent of the two; the unread count is still there underneath, and
          // comes back the moment the work finishes.
          const unread = running > 0 ? 0 : unreadCountByAgent.get(agent.sourceId) ?? 0;
          const badge = running > 0 ? running : unread;
          return (
            <div className={`agent-chip${selected ? " is-selected" : ""}`} role="listitem" key={agent.sourceId}>
              <button
                type="button"
                className={`agent-chip-square is-${agent.status}${selected ? " is-active" : ""}`}
                aria-pressed={selected}
                aria-label={`${agent.label}, ${agent.status}${pinned ? ", pinned" : ""}${running > 0 ? `, ${String(running)} running` : ""}${unread > 0 ? `, ${String(unread)} unread` : ""}`}
                title={`${agent.label} · ${agent.status}`}
                onClick={() => selectAgent(agent.sourceId)}
              >
                <span className="agent-chip-initials">{agentInitials(agent.label)}</span>
                {/* The accessible name already says ", pinned"; this is the same
                    fact for the eye, in the corner the count does not take. */}
                {pinned && (
                  <span className="agent-chip-pin" aria-hidden="true">
                    <Icon name="star" size={9} fill="currentColor" />
                  </span>
                )}
                {badge > 0 && (
                  <span
                    className={`agent-chip-badge${running > 0 ? "" : " is-unread"}`}
                    aria-hidden="true"
                  >
                    {badge}
                  </span>
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
        {/* The rest of the fleet rides at the END of the same line rather than
            on a fixed square at the right edge: the line scrolls the whole
            width of the screen, and the control is where the agents it reveals
            will appear. */}
        {hiddenOfflineAgentCount > 0 && (
          <div className="agent-strip-more" role="listitem">
            {/* The agents' own square and the agents' own count badge: what it
                reveals is agents, so it is the same object drawn as an
                outline. */}
            <button
              type="button"
              className={`agent-chip-square agent-strip-offline${showOfflineAgents ? " is-active" : ""}`}
              aria-pressed={showOfflineAgents}
              aria-label={showOfflineAgents
                ? "Hide offline agents"
                : `Show ${hiddenOfflineAgentCount} offline agent${hiddenOfflineAgentCount === 1 ? "" : "s"}`}
              title={showOfflineAgents ? "Hide offline agents" : `Show ${hiddenOfflineAgentCount} offline`}
              onClick={() => setShowOfflineAgents(!showOfflineAgents)}
            >
              <Icon name={showOfflineAgents ? "eye-off" : "eye"} size={17} />
              <span className="agent-chip-badge is-unread" aria-hidden="true">{hiddenOfflineAgentCount}</span>
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
