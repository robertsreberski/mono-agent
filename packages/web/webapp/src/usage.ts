import type { ThreadDetail, WebMessage } from "./types";
import {
  childRecord,
  dataLayers,
  isCompactionTelemetry,
  isContextTelemetry,
  normalizeUsage,
  numericValue,
  stringValue,
} from "../../src/message-cost.js";
import { messageUsageRollup } from "../../src/message-cost.js";
import { sumThreadUsage } from "../../src/thread-usage.js";
import type { WebThreadUsage } from "../../src/contracts.js";

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
  /** Structured rendering facts; wording never has to be parsed from reason. */
  readonly nextModel?: string;
  readonly lastTurnFailed?: boolean;
  readonly noContextRuntime?: "claude";
  readonly compaction?: { readonly tokensBefore?: number; readonly tokensAfter?: number; readonly tokenCountsExact?: boolean; readonly running: boolean };
}

export interface ConsoleUsage {
  readonly context: ConsoleContextProjection;
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

export const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(tokens);
};

export const contextLevel = (percent: number | undefined): "normal" | "warning" | "danger" =>
  percent !== undefined && percent >= 95 ? "danger" : percent !== undefined && percent >= 80 ? "warning" : "normal";

export function windowUsage(detail: ThreadDetail): WebThreadUsage {
  const rollups = detail.messages.filter((message) => message.role === "assistant").map(messageUsageRollup);
  const settled = detail.messages.filter((message) => message.role === "assistant"
    && message.turnId !== undefined && message.status !== "running").length;
  const usage = sumThreadUsage(rollups, new Date().toISOString(), settled);
  if (detail.messagesNextCursor === undefined) return usage;
  return {
    ...usage,
    total: { ...usage.total, tokensPartial: true, costPartial: true },
    byModel: usage.byModel.map((model) => ({ ...model, costPartial: true as const, tokensPartial: true as const })),
    ...(usage.subagents === undefined ? {} : { subagents: {
      ...usage.subagents, tokensPartial: true as const, costPartial: true as const,
    } }),
  };
}

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
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly tokenCountsExact?: boolean;
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
            ...(numericValue(innerToOuter, ["tokensBefore"]) === undefined ? {} : { tokensBefore: numericValue(innerToOuter, ["tokensBefore"]) }),
            ...(numericValue(innerToOuter, ["tokensAfter"]) === undefined ? {} : { tokensAfter: numericValue(innerToOuter, ["tokensAfter"]) }),
            ...(innerToOuter.find((layer) => typeof layer.tokenCountsExact === "boolean")?.tokenCountsExact === undefined
              ? {} : { tokenCountsExact: innerToOuter.find((layer) => typeof layer.tokenCountsExact === "boolean")?.tokenCountsExact as boolean }),
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

  if (invalidated && latestInvalidation !== undefined) {
    const after = latestInvalidation.tokensAfter;
    return {
      status: "awaiting_measurement",
      ...(latestInvalidation.status === "running" && latestExact !== undefined ? { usage: latestExact.usage }
        : after === undefined || after < 0 ? {} : { usage: {
          total: after,
          ...(latestExact?.usage.contextWindow === undefined ? {} : { contextWindow: latestExact.usage.contextWindow }),
        } }),
      compaction: {
        running: latestInvalidation.status === "running",
        ...(latestInvalidation.tokensBefore === undefined ? {} : { tokensBefore: latestInvalidation.tokensBefore }),
        ...(after === undefined ? {} : { tokensAfter: after }),
        ...(latestInvalidation.tokenCountsExact === undefined ? {} : { tokenCountsExact: latestInvalidation.tokenCountsExact }),
      },
      reason: after === undefined ? "Compaction changed the context. It's measured again on the next turn."
        : "Estimated after compaction. Measured exactly on the next turn.",
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
        ...(modelMismatch ? { nextModel } : { lastTurnFailed: true }),
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
    ...(nextModel?.startsWith("claude:") ? { noContextRuntime: "claude" as const } : {}),
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

  return { context: contextProjection(detail, options.selectedModel) };
};
