import type { ThreadDetail } from "./types";

export interface ConsoleUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cost?: number;
  readonly model?: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

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

const isUsageTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean => {
  const labels = [
    event,
    ...layers.flatMap((layer) =>
      [layer.type, layer.event, layer.kind].filter(
        (value): value is string => typeof value === "string",
      ),
    ),
  ];
  return labels.some((label) => {
    const normalized = label.toLowerCase();
    return normalized.includes("usage") || normalized.includes("cost");
  });
};

const normalizeUsage = (event: string, data: unknown): ConsoleUsage | null => {
  const outerToInner = dataLayers(data);
  if (!isUsageTelemetry(event, outerToInner)) return null;

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
  const cost = numericValue(innerToOuter, COST_KEYS);
  const model = stringValue(innerToOuter, MODEL_KEYS);
  const usage: ConsoleUsage = {
    ...(input === undefined ? {} : { input }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cost === undefined ? {} : { cost }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
};

const latestMessageUsage = (
  parts: ThreadDetail["messages"][number]["parts"],
): ConsoleUsage | null => {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry") continue;
    const usage = normalizeUsage(part.event, part.data);
    if (usage !== null) return usage;
  }
  return null;
};

const addMetric = (total: number | undefined, value: number | undefined): number | undefined =>
  value === undefined ? total : (total ?? 0) + value;

export const conversationConsoleUsage = (detail: ThreadDetail | null): ConsoleUsage | null => {
  if (detail === null) return null;

  let latestUsage: ConsoleUsage | null = null;
  let input: number | undefined;
  let cachedInput: number | undefined;
  let cacheCreation: number | undefined;
  let output: number | undefined;
  let reasoning: number | undefined;
  let cost: number | undefined;
  for (const message of detail.messages) {
    const usage = latestMessageUsage(message.parts);
    if (usage === null) continue;
    latestUsage = usage;
    input = addMetric(input, usage.input);
    cachedInput = addMetric(cachedInput, usage.cachedInput);
    cacheCreation = addMetric(cacheCreation, usage.cacheCreation);
    output = addMetric(output, usage.output);
    reasoning = addMetric(reasoning, usage.reasoning);
    cost = addMetric(cost, usage.cost);
  }
  if (latestUsage === null) return null;
  return {
    ...(input === undefined ? {} : { input }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cost === undefined ? {} : { cost }),
    ...(latestUsage.model === undefined ? {} : { model: latestUsage.model }),
  };
};
