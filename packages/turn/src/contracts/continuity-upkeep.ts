export interface ContinuityUpkeepReceipt {
  readonly operationId: string; readonly model: string; readonly api: string; readonly providerInvoked: boolean;
  readonly capEnforcement: "request" | "stream_abort"; readonly status: "valid" | "invalid" | "skipped";
  readonly outcomeDowngrades?: number; readonly decisionRelabels?: number;
  readonly failure?: string; readonly reason: string; readonly elapsedMs: number;
  /** Uncached input; cache counters are never folded into this value. */
  readonly inputTokens: number | null; readonly outputTokens: number | null;
  /** Optional only for legacy receipt compatibility; the producer always sets these. */
  readonly cacheReadTokens?: number | null; readonly cacheWriteTokens?: number | null;
  readonly estimatedInputTokens: number; readonly estimatedInputCostUsd: number | null;
  readonly providerUsage?: { readonly input: number | null; readonly output: number | null; readonly cacheRead: number | null; readonly cacheWrite: number | null };
  readonly costUsd: number | null; readonly visibleEstimate: number; readonly outputOverrun: boolean;
}
export interface ContinuityUpkeepResult { readonly text?: string; readonly receipt: ContinuityUpkeepReceipt }
/** Completion receipts must retain binding.model and the supplied budget.operationId. */
export interface ContinuityUpkeepBinding {
  readonly model: string;
  readonly complete: (prompt: string, signal: AbortSignal, budget?: { readonly operationId: string; readonly inputTokens: 64000 | 128000; maxEntries?: number | undefined }) => Promise<ContinuityUpkeepResult>;
}
