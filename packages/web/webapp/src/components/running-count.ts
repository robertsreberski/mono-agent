import type { ActiveThreads, AgentSummary } from "../types";

/** An absent count is unknown; only an explicit zero means no running work. */
export const runningCountFor = (agent: AgentSummary, activeThreads: ActiveThreads | null | undefined): number | undefined =>
  activeThreads?.runningCounts[agent.sourceId] ?? agent.runningCount;
