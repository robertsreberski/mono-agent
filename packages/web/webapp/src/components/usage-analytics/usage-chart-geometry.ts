import type { ProviderUsageHistoryProvider, UsageHistoryRange } from "@mono-agent/contracts/provider-usage";
import type { WebUsageSlice } from "../../../../src/contracts";

export const CHART = { width: 640, height: 176, left: 36, right: 16, top: 20, bottom: 28 };
export const modelColor = (index: number) => `var(--usage-color-${index % 8})`;
export const knownSpend = (slice: WebUsageSlice) => slice.costUsd ?? slice.knownCostUsd ?? 0;
export const tokenTotal = (slice: WebUsageSlice) => slice.tokens ? slice.tokens.input + slice.tokens.output + slice.tokens.cacheRead + slice.tokens.cacheWrite : 0;
export const partialSpend = (slice: WebUsageSlice) => slice.costUsd === null || slice.costUnknown === true || slice.costPartial === true || slice.costUsd === undefined && slice.tokens !== undefined;
export function xAt(at: string, range: Pick<UsageHistoryRange, "from" | "to">) {
  return CHART.left + Math.max(0, Math.min(1, (Date.parse(at) - Date.parse(range.from)) / (Date.parse(range.to) - Date.parse(range.from)))) * (CHART.width - CHART.left - CHART.right);
}
/** Every connector has two real endpoints; never connect across account/reset boundaries. */
export function quotaPaths(provider: ProviderUsageHistoryProvider, kind: string, range: UsageHistoryRange) {
  let solid = "", uncertain = "", dots = "";
  const points = provider.samples.flatMap(sample => {
    const window = sample.windows.find(w => w.kind === kind);
    return window ? [{ at: sample.fetchedAt, window, gap: sample.maxGapMs }] : [];
  });
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!, x = xAt(point.at, range), y = CHART.top + (100 - point.window.usedPercent) / 100 * (CHART.height - CHART.top - CHART.bottom);
    dots += `M${x - 2},${y}a2,2 0 1,0 4,0a2,2 0 1,0 -4,0 `;
    const before = points[i - 1];
    if (!before || before.window.resetsAt !== point.window.resetsAt || provider.accountChanges.some(at => at > before.at && at <= point.at)) continue;
    const previousY = CHART.top + (100 - before.window.usedPercent) / 100 * (CHART.height - CHART.top - CHART.bottom);
    const connector = `M${xAt(before.at, range)},${previousY}L${x},${y} `;
    if (Date.parse(point.at) - Date.parse(before.at) > 900_000 || point.gap > 900_000 || provider.downsampled) uncertain += connector;
    else solid += connector;
  }
  return { solid, uncertain, dots };
}

/** Hour boundaries are UTC instants, but their labels still follow the viewer. */
export function displayTimeZone(range: Pick<UsageHistoryRange, "bucket" | "timeZone">, viewer = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return range.bucket === "hour" ? viewer : range.timeZone;
}
