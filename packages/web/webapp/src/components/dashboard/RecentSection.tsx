import {
  ThreadListPrimitive,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { useConsoleStore } from "../../console-store";
import { flattenCatalogModels } from "../route-label";
import { AutomationsList } from "../AutomationsList";
import { Icon } from "../Icon";
import { ThreadSearchResults } from "../ThreadSearchResults";
import type { ThreadSearchState } from "../../thread-search";
import { isRecentThread, threadProjectLabel } from "./dashboard-model";
import { ThreadListItem } from "./ThreadListItem";

/**
 * The selected agent's current archive bucket, and nothing else. Cron channels
 * are not in it: the listing is server-scoped to chats, and the rows defend
 * that here for anything an older page or event still carries. A project's
 * conversations are in it, wearing their project's name.
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
    tagsByAgent,
    agents,
    catalogByProvider,
    projectsByAgent,
    selectedAgentId,
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
  const agentBySourceId = useMemo(
    () => new Map(agents.map((agent) => [agent.sourceId, agent])),
    [agents],
  );
  const catalogModels = useMemo(
    () => flattenCatalogModels(catalogByProvider),
    [catalogByProvider],
  );
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
          <ThreadSearchResults
            query={query}
            search={search}
            onSelect={onNavigate}
            highlightSelected={highlightSelected}
          />
        ) : (
          <>
            <ThreadListPrimitive.Items archived={showArchived}>
              {({ threadListItem }) => {
                const thread = threadById.get(threadListItem.id);
                if (!thread || !isRecentThread(thread)) return null;
                // A project's conversation sits in this list like any other
                // and says which project it belongs to; the project page is a
                // second way into it, not the only one.
                const project = threadProjectLabel(thread, projectsByAgent);
                return (
                  <ThreadListItem
                    thread={thread}
                    tags={(tagsByAgent?.[thread.sourceId] ?? []).filter((tag) => thread.tagIds?.includes(tag.id))}
                    agent={agentBySourceId.get(thread.sourceId) ?? null}
                    catalogModels={thread.sourceId === selectedAgentId ? catalogModels : undefined}
                    {...(project === undefined ? {} : { project })}
                    unread={unreadThreadIds.has(thread.id)}
                    onNavigate={onNavigate}
                    highlightSelected={highlightSelected}
                  />
                );
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
