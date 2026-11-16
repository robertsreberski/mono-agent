import type {
  ProviderUsageHistoryProvider,
  UsageHistoryRange,
} from "@mono-agent/contracts/provider-usage";
import { formatUsageCost } from "../../usage";
import type { WebUsageSlice } from "../../../../src/contracts";

// Axes live in HTML. SVG coordinates describe only the fixed-height data plot.
export const CHART = {
  width: 640,
  height: 200,
  left: 0,
  right: 0,
  top: 20,
  bottom: 0,
};
export const MIN_LONG_GAP_MS = 6 * 3_600_000;
export const modelColor = (index: number) => `var(--usage-color-${index % 8})`;
export const knownSpend = (slice: WebUsageSlice): number | null =>
  slice.costUsd ?? slice.knownCostUsd ?? null;
export const formatAnalyticsCost = (slice: WebUsageSlice): string => {
  if (slice.costUnknown) return formatUsageCost({ ...slice, costUsd: null });
  if (slice.costUsd === undefined && slice.knownCostUsd === undefined && !slice.pending) return "Not reported";
  return formatUsageCost(slice);
};
export const tokenTotal = (slice: WebUsageSlice) => slice.tokens
  ? slice.tokens.input + slice.tokens.output + slice.tokens.cacheRead + slice.tokens.cacheWrite
  : 0;
export const partialSpend = (slice: WebUsageSlice) =>
  slice.costUsd === null || slice.costUnknown === true || slice.costPartial === true
  || slice.costUsd === undefined && slice.tokens !== undefined;

export function xAt(at: string, range: Pick<UsageHistoryRange, "from" | "to">) {
  const fraction = (Date.parse(at) - Date.parse(range.from))
    / (Date.parse(range.to) - Date.parse(range.from));
  return CHART.left + Math.max(0, Math.min(1, fraction))
    * (CHART.width - CHART.left - CHART.right);
}

export function yAt(fraction: number) {
  return CHART.top + (1 - fraction) * (CHART.height - CHART.top - CHART.bottom);
}

/** Every connector has real endpoints; account/reset boundaries always break lines. */
export function quotaPaths(
  provider: ProviderUsageHistoryProvider,
  kind: string,
  range: UsageHistoryRange,
) {
  const points = provider.samples.flatMap(sample => {
    const window = sample.windows.find(w => w.kind === kind);
    if (!window) return [];
    return [{
      at: sample.fetchedAt,
      window,
      gap: sample.maxGapMs,
      observations: sample.observations,
      // Identical daily-span endpoints can contain many intermediate checks.
      span: JSON.stringify([
        sample.fetchedAt.slice(0, 10), sample.observations, sample.maxGapMs,
        sample.plan, sample.windows,
      ]),
    }];
  });
  const intervals = points.slice(1).flatMap((point, index) => {
    const before = points[index]!;
    if (before.window.resetsAt !== point.window.resetsAt
      || provider.accountChanges.some(at => at > before.at && at <= point.at)) return [];
    const compressed = point.observations > 1 && before.span === point.span;
    // Reduction removes adjacency evidence, not necessarily the checks themselves.
    const gap = compressed || provider.downsampled
      ? point.gap
      : Math.max(Date.parse(point.at) - Date.parse(before.at), point.gap);
    return [{ before, point, gap }];
  });
  const gaps = intervals.map(interval => interval.gap).filter(gap => gap > 0)
    .sort((a, b) => a - b);
  // With fewer than three intervals there is no useful typical-gap estimate.
  const typical = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)]! : 0;
  const gapThresholdMs = Math.max(2 * typical, MIN_LONG_GAP_MS);
  let solid = "", uncertain = "", dots = "";
  for (const point of points) {
    // A round, zero-length stroke stays a small CSS-pixel dot at any SVG scale.
    dots += `M${xAt(point.at, range)},${yAt(point.window.usedPercent / 100)}h0 `;
  }
  for (const { before, point, gap } of intervals) {
    const connector = `M${xAt(before.at, range)},${yAt(before.window.usedPercent / 100)}`
      + `L${xAt(point.at, range)},${yAt(point.window.usedPercent / 100)} `;
    if (gap > gapThresholdMs) uncertain += connector;
    else solid += connector;
  }
  return { solid, uncertain, dots, gapThresholdMs };
}

/** Hour boundaries are UTC instants, but their labels still follow the viewer. */
export function displayTimeZone(
  range: Pick<UsageHistoryRange, "bucket" | "timeZone">,
  viewer = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  return range.bucket === "hour" ? viewer : range.timeZone;
}
