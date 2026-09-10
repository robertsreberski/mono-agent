import { Fragment } from "react";
import { Icon } from "../Icon";
import { threadPresentation } from "../../thread-presentation";
import type { AgentSummary, ThreadSummary } from "../../types";
import { relativeTime } from "../time";
import {
  agentInitials,
  RUNNING_CARDS_PER_AGENT,
  runningThreadCount,
  type RunningAgentGroup,
} from "./dashboard-model";

function RunningCard({
  agent,
  thread,
  onOpen,
}: {
  readonly agent: AgentSummary;
  readonly thread: ThreadSummary;
  readonly onOpen: (thread: ThreadSummary) => void;
}) {
  const presentation = threadPresentation(thread);
  return (
    <button
      type="button"
      className="running-card"
      aria-label={`Open ${thread.title} on ${agent.label}`}
      onClick={() => onOpen(thread)}
    >
      <span className="running-card-agent" aria-hidden="true">{agentInitials(agent.label)}</span>
      <span className="running-card-copy">
        <span className="running-card-title">{thread.title}</span>
        <span className="running-card-status">{presentation.text}</span>
      </span>
      <time className="running-card-time" dateTime={thread.updatedAt}>
        {relativeTime(thread.updatedAt)}
      </time>
    </button>
  );
}

/**
 * What this browser is HOLDING that has work in flight, whichever agent owns it.
 *
 * Deliberately silent when empty rather than claiming "0 running": the section
 * is built from the conversation cache, so it can only speak for what this tab
 * happens to hold, and an absence here is not evidence that the fleet is idle.
 * The count says how many CACHED conversations are working, for the same
 * reason.
 */
export function RunningSection({
  groups,
  expandedAgentIds,
  onToggleAgent,
  onOpen,
}: {
  readonly groups: readonly RunningAgentGroup[];
  readonly expandedAgentIds: ReadonlySet<string>;
  readonly onToggleAgent: (sourceId: string) => void;
  readonly onOpen: (thread: ThreadSummary) => void;
}) {
  if (groups.length === 0) return null;
  const total = runningThreadCount(groups);

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-running-label">
      <h2
        className="dashboard-section-label is-running"
        id="dashboard-running-label"
        aria-label={`Running, ${String(total)} cached`}
      >
        <Icon name="activity" size={13} />
        Running
        <span className="dashboard-section-count" title="Conversations this browser is holding">
          {total}
        </span>
      </h2>
      {groups.map((group) => {
        const expanded = expandedAgentIds.has(group.agent.sourceId);
        const shown = expanded
          ? group.threads
          : group.threads.slice(0, RUNNING_CARDS_PER_AGENT);
        const hidden = group.threads.length - shown.length;
        return (
          <Fragment key={group.agent.sourceId}>
            {shown.map((thread) => (
              <RunningCard key={thread.id} agent={group.agent} thread={thread} onOpen={onOpen} />
            ))}
            {(hidden > 0 || expanded) && group.threads.length > RUNNING_CARDS_PER_AGENT && (
              <button
                type="button"
                className="running-more"
                onClick={() => onToggleAgent(group.agent.sourceId)}
              >
                {expanded
                  ? `Show fewer · ${group.agent.label}`
                  : `+${String(hidden)} more · ${group.agent.label}`}
              </button>
            )}
          </Fragment>
        );
      })}
    </section>
  );
}
