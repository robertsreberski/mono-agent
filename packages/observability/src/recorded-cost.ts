import { isRecord } from "./artifact-fs.js";

/** An explicit unknown total must not fall through to a lower-priority price. */
export function recordedCost(summary: { readonly cost?: unknown; readonly usage?: unknown }): { total: number | null | undefined; known?: number } {
  const cost = isRecord(summary.cost) ? summary.cost : {};
  const usage = isRecord(summary.usage) ? summary.usage : {};
  for (const field of [
    { record: cost, key: "cumulativeUsd", knownKey: "knownCostUsd" },
    { record: cost, key: "totalUsd", knownKey: "knownUsd" },
    { record: usage, key: "cost_usd", knownKey: "known_cost_usd" },
  ]) {
    if (field.record[field.key] === null) {
      const known = price(field.record[field.knownKey]) ?? price(usage.known_cost_usd);
      return { total: null, ...(known === undefined ? {} : { known }) };
    }
    const total = price(field.record[field.key]);
    if (total !== undefined) return { total };
  }
  return { total: undefined };
}

function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
