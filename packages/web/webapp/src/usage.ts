import type { ThreadDetail } from "./types";

export interface ConsoleTokenUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly model?: string;
}

export interface ConsoleContextUsage extends ConsoleTokenUsage {
  readonly total: number;
  readonly contextWindow?: number;
}

export interface ConsoleUsage {
  readonly context?: ConsoleContextUsage;
  readonly processed?: ConsoleTokenUsage;
  readonly cost?: number;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface NormalizedUsage extends ConsoleTokenUsage {
  readonly total?: number;
  readonly contextWindow?: number;
  readonly cost?: number;
}

const INPUT_KEYS = ["input", "input_tokens", "inputTokens"] as const;
const CACHED_INPUT_KEYS = [
  "cachedInput",
  "cached_input",
  "cachedInputTokens",
  "cached_input_tokens",
  "cacheRead",
  "cache_read",
  "cacheReadTokens",
  "cache_read_tokens",
] as const;
const CACHE_CREATION_KEYS = [
  "cacheCreation",
  "cache_creation",
  "cacheCreationTokens",
  "cache_creation_tokens",
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
] as const;
const OUTPUT_KEYS = ["output", "output_tokens", "outputTokens"] as const;
const REASONING_KEYS = ["reasoning", "reasoning_tokens", "reasoningTokens"] as const;
const TOTAL_KEYS = ["total", "total_tokens", "totalTokens"] as const;
const CONTEXT_WINDOW_KEYS = ["contextWindow", "context_window"] as const;
const COST_KEYS = [
  "cumulativeUsd",
  "cumulative_usd",
  "totalUsd",
  "total_usd",
  "costUsd",
  "cost_usd",
  "cost",
] as const;
const MODEL_KEYS = ["model", "modelId", "model_id"] as const;

const recordValue = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const dataLayers = (value: unknown): readonly UnknownRecord[] => {
  const layers: UnknownRecord[] = [];
  const seen = new Set<UnknownRecord>();
  let current = recordValue(value);
  while (current !== undefined && layers.length < 8 && !seen.has(current)) {
    layers.push(current);
    seen.add(current);
    current = recordValue(current.data);
  }
  return layers;
};

const numericValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): number | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
};

const stringValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): string | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return undefined;
};

const telemetryLabels = (event: string, layers: readonly UnknownRecord[]): readonly string[] => [
  event,
  ...layers.flatMap((layer) =>
    [layer.type, layer.event, layer.kind].filter(
      (value): value is string => typeof value === "string",
    ),
  ),
];

const isContextTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  telemetryLabels(event, layers).some((label) => label.toLowerCase() === "context_usage");

const isAggregateUsageTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  !isContextTelemetry(event, layers) && telemetryLabels(event, layers).some((label) => {
    const normalized = label.toLowerCase();
    return normalized.includes("usage") || normalized.includes("cost");
  });

const normalizeUsage = (data: unknown): NormalizedUsage | null => {
  const outerToInner = dataLayers(data);
  const innerToOuter = [...outerToInner].reverse();
  const tokenRecords = [
    ...innerToOuter.flatMap((layer) => {
      const tokens = recordValue(layer.tokens);
      return tokens === undefined ? [] : [tokens];
    }),
    ...innerToOuter,
  ];
  const input = numericValue(tokenRecords, INPUT_KEYS);
  const cachedInput = numericValue(tokenRecords, CACHED_INPUT_KEYS);
  const cacheCreation = numericValue(tokenRecords, CACHE_CREATION_KEYS);
  const output = numericValue(tokenRecords, OUTPUT_KEYS);
  const reasoning = numericValue(tokenRecords, REASONING_KEYS);
  const total = numericValue(tokenRecords, TOTAL_KEYS);
  const contextWindow = numericValue(innerToOuter, CONTEXT_WINDOW_KEYS);
  const cost = numericValue(innerToOuter, COST_KEYS);
  const model = stringValue(innerToOuter, MODEL_KEYS);
  const usage: NormalizedUsage = {
    ...(input === undefined ? {} : { input }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(total === undefined ? {} : { total }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
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
    };
  }
  return null;
};

const latestMessageCost = (
  parts: ThreadDetail["messages"][number]["parts"],
): number | undefined => {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry") continue;
    const layers = dataLayers(part.data);
    if (!isAggregateUsageTelemetry(part.event, layers)) continue;
    const cost = normalizeUsage(part.data)?.cost;
    if (cost !== undefined) return cost;
  }
  return undefined;
};

const latestContextUsage = (detail: ThreadDetail): ConsoleContextUsage | undefined => {
  for (let messageIndex = detail.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = detail.messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "telemetry") continue;
      const layers = dataLayers(part.data);
      if (!isContextTelemetry(part.event, layers)) continue;
      const usage = normalizeUsage(part.data);
      if (usage?.total === undefined || usage.total < 0) continue;
      return {
        total: usage.total,
        ...(usage.input === undefined ? {} : { input: usage.input }),
        ...(usage.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
        ...(usage.cacheCreation === undefined ? {} : { cacheCreation: usage.cacheCreation }),
        ...(usage.output === undefined ? {} : { output: usage.output }),
        ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
        ...(usage.model === undefined ? {} : { model: usage.model }),
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      };
    }
  }
  return undefined;
};

export const conversationConsoleUsage = (detail: ThreadDetail | null): ConsoleUsage | null => {
  if (detail === null) return null;

  let processed: ConsoleTokenUsage | undefined;
  let cost: number | undefined;
  for (const message of detail.messages) {
    const messageProcessed = latestMessageProcessed(message.parts);
    if (messageProcessed !== null) processed = messageProcessed;
    const messageCost = latestMessageCost(message.parts);
    if (messageCost !== undefined) cost = (cost ?? 0) + messageCost;
  }
  const context = latestContextUsage(detail);
  if (context === undefined && processed === undefined && cost === undefined) return null;
  return {
    ...(context === undefined ? {} : { context }),
    ...(processed === undefined ? {} : { processed }),
    ...(cost === undefined ? {} : { cost }),
  };
};
