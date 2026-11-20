import { useId, useState } from "react";
import {
  projectProviderUsageWindow,
  type ProviderUsageHistory,
  type ProviderUsageHistoryProvider,
  type ProviderUsageWindow,
} from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics, WebUsageSlice } from "../../../../src/contracts";
import { formatTokenCount, formatUsd } from "../../usage";
import { UsageChartFrame, localTime } from "./UsageChartFrame";
import { BucketTotalsTable, ModelBucketTable, QuotaObservationTable } from "./UsageTables";
import {
  CHART, displayTimeZone, knownSpend, modelColor, partialSpend, quotaPaths, tokenTotal, xAt,
} from "./usage-chart-geometry";

const quotaTicks = [0, 50, 100].map(percent => ({ fraction: percent / 100, label: `${percent}%` }));

function QuotaWindowChart({ provider, history, window, fetchedAt, showTimeAxis }: {
  readonly provider: ProviderUsageHistoryProvider;
  readonly history: ProviderUsageHistory;
  readonly window: ProviderUsageWindow;
  readonly fetchedAt: string;
  readonly showTimeAxis: boolean;
}) {
  const paths = quotaPaths(provider, window.kind, history);
  const pace = projectProviderUsageWindow(window, fetchedAt);
  const zone = displayTimeZone(history);
  const markerPath = (times: readonly number[]) => times.map(at => (
    `M${xAt(at, history)},${CHART.top}V${CHART.height - CHART.bottom}`
  )).join(" ");
  return (
    <div className="usage-quota-window">
      <div className="usage-quota-window-heading">
        <h4>{window.label}</h4>
        <strong>{Number(window.usedPercent.toFixed(1))}% used</strong>
        <span className="usage-quota-pace" data-severity={pace?.severity}>
          {pace ? `${pace.pace.toFixed(2)}× pace${pace.confidence === "low" ? " (early)" : ""}` : "Pace unavailable"}
        </span>
        <span className="usage-quota-reset-time">
          {window.resetsAt ? (
            <>Resets <time dateTime={window.resetsAt}>{localTime(window.resetsAt, zone)}</time></>
          ) : "Reset not reported"}
        </span>
      </div>
      <UsageChartFrame
        title={`${provider.label} ${window.label} quota history`}
        description={
          "Percent used from 0 to 100. Dots mark checks; dashed segments show inferred resets "
          + "or long gaps. Lines stop at account changes. Exact observations are in the table."
        }
        range={history}
        ticks={quotaTicks}
        showTimeAxis={showTimeAxis}
      >
        <path className="usage-reset" d={markerPath(paths.resets)} vectorEffect="non-scaling-stroke" />
        <path
          className="usage-boundary"
          d={markerPath(provider.accountChanges.map(at => Date.parse(at)))}
          vectorEffect="non-scaling-stroke"
        />
        <path className="usage-quota-line" d={paths.solid} vectorEffect="non-scaling-stroke" />
        <path
          className="usage-quota-line usage-quota-inferred"
          d={paths.uncertain}
          vectorEffect="non-scaling-stroke"
        />
        <path className="usage-sample-dots" d={paths.dots} vectorEffect="non-scaling-stroke" />
      </UsageChartFrame>
    </div>
  );
}

export function QuotaHistoryChart({ provider, history }: {
  readonly provider: ProviderUsageHistoryProvider;
  readonly history: ProviderUsageHistory;
}) {
  const [page, setPage] = useState(0);
  const zone = displayTimeZone(history);
  const windows = new Map<ProviderUsageWindow["kind"], { window: ProviderUsageWindow; fetchedAt: string }>();
  for (const sample of provider.samples) {
    for (const window of sample.windows) windows.set(window.kind, { window, fetchedAt: sample.fetchedAt });
  }
  const last = provider.samples.at(-1);
  const boundary = provider.accountChanges.at(-1);
  const stale = last !== undefined && Date.now() - Date.parse(last.fetchedAt) > 300_000;

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
          {windows.size > 0 ? (
            <>
              <div className="usage-quota-windows">
                {[...windows.values()].map(({ window, fetchedAt }, index) => (
                  <QuotaWindowChart
                    key={window.kind}
                    provider={provider}
                    history={history}
                    window={window}
                    fetchedAt={fetchedAt}
                    showTimeAxis={index === windows.size - 1}
                  />
                ))}
              </div>
              <p className="usage-muted">Dots mark checks; dashed lines show estimated resets or long gaps.</p>
            </>
          ) : <p>No quota windows were reported in this range.</p>}
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

function BucketBars({ id, data, models, max, value, formatted }: {
  readonly id: string;
  readonly data: WebUsageAnalytics;
  readonly models: readonly string[];
  readonly max: number;
  readonly value: (slice: WebUsageSlice) => number | null;
  readonly formatted: (amount: number) => string;
}) {
  const width = (CHART.width - CHART.left - CHART.right) / Math.max(1, data.buckets.length);
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return data.buckets.map((bucket, i) => {
    let stacked = 0;
    return (
      <g key={bucket.start}>
        {bucket.models.map((model, j) => {
          const amount = value(model);
          if (amount === null) return null; // Unknown prices are omitted, never plotted as free work.
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
    bucket.models.reduce((sum, model) => sum + (value(model) ?? 0), 0)
  )));
  const hasUnknownCost = data.buckets.some(item => item.models.some(model =>
    knownSpend(model) === null && partialSpend(model)
  ));
  const hasKnownCost = data.buckets.some(item => item.models.some(model => knownSpend(model) !== null));
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
      {metric === "cost" && hasUnknownCost && (
        <p className="usage-warning">Unknown prices are omitted from bars; only known amounts are plotted.</p>
      )}
      {metric === "cost" && hasUnknownCost && !hasKnownCost ? (
        <p className="usage-empty" role="status">No known prices to plot. Cost is unknown.</p>
      ) : <UsageChartFrame
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
        />
      </UsageChartFrame>}
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
