import type { WebThreadUsage, WebUsageTokens } from "./contracts.js";
import { upkeepUsageRollup, type MessageUsageRollup, type MessageUsageSlice } from "./message-cost.js";

type MutableSlice = { pending?: true; tokens?: WebUsageTokens; costUsd?: number | null; knownCostUsd?: number; tokensPartial?: true; costPartial?: true };
const safeSum = (left: number, right: number): number => Math.min(Number.MAX_SAFE_INTEGER, left + right);
const addTokens = (left: WebUsageTokens | undefined, right: WebUsageTokens): WebUsageTokens => ({
  input: safeSum(left?.input ?? 0, right.input), cacheRead: safeSum(left?.cacheRead ?? 0, right.cacheRead),
  cacheWrite: safeSum(left?.cacheWrite ?? 0, right.cacheWrite), output: safeSum(left?.output ?? 0, right.output),
});
const known = (slice: MessageUsageSlice): number | undefined => slice.costUsd ?? slice.knownCostUsd;
function add(target: MutableSlice, source: MessageUsageSlice) {
  if (source.pending && (target.pending || target.costUsd === undefined && target.tokens === undefined)) target.pending = true;
  else delete target.pending;
  if (source.tokens !== undefined) {
    const keys: ReadonlyArray<keyof WebUsageTokens> = ["input", "output", "cacheRead", "cacheWrite"];
    for (const key of keys) if (source.tokens[key] > Number.MAX_SAFE_INTEGER - (target.tokens?.[key] ?? 0)) target.tokensPartial = true;
    target.tokens = addTokens(target.tokens, source.tokens);
  }
  const left = known(target);
  const right = known(source);
  if (source.costUsd !== undefined) {
    target.costUsd = target.costUsd === null || source.costUsd === null
      ? null : (target.costUsd ?? 0) + (source.costUsd ?? 0);
    if (target.costUsd === null && (left !== undefined || right !== undefined)) target.knownCostUsd = (left ?? 0) + (right ?? 0);
    else delete target.knownCostUsd;
  }
  if (source.costPartial) target.costPartial = true;
  if (source.tokensPartial) target.tokensPartial = true;
}

/** Synchronous children are inclusive subsets; detached jobs are independent. */
export function sumThreadUsage(rollups: readonly MessageUsageRollup[], computedAt = new Date().toISOString(), settledAssistantTurns?: number): WebThreadUsage {
  const total: MutableSlice = {};
  const compaction: MutableSlice & { requests: number; requestsWithUsage: number } = { requests: 0, requestsWithUsage: 0 };
  const subagents: MutableSlice & { runs: number; runsWithTokens: number } = { runs: 0, runsWithTokens: 0 };
  const byModel = new Map<string | undefined, MutableSlice>();
  const modelSlice = (model: string | undefined): MutableSlice => {
    let slice = byModel.get(model);
    if (slice === undefined) { slice = {}; byModel.set(model, slice); }
    return slice;
  };
  for (const rollup of rollups) {
    const inference = rollup.inference ?? rollup.main;
    if (rollup.inference && inference.tokens === undefined) total.tokensPartial = true;
    const syncKnown = rollup.subagents.reduce((sum, child) => sum + (!child.detached ? known(child) ?? 0 : 0), 0);
    const inclusiveKnown = known(inference);
    const ownKnown = inclusiveKnown === undefined ? undefined : Math.max(0, inclusiveKnown - syncKnown - (known(rollup.compaction ?? {}) ?? 0));
    if (!(rollup.main.pending && inference.costUsd === undefined && inference.tokens === undefined)) add(total, rollup.inference && inference.costUsd === undefined ? { ...inference, costUsd: null, costPartial: true } : inference);
    const main = modelSlice(inference.model);
    const allTokens = inference.tokens;
    const summaryTokens = rollup.compaction?.tokens;
    const ownTokens = allTokens === undefined ? undefined : {
      input: Math.max(0, allTokens.input - (summaryTokens?.input ?? 0)), output: Math.max(0, allTokens.output - (summaryTokens?.output ?? 0)),
      cacheRead: Math.max(0, allTokens.cacheRead - (summaryTokens?.cacheRead ?? 0)), cacheWrite: Math.max(0, allTokens.cacheWrite - (summaryTokens?.cacheWrite ?? 0)),
    };
    const { costUsd: _inclusiveCost, knownCostUsd: _inclusiveKnown, tokens: _inclusiveTokens, ...mainMetadata } = inference;
    add(main, { ...mainMetadata,
      ...(inference.costUsd === null ? { costUsd: null, ...(ownKnown !== undefined ? { knownCostUsd: ownKnown } : {}) }
        : ownKnown === undefined || ownKnown === 0 && inference.costPartial ? {} : { costUsd: ownKnown }),
      ...(ownTokens === undefined ? {} : { tokens: ownTokens }) });
    if (rollup.compaction) {
      add(compaction, rollup.compaction);
      compaction.requests += rollup.compaction.requests;
      compaction.requestsWithUsage += rollup.compaction.requestsWithUsage;
      for (const row of rollup.compactionByModel ?? []) add(modelSlice(row.model), row);
    }
    if (rollup.main.costUsd !== undefined && rollup.main.tokens === undefined) total.tokensPartial = true;
    for (const child of rollup.subagents) {
      subagents.runs += 1;
      if (child.tokens !== undefined) subagents.runsWithTokens += 1;
      const observed = child;
      add(subagents, observed);
      if (child.detached) {
        add(total, observed);
        if (child.tokens === undefined) total.tokensPartial = true;
      }
      if (child.tokens === undefined) subagents.tokensPartial = true;
      const { tokens: _syncTokens, ...costOnly } = observed;
      add(modelSlice(child.model), child.detached ? observed : costOnly);
    }
  }
  const upkeep = upkeepUsageRollup(rollups.flatMap(r => r.upkeepAccounting ?? []), rollups.some(r => r.upkeepPartial));
  const hasUpkeep = upkeep.accounting.length > 0 || upkeep.partial;
  if (hasUpkeep) {
    add(total, upkeep.slice);
    for (const row of upkeep.byModel) add(modelSlice(row.model), row);
  }
  return {
    total: { ...total },
    ...(hasUpkeep ? { upkeep: upkeep.slice } : {}),
    ...(compaction.requests ? { compaction: { ...compaction } } : {}),
    ...(subagents.runs === 0 ? {} : { subagents: { ...subagents } }),
    byModel: [...byModel.entries()].filter(([, slice]) => slice.costUsd !== undefined)
      .sort((a, b) => (known(b[1]) ?? 0) - (known(a[1]) ?? 0))
      .map(([model, slice]) => ({ ...slice, ...(model === undefined ? {} : { model }) })),
    computedAt,
    ...(settledAssistantTurns === undefined ? {} : { settledAssistantTurns }),
  };
}
