import type {
  AgentSummary,
  ThreadListGroupBy,
  ThreadSummary,
  WebCollection,
  WebRunPreference,
  WebWorkflowStatus,
} from "./types";

export type BuiltInCollectionId = "all" | "pinned" | "unfiled" | "archive";
export type WorkspaceCollectionId = BuiltInCollectionId | `collection:${string}`;
export type WorkspaceKind = "interactive" | "automation";

export const WORKFLOW_COLUMNS: readonly {
  readonly id: WebWorkflowStatus;
  readonly label: string;
}[] = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];

export const messageAnchor = (messageId: string): string =>
  `message-${encodeURIComponent(messageId)}`;

export const messageIdFromHash = (hash = window.location.hash): string | undefined => {
  const match = /^#message-(.+)$/u.exec(hash);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
};

export const conversationPath = (threadId?: string): string =>
  threadId ? `/conversations/${encodeURIComponent(threadId)}` : "/conversations";

export const conversationThreadFromPath = (path = window.location.pathname): string | undefined => {
  const match = /^\/conversations\/([^/]+)\/?$/u.exec(path);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
};

export const collectionName = (
  collectionId: string | null,
  collections: readonly WebCollection[],
): string => collectionId === null
  ? "Unfiled"
  : collections.find(({ id }) => id === collectionId)?.name ?? "Unknown collection";

export const isAutomationThread = (thread: ThreadSummary): boolean =>
  thread.trigger !== undefined || thread.workflowStatus === undefined;

export const workspaceThreadMatches = (
  thread: ThreadSummary,
  input: {
    readonly collectionId: WorkspaceCollectionId;
    readonly sourceIds: ReadonlySet<string>;
    readonly kind: WorkspaceKind;
  },
): boolean => {
  if (Boolean(thread.archivedAt) !== (input.collectionId === "archive")) return false;
  if (input.sourceIds.size > 0 && !input.sourceIds.has(thread.sourceId)) return false;
  if (isAutomationThread(thread) !== (input.kind === "automation")) return false;
  if (input.kind === "automation" || input.collectionId === "all" || input.collectionId === "archive") {
    return true;
  }
  if (input.collectionId === "pinned") return thread.pinned;
  if (input.collectionId === "unfiled") return thread.collectionId === null;
  return thread.collectionId === input.collectionId.slice("collection:".length);
};

export interface ThreadGroup {
  readonly id: string;
  readonly label: string;
  readonly threads: readonly ThreadSummary[];
}

export const groupWorkspaceThreads = (
  threads: readonly ThreadSummary[],
  groupBy: ThreadListGroupBy,
  collections: readonly WebCollection[],
  agents: readonly AgentSummary[],
): readonly ThreadGroup[] => {
  if (groupBy === "none") return [{ id: "all", label: "Conversations", threads }];
  const values = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key = groupBy === "collection" ? thread.collectionId ?? "unfiled" : thread.sourceId;
    const group = values.get(key) ?? [];
    group.push(thread);
    values.set(key, group);
  }
  return [...values.entries()]
    .map(([id, items]) => ({
      id,
      label: groupBy === "collection"
        ? collectionName(id === "unfiled" ? null : id, collections)
        : agents.find(({ sourceId }) => sourceId === id)?.label ?? id,
      threads: items,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
};

/** Each setting inherits independently; choosing a model never erases inherited effort. */
export const effectiveRunPreference = (
  conversation: WebRunPreference | null | undefined,
  agent: WebRunPreference | null | undefined,
  advertised: WebRunPreference,
): Required<WebRunPreference> => ({
  model: conversation?.model ?? agent?.model ?? advertised.model ?? "",
  effort: conversation?.effort ?? agent?.effort ?? advertised.effort ?? "",
});
