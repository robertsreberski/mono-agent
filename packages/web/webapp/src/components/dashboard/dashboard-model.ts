import { threadOutcomeError, threadPresentation } from "../../thread-presentation";
import type { AgentSummary, ThreadSummary } from "../../types";
import type { IconName } from "../Icon";

/**
 * Everything the dashboard decides about a conversation or an agent WITHOUT a
 * store, a hook or a DOM. Kept apart from the components on purpose: the
 * precedence rules below are the part worth a test that cannot render.
 */

/** What a conversation row's glyph says this conversation IS. */
export type DashboardThreadKind = "alert" | "cron" | "webhook" | "chat";

/** How many cards one agent contributes to Running before the rest fold away. */
export const RUNNING_CARDS_PER_AGENT = 2;

const ICON_BY_KIND: Readonly<Record<DashboardThreadKind, IconName>> = {
  alert: "alert",
  cron: "clock",
  webhook: "activity",
  chat: "threads",
};

const LABEL_BY_KIND: Readonly<Record<DashboardThreadKind, string>> = {
  alert: "Needs attention",
  cron: "Scheduled",
  webhook: "Webhook",
  chat: "Conversation",
};

/**
 * An agent's monogram: one letter per word, or the first two of a single word.
 *
 * Never empty -- a label made entirely of separators still has to draw
 * something inside a 48-pixel square.
 */
export const agentInitials = (label: string): string => {
  const words = label.split(/[\s_-]+/u).filter(Boolean);
  const first = words[0];
  if (first === undefined) return "A";
  const letters = words.length === 1
    ? [...first].slice(0, 2)
    : words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toLocaleUpperCase();
};

/**
 * Trouble first, then how the conversation started.
 *
 * A failed cron run is a failure the operator has to see, so the alert wins the
 * glyph -- which is why the trigger badge stays on the row beside it rather
 * than being replaced by it. The outcome comes from the shared classification,
 * never from reading the status line back.
 */
export const dashboardThreadKind = (thread: ThreadSummary): DashboardThreadKind =>
  threadOutcomeError(thread) !== undefined
    ? "alert"
    : thread.trigger?.kind === "cron"
      ? "cron"
      : thread.trigger?.kind === "webhook"
        ? "webhook"
        : "chat";

export const dashboardKindIcon = (kind: DashboardThreadKind): IconName => ICON_BY_KIND[kind];
export const dashboardKindLabel = (kind: DashboardThreadKind): string => LABEL_BY_KIND[kind];

/**
 * Recent is conversations; a cron channel is an automation's history and lives
 * in that collection. The listing is server-scoped the same way -- this is the
 * row-level guard for whatever an older page or event still carries.
 */
export const isRecentThread = (thread: ThreadSummary): boolean =>
  thread.trigger?.kind !== "cron";

/**
 * What Running has to draw from: the cache's held activity, plus whatever the
 * LISTING already says is active. The listing is the page the operator is
 * looking at, refreshed by the same events; a conversation working there and
 * absent from Running would contradict the row directly under it. The cache's
 * copy wins a tie because it is the one a detail read has touched.
 */
export const mergeRunningThreads = (
  cached: readonly ThreadSummary[],
  listed: readonly ThreadSummary[],
): readonly ThreadSummary[] => {
  const byId = new Map<string, ThreadSummary>();
  for (const thread of listed) {
    if (threadPresentation(thread).active) byId.set(thread.id, thread);
  }
  for (const thread of cached) byId.set(thread.id, thread);
  return [...byId.values()];
};

export interface RunningAgentGroup {
  readonly agent: AgentSummary;
  readonly threads: readonly ThreadSummary[];
}

const byMostRecentThenId = (a: ThreadSummary, b: ThreadSummary) =>
  (Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Held activity, grouped into the agent order the console already uses.
 *
 * The store's projection is discovery-UNFILTERED -- a browser can hold
 * conversations for an agent that has since left the fleet -- so an agent
 * missing from `agents` takes its conversations out of Running with it. This
 * is the only place that decision is made.
 */
export const groupRunningThreads = (
  running: readonly ThreadSummary[],
  agents: readonly AgentSummary[],
): readonly RunningAgentGroup[] => {
  const byAgent = new Map<string, ThreadSummary[]>();
  for (const thread of running) {
    const held = byAgent.get(thread.sourceId);
    if (held === undefined) byAgent.set(thread.sourceId, [thread]);
    else held.push(thread);
  }
  return agents.flatMap((agent) => {
    const threads = byAgent.get(agent.sourceId);
    return threads === undefined || threads.length === 0
      ? []
      : [{ agent, threads: [...threads].sort(byMostRecentThenId) }];
  });
};

/** How many cards Running is showing in total, across every group. */
export const runningThreadCount = (groups: readonly RunningAgentGroup[]): number =>
  groups.reduce((total, group) => total + group.threads.length, 0);
