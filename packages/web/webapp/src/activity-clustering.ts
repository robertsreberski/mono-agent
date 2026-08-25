interface ToolLikePart {
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly status?: { readonly type?: string };
  readonly artifact?: unknown;
}

export interface ToolClusterData {
  readonly toolName: string;
  readonly status: "running" | "complete" | "failed";
  readonly failedCount: number;
  readonly totalMs?: number;
  readonly calls: readonly ToolLikePart[];
}

const executionMs = (part: ToolLikePart): number | undefined => {
  const artifact = part.artifact;
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
  const value = (artifact as Record<string, unknown>).executionMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

export function clusterToolCalls<T extends ToolLikePart>(parts: readonly T[]): readonly (T | {
  readonly type: "data-tool-cluster";
  readonly data: ToolClusterData;
})[] {
  const clustered: Array<T | { readonly type: "data-tool-cluster"; readonly data: ToolClusterData }> = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.type !== "tool-call" || part.toolName === "AskUser" || part.toolName === undefined) {
      clustered.push(part);
      index += 1;
      continue;
    }
    const run: T[] = [part];
    let cursor = index + 1;
    while (cursor < parts.length) {
      const next = parts[cursor]!;
      if (next.type !== "tool-call" || next.toolName !== part.toolName || next.toolName === "AskUser") break;
      run.push(next);
      cursor += 1;
    }
    if (run.length < 2) clustered.push(part);
    else {
      const failedCount = run.filter((call) => call.isError === true).length;
      const durations = run.map(executionMs).filter((value): value is number => value !== undefined);
      clustered.push({
        type: "data-tool-cluster",
        data: {
          toolName: part.toolName,
          status: run.some((call) => call.status?.type === "running")
            ? "running"
            : failedCount > 0 ? "failed" : "complete",
          failedCount,
          ...(durations.length === 0 ? {} : { totalMs: durations.reduce((sum, value) => sum + value, 0) }),
          calls: run,
        },
      });
    }
    index = cursor;
  }
  return clustered;
}
