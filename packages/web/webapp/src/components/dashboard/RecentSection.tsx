import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { useConsoleStore } from "../../console-store";
import { threadPresentation } from "../../thread-presentation";
import type { ThreadSummary } from "../../types";
import { AutomationsList } from "../AutomationsList";
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
  unread,
  onNavigate,
  highlightSelected,
}: {
  readonly thread: ThreadSummary;
  /** This device has not seen the conversation as it now stands. */
  readonly unread: boolean;
  /** Closing the drawer belongs to the row that navigated, not to a click that
      happened to bubble through the list container. */
  readonly onNavigate?: () => void;
  /** The selected conversation is on screen, so saying which row it is means
      something. See {@link RecentSection}. */
  readonly highlightSelected: boolean;
}) {
  const selected = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const isActive = selected && highlightSelected;
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
            {unread && <i className="thread-unread" role="img" aria-label="Unread" />}
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
 *
 * A row is marked as the open one only where the operator can SEE the
 * conversation it names. The store always holds a selection, because the chat
 * screen needs one; on a phone showing the Dashboard that conversation is on
 * the screen behind, and a highlighted row there reads as a list that has
 * already made the operator's choice for them.
 */
export function RecentSection({
  searching,
  query,
  search,
  onNavigate,
  highlightSelected = true,
}: {
  readonly searching: boolean;
  readonly query: string;
  readonly search: ThreadSearchState;
  readonly onNavigate?: () => void;
  /** See {@link Dashboard}. */
  readonly highlightSelected?: boolean;
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
    navigationDestination,
    setNavigationDestination,
    cronOverview,
    unreadThreadIds,
  } = useConsoleStore();
  const automations = navigationDestination === "automations";
  const jobs = cronOverview?.jobs.length;
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const visibleCount = visibleThreads.filter(isRecentThread).length;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-recent-label">
      <div className="dashboard-section-head">
        <h2 className="dashboard-section-label" id="dashboard-recent-label">
          {automations ? "Automations" : showArchived ? "Archived" : "Recent"}
        </h2>
        {/* The list's two faces, side by side where the design keeps its
            chips. Automations are the agent's cron jobs, read from the
            overview rather than the conversation page. */}
        <div className="dashboard-chips" role="group" aria-label="Show">
          <button
            type="button"
            className={`dashboard-chip${automations ? "" : " is-active"}`}
            aria-pressed={!automations}
            onClick={() => setNavigationDestination("chats")}
          >
            Chats
          </button>
          <button
            type="button"
            className={`dashboard-chip${automations ? " is-active" : ""}`}
            aria-pressed={automations}
            aria-label={jobs === undefined
              ? "Automations"
              : `Automations, ${String(jobs)} ${jobs === 1 ? "job" : "jobs"}`}
            onClick={() => setNavigationDestination("automations")}
          >
            <Icon name="clock" size={11} />
            Automations
            {jobs !== undefined && <span className="dashboard-chip-count">{jobs}</span>}
          </button>
        </div>
      </div>
      {automations ? (
        <AutomationsList query={query} onSelect={onNavigate} highlightSelected={highlightSelected} />
      ) : (
      <>
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
                  <ThreadListItem
                    thread={thread}
                    unread={unreadThreadIds.has(thread.id)}
                    onNavigate={onNavigate}
                    highlightSelected={highlightSelected}
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
      </>
      )}
    </section>
  );
}
