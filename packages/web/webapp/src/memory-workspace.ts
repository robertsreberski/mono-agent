import type {
  MemoryGraph,
  MemoryGraphNode,
  MemoryOperation,
  MemoryOperationStatus,
} from "./types";

export type WorkspaceRoute =
  | { readonly kind: "conversations" }
  | { readonly kind: "memory"; readonly sourceId: string }
  | { readonly kind: "malformed-memory" };

const invalidRouteText = /[\u0000-\u001f\u007f]/u;

export const memoryPath = (sourceId: string): string =>
  `/memory/${encodeURIComponent(sourceId)}`;

export const memorySourceFromPath = (path = window.location.pathname): string | undefined => {
  const match = /^\/memory\/([^/]+)\/?$/u.exec(path);
  if (match === null) return undefined;
  try {
    const sourceId = decodeURIComponent(match[1]!);
    return sourceId.length > 0 && !invalidRouteText.test(sourceId) ? sourceId : undefined;
  } catch {
    return undefined;
  }
};

/** The top-level console router intentionally owns only conversations and memory. */
export const workspaceRouteFromPath = (path = window.location.pathname): WorkspaceRoute => {
  const sourceId = memorySourceFromPath(path);
  if (sourceId !== undefined) return { kind: "memory", sourceId };
  if (path === "/memory" || path.startsWith("/memory/")) return { kind: "malformed-memory" };
  return { kind: "conversations" };
};

export interface MemoryGraphPosition {
  readonly node: MemoryGraphNode;
  readonly x: number;
  readonly y: number;
}

export interface MemoryGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly positions: readonly MemoryGraphPosition[];
  readonly byId: ReadonlyMap<string, MemoryGraphPosition>;
}

const columnPositions = (
  nodes: readonly MemoryGraphNode[],
  x: number,
  height: number,
): readonly MemoryGraphPosition[] => nodes.map((node, index) => ({
  node,
  x,
  y: ((index + 1) * height) / (nodes.length + 1),
}));

export const MEMORY_GRAPH_MIN_VERTICAL_GAP = 72;

/** Stable, bounded two-column layout; no force simulation or runtime dependency. */
export const layoutMemoryGraph = (
  graph: MemoryGraph,
  width = 900,
  height = 520,
): MemoryGraphLayout => {
  const entities = graph.nodes.filter((node) => node.kind === "entity");
  const memories = graph.nodes.filter((node) => node.kind === "memory");
  const largestColumn = entities.length > 0 && memories.length > 0
    ? Math.max(entities.length, memories.length)
    : graph.nodes.length;
  const layoutHeight = Math.max(
    height,
    (largestColumn + 1) * MEMORY_GRAPH_MIN_VERTICAL_GAP,
  );
  const positions = entities.length > 0 && memories.length > 0
    ? [
        ...columnPositions(entities, width * 0.28, layoutHeight),
        ...columnPositions(memories, width * 0.72, layoutHeight),
      ]
    : columnPositions(graph.nodes, width / 2, layoutHeight);
  return {
    width,
    height: layoutHeight,
    positions,
    byId: new Map(positions.map((position) => [position.node.id, position])),
  };
};

export const truncateMemoryGraphLabel = (label: string, maximum = 34): string => {
  const points = [...label];
  return points.length <= maximum
    ? label
    : `${points.slice(0, Math.max(1, maximum - 1)).join("")}…`;
};

export const MEMORY_OPERATION_POLL_INITIAL_MS = 1_000;
export const MEMORY_OPERATION_POLL_MAX_INTERVAL_MS = 10_000;

export const isTerminalMemoryOperationStatus = (status: MemoryOperationStatus): boolean =>
  status === "succeeded" || status === "failed";

export const isTerminalMemoryOperation = (operation: MemoryOperation): boolean =>
  isTerminalMemoryOperationStatus(operation.status);

export const memoryOperationPollDelay = (
  attempt: number,
): number => Math.min(
  MEMORY_OPERATION_POLL_INITIAL_MS * 2 ** Math.max(0, attempt),
  MEMORY_OPERATION_POLL_MAX_INTERVAL_MS,
);
