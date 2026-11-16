import { useId, useState } from "react";
import {
  projectProviderUsageWindow,
  type ProviderUsageHistory,
  type ProviderUsageHistoryProvider,
} from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics, WebUsageSlice } from "../../../../src/contracts";
import { formatTokenCount, formatUsd } from "../../usage";
import { UsageChartFrame, localTime } from "./UsageChartFrame";
import { BucketTotalsTable, ModelBucketTable, QuotaObservationTable } from "./UsageTables";
import {
  CHART, displayTimeZone, knownSpend, modelColor, partialSpend, quotaPaths, tokenTotal, xAt,
} from "./usage-chart-geometry";

interface WindowSeries {
  readonly kind: string;
  readonly paths: ReturnType<typeof quotaPaths>;
}

function QuotaSeries({ series }: { readonly series: readonly WindowSeries[] }) {
  return series.map(({ kind, paths }, index) => (
    <g key={kind} style={{ color: modelColor(index) }}>
      <path
        className="usage-quota-line"
        d={paths.solid}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="usage-quota-line"
        strokeDasharray="3 5"
        d={paths.uncertain}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="usage-sample-dots"
        d={paths.dots}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  ));
}

function QuotaLegend({ provider, series }: {
  readonly provider: ProviderUsageHistoryProvider;
  readonly series: readonly WindowSeries[];
}) {
  const last = provider.samples.at(-1)!;
  return (
    <ul className="usage-legend">
      {series.map(({ kind }, index) => {
        const window = last.windows.find(w => w.kind === kind);
        const pace = window && projectProviderUsageWindow(window, last.fetchedAt);
        return (
          <li key={kind}>
            <i style={{ background: modelColor(index) }} aria-hidden="true" />
            {window?.label ?? kind}
            {pace && (
              <span className={pace.severity === "ok" ? "usage-muted" : "usage-warning"}>
                {pace.pace.toFixed(2)}× pace
                {pace.confidence === "low" ? " (early estimate)" : ""}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function QuotaHistoryChart({ provider, history }: {
  readonly provider: ProviderUsageHistoryProvider;
  readonly history: ProviderUsageHistory;
}) {
  const [page, setPage] = useState(0);
  const zone = displayTimeZone(history);
  const kinds = [...new Set(provider.samples.flatMap(sample => sample.windows.map(w => w.kind)))];
  const series = kinds.map(kind => ({ kind, paths: quotaPaths(provider, kind, history) }));
  const last = provider.samples.at(-1);
  const boundary = provider.accountChanges.at(-1);
  const stale = last !== undefined && Date.now() - Date.parse(last.fetchedAt) > 300_000;
  const resets = [...new Set(provider.samples.flatMap(sample => sample.windows.flatMap(window => (
    window.resetsAt && window.resetsAt >= history.from && window.resetsAt < history.to
      ? [window.resetsAt] : []
  ))))];
  const markerPath = (times: readonly string[]) => times.map(at => (
    `M${xAt(at, history)},${CHART.top}V${CHART.height - CHART.bottom}`
  )).join(" ");

  return (
    <article className="usage-card" aria-label={`${provider.label} quota history`}>
      <div className="usage-card-heading">
        <h3>{provider.label}</h3>
        {last?.plan && <span>{last.plan}</span>}
      </div>
      {last ? (
        <p className="usage-muted">
          {stale ? "Last known usage · " : "Last check · "}
          <time dateTime={last.fetchedAt}>{localTime(last.fetchedAt, zone)}</time>
        </p>
      ) : (
        <p>No quota history yet. An existing usage check or explicit Refresh usage records a sample.</p>
      )}
      {provider.truncatedBefore && (
        <p className="usage-warning">Earlier history was removed by a capacity limit.</p>
      )}
      {boundary && (
        <p className="usage-warning">Account changed · {localTime(boundary, zone)}</p>
      )}
      {last && (
        <>
          <UsageChartFrame
            title={`${provider.label} quota percentages`}
            description={
              "Percent used from 0 to 100. Lines connect actual observations, not continuous "
              + "measurements. Dotted lines indicate unusually long known gaps: over twice the "
              + "typical interval or six hours, whichever is longer. Lines break at account "
              + "changes and resets. Exact observations are in the table."
            }
            range={history}
            ticks={[0, 50, 100].map(percent => ({ fraction: percent / 100, label: `${percent}%` }))}
            {...(boundary ? { accountBoundary: boundary } : {})}
          >
            <path
              className="usage-reset"
              d={markerPath(resets)}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="usage-boundary"
              d={markerPath(provider.accountChanges)}
              vectorEffect="non-scaling-stroke"
            />
            <QuotaSeries series={series} />
          </UsageChartFrame>
          <QuotaLegend provider={provider} series={series} />
          <p className="usage-muted">
            Lines join observed samples, not continuous measurements. Dotted: known gaps over
            max(2× typical interval, 6h); with fewer than three intervals, 6h.
            Dashed vertical: reported reset · Solid vertical: account boundary.
            Pace is constant-rate extrapolation at the actual check, not a forecast.
          </p>
          <QuotaObservationTable provider={provider} zone={zone} page={page} onPage={setPage} />
        </>
      )}
    </article>
  );
}

type ModelRow = WebUsageAnalytics["buckets"][number]["models"][number];
const modelKey = (model: ModelRow) => model.other ? "Other models" : model.model ?? "Unknown model";

function ModelPatterns({ id, models }: { readonly id: string; readonly models: readonly string[] }) {
  return (
    <defs>
      {models.map((_, index) => (
        <pattern
          key={index}
          id={`${id}-model-${index}`}
          patternUnits="userSpaceOnUse"
          width="8"
          height="8"
          patternTransform={index < 16 ? "rotate(45)" : undefined}
        >
          <rect width="8" height="8" fill={modelColor(index)} />
          {index >= 16 ? (
            <circle cx="4" cy="4" r="1.5" fill="var(--panel)" opacity=".7" />
          ) : index >= 8 ? (
            <path d="M0 0V8" stroke="var(--panel)" strokeWidth="2" opacity=".7" />
          ) : null}
        </pattern>
      ))}
    </defs>
  );
}

function BucketBars({ id, data, models, max, value, formatted, onSelect }: {
  readonly id: string;
  readonly data: WebUsageAnalytics;
  readonly models: readonly string[];
  readonly max: number;
  readonly value: (slice: WebUsageSlice) => number;
  readonly formatted: (amount: number) => string;
  readonly onSelect: (index: number) => void;
}) {
  const width = (CHART.width - CHART.left - CHART.right) / Math.max(1, data.buckets.length);
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return data.buckets.map((bucket, i) => {
    let stacked = 0;
    return (
      <g key={bucket.start}>
        {bucket.models.map((model, j) => {
          const amount = value(model);
          const height = amount / max * plotHeight;
          stacked += amount;
          return (
            <rect
              key={j}
              x={CHART.left + i * width + 1}
              y={CHART.height - CHART.bottom - stacked / max * plotHeight}
              width={Math.max(0.5, width - 2)}
              height={height}
              fill={`url(#${id}-model-${models.indexOf(modelKey(model))})`}
              onClick={() => onSelect(i)}
            >
              <title>{model.model ?? "Unknown model"}: {formatted(amount)}</title>
            </rect>
          );
        })}
      </g>
    );
  });
}

function ModelLegend({ models }: { readonly models: readonly string[] }) {
  return (
    <ul className="usage-legend">
      {models.map((model, index) => (
        <li key={model}>
          <i
            aria-hidden="true"
            style={{
              background: modelColor(index),
              backgroundImage: index >= 16
                ? "radial-gradient(var(--panel) 1px, transparent 1px)"
                : index >= 8
                  ? "repeating-linear-gradient(45deg, transparent 0 3px, var(--panel) 3px 4px)"
                  : undefined,
              backgroundSize: index >= 16 ? "4px 4px" : undefined,
            }}
          />
          {model}
        </li>
      ))}
    </ul>
  );
}

export function UsageBucketChart({ data }: { readonly data: WebUsageAnalytics }) {
  const id = useId();
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [selected, setSelected] = useState(0);
  const zone = displayTimeZone(data);
  const models = [...new Set(data.buckets.flatMap(bucket => bucket.models.map(modelKey)))];
  const value = metric === "cost" ? knownSpend : tokenTotal;
  const max = Math.max(0.000001, ...data.buckets.map(bucket => (
    bucket.models.reduce((sum, model) => sum + value(model), 0)
  )));
  const bucket = data.buckets[Math.min(selected, data.buckets.length - 1)];
  const formatted = (amount: number) => metric === "cost"
    ? formatUsd(amount) : formatTokenCount(amount);

  return (
    <section className="usage-card" aria-labelledby={`${id}-heading`}>
      <div className="usage-card-heading">
        <h2 id={`${id}-heading`}>Tokens and spend</h2>
        <div className="usage-actions" role="group" aria-label="Chart metric">
          <button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>
            Cost
          </button>
          <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>
            Tokens
          </button>
        </div>
      </div>
      <p className="usage-muted">
        {metric === "cost" && partialSpend(data.total)
          ? "Known spend only; total cost is incomplete. " : ""}
        Stacked by recorded model. Synchronous child tokens stay in their inclusive parent model.
      </p>
      <UsageChartFrame
        title={`${metric === "cost" ? "Known cost" : "Reported tokens"} by model and bucket`}
        description={
          `${data.buckets.length} time buckets. Use the bucket selector or table for exact values `
          + "and model breakdown. Unknown prices are not zero."
        }
        range={data}
        ticks={[0, 0.5, 1].map(fraction => ({ fraction, label: formatted(max * fraction) }))}
      >
        <ModelPatterns id={id} models={models} />
        <BucketBars
          id={id}
          data={data}
          models={models}
          max={max}
          value={value}
          formatted={formatted}
          onSelect={setSelected}
        />
      </UsageChartFrame>
      <ModelLegend models={models} />
      <label className="usage-bucket-select">
        Inspect bucket
        <select
          value={Math.min(selected, data.buckets.length - 1)}
          onChange={event => setSelected(Number(event.target.value))}
        >
          {data.buckets.map((item, i) => (
            <option key={item.start} value={i}>{localTime(item.start, zone)}</option>
          ))}
        </select>
      </label>
      {bucket && <ModelBucketTable bucket={bucket} zone={zone} />}
      <BucketTotalsTable data={data} zone={zone} />
    </section>
  );
}
