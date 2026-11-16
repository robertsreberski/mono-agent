import { useId, type ReactNode } from "react";
import type { UsageHistoryRange } from "@mono-agent/contracts/provider-usage";
import { CHART, displayTimeZone, xAt, yAt } from "./usage-chart-geometry";

export function localTime(at: string, zone: string) {
  return new Date(at).toLocaleString(undefined, {
    timeZone: zone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

interface ChartTick {
  readonly fraction: number;
  readonly label: string;
}

/** HTML labels stay at CSS font size; only the data geometry scales horizontally. */
export function UsageChartFrame({
  title, description, range, ticks, accountBoundary, children,
}: {
  readonly title: string;
  readonly description: string;
  readonly range: UsageHistoryRange;
  readonly ticks: readonly ChartTick[];
  readonly accountBoundary?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const zone = displayTimeZone(range);
  const boundaryPercent = accountBoundary === undefined
    ? undefined
    : xAt(accountBoundary, range) / CHART.width * 100;

  return (
    <div className="usage-chart-frame">
      <div className="usage-chart-y-axis" aria-hidden="true">
        {ticks.map(tick => (
          <span
            key={tick.fraction}
            className="usage-chart-y-tick"
            style={{ top: `${yAt(tick.fraction) / CHART.height * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="usage-chart-plot">
        {boundaryPercent !== undefined && (
          <span
            className="usage-boundary-label"
            aria-hidden="true"
            style={{ left: `clamp(56px, ${boundaryPercent}%, calc(100% - 56px))` }}
          >
            Account changed
          </span>
        )}
        <svg
          className="usage-chart"
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
        >
          <title id={`${id}-title`}>{title}</title>
          <desc id={`${id}-description`}>{description}</desc>
          {ticks.map(tick => (
            <line
              key={tick.fraction}
              className="usage-grid"
              x1={CHART.left}
              x2={CHART.width - CHART.right}
              y1={yAt(tick.fraction)}
              y2={yAt(tick.fraction)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {children}
        </svg>
      </div>
      <div className="usage-chart-x-axis" aria-hidden="true">
        <span>{localTime(range.from, zone)}</span>
        <span>{localTime(range.to, zone)}</span>
      </div>
    </div>
  );
}
