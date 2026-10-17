const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const fields = { input_tokens: "input", output_tokens: "output", cache_read_tokens: "cacheRead", cache_write_tokens: "cacheWrite", cost_usd: "costUsd" };

/** Upsert snapshots of actual summary requests. No text or error bodies retained. */
export function createCompactionUsage() {
  const requests = new Map();
  const add = (rows = []) => {
    for (const row of rows) {
      if (typeof row?.requestId !== "string") continue;
      const before = requests.get(row.requestId) ?? {};
      const next = { requestId: row.requestId, model: row.model ?? before.model, status: row.status ?? before.status,
        ...(typeof (row.providerInvoked ?? before.providerInvoked) === "boolean" ? { providerInvoked: row.providerInvoked ?? before.providerInvoked } : {}) };
      for (const [key, raw] of Object.entries(fields)) next[key] = finite(row[key] ?? row[raw]) ? row[key] ?? row[raw] : before[key] ?? null;
      requests.set(row.requestId, next);
    }
  };
  return {
    add,
    observe(event) { if (event?.type === "context_compaction") add(event.accounting?.requests); },
    slice() {
      if (!requests.size) return undefined;
      const rows = [...requests.values()];
      const slice = { version: 1, requests: rows };
      for (const key of Object.keys(fields)) {
        const known = rows.filter((row) => finite(row[key]));
        slice[key] = known.length ? known.reduce((sum, row) => sum + row[key], 0) : null;
      }
      if (rows.some((row) => !finite(row.cost_usd))) slice.cost_partial = true;
      return slice;
    },
  };
}

/** Fold a deduped union, subtracting the subset already in this attempt. */
export function withCompactionUsage(result, collector) {
  collector.add(result.usage?.compaction?.requests);
  const compaction = collector.slice();
  if (!compaction) return result;
  const usage = { ...(result.usage ?? {}) };
  const included = usage.compaction;
  for (const key of Object.keys(fields)) {
    const own = finite(usage[key]) ? usage[key] : null;
    const old = finite(included?.[key]) ? included[key] : 0;
    usage[key] = own === null && compaction[key] === null ? null : Math.max(0, (own ?? 0) - old) + (compaction[key] ?? 0);
  }
  usage.cache_creation_tokens = usage.cache_write_tokens;
  usage.compaction = compaction;
  if (compaction.cost_partial || !finite(result.usage?.cost_usd)) usage.cost_partial = true;
  return { ...result, usage };
}

/** Same totals as the run summary, including zeros but never invented costs. */
export function compactionCostEvent(result) {
  const usage = result.usage ?? {};
  return { type: "cost_accumulated", sdk: "pi", model: result.model,
    ...(finite(usage.cost_usd) ? { cumulativeUsd: usage.cost_usd } : {}),
    ...(usage.cost_partial ? { costPartial: true } : {}),
    // Billing totals remain inclusive; occupancy consumers must not count summaries.
    contextTokens: Math.min(Number.MAX_SAFE_INTEGER, Object.keys(fields).filter((key) => key !== "cost_usd")
      .reduce((sum, key) => sum + Math.max(0, (usage[key] ?? 0) - (usage.compaction?.[key] ?? 0)), 0)),
    tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_tokens ?? 0, cacheCreationTokens: usage.cache_write_tokens ?? 0 } };
}

/** Only a bounded billing projection crosses the manual operator boundary. */
export function manualCompactionAccounting(slice) {
  if (!slice) return undefined;
  return { version: 2, usageIncluded: false, requests: slice.requests.slice(0, 2).map((row) => ({
    requestId: row.requestId, ...(typeof row.providerInvoked === "boolean" ? { providerInvoked: row.providerInvoked } : {}), ...(row.model ? { model: row.model } : {}), status: row.status,
    input: row.input_tokens, output: row.output_tokens, cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens, costUsd: row.cost_usd,
  })) };
}
