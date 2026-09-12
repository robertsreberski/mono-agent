import { Fragment } from "react";
import { Icon } from "../Icon";
import type { AgentSummary, CatalogModel, ThreadSummary } from "../../types";
import { resolveThreadRoute } from "../route-label";
import { RouteBadge } from "../RouteBadge";
import { relativeTime } from "../time";
import {
  agentInitials,
  runningCardPending,
  runningCardStatus,
  RUNNING_CARDS_PER_AGENT,
  runningThreadCount,
  type RunningAgentGroup,
} from "./dashboard-model";

function RunningCard({
  agent,
  thread,
  catalogModels,
  onOpen,
}: {
  readonly agent: AgentSummary;
  readonly thread: ThreadSummary;
  readonly catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>;
  readonly onOpen: (thread: ThreadSummary) => void;
}) {
  const pending = runningCardPending(thread);
  // The card's OWN agent, never the selected one: fleet rows span agents.
  const route = resolveThreadRoute(thread, agent, catalogModels);
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
        <span className="running-card-status-line">
          <span className={`running-card-status${pending ? " is-pending" : ""}`}>
            {runningCardStatus(thread)}
          </span>
          <RouteBadge
            modelShort={route.modelShort}
            effortShort={route.effortShort}
            label={route.label}
            title={route.title}
          />
        </span>
      </span>
      <time className="running-card-time" dateTime={thread.updatedAt}>
        {relativeTime(thread.updatedAt)}
      </time>
    </button>
  );
}

/**
 * What the FLEET has in flight -- every agent the server discovered, whether or
 * not this browser has ever opened one of their conversations.
 *
 * The count beside the label is the server's, taken over the whole qualifying
 * set rather than over the cards: a section showing fifty of sixty-three says
 * so underneath rather than quietly reporting fifty.
 *
 * When no server answer stands behind what is drawn -- no stream, a read that
 * failed, a device snapshot on a cold start -- the section says LAST KNOWN and
 * means it. It is still silent when there is nothing to draw, because an
 * unlabelled "0 running" from a console that cannot see the fleet is the one
 * claim this section must never make.
 */
export function RunningSection({
  groups,
  expandedAgentIds,
  onToggleAgent,
  onOpen,
  total,
  truncated = false,
  authoritative = true,
  catalogModels,
}: {
  readonly groups: readonly RunningAgentGroup[];
  readonly expandedAgentIds: ReadonlySet<string>;
  readonly onToggleAgent: (sourceId: string) => void;
  readonly onOpen: (thread: ThreadSummary) => void;
  /** Running conversations in the whole fleet; the cards may be fewer. */
  readonly total?: number;
  /** The server had more than it may carry, so the cards are part of the answer. */
  readonly truncated?: boolean;
  /** A live server answer stands behind this. See the note above. */
  readonly authoritative?: boolean;
  /**
   * The store's already-fetched catalog projection. Optional so standalone
   * callers keep working; without it a catalog-only route honestly reports no
   * effort rather than a guessed one.
   */
  readonly catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>;
}) {
  if (groups.length === 0) return null;
  const shown = runningThreadCount(groups);
  const claimed = total ?? shown;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-running-label">
      <h2
        className="dashboard-section-label is-running"
        id="dashboard-running-label"
        aria-label={`Running, ${String(claimed)}${authoritative ? "" : ", last known"}`}
      >
        <Icon name="activity" size={13} />
        Running
        <span
          className="dashboard-section-count"
          title={authoritative
            ? "Conversations running across the fleet"
            : "The last thing the server said; not confirmed just now"}
        >
          {claimed}
        </span>
        {!authoritative && (
          <span className="dashboard-section-note" aria-hidden="true">last known</span>
        )}
      </h2>
      {groups.map((group) => {
        const expanded = expandedAgentIds.has(group.agent.sourceId);
        const cards = expanded
          ? group.threads
          : group.threads.slice(0, RUNNING_CARDS_PER_AGENT);
        const hidden = group.threads.length - cards.length;
        return (
          <Fragment key={group.agent.sourceId}>
            {cards.map((thread) => (
              <RunningCard
                key={thread.id}
                agent={group.agent}
                thread={thread}
                {...(catalogModels === undefined ? {} : { catalogModels })}
                onOpen={onOpen}
              />
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
      {truncated && (
        <p className="running-truncated">
          {`Showing ${String(shown)} of ${String(claimed)}`}
        </p>
      )}
    </section>
  );
}
