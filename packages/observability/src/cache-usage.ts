export interface CacheUsageMetrics {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTotalTokens?: number;
  readonly cacheHitRatio?: number;
}

const token = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Normalize one aggregate token record without conflating an absent counter with measured zero. */
export function cacheUsageMetrics(usage: unknown): CacheUsageMetrics {
  const value = usage !== null && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const inputTokens = token(value.input_tokens ?? value.input);
  const cacheReadTokens = token(value.cache_read_tokens ?? value.cacheRead ?? value.cachedInput);
  const cacheWriteTokens = token(value.cache_creation_tokens ?? value.cache_write_tokens ?? value.cacheWrite ?? value.cacheCreation);
  const known = inputTokens !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined;
  const inputTotalTokens = known ? inputTokens + cacheReadTokens + cacheWriteTokens : undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(inputTotalTokens === undefined ? {} : { inputTotalTokens }),
    ...(inputTotalTokens === undefined || inputTotalTokens === 0 ? {} : { cacheHitRatio: cacheReadTokens! / inputTotalTokens }),
  };
}
