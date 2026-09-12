import { Fragment, useMemo } from "react";
import { useConsoleStore } from "../console-store";
import {
  highlightSegments,
  highlightTitle,
  type HighlightSegment,
  type ThreadSearchState,
} from "../thread-search";
import type { AgentSummary, CatalogModel, ThreadSearchHit } from "../types";
import { Icon } from "./Icon";
import { flattenCatalogModels, resolveThreadRoute } from "./route-label";
import { RouteBadge } from "./RouteBadge";
import { relativeTime } from "./time";

function Highlighted({ segments }: { readonly segments: readonly HighlightSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment.match ? <mark>{segment.text}</mark> : segment.text}
        </Fragment>
      ))}
    </>
  );
}

function SearchHit({
  hit,
  query,
  agent,
  catalogModels,
  onSelect,
  highlightSelected,
}: {
  readonly hit: ThreadSearchHit;
  readonly query: string;
  /** The hit's OWN agent match; null when discovery no longer lists it. */
  readonly agent: AgentSummary | null;
  readonly catalogModels: Readonly<Record<string, readonly CatalogModel[]>> | undefined;
  readonly onSelect?: () => void;
  readonly highlightSelected: boolean;
}) {
  const { selectThread, selectedThreadId } = useConsoleStore();
  const { thread } = hit;
  const active = highlightSelected && thread.id === selectedThreadId;
  // Search replaces the list, so its hits carry the same current-settings
  // badge the rows they stand in for draw.
  const route = resolveThreadRoute(thread, agent, catalogModels);
  return (
    <button
      type="button"
      className={`thread-search-hit${active ? " is-active" : ""}`}
      aria-label={`Open ${thread.title}`}
      onClick={() => {
        selectThread(thread.id);
        onSelect?.();
      }}
    >
      <span className="thread-title-line">
        <span className="thread-title">
          <Highlighted segments={highlightTitle(thread.title, query)} />
        </span>
        {thread.trigger && (
          <span className="trigger-badge">{thread.trigger.kind}</span>
        )}
        <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
      </span>
      <span className="thread-preview">
        <span className="thread-preview-text">
          {hit.snippet === undefined
            ? hit.titleMatch
              ? "Matched the title"
              : thread.lastMessagePreview || "No matching message text"
            : <Highlighted segments={highlightSegments(hit.snippet)} />}
        </span>
        {hit.messageMatches > 1 && (
          <span className="thread-search-count">{`${String(hit.messageMatches)} matches`}</span>
        )}
        <RouteBadge
          modelShort={route.modelShort}
          effortShort={route.effortShort}
          label={route.label}
          title={route.title}
        />
      </span>
    </button>
  );
}

/**
 * Search results replace the conversation list while a query is active. They
 * come from the server rather than the loaded page, so a conversation the
 * sidebar has never fetched still shows up — and archived ones get their own
 * group instead of being hidden behind the archive toggle.
 */
export function ThreadSearchResults({
  query,
  search,
  onSelect,
  highlightSelected = true,
}: {
  readonly query: string;
  readonly search: ThreadSearchState;
  readonly onSelect?: () => void;
  /**
   * Whether the selected conversation is marked here. The phone Dashboard is
   * the whole screen and the conversation it would be pointing at is not on
   * it, so the mark is withheld -- the store's selection is untouched, exactly
   * as it is for the ordinary rows this list replaces.
   */
  readonly highlightSelected?: boolean;
}) {
  const { agents, catalogByProvider } = useConsoleStore();
  const agentBySourceId = useMemo(
    () => new Map(agents.map((agent) => [agent.sourceId, agent])),
    [agents],
  );
  const catalogModels = useMemo(
    () => flattenCatalogModels(catalogByProvider),
    [catalogByProvider],
  );
  const active = search.hits.filter((hit) => hit.thread.archivedAt === null);
  const archived = search.hits.filter((hit) => hit.thread.archivedAt !== null);

  if (search.status === "error") {
    return (
      <div className="thread-list-empty" role="alert">
        <Icon name="search" size={19} />
        <span>Search is unavailable right now</span>
      </div>
    );
  }
  if (search.hits.length === 0) {
    return (
      <div className="thread-list-empty">
        <Icon name="search" size={19} />
        <span>
          {search.status === "loading" ? "Searching…" : "No matching conversations"}
        </span>
      </div>
    );
  }
  return (
    <div className="thread-search-results" aria-busy={search.status === "loading"}>
      {active.length > 0 && (
        <section>
          <h2 className="thread-search-group">Conversations</h2>
          {active.map((hit) => (
            <SearchHit
              key={hit.thread.id}
              hit={hit}
              query={query}
              agent={agentBySourceId.get(hit.thread.sourceId) ?? null}
              catalogModels={catalogModels}
              onSelect={onSelect}
              highlightSelected={highlightSelected}
            />
          ))}
        </section>
      )}
      {archived.length > 0 && (
        <section>
          <h2 className="thread-search-group">Archived</h2>
          {archived.map((hit) => (
            <SearchHit
              key={hit.thread.id}
              hit={hit}
              query={query}
              agent={agentBySourceId.get(hit.thread.sourceId) ?? null}
              catalogModels={catalogModels}
              onSelect={onSelect}
              highlightSelected={highlightSelected}
            />
          ))}
        </section>
      )}
      {search.truncated && (
        <p className="thread-search-truncated">
          Showing the closest matches. Add a word to narrow the search.
        </p>
      )}
    </div>
  );
}
