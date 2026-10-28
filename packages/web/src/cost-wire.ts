/** Browser compatibility: old bundles accept absent amounts, but throw on null. */
export function browserCostWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(browserCostWire);
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["costUsd", "cost_usd", "cumulativeUsd", "cumulative_usd", "totalUsd", "total_usd", "cost", "monthUsd"].includes(key)
      && typeof child === "number" && (!Number.isFinite(child) || child < 0)) continue;
    if (["knownCostUsd", "known_cost_usd", "knownUsd", "monthKnownUsd"].includes(key)
      && (child === null || typeof child === "number" && (!Number.isFinite(child) || child < 0))) continue;
    if (child === null && ["costUsd", "cost_usd", "cumulativeUsd", "cumulative_usd", "totalUsd", "total_usd", "cost"].includes(key)) {
      result.costUnknown = true;
    } else if (key === "monthUsd" && child === null) {
      result.monthCostUnknown = true;
    } else {
      // Tool payloads are opaque user data, not framework billing envelopes.
      result[key] = opaque(key, child) ? child : browserCostWire(child);
    }
  }
  return result;
}

/** Normalize explicit wire markers; omission without a marker is not a price. */
export function normalizeBrowserCosts(value: unknown): void {
  if (Array.isArray(value)) { for (const child of value) normalizeBrowserCosts(child); return; }
  if (!record(value)) return;
  if (value.costUnknown === true) {
    value.costUsd = null;
    if ("toolCallCount" in value && "phase" in value) value.cumulativeUsd = null;
  }
  if (value.monthCostUnknown === true) value.monthUsd = null;
  for (const [key, child] of Object.entries(value)) if (!opaque(key, child)) normalizeBrowserCosts(child);
}

export function costAmount(value: unknown, field = "costUsd"): number | null | undefined {
  if (!record(value)) return undefined;
  if (value.costUnknown === true || value[field] === null) return null;
  const amount = value[field];
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export function knownCostAmount(value: unknown): number | undefined {
  if (!record(value)) return undefined;
  const amount = value.knownCostUsd ?? value.known_cost_usd;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opaque(key: string, child: unknown): boolean {
  // Immutable upkeep counters/cost deliberately retain null inside their closed envelope.
  if (key === "accounting" && record(child) && child.version === 1 && child.usageIncluded === false) return true;
  return ["args", "arguments", "structuredContent", "structuredResult", "partialResult", "result", "schema", "requestedSchema"].includes(key);
}
