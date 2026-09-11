import {
  threadJobSummaries,
  threadOutcomeError,
  threadPresentation,
} from "../../thread-presentation";
import type { AgentSummary, ThreadSummary } from "../../types";
import { formatUsd } from "../../usage";
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
 * The word under the square: the label's first word, as the design shows
 * "Personal" under PA and "Mono" under MM. The square's accessible name and
 * the header carry the whole label; a 48-pixel caption cannot.
 */
export const agentShortLabel = (label: string): string =>
  label.split(/\s+/u).filter(Boolean)[0] ?? label;

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
 * What Running falls back to when the server's listing is not standing behind
 * it: the cache's held activity, the last listing heard, and whatever the page
 * on screen already says is active.
 *
 * Only ever a FALLBACK. It is bounded by what this browser happens to hold, so
 * an empty result here is not evidence that the fleet is idle -- which is why
 * everything drawn from it is labelled last known. The cache's copy wins a tie
 * because it is the one a detail read has touched.
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

/**
 * What one running card says it is doing.
 *
 * Three claims, and nothing beyond them: how many tool calls this turn has
 * made, whether it is waiting on an answer from the operator, and what it has
 * cost so far. There is no step ordinal, no estimate of how much longer and no
 * token percentage, because none of those means the same thing in two runtimes.
 *
 * A turn with nothing to report yet keeps the shared `Working…` -- a card that
 * said "Working · 0 tool calls" would be reporting the absence of evidence as
 * evidence. Background jobs keep the words the sidebar gives them.
 */
export const runningCardStatus = (thread: ThreadSummary): string => {
  const { runState } = thread;
  const activity = runState.status === "running" ? runState.activity : undefined;
  if (activity === undefined) return threadPresentation(thread).text;
  const calls = activity.toolCallCount;
  const head = activity.phase === "asking"
    ? "Asking you a question"
    : calls > 0
      ? `Working · ${String(calls)} tool call${calls === 1 ? "" : "s"}`
      : "Working…";
  return [
    head,
    ...threadJobSummaries(thread),
    ...(activity.cumulativeUsd === undefined ? [] : [formatUsd(activity.cumulativeUsd)]),
  ].join(" · ");
};

/** Whether a card has been told anything yet about the turn it is drawing. */
export const runningCardPending = (thread: ThreadSummary): boolean =>
  thread.runState.status !== "running" || thread.runState.activity === undefined;
