import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { useConsoleStore } from "../../console-store";
import { threadPresentation } from "../../thread-presentation";
import type { ThreadSummary } from "../../types";
import { Icon } from "../Icon";
import { ThreadSearchResults } from "../ThreadSearchResults";
import type { ThreadSearchState } from "../../thread-search";
import { relativeTime } from "../time";
import {
  dashboardKindIcon,
  dashboardKindLabel,
  dashboardThreadKind,
  matchesRecentFilter,
  type RecentFilter,
} from "./dashboard-model";

const CHIPS: readonly { readonly id: RecentFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "cron", label: "Cron" },
];

function ThreadListItem({
  thread,
  archived,
  onNavigate,
}: {
  readonly thread: ThreadSummary;
  readonly archived: boolean;
  /** Closing the drawer belongs to the row that navigated, not to a click that
      happened to bubble through the list container. */
  readonly onNavigate?: () => void;
}) {
  const isActive = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const presentation = threadPresentation(thread);
  const kind = dashboardThreadKind(thread);
  return (
    <ThreadListItemPrimitive.Root
      className={`thread-item${isActive ? " is-active" : ""}`}
    >
      <ThreadListItemPrimitive.Trigger
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
        onClick={onNavigate}
      >
        <span className={`thread-kind is-${kind}`} title={dashboardKindLabel(kind)}>
          <Icon name={dashboardKindIcon(kind)} size={15} />
        </span>
        <span className="thread-copy">
          <span className="thread-title-line">
            <span className="thread-title">
              <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
            </span>
            {thread.trigger && (
              <span className="trigger-badge" aria-label={`${thread.trigger.kind} notification`}>
                {thread.trigger.kind}
              </span>
            )}
            <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
          </span>
          <span className="thread-preview">
            {presentation.active && <i className="thread-running" role="img" aria-label={presentation.text} />}
            <span className="thread-preview-text" title={presentation.text}>
              {presentation.text}
            </span>
          </span>
        </span>
      </ThreadListItemPrimitive.Trigger>
      {archived ? (
        <ThreadListItemPrimitive.Unarchive
          className="thread-action"
          aria-label={`Restore ${thread.title}`}
          title="Restore conversation"
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="restore" size={15} />
        </ThreadListItemPrimitive.Unarchive>
      ) : (
        <ThreadListItemPrimitive.Archive
          className="thread-action"
          aria-label={`Archive ${thread.title}`}
          title="Archive conversation"
        >
          <Icon name="archive" size={15} />
        </ThreadListItemPrimitive.Archive>
      )}
    </ThreadListItemPrimitive.Root>
  );
}

/**
 * The selected agent's current archive bucket, and nothing else.
 *
 * A search REPLACES these rows -- it goes to the server and reads every
 * conversation of the agent rather than the page this list has loaded -- so the
 * chips go with them: they filter what is loaded, and a result set the server
 * already ranked is not that.
 */
export function RecentSection({
  filter,
  onFilterChange,
  searching,
  query,
  search,
  onNavigate,
}: {
  readonly filter: RecentFilter;
  readonly onFilterChange: (filter: RecentFilter) => void;
  readonly searching: boolean;
  readonly query: string;
  readonly search: ThreadSearchState;
  readonly onNavigate?: () => void;
}) {
  const {
    threads,
    visibleThreads,
    showArchived,
    selectionLoading,
    selectionError,
    threadListError,
    retryThreadList,
    hasMoreThreads,
    loadMoreThreads,
  } = useConsoleStore();
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const visibleCount = visibleThreads.filter(
    (thread) => matchesRecentFilter(thread, filter),
  ).length;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-recent-label">
      <div className="dashboard-section-head">
        <h2 className="dashboard-section-label" id="dashboard-recent-label">Recent</h2>
        {!searching && (
          <div className="dashboard-chips" role="group" aria-label="Filter conversations">
            {CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`dashboard-chip${filter === chip.id ? " is-active" : ""}`}
                aria-pressed={filter === chip.id}
                onClick={() => onFilterChange(chip.id)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {threadListError !== null && (
        <div className="thread-list-error" role="alert">
          <span>Conversations could not be refreshed. {threadListError}</span>
          <button type="button" onClick={retryThreadList}>Retry conversations</button>
        </div>
      )}
      <ThreadListPrimitive.Root className="thread-list">
        {searching ? (
          <ThreadSearchResults query={query} search={search} onSelect={onNavigate} />
        ) : (
          <>
            <ThreadListPrimitive.Items archived={showArchived}>
              {({ threadListItem }) => {
                const thread = threadById.get(threadListItem.id);
                return thread && matchesRecentFilter(thread, filter) ? (
                  <ThreadListItem
                    thread={thread}
                    archived={showArchived}
                    onNavigate={onNavigate}
                  />
                ) : null;
              }}
            </ThreadListPrimitive.Items>
            {visibleCount === 0 && (
              <div className="thread-list-empty">
                <Icon name={showArchived ? "archive" : "threads"} size={19} />
                <span>
                  {selectionError !== null || threadListError !== null
                    ? "Conversations unavailable"
                    : selectionLoading
                    ? "Loading conversations…"
                    : filter === "cron"
                      ? "No cron conversations loaded"
                      : showArchived
                        ? "No archived conversations"
                        : "Start a conversation"}
                </span>
              </div>
            )}
            {hasMoreThreads && (
              <button
                type="button"
                className="thread-load-more"
                onClick={() => { void loadMoreThreads().catch(() => undefined); }}
              >
                Load older conversations
              </button>
            )}
          </>
        )}
      </ThreadListPrimitive.Root>
    </section>
  );
}
