import type { ReactNode } from "react";
import type { ProviderUsageHistoryProvider } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics } from "../../../../src/contracts";
import { formatTokenCount } from "../../usage";
import { formatAnalyticsCost, tokenTotal } from "./usage-chart-geometry";
import { localTime } from "./UsageChartFrame";

type UsageBucket = WebUsageAnalytics["buckets"][number];

function ScrollableTable({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div
      className="usage-table-scroll"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

export function QuotaObservationTable({ provider, zone, page, onPage }: {
  readonly provider: ProviderUsageHistoryProvider;
  readonly zone: string;
  readonly page: number;
  readonly onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(provider.samples.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const samples = provider.samples.slice(currentPage * 50, (currentPage + 1) * 50);

  return (
    <details>
      <summary>Quota observations and account boundaries</summary>
      {provider.accountChanges.length > 0 && (
        <ul>
          {provider.accountChanges.map((at, i) => (
            <li key={`${at}-${i}`}>
              Account changed: <time dateTime={at}>{localTime(at, zone)}</time>
            </li>
          ))}
        </ul>
      )}
      <ScrollableTable label={`${provider.label} quota observations`}>
        <table>
          <caption>
            {provider.label} · {provider.downsampled ? "Reduced observations" : "Observed endpoints"}
            {" · "}page {currentPage + 1} of {pages}
          </caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Window / used</th>
              <th scope="col">Reported reset</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((sample, i) => (
              <tr key={`${sample.fetchedAt}-${i}`}>
                <td>
                  <time dateTime={sample.fetchedAt}>{localTime(sample.fetchedAt, zone)}</time>
                  <small>{sample.observations} checks in stored span</small>
                </td>
                <td>
                  {sample.windows.map(window => (
                    <div key={window.kind}>{window.label}: {window.usedPercent.toFixed(1)}%</div>
                  ))}
                </td>
                <td>
                  {sample.windows.map(window => (
                    <div key={window.kind}>
                      {window.resetsAt ? localTime(window.resetsAt, zone) : "Not reported"}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>
      {pages > 1 && (
        <div className="usage-actions">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => onPage(currentPage - 1)}
          >
            Previous observations
          </button>
          <button
            type="button"
            disabled={currentPage === pages - 1}
            onClick={() => onPage(currentPage + 1)}
          >
            Next observations
          </button>
        </div>
      )}
    </details>
  );
}

export function ModelBucketTable({ bucket, zone }: {
  readonly bucket: UsageBucket;
  readonly zone: string;
}) {
  return (
    <ScrollableTable label={`Model breakdown for ${localTime(bucket.start, zone)}`}>
      <table>
        <caption>Model breakdown · {localTime(bucket.start, zone)}</caption>
        <thead>
          <tr>
            <th scope="col">Provider / model</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache read</th>
            <th scope="col">Cache write</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {bucket.models.length ? bucket.models.map((model, i) => (
            <tr key={i}>
              <th scope="row">
                {model.model ?? "Unknown model"}
                <small>{model.provider ?? "Unknown provider"}</small>
              </th>
              {(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => (
                <td key={key}>
                  {model.tokens ? formatTokenCount(model.tokens[key]) : "Not reported"}
                </td>
              ))}
              <td>
                {formatAnalyticsCost(model)}
                {model.tokensPartial && <small>Token counters incomplete</small>}
              </td>
            </tr>
          )) : (
            <tr><td colSpan={6}>No observed usage in this bucket.</td></tr>
          )}
        </tbody>
      </table>
    </ScrollableTable>
  );
}

export function BucketTotalsTable({ data, zone }: {
  readonly data: WebUsageAnalytics;
  readonly zone: string;
}) {
  return (
    <details>
      <summary>All bucket totals</summary>
      <ScrollableTable label="All usage bucket totals">
        <table>
          <caption>
            Times displayed in {zone}; hourly boundaries are UTC, day boundaries follow {data.timeZone}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Bucket start</th>
              <th scope="col">Tokens</th>
              <th scope="col">Known cost</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map(bucket => (
              <tr key={bucket.start}>
                <td>
                  <time dateTime={bucket.start}>{localTime(bucket.start, zone)}</time>
                </td>
                <td>{bucket.total.tokens ? formatTokenCount(tokenTotal(bucket.total)) : "Not reported"}</td>
                <td>
                  {formatAnalyticsCost(bucket.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>
    </details>
  );
}
