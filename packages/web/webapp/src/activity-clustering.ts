/**
 * A long turn reads as one wall of identical rows when an agent calls the same
 * tool many times in a row. Collapsing each run into a single expandable row
 * keeps the Activity log scannable without hiding any call.
 */
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
  /** Summed only over members whose duration the runtime actually reported. */
  readonly totalMs?: number;
  readonly calls: readonly ToolLikePart[];
}

export type ToolClusterPartLike = {
  readonly type: "data-tool-cluster";
  readonly data: ToolClusterData;
};

/**
 * `AskUser` renders its own interactive card and must never be folded into a
 * summary row: clustering it would bury the question the turn is waiting on.
 */
const NEVER_CLUSTERED = new Set(["AskUser"]);

const executionMs = (part: ToolLikePart): number | undefined => {
  const artifact = part.artifact;
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
  const value = (artifact as Record<string, unknown>).executionMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

const clusterable = (part: ToolLikePart): boolean =>
  part.type === "tool-call"
  && part.toolName !== undefined
  && !NEVER_CLUSTERED.has(part.toolName);

/**
 * Collapses runs of two or more adjacent same-tool calls. Any other part —
 * reasoning, a note, a subagent — breaks a run, so chronology survives. A run
 * of one passes through unchanged, which keeps an unclustered transcript
 * identical to its input.
 *
 * Pure and order-stable, which is what keeps a growing run from thrashing while
 * a turn streams: the same input always yields the same clusters in the same
 * positions. (assistant-ui keys data parts by position, not by any id this
 * module supplies, so position stability is the property that matters.)
 */
export function clusterToolCalls<T extends ToolLikePart>(
  parts: readonly T[],
): readonly (T | ToolClusterPartLike)[] {
  const clustered: Array<T | ToolClusterPartLike> = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (!clusterable(part)) {
      clustered.push(part);
      index += 1;
      continue;
    }
    const run: T[] = [part];
    let cursor = index + 1;
    while (cursor < parts.length) {
      const next = parts[cursor]!;
      if (!clusterable(next) || next.toolName !== part.toolName) break;
      run.push(next);
      cursor += 1;
    }
    if (run.length < 2) clustered.push(part);
    else {
      const failedCount = run.filter((call) => call.isError === true).length;
      const durations = run.flatMap((call) => {
        const duration = executionMs(call);
        return duration === undefined ? [] : [duration];
      });
      clustered.push({
        type: "data-tool-cluster",
        data: {
          toolName: part.toolName!,
          status: run.some((call) => call.status?.type === "running")
            ? "running"
            : failedCount > 0 ? "failed" : "complete",
          failedCount,
          ...(durations.length === 0
            ? {}
            : { totalMs: durations.reduce((sum, value) => sum + value, 0) }),
          calls: run,
        },
      });
    }
    index = cursor;
  }
  return clustered;
}
