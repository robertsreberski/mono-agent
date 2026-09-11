import { toolNameLeaf } from "@mono-agent/agent-contracts";

import type { WebMessagePart, WebRunActivity } from "./contracts.js";

/**
 * Whether a tool name IS AskUser, however the agent qualified it.
 *
 * An MCP server serves it as `mcp__<server>__ask_user`, a forwarding runtime as
 * `some.namespace:AskUser`, and separators vary. Three places have to agree on
 * this -- the frame observer that arms the interaction poller, the shaper that
 * must leave the card's question and answer alone, and the activity projection
 * below -- so they read the same rule rather than three spellings of it. An
 * exact `=== "AskUser"` silently missed every run that routes the tool through
 * a server.
 */
export const isAskUserToolName = (toolName: string): boolean =>
  toolNameLeaf(toolName).toLowerCase().replace(/[^a-z0-9]+/gu, "") === "askuser";

/**
 * A cumulative cost worth showing, or nothing.
 *
 * `usage_update` is a runtime-supplied number that reaches the store unparsed,
 * so a missing price, a NaN from a failed division and a negative from a
 * reconciliation all arrive here. None of them is "this run has cost $0.00",
 * and printing one as if it were would be the console's own invention.
 */
const reportableCost = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The `usage_update` payload the store wraps in a telemetry part. */
const usageCumulativeUsd = (data: unknown): number | undefined => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const usage = data as Record<string, unknown>;
  if (usage.type !== "usage_update") return undefined;
  return reportableCost(usage.cumulativeUsd);
};

/**
 * What a running turn's card can say about itself, from its retained parts.
 *
 * ONE implementation, deliberately: the listing derives this from the assistant
 * message it reads back, and the streaming write path derives it from the parts
 * it is about to persist so it can tell whether the projection MOVED. Two
 * readings of "how many tool calls" would eventually disagree, and the
 * disagreement would show up as a card that never stops re-announcing itself.
 *
 * Subagent groups contribute nothing. A delegation's parent `Agent` call is
 * REPLACED by its group (see `applyEvent`), so counting top-level `tool-call`
 * parts already excludes both the parent and its children -- and it counts each
 * call once, because the store upserts a call in place as it progresses.
 */
export const runActivityFromParts = (parts: readonly WebMessagePart[]): WebRunActivity => {
  let toolCallCount = 0;
  let asking = false;
  let cumulativeUsd: number | undefined;
  for (const part of parts) {
    if (part.type === "tool-call") {
      toolCallCount += 1;
      if (part.status === "running" && isAskUserToolName(part.toolName)) asking = true;
      continue;
    }
    if (part.type === "telemetry") {
      // Last one wins: `cumulativeUsd` is cumulative, and the parts array is
      // append-ordered, so the newest reading is the run's total so far.
      const cost = usageCumulativeUsd(part.data);
      if (cost !== undefined) cumulativeUsd = cost;
    }
  }
  return {
    toolCallCount,
    phase: asking ? "asking" : "working",
    ...(cumulativeUsd === undefined ? {} : { cumulativeUsd }),
  };
};

/**
 * Whether two projections would draw the same status line.
 *
 * The whole point of the projection being this small: a turn rewrites its
 * message every ~50 ms and nearly every one of those writes is prose, which
 * this cannot see. Compared field by field rather than by serialization so a
 * key order change can never read as a change.
 */
export const sameRunActivity = (
  left: WebRunActivity | undefined,
  right: WebRunActivity | undefined,
): boolean => left === right
  || (left !== undefined
    && right !== undefined
    && left.toolCallCount === right.toolCallCount
    && left.phase === right.phase
    && left.cumulativeUsd === right.cumulativeUsd);
