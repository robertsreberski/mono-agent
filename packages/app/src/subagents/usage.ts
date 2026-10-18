import type { InstanceUsage } from "./types.js";

export function isInstanceUsage(value: unknown): value is InstanceUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("input" in value) || !("output" in value) || !("cacheRead" in value) || !("cacheWrite" in value) || !("costUsd" in value)) return false;
  if (Object.keys(value).some((key) => !["input", "output", "cacheRead", "cacheWrite", "costUsd", "knownCostUsd"].includes(key))) return false;
  if (![value.input, value.output, value.cacheRead, value.cacheWrite].every((amount) => typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0)) return false;
  if (value.costUsd !== null && !price(value.costUsd)) return false;
  return !("knownCostUsd" in value) || (price(value.knownCostUsd) && (value.costUsd === null || value.knownCostUsd === value.costUsd));
}

/** Lifetime totals include every executed turn, including unknown prices. */
export function addInstanceUsage(target: InstanceUsage, source: Partial<InstanceUsage> | undefined, priorTurns: number): void {
  const before = target.costUsd;
  if (source?.costUsd === undefined) {
    addTokens(target, source);
    return;
  }
  const next = price(source.costUsd) ? source.costUsd : null;
  const sourceKnown = price(source.knownCostUsd) ? source.knownCostUsd : undefined;
  const known = (before ?? target.knownCostUsd ?? 0) + (next ?? sourceKnown ?? 0);
  target.costUsd = before === null || next === null ? null : before + next;
  if (target.costUsd === null && ((priorTurns > 0 && before !== null) || target.knownCostUsd !== undefined || next !== null || sourceKnown !== undefined)) {
    target.knownCostUsd = known;
  } else delete target.knownCostUsd;
  addTokens(target, source);
}

function addTokens(target: InstanceUsage, source: Partial<InstanceUsage> | undefined): void {
  const tokenKeys: Array<"input" | "output" | "cacheRead" | "cacheWrite"> = ["input", "output", "cacheRead", "cacheWrite"];
  for (const key of tokenKeys) {
    const amount = source?.[key];
    if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0) target[key] += amount;
  }
}

function price(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
