import { useCallback, useEffect, useMemo, useState } from "react";
import { useConsoleStore } from "../../console-store";
import { MIN_SEARCH_QUERY, useThreadSearch } from "../../thread-search";
import type { ThreadSummary } from "../../types";
import { AgentStrip } from "./AgentStrip";
import { DashboardFooter } from "./DashboardFooter";
import { DashboardHeader } from "./DashboardHeader";
import { DashboardSearch } from "./DashboardSearch";
import { groupRunningThreads, mergeRunningThreads } from "./dashboard-model";
import { RecentSection } from "./RecentSection";
import { RunningSection } from "./RunningSection";

/**
 * The console's one navigation surface: the desktop left column AND the mobile
 * drawer, mounted once and shared. Modality, gestures and where it sits belong
 * to the shell; what is in it belongs here.
 *
 * `highlightSelected` is the shell's answer to whether the selected
 * conversation is actually on screen. The store always holds a selection; a
 * phone showing only this list has nothing to point at with it.
 *
 * `onNavigate` is called by the actions that have taken the operator somewhere
 * -- a conversation, a search hit, a running card, a new conversation, the
 * settings dialog. Pinning, chips, paging, retry, the archive shelf and the
 * running overflow deliberately do not call it: on a phone the operator has
 * more to do here, and closing the drawer under them would undo it.
 */
export function Dashboard({
  onNavigate,
  highlightSelected = true,
}: {
  readonly onNavigate?: () => void;
  readonly highlightSelected?: boolean;
}) {
  const {
    activeThreads,
    agents,
    cachedRunningThreads,
    navigationDestination,
    selectedAgentId,
    selectAgent,
    selectThread,
    setShowArchived,
    threads,
  } = useConsoleStore();
  const [query, setQuery] = useState("");
  const chats = navigationDestination === "chats";
  const [expandedAgentIds, setExpandedAgentIds] = useState<ReadonlySet<string>>(new Set());

  // Searching goes to the server, which reads every conversation of this agent
  // rather than only the page the list has loaded.
  // With the Automations chip down the same field narrows the cron overview
  // locally, and no request is made for it.
  const searching = chats && query.trim().length >= MIN_SEARCH_QUERY;
  const search = useThreadSearch(selectedAgentId, chats ? query : "");

  // A query is about ONE agent, and its hits are that agent's. Carrying them
  // across a switch would flash another agent's conversations under the new
  // agent's name for as long as the next request takes.
  useEffect(() => { setQuery(""); }, [selectedAgentId]);
  // The field means something else under the other chip.
  useEffect(() => { setQuery(""); }, [navigationDestination]);

  /**
   * The server's answer while it stands, and only then.
   *
   * Authoritative, it IS the section: it covers agents this browser has never
   * opened and conversations past every loaded page, and an empty one means the
   * fleet is idle. Without it -- no stream, a failed read, a cold start off the
   * device -- the section falls back to the last listing heard plus what this
   * tab is holding, and says so.
   */
  const authoritative = activeThreads?.authoritative === true;
  const running = useMemo(
    () => authoritative && activeThreads !== null
      ? activeThreads.threads
      : mergeRunningThreads(
          cachedRunningThreads,
          [...(activeThreads?.threads ?? []), ...threads],
        ),
    [activeThreads, authoritative, cachedRunningThreads, threads],
  );
  const groups = useMemo(
    () => groupRunningThreads(running, agents),
    [agents, running],
  );
  /**
   * The badge on each agent's square.
   *
   * The server's per-agent count when there is one standing behind it --
   * counted over everything that qualifies, not over the cards, so a truncated
   * section still badges the right number. In fallback the badge counts what is
   * actually drawn beneath it, because a last-known total beside a shorter list
   * of cards is a contradiction the operator cannot resolve.
   */
  const runningCounts = useMemo(
    () => authoritative && activeThreads !== null
      ? new Map(Object.entries(activeThreads.runningCounts))
      : new Map(groups.map((group) => [group.agent.sourceId, group.threads.length])),
    [activeThreads, authoritative, groups],
  );

  const toggleAgentExpansion = useCallback((sourceId: string) => {
    setExpandedAgentIds((current) => {
      const next = new Set(current);
      if (!next.delete(sourceId)) next.add(sourceId);
      return next;
    });
  }, []);

  /**
   * One synchronous handler, in this order: a running card can name a
   * conversation of another agent, in the other archive bucket, and the console
   * has to be pointed at all three before the selection can settle. None of
   * these return anything worth awaiting.
   */
  const openRunning = useCallback((thread: ThreadSummary) => {
    if (thread.sourceId !== selectedAgentId) selectAgent(thread.sourceId);
    setShowArchived(Boolean(thread.archivedAt));
    selectThread(thread.id);
    onNavigate?.();
  }, [onNavigate, selectAgent, selectThread, selectedAgentId, setShowArchived]);

  return (
    <div className="dashboard">
      <DashboardHeader onNavigate={onNavigate} />
      <AgentStrip runningCounts={runningCounts} />
      <DashboardSearch
        value={query}
        onChange={setQuery}
        label={chats ? "Search conversations" : "Search automations"}
      />
      <div className="dashboard-scroll">
        <RunningSection
          groups={groups}
          expandedAgentIds={expandedAgentIds}
          onToggleAgent={toggleAgentExpansion}
          onOpen={openRunning}
          {...(authoritative && activeThreads !== null
            ? { total: activeThreads.total, truncated: activeThreads.truncated }
            : {})}
          authoritative={authoritative}
        />
        {/* Projects will take the labelled section between Running and Recent. */}
        <RecentSection
          searching={searching}
          query={query}
          search={search}
          onNavigate={onNavigate}
          highlightSelected={highlightSelected}
        />
      </div>
      <DashboardFooter archiveShelf={chats} />
    </div>
  );
}
