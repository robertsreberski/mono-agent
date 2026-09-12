import type { ThreadDetail, WebMessage } from "./types";
import {
  childRecord,
  dataLayers,
  isAggregateUsageTelemetry,
  isCompactionTelemetry,
  isContextTelemetry,
  latestMessageCostUsd,
  normalizeUsage,
  numericValue,
  stringValue,
} from "../../src/message-cost.js";
import type { NormalizedUsage } from "../../src/message-cost.js";

export interface ConsoleTokenUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly model?: string;
  readonly cacheHitRatio?: number;
}

export interface ConsoleContextUsage extends ConsoleTokenUsage {
  readonly total: number;
  readonly contextWindow?: number;
}

export type ConsoleContextStatus =
  | "current"
  | "updating"
  | "awaiting_measurement"
  | "last_measured"
  | "unavailable";

export interface ConsoleContextProjection {
  readonly status: ConsoleContextStatus;
  readonly usage?: ConsoleContextUsage;
  readonly measuredModel?: string;
  readonly reason?: string;
}

export interface ConsoleUsage {
  readonly context: ConsoleContextProjection;
  readonly processed?: ConsoleTokenUsage;
  readonly cost?: number;
}

export interface ConsoleUsageOptions {
  readonly selectedModel?: string;
}

/**
 * One rendering of a dollar figure for the whole console, so a delegation's own
 * cost and the conversation total that contains it read the same. Sub-cent
 * amounts keep four places, because most single turns are sub-cent and `$0.00`
 * says nothing.
 */
