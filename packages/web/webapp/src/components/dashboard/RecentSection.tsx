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
  isRecentThread,
} from "./dashboard-model";

function ThreadListItem({
  thread,
  onNavigate,
}: {
  readonly thread: ThreadSummary;
  /** Closing the drawer belongs to the row that navigated, not to a click that
      happened to bubble through the list container. */
  readonly onNavigate?: () => void;
}) {
  const isActive = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const presentation = threadPresentation(thread);
  const kind = dashboardThreadKind(thread);
  // The glyph says what the row IS; when a failure has taken the glyph, the
  // accessible name still says where the conversation came from.
  const kindName = thread.trigger && kind === "alert"
    ? `${dashboardKindLabel(kind)}, ${thread.trigger.kind} conversation`
    : dashboardKindLabel(kind);
  return (
    <ThreadListItemPrimitive.Root
      className={`thread-item${isActive ? " is-active" : ""}`}
    >
      <ThreadListItemPrimitive.Trigger
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
        onClick={onNavigate}
      >
        <span className={`thread-kind is-${kind}`} role="img" aria-label={kindName} title={kindName}>
          <Icon name={dashboardKindIcon(kind)} size={16} />
        </span>
        <span className="thread-copy">
          <span className="thread-title-line">
            <span className="thread-title">
              <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
            </span>
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
    </ThreadListItemPrimitive.Root>
  );
}

/**
 * The selected agent's current archive bucket, and nothing else. Cron channels
 * are not in it: the listing is server-scoped to chats, and the rows defend
 * that here for anything an older page or event still carries.
 *
 * A search REPLACES these rows -- it goes to the server and reads every
 * conversation of the agent rather than the page this list has loaded.
 */
export function RecentSection({
  searching,
  query,
  search,
  onNavigate,
}: {
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
  const visibleCount = visibleThreads.filter(isRecentThread).length;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-recent-label">
      <div className="dashboard-section-head">
        <h2 className="dashboard-section-label" id="dashboard-recent-label">
          {showArchived ? "Archived" : "Recent"}
        </h2>
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
                return thread && isRecentThread(thread) ? (
                  <ThreadListItem thread={thread} onNavigate={onNavigate} />
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
