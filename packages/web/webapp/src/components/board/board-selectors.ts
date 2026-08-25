import type { AgentSummary, ThreadState, ThreadSummary } from "../../types";

export type BoardGroupBy = "state" | "agent" | "label" | "project";

export const boardThreads = (
  threads: readonly ThreadSummary[],
  query: string,
  agentIds: ReadonlySet<string>,
): readonly ThreadSummary[] => {
  const normalized = query.trim().toLocaleLowerCase();
  return threads.filter((thread) => {
    if (thread.archivedAt !== null) return false;
    if (agentIds.size > 0 && !agentIds.has(thread.sourceId)) return false;
    if (normalized.length === 0) return true;
    return [thread.title, thread.lastMessagePreview, thread.project, ...thread.labels]
      .some((value) => value?.toLocaleLowerCase().includes(normalized));
  });
};

export const agentCounts = (
  threads: readonly ThreadSummary[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    counts.set(thread.sourceId, (counts.get(thread.sourceId) ?? 0) + 1);
  }
  return counts;
};

const stateLabel: Record<ThreadState, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

export const groupThreads = (
  threads: readonly ThreadSummary[],
  groupBy: BoardGroupBy,
  agents: readonly AgentSummary[],
): readonly { readonly id: string; readonly label: string; readonly threads: readonly ThreadSummary[] }[] => {
  const agentNames = new Map(agents.map((agent) => [agent.sourceId, agent.label]));
  const groups = new Map<string, ThreadSummary[]>();
  const add = (id: string, thread: ThreadSummary) => groups.set(id, [...(groups.get(id) ?? []), thread]);
  for (const thread of threads) {
    if (groupBy === "state") add(thread.state, thread);
    else if (groupBy === "agent") add(thread.sourceId, thread);
    else if (groupBy === "project") add(thread.project ?? "", thread);
    else if (thread.labels.length === 0) add("", thread);
    else for (const label of thread.labels) add(label, thread);
  }
  const preferred = groupBy === "state" ? ["todo", "doing", "done"] : [...groups.keys()].sort();
  return preferred.flatMap((id) => {
    const grouped = groups.get(id);
    if (grouped === undefined || grouped.length === 0) return [];
    const label = groupBy === "state"
      ? stateLabel[id as ThreadState]
      : groupBy === "agent"
        ? agentNames.get(id) ?? id
        : id || (groupBy === "label" ? "No label" : "No project");
    return [{ id, label, threads: grouped }];
  });
};

export const nextThreadState = (state: ThreadState): ThreadState =>
  state === "todo" ? "doing" : state === "doing" ? "done" : "todo";

export const labelColorIndex = (label: string): number => {
  let hash = 2166136261;
  for (const character of label) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return Math.abs(hash) % 6;
};
