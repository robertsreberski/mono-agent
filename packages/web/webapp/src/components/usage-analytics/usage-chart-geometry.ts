import {
  sameProviderUsageResetPeriod,
  type ProviderUsageHistoryProvider,
  type ProviderUsageWindow,
  type UsageHistoryRange,
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

export function xAt(at: number, range: Pick<UsageHistoryRange, "from" | "to">) {
  const fraction = (at - Date.parse(range.from))
    / (Date.parse(range.to) - Date.parse(range.from));
  return CHART.left + Math.max(0, Math.min(1, fraction))
    * (CHART.width - CHART.left - CHART.right);
}

export function yAt(fraction: number) {
  return CHART.top + (1 - fraction) * (CHART.height - CHART.top - CHART.bottom);
}

/** Lines are inferred between real observations; reset estimates may be missing. */
export function quotaPaths(
  provider: ProviderUsageHistoryProvider,
  kind: ProviderUsageWindow["kind"],
  range: UsageHistoryRange,
) {
  const from = Date.parse(range.from), to = Date.parse(range.to);
  const points = provider.samples.flatMap(sample => {
    const at = Date.parse(sample.fetchedAt);
    const window = sample.windows.find(w => w.kind === kind);
    if (!window || at < from || at >= to) return [];
    return [{
      at, window,
      x: xAt(at, range), y: yAt(window.usedPercent / 100),
      gap: sample.maxGapMs,
      observations: sample.observations,
      // Identical daily-span endpoints can contain many intermediate checks.
      span: JSON.stringify([
        sample.fetchedAt.slice(0, 10), sample.observations, sample.maxGapMs,
        sample.plan, sample.windows,
      ]),
    }];
  });
  const boundaries = provider.accountChanges.map(at => Date.parse(at));
  const intervals = points.slice(1).map((point, index) => {
    const before = points[index]!;
    // Duplicate timestamps at a boundary are ambiguous, so don't join them either.
    const accountChanged = boundaries.some(at => at <= point.at
      && (at > before.at || at === before.at && at === point.at));
    const samePeriod = !accountChanged && sameProviderUsageResetPeriod(before.window, point.window);
    const compressed = point.observations > 1 && before.span === point.span;
    // Reduction removes adjacency evidence, not necessarily the checks themselves.
    const gap = compressed || provider.downsampled ? point.gap : Math.max(point.at - before.at, point.gap);
    return { before, point, accountChanged, samePeriod, gap };
  });
  const gaps = intervals.filter(interval => interval.samePeriod && interval.gap > 0)
    .map(interval => interval.gap).sort((a, b) => a - b);
  // With fewer than three intervals there is no useful typical-gap estimate.
  const typical = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)]! : 0;
  const gapThresholdMs = Math.max(2 * typical, MIN_LONG_GAP_MS);
  const resets = new Set<number>();
  let reset = Date.parse(points[0]?.window.resetsAt ?? "");
  const retainResetMarker = () => {
    if (reset >= from && reset < to) resets.add(reset);
  };
  const connected = new Set<typeof points[number]>();
  let solid = "", uncertain = "", dots = "";
  for (const { before, point, accountChanged, samePeriod, gap } of intervals) {
    const previousReset = reset;
    const nextReset = Date.parse(point.window.resetsAt ?? "");
    if (!samePeriod) retainResetMarker();
    if (!samePeriod || Number.isFinite(nextReset)) reset = nextReset;
    if (accountChanged) continue;
    if (samePeriod) {
      if (before.x === point.x && before.y === point.y) continue;
      const connector = `M${before.x},${before.y}L${point.x},${point.y} `;
      if (gap > gapThresholdMs) uncertain += connector;
      else solid += connector;
      connected.add(before); connected.add(point);
      continue;
    }

    const nextStart = nextReset - point.window.periodMs;
    // Only place the drop at a plausible reset between the two actual checks.
    // If the old reset is unknown, a reported start of the next period can anchor it.
    const between = (at: number) => at >= before.at && at <= point.at;
    const drop = between(previousReset) ? previousReset : between(nextStart) ? nextStart : undefined;
    const zero = yAt(0);
    if (drop !== undefined && (drop > before.at || before.y !== zero)) {
      uncertain += `M${before.x},${before.y}H${xAt(drop, range)}V${zero} `;
      connected.add(before);
    }
    if (Number.isFinite(nextStart)) {
      // If periods were skipped, leave the gap between the first reset and this rise blank.
      const start = Math.min(point.at, Math.max(drop ?? before.at, nextStart));
      if (start < point.at || point.y !== zero) {
        uncertain += `M${xAt(start, range)},${zero}L${point.x},${point.y} `;
        connected.add(point);
      }
    }
  }
  retainResetMarker();
  for (const point of points) {
    // A round, zero-length stroke stays a small CSS-pixel dot at any SVG scale.
    dots += `M${point.x},${point.y}h0 `;
    if (!connected.has(point)) {
      // Even a lone check (or a check isolated by an account change) gets a line.
      const radius = CHART.width * 0.015;
      solid += `M${Math.max(CHART.left, point.x - radius)},${point.y}`
        + `H${Math.min(CHART.width - CHART.right, point.x + radius)} `;
    }
  }
  return { solid, uncertain, dots, resets: [...resets], gapThresholdMs };
}

/** Hour boundaries are UTC instants, but their labels still follow the viewer. */
export function displayTimeZone(
  range: Pick<UsageHistoryRange, "bucket" | "timeZone">,
  viewer = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  return range.bucket === "hour" ? viewer : range.timeZone;
}
