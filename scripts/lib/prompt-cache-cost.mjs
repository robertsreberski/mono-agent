/** Pure offline accounting shared by the measurement report and stop threshold. */
export function measurementCosts(rows) {
  let costUsd = 0;
  let knownCostUsd = 0;
  let observed = false;
  for (const row of rows) {
    const complete = typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0;
    if (!complete) costUsd = null;
    else if (costUsd !== null) costUsd += row.costUsd;
    const known = complete ? row.costUsd : row.knownCostUsd;
    if (typeof known === "number" && Number.isFinite(known) && known >= 0) { knownCostUsd += known; observed = true; }
  }
  return { costUsd, ...(costUsd === null && observed ? { knownCostUsd } : {}) };
}

export function assertMeasurementThreshold(cost, ceiling) {
  if (ceiling === undefined) return;
  if (cost.costUsd === null) throw new Error("Observed spend is unknown; the post-response threshold cannot be evaluated. Further paid measurements stopped.");
  if (cost.costUsd > ceiling) throw new Error("Observed spend exceeded the secondary post-response stop threshold; measurement stopped. This threshold is not a hard ceiling.");
}