export const formatUsd = (cost: number): string =>
  `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;

interface OrderedObservation {
  readonly order: number;
  readonly timestamp?: number;
}

interface ContextObservation extends OrderedObservation {
  readonly usage: ConsoleContextUsage;
  readonly messageStatus: WebMessage["status"];
}

interface CompactionObservation extends OrderedObservation {
  readonly status: "running" | "succeeded";
}

const contextUsage = (data: unknown): ConsoleContextUsage | undefined => {
  const usage = normalizeUsage(data);
  // ACP reports its exact snapshot as `context: { used, window }` rather than
  // the token object emitted by Pi/Codex/OpenCode. Keep this fallback confined
  // to context telemetry: aggregate billing events must never become an
  // inferred occupancy measurement.
  const contextRecords = dataLayers(data).flatMap((layer) => {
    const context = childRecord(layer, "context");
    return context === undefined ? [] : [context];
  });
  const total = usage?.total ?? numericValue(contextRecords, ["used"]);
  const contextWindow = usage?.contextWindow ?? numericValue(contextRecords, ["window"]);
  if (total === undefined || total < 0) return undefined;
  return {
    total,
    ...(usage?.input === undefined ? {} : { input: usage.input }),
    ...(usage?.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
    ...(usage?.cacheCreation === undefined ? {} : { cacheCreation: usage.cacheCreation }),
    ...(usage?.output === undefined ? {} : { output: usage.output }),
    ...(usage?.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    ...(usage?.model === undefined ? {} : { model: usage.model }),
    ...(usage?.cacheHitRatio === undefined ? {} : { cacheHitRatio: usage.cacheHitRatio }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
};

const hasProcessedTokens = (usage: NormalizedUsage): boolean =>
  usage.input !== undefined ||
  usage.cachedInput !== undefined ||
  usage.cacheCreation !== undefined ||
  usage.output !== undefined ||
  usage.reasoning !== undefined;

const latestMessageProcessed = (
  parts: ThreadDetail["messages"][number]["parts"],
): ConsoleTokenUsage | null => {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry") continue;
    const layers = dataLayers(part.data);
    if (!isAggregateUsageTelemetry(part.event, layers)) continue;
    const usage = normalizeUsage(part.data);
    if (usage === null || !hasProcessedTokens(usage)) continue;
    return {
      ...(usage.input === undefined ? {} : { input: usage.input }),
      ...(usage.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
      ...(usage.cacheCreation === undefined ? {} : { cacheCreation: usage.cacheCreation }),
      ...(usage.output === undefined ? {} : { output: usage.output }),
      ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
      ...(usage.model === undefined ? {} : { model: usage.model }),
      ...(usage.cacheHitRatio === undefined ? {} : { cacheHitRatio: usage.cacheHitRatio }),
    };
  }
  return null;
};

const latestMessageCost = (
  parts: ThreadDetail["messages"][number]["parts"],
): number | undefined => latestMessageCostUsd(parts);

const occursAfter = (candidate: OrderedObservation, reference: OrderedObservation): boolean => {
  if (
    candidate.timestamp !== undefined &&
    reference.timestamp !== undefined &&
    candidate.timestamp !== reference.timestamp
  ) {
    return candidate.timestamp > reference.timestamp;
  }
  return candidate.order > reference.order;
};

const latestObservation = <T extends OrderedObservation>(values: readonly T[]): T | undefined =>
  values.reduce<T | undefined>(
    (latest, candidate) => latest === undefined || occursAfter(candidate, latest) ? candidate : latest,
    undefined,
  );

const contextProjection = (
  detail: ThreadDetail,
  selectedModel: string | undefined,
): ConsoleContextProjection => {
  const contexts: ContextObservation[] = [];
  const compactions: CompactionObservation[] = [];
  let order = 0;

  for (const message of detail.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "telemetry") continue;
      order += 1;
      const layers = dataLayers(part.data);
      const innerToOuter = [...layers].reverse();
      const timestamp = numericValue(innerToOuter, ["timestamp"]);
      if (isContextTelemetry(part.event, layers)) {
        const usage = contextUsage(part.data);
        if (usage !== undefined) {
          contexts.push({
            usage,
            messageStatus: message.status,
            order,
            ...(timestamp === undefined ? {} : { timestamp }),
          });
        }
      }
      if (isCompactionTelemetry(part.event, layers)) {
        const status = stringValue(innerToOuter, ["status"]);
        if (status === "running" || status === "succeeded") {
          compactions.push({
            status,
            order,
            ...(timestamp === undefined ? {} : { timestamp }),
          });
        }
      }
    }
  }

  // A failed/cancelled/interrupted turn can report usage for a request that was
  // never committed to the conversation. Exact snapshots from those messages
  // are deliberately excluded; completed and currently-running turns remain.
  const latestExact = latestObservation(contexts.filter(
    (observation) => observation.messageStatus === "complete" || observation.messageStatus === "running",
  ));
  const latestInvalidation = latestObservation(compactions);
  const invalidated = latestInvalidation !== undefined &&
    (latestExact === undefined || occursAfter(latestInvalidation, latestExact));

  if (invalidated) {
    return {
      status: "awaiting_measurement",
      reason: "Context changed during compaction; waiting for the next exact provider measurement.",
    };
  }

  const runStatus = detail.thread.runState.status;
  const running = runStatus === "running" || detail.messages.some((message) => message.status === "running");
  if (running) {
    if (latestExact === undefined) {
      return {
        status: "updating",
        reason: "The current turn has not reported an exact provider measurement yet.",
      };
    }
    return {
      status: "updating",
      usage: latestExact.usage,
      ...(latestExact.usage.model === undefined ? {} : { measuredModel: latestExact.usage.model }),
      reason: "The provider measurement is exact, but the current turn is still updating context.",
    };
  }

  if (latestExact !== undefined) {
    const measuredModel = latestExact.usage.model;
    const nextModel = selectedModel?.trim() || undefined;
    const modelMismatch = nextModel !== undefined && measuredModel !== nextModel;
    const failedTurn = runStatus === "failed" || runStatus === "cancelled" || runStatus === "interrupted";
    if (failedTurn || modelMismatch) {
      return {
        status: "last_measured",
        usage: latestExact.usage,
        ...(measuredModel === undefined ? {} : { measuredModel }),
        reason: modelMismatch
          ? measuredModel === undefined
            ? `The exact measurement did not identify its model; the next turn is set to ${nextModel}.`
            : `This measurement belongs to ${measuredModel}; the next turn is set to ${nextModel}.`
          : "The latest turn did not complete, so this is the last successful provider measurement.",
      };
    }
    return {
      status: "current",
      usage: latestExact.usage,
      ...(measuredModel === undefined ? {} : { measuredModel }),
    };
  }

  const nextModel = selectedModel?.trim();
  return {
    status: "unavailable",
    reason: nextModel?.startsWith("claude:")
      ? "This Claude runtime does not expose exact context measurements."
      : "Exact context usage has not been reported for this conversation.",
  };
};

export const conversationConsoleUsage = (
  detail: ThreadDetail | null,
  options: ConsoleUsageOptions = {},
): ConsoleUsage | null => {
  if (detail === null) return null;

  let processed: ConsoleTokenUsage | undefined;
  let cost: number | undefined;
  for (const message of detail.messages) {
    const messageProcessed = latestMessageProcessed(message.parts);
    if (messageProcessed !== null) processed = messageProcessed;
    const messageCost = latestMessageCost(message.parts);
    if (messageCost !== undefined) cost = (cost ?? 0) + messageCost;
  }
  return {
    context: contextProjection(detail, options.selectedModel),
    ...(processed === undefined ? {} : { processed }),
    ...(cost === undefined ? {} : { cost }),
  };
};
