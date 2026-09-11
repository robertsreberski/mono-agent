/**
 * The browser-safe cost observation helpers, shared verbatim by both ends of
 * the console.
 *
 * The service sums recognised priced usage for a project's monthly cost; the
 * browser sums the same observations for a conversation's cost display. Written
 * twice, those two sums drift, and the drift is invisible: a project month
 * would disagree with the conversations inside it.
 *
 * This module is imported by `store.ts` and by `webapp/src/usage.ts`
 * (relatively, the way `mcp-app-document.ts` already is), so there is exactly
 * one implementation of the precedence rules.
 *
 * It must therefore stay dependency-free: the webapp is its own pnpm workspace
 * and cannot resolve anything else from the monorepo. Only the aggregate cost
 * observation moves here -- context occupancy, compaction and processed-token
 * projections stay browser-side.
 */

export interface CostTelemetryPart {
  readonly type: string;
  readonly event?: string;
  readonly data?: unknown;
}

export interface NormalizedUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly total?: number;
  readonly contextWindow?: number;
  readonly cost?: number;
  readonly model?: string;
  readonly cacheHitRatio?: number;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
export type UsageRecord = UnknownRecord;

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

/** Read one nested object layer, for callers that walk past `data`. */
export const childRecord = (value: UnknownRecord, key: string): UnknownRecord | undefined =>
  recordValue(value[key]);

export const dataLayers = (value: unknown): readonly UnknownRecord[] => {
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

export const numericValue = (
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

export const stringValue = (
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

const hasTelemetryLabel = (
  event: string,
  layers: readonly UnknownRecord[],
  expected: string,
): boolean => telemetryLabels(event, layers).some((label) => label.toLowerCase() === expected);

export const isContextTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_usage");

export const isCompactionTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_compaction");

export const isAggregateUsageTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  !isContextTelemetry(event, layers) && telemetryLabels(event, layers).some((label) => {
    const normalized = label.toLowerCase();
    return normalized.includes("usage") || normalized.includes("cost");
  });

export const normalizeUsage = (data: unknown): NormalizedUsage | null => {
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
  const inputTotal = input !== undefined && cachedInput !== undefined && cacheCreation !== undefined
    ? input + cachedInput + cacheCreation : undefined;
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
    ...(inputTotal === undefined || inputTotal === 0 ? {} : { cacheHitRatio: cachedInput! / inputTotal }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
};

/**
 * The latest recognised aggregate cost observation of one message, in USD.
 *
 * Latest wins within the message; context-occupancy observations never price
 * anything; subagent delegations are not top-level telemetry and are never
 * added on top of the aggregate that already contains them.
 */
export function latestMessageCostUsd(parts: readonly CostTelemetryPart[]): number | undefined {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry" || part.event === undefined) continue;
    const layers = dataLayers(part.data);
    if (!isAggregateUsageTelemetry(part.event, layers)) continue;
    const cost = normalizeUsage(part.data)?.cost;
    if (cost !== undefined) return cost;
  }
  return undefined;
}

/**
 * Sum recognised per-message observations, omitting the total when nothing was
 * priced. A measured zero is kept as zero: no priced observation is not the
 * same as a free month.
 */
export function sumMessageCosts(costs: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  let priced = false;
  for (const cost of costs) {
    if (cost === undefined) continue;
    total += cost;
    priced = true;
  }
  return priced ? total : undefined;
}
