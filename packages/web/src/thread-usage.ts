import type { WebThreadUsage, WebUsageSlice, WebUsageTokens } from "./contracts.js";
import type { MessageUsageRollup, MessageUsageSlice } from "./message-cost.js";

type MutableSlice = { tokens?: WebUsageTokens; costUsd?: number; tokensPartial?: true; costPartial?: true };
const safeSum = (left: number, right: number): number => Math.min(Number.MAX_SAFE_INTEGER, left + right);
const addTokens = (left: WebUsageTokens | undefined, right: WebUsageTokens): WebUsageTokens =>
  ({
    input: safeSum(left?.input ?? 0, right.input),
    cacheRead: safeSum(left?.cacheRead ?? 0, right.cacheRead),
    cacheWrite: safeSum(left?.cacheWrite ?? 0, right.cacheWrite),
    output: safeSum(left?.output ?? 0, right.output),
  });
function add(target: MutableSlice, source: MessageUsageSlice) {
  if (source.tokens !== undefined) {
    for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) {
      if (source.tokens[key] > Number.MAX_SAFE_INTEGER - (target.tokens?.[key] ?? 0)) target.tokensPartial = true;
    }
    target.tokens = addTokens(target.tokens, source.tokens);
  }
  if (source.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  if (source.costPartial) target.costPartial = true;
}

/** Fold per-message rollups without ever adding synchronous spend twice. */
export function sumThreadUsage(rollups: readonly MessageUsageRollup[], computedAt = new Date().toISOString(), settledAssistantTurns?: number): WebThreadUsage {
  const total: MutableSlice = {};
  const subagents: MutableSlice & { runs: number } = { runs: 0 };
  const byModel = new Map<string | undefined, MutableSlice>();
  const modelSlice = (model: string | undefined): MutableSlice => {
    let slice = byModel.get(model);
    if (slice === undefined) { slice = {}; byModel.set(model, slice); }
    return slice;
  };
  for (const rollup of rollups) {
    const syncCost = rollup.subagents.reduce((sum, child) => sum + (!child.detached ? child.costUsd ?? 0 : 0), 0);
    const ownCost = rollup.main.costUsd === undefined ? undefined : Math.max(0, rollup.main.costUsd - syncCost);
    add(total, rollup.main);
    const main = modelSlice(rollup.main.model);
    add(main, { ...rollup.main, ...(ownCost === undefined ? {} : { costUsd: ownCost }) });
    if (rollup.main.costUsd !== undefined && rollup.main.tokens === undefined) total.tokensPartial = true;
    for (const child of rollup.subagents) {
      subagents.runs += 1;
      add(subagents, child);
      if (child.detached) {
        add(total, child);
        if (child.tokens === undefined) total.tokensPartial = true;
      }
      if (child.tokens === undefined) subagents.tokensPartial = true;
      // Parent aggregate tokens already include synchronous children. Preserve
      // their model's cost, but never add their tokens a second time by model.
      const { tokens: _syncTokens, ...costOnly } = child;
      add(modelSlice(child.model), child.detached ? child : costOnly);
    }
  }
  const clean = (slice: MutableSlice): WebUsageSlice => ({
    ...(slice.tokens === undefined ? {} : { tokens: slice.tokens }),
    ...(slice.costUsd === undefined ? {} : { costUsd: slice.costUsd }),
    ...(slice.tokensPartial ? { tokensPartial: true as const } : {}),
    ...(slice.costPartial ? { costPartial: true as const } : {}),
  });
  return {
    total: clean(total),
    ...(subagents.runs === 0 ? {} : { subagents: { ...clean(subagents), runs: subagents.runs } }),
    byModel: [...byModel.entries()].filter(([, slice]) => slice.costUsd !== undefined)
      .sort((a, b) => (b[1].costUsd ?? 0) - (a[1].costUsd ?? 0))
      .map(([model, slice]) => ({ ...clean(slice), ...(model === undefined ? {} : { model }) })),
    computedAt,
    ...(settledAssistantTurns === undefined ? {} : { settledAssistantTurns }),
  };
}
