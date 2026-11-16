import { useId, useState } from "react";
import { projectProviderUsageWindow, type ProviderUsageHistory, type ProviderUsageHistoryProvider } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics } from "../../../../src/contracts";
import { formatTokenCount, formatUsd } from "../../usage";
import { CHART, displayTimeZone, knownSpend, modelColor, partialSpend, quotaPaths, tokenTotal, xAt } from "./usage-chart-geometry";

const localTime = (at: string, zone: string) => new Date(at).toLocaleString(undefined, { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
export function QuotaHistoryChart({ provider, history }: { readonly provider: ProviderUsageHistoryProvider; readonly history: ProviderUsageHistory }) {
  const id = useId(), [page, setPage] = useState(0);
  const zone = displayTimeZone(history);
  const kinds = [...new Set(provider.samples.flatMap(sample => sample.windows.map(w => w.kind)))];
  const last = provider.samples.at(-1);
  const stale = last !== undefined && Date.now() - Date.parse(last.fetchedAt) > 300_000;
  const resets = [...new Set(provider.samples.flatMap(s => s.windows.flatMap(w => w.resetsAt && w.resetsAt >= history.from && w.resetsAt < history.to ? [w.resetsAt] : [])))];
  const pages = Math.max(1, Math.ceil(provider.samples.length / 50)), currentPage = Math.min(page, pages - 1);
  return <article className="usage-card" aria-label={`${provider.label} quota history`}>
    <div className="usage-card-heading"><h3>{provider.label}</h3>{last?.plan && <span>{last.plan}</span>}</div>
    {last ? <p className="usage-muted">{stale ? "Last known usage · " : "Last check · "}<time dateTime={last.fetchedAt}>{localTime(last.fetchedAt, zone)}</time></p> : <p>No quota history yet. An existing usage check or explicit Refresh usage records a sample.</p>}
    {provider.truncatedBefore && <p className="usage-warning">Earlier history was removed by a capacity limit.</p>}
    {provider.accountChanges.length > 0 && <p className="usage-warning">Account changed · {localTime(provider.accountChanges.at(-1)!, zone)}</p>}
    {last && <>
      <svg className="usage-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>{provider.label} quota percentages</title><desc id={`${id}-description`}>Percent used from 0 to 100. Dotted connectors are unobserved or reduced intervals. Lines break at detected account changes and resets. Exact observations are in the table.</desc>
        {[0, 50, 100].map(percent => { const y = CHART.top + (100 - percent) / 100 * (CHART.height - CHART.top - CHART.bottom); return <g key={percent}><line className="usage-grid" x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} /><text x={CHART.left - 6} y={y + 4} textAnchor="end">{percent}%</text></g>; })}
        <path className="usage-reset" d={resets.map(at => `M${xAt(at, history)},${CHART.top}V${CHART.height - CHART.bottom}`).join(" ")} />
        <path className="usage-boundary" d={provider.accountChanges.map(at => `M${xAt(at, history)},${CHART.top}V${CHART.height - CHART.bottom}`).join(" ")} />
        {provider.accountChanges.length > 0 && <text className="usage-boundary-label" x={Math.max(100, Math.min(540, xAt(provider.accountChanges.at(-1)!, history)))} y={13} textAnchor="middle">Account changed</text>}
        {kinds.map((kind, index) => { const paths = quotaPaths(provider, kind, history); return <g key={kind} style={{ color: modelColor(index) }}><path className="usage-quota-line" d={paths.solid} /><path className="usage-quota-line" strokeDasharray="3 5" d={paths.uncertain} /><path fill="currentColor" d={paths.dots} /></g>; })}
        <text x={CHART.left} y={CHART.height - 4}>{localTime(history.from, zone)}</text><text x={CHART.width - CHART.right} y={CHART.height - 4} textAnchor="end">{localTime(history.to, zone)}</text>
      </svg>
      <ul className="usage-legend">{kinds.map((kind, index) => { const window = last.windows.find(w => w.kind === kind); const pace = window && projectProviderUsageWindow(window, last.fetchedAt); return <li key={kind}><i style={{ background: modelColor(index) }} aria-hidden="true" />{window?.label ?? kind}{pace && <span className={pace.severity === "ok" ? "usage-muted" : "usage-warning"}>{pace.pace.toFixed(2)}× pace{pace.confidence === "low" ? " (early estimate)" : ""}</span>}</li>; })}</ul>
      <p className="usage-muted">Dashed vertical: reported reset · Solid vertical: account boundary. Pace is constant-rate extrapolation at the actual check, not a forecast.</p>
      <details><summary>Quota observations and account boundaries</summary>
        {provider.accountChanges.length > 0 && <ul>{provider.accountChanges.map((at, i) => <li key={`${at}-${i}`}>Account changed: <time dateTime={at}>{localTime(at, zone)}</time></li>)}</ul>}
        <div className="usage-table-scroll" role="region" aria-label="Scrollable usage data table" tabIndex={0}><table><caption>{provider.label} · {provider.downsampled ? "Reduced observations" : "Observed endpoints"} · page {currentPage + 1} of {pages}</caption><thead><tr><th scope="col">Check</th><th scope="col">Window / used</th><th scope="col">Reported reset</th></tr></thead><tbody>{provider.samples.slice(currentPage * 50, (currentPage + 1) * 50).map((sample, i) => <tr key={`${sample.fetchedAt}-${i}`}><td><time dateTime={sample.fetchedAt}>{localTime(sample.fetchedAt, zone)}</time><small>{sample.observations} checks in stored span</small></td><td>{sample.windows.map(w => <div key={w.kind}>{w.label}: {w.usedPercent.toFixed(1)}%</div>)}</td><td>{sample.windows.map(w => <div key={w.kind}>{w.resetsAt ? localTime(w.resetsAt, zone) : "Not reported"}</div>)}</td></tr>)}</tbody></table></div>
        {pages > 1 && <div className="usage-actions"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous observations</button><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next observations</button></div>}
      </details>
    </>}
  </article>;
}

export function UsageBucketChart({ data }: { readonly data: WebUsageAnalytics }) {
  const id = useId(), [metric, setMetric] = useState<"cost" | "tokens">("cost"), [selected, setSelected] = useState(0);
  const zone = displayTimeZone(data);
  const models = [...new Set(data.buckets.flatMap(b => b.models.map(m => m.other ? "Other models" : m.model ?? "Unknown model")))];
  const value = metric === "cost" ? knownSpend : tokenTotal;
  const max = Math.max(0.000001, ...data.buckets.map(b => b.models.reduce((sum, m) => sum + value(m), 0)));
  const width = (CHART.width - CHART.left - CHART.right) / Math.max(1, data.buckets.length);
  const bucket = data.buckets[Math.min(selected, data.buckets.length - 1)];
  const formatted = (n: number) => metric === "cost" ? formatUsd(n) : formatTokenCount(n);
  return <section className="usage-card" aria-labelledby={`${id}-heading`}>
    <div className="usage-card-heading"><h2 id={`${id}-heading`}>Tokens and spend</h2><div className="usage-actions" role="group" aria-label="Chart metric"><button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Cost</button><button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button></div></div>
    <p className="usage-muted">{metric === "cost" && partialSpend(data.total) ? "Known spend only; total cost is incomplete. " : ""}Stacked by recorded model. Synchronous child tokens stay in their inclusive parent model.</p>
    <svg className="usage-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{metric === "cost" ? "Known cost" : "Reported tokens"} by model and bucket</title><desc id={`${id}-description`}>{data.buckets.length} time buckets. Use the bucket selector or table for exact values and model breakdown. Unknown prices are not zero.</desc>
      <defs>{models.map((_, index) => <pattern key={index} id={`${id}-model-${index}`} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform={index < 16 ? "rotate(45)" : undefined}><rect width="8" height="8" fill={modelColor(index)} />{index >= 16 ? <circle cx="4" cy="4" r="1.5" fill="var(--panel)" opacity=".7" /> : index >= 8 ? <path d="M0 0V8" stroke="var(--panel)" strokeWidth="2" opacity=".7" /> : null}</pattern>)}</defs>
      {[0, 0.5, 1].map(fraction => { const y = CHART.top + (1 - fraction) * (CHART.height - CHART.top - CHART.bottom); return <g key={fraction}><line className="usage-grid" x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} /><text x={CHART.left - 5} y={y + 4} textAnchor="end">{formatted(max * fraction)}</text></g>; })}
      {data.buckets.map((b, i) => { let stacked = 0; return <g key={b.start}>{b.models.map((m, j) => { const amount = value(m), height = amount / max * (CHART.height - CHART.top - CHART.bottom); stacked += amount; return <rect key={j} x={CHART.left + i * width + 1} y={CHART.height - CHART.bottom - stacked / max * (CHART.height - CHART.top - CHART.bottom)} width={Math.max(0.5, width - 2)} height={height} fill={`url(#${id}-model-${models.indexOf(m.other ? "Other models" : m.model ?? "Unknown model")})`} onClick={() => setSelected(i)}><title>{m.model ?? "Unknown model"}: {formatted(amount)}</title></rect>; })}</g>; })}
      <text x={CHART.left} y={CHART.height - 4}>{localTime(data.from, zone)}</text><text x={CHART.width - CHART.right} y={CHART.height - 4} textAnchor="end">{localTime(data.to, zone)}</text>
    </svg>
    <ul className="usage-legend">{models.map((model, index) => <li key={model}><i aria-hidden="true" style={{ background: modelColor(index), backgroundImage: index >= 16 ? "radial-gradient(var(--panel) 1px, transparent 1px)" : index >= 8 ? "repeating-linear-gradient(45deg, transparent 0 3px, var(--panel) 3px 4px)" : undefined, backgroundSize: index >= 16 ? "4px 4px" : undefined }} />{model}</li>)}</ul>
    <label className="usage-bucket-select">Inspect bucket <select value={Math.min(selected, data.buckets.length - 1)} onChange={event => setSelected(Number(event.target.value))}>{data.buckets.map((b, i) => <option key={b.start} value={i}>{localTime(b.start, zone)}</option>)}</select></label>
    {bucket && <div className="usage-table-scroll" role="region" aria-label="Scrollable usage data table" tabIndex={0}><table><caption>Model breakdown · {localTime(bucket.start, zone)}</caption><thead><tr><th scope="col">Provider / model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">Cost</th></tr></thead><tbody>{bucket.models.length ? bucket.models.map((m, i) => <tr key={i}><th scope="row">{m.model ?? "Unknown model"}<small>{m.provider ?? "Unknown provider"}</small></th>{["input", "output", "cacheRead", "cacheWrite"].map(key => <td key={key}>{m.tokens ? formatTokenCount(m.tokens[key as keyof NonNullable<typeof m.tokens>]) : "Not reported"}</td>)}<td>{partialSpend(m) ? `${formatUsd(knownSpend(m))} known · incomplete` : m.costUsd === undefined ? "Not reported" : formatUsd(m.costUsd!)}{m.tokensPartial && <small>Token counters incomplete</small>}</td></tr>) : <tr><td colSpan={6}>No observed usage in this bucket.</td></tr>}</tbody></table></div>}
    <details><summary>All bucket totals</summary><div className="usage-table-scroll" role="region" aria-label="Scrollable usage data table" tabIndex={0}><table><caption>Times displayed in {zone}; hourly boundaries are UTC, day boundaries follow {data.timeZone}.</caption><thead><tr><th scope="col">Bucket start</th><th scope="col">Tokens</th><th scope="col">Known cost</th></tr></thead><tbody>{data.buckets.map(b => <tr key={b.start}><td><time dateTime={b.start}>{localTime(b.start, zone)}</time></td><td>{b.total.tokens ? formatTokenCount(tokenTotal(b.total)) : "Not reported"}</td><td>{b.total.costUsd === undefined && b.total.knownCostUsd === undefined ? "Not reported" : formatUsd(knownSpend(b.total))}{partialSpend(b.total) ? " · incomplete" : ""}</td></tr>)}</tbody></table></div></details>
  </section>;
}
