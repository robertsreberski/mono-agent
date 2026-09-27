"use client";

import { isProviderUsageId, PROVIDER_USAGE_LABELS } from "@mono-agent/agent-contracts/provider-usage";
import type { AgentManualCompactionResult } from "@mono-agent/agent-contracts";
import { Popover } from "@base-ui/react/popover";
import { useId, useRef, useState } from "react";
import type { WebThreadUsage, WebUsageSlice } from "../../../../src/contracts.js";
import { api, ApiError } from "../../api";
import type { AgentSummary, ProviderUsageId, ThreadDetail } from "../../types";
import { contextLevel, formatTokenCount, formatUsd, type ConsoleContextProjection } from "../../usage";
import { useThreadUsage } from "../../use-thread-usage";
import { ProviderUsageMeters, useProviderUsage } from "../ProviderUsageMeters";
import { shortModelName } from "../route-label";

export interface ContextDisplayProps {
  readonly threadId?: string;
  readonly detail?: ThreadDetail | null;
  readonly compactThreadId?: string;
  readonly compactBlocked?: boolean;
  readonly running?: boolean;
  readonly contextLoading?: boolean;
  readonly context: ConsoleContextProjection;
  /** Explicit stories and focused tests may provide a settled aggregate. */
  readonly totals?: WebThreadUsage;
  readonly providerUsage?: { readonly agent: AgentSummary; readonly providerId: string };
  readonly className?: string;
}

const count = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const windowSize = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
const percentText = (percent: number): string => percent > 0 && percent < 0.5 ? "<1%" : `${Math.round(percent)}%`;
const exact = (value: number): string => value.toLocaleString();
const modelName = (model: string | undefined): string => model === undefined ? "Unknown model" : shortModelName(model);

function ContextRing({ percent, unknown }: { readonly percent?: number; readonly unknown: boolean }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return <svg className="context-display-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle className="ring-track" cx="7" cy="7" r={radius} strokeWidth="2" fill="none" strokeDasharray={unknown ? "2 2" : undefined} />
    {!unknown && <circle className="ring-value" cx="7" cy="7" r={radius} strokeWidth="2" fill="none"
      strokeDasharray={`${circumference * Math.min(100, percent ?? 0) / 100} ${circumference}`}
      transform="rotate(-90 7 7)" />}
  </svg>;
}

function ContextWindowSection({ context, running, loading, id }: {
  readonly context: ConsoleContextProjection; readonly running: boolean; readonly loading: boolean; readonly id: string;
}) {
  const { usage, measuredModel, status, compaction } = context;
  const used = usage === undefined ? undefined : count(usage.total);
  const size = windowSize(usage?.contextWindow);
  const fraction = used === undefined || size === undefined ? undefined : Math.min(100, used / size * 100);
  const estimate = status === "awaiting_measurement" && compaction?.running !== true && used !== undefined;
  const busy = compaction?.running === true;
  const muted = status === "last_measured" || busy;
  const model = measuredModel ?? usage?.model;
  const meta = loading ? "" : busy ? "Compacting…" : status === "updating" || running ? "Updating"
    : status === "last_measured" ? "Last measured" : status === "awaiting_measurement" ? "Estimate"
      : model === undefined ? "" : modelName(model);
  const note = loading ? undefined
    : status === "last_measured" ? context.nextModel !== undefined
      ? model === undefined
        ? `The measurement didn't name its model. The next turn uses ${context.nextModel}.`
        : `Measured on ${model}. The next turn uses ${context.nextModel}.`
      : context.lastTurnFailed ? "The last turn didn't finish. This is the previous measurement." : undefined
      : status === "awaiting_measurement" ? busy ? undefined
        : context.compaction?.tokensAfter === undefined
          ? "Compaction changed the context. It's measured again on the next turn."
          : "Estimated after compaction. Measured exactly on the next turn."
        : status === "updating" && used === undefined ? "The size appears when the first reply reports it."
          : status === "unavailable" && context.noContextRuntime === "claude" ? "This runtime doesn't report its context size."
            : status === "unavailable" ? "No reply in this conversation has reported its context size." : undefined;
  return <section className="context-display-section" aria-labelledby={id}>
    <div className="context-display-section-heading"><h3 className="context-display-eyebrow" id={id}>Context window</h3>
      <span className="context-display-meta" title={model} data-tone={busy || status === "updating" ? "accent" : status === "last_measured" ? "warning" : undefined}>{meta}</span>
    </div>
    <div className="context-display-figure" data-level={contextLevel(fraction)} data-muted={muted ? "" : undefined}>
      <span>{used === undefined
        ? <span className="context-display-figure-empty">{loading ? "Loading…" : status === "unavailable" ? "Not reported" : "Not measured yet"}</span>
        : <><span className="context-display-figure-value">{estimate ? "≈" : ""}{formatTokenCount(used)}</span>
          <span className="context-display-figure-of">{size === undefined ? " tokens" : ` / ${formatTokenCount(size)} tokens`}</span></>}
      </span>
      {fraction !== undefined && <span className="context-display-figure-percent">{estimate ? "≈" : ""}{percentText(fraction)}</span>}
    </div>
    {fraction !== undefined && used !== undefined && size !== undefined && <div className="context-display-progress" role="progressbar"
      aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(fraction.toFixed(1))}
      aria-valuetext={`${estimate ? "About " : ""}${exact(used)} of ${exact(size)} tokens, ${percentText(fraction)}`}
      data-level={contextLevel(fraction)} data-muted={muted ? "" : undefined} data-estimate={estimate ? "" : undefined} data-busy={busy ? "" : undefined}>
      <span className="context-display-progress-value" style={{ width: `${fraction}%` }} />
    </div>}
    {note && <p className="context-display-note" data-tone={status === "last_measured" ? "warning" : undefined}>{note}</p>}
  </section>;
}

const tokenColumns = [
  { key: "input", label: "Input", title: "Uncached input, including cache writes" },
  { key: "cacheRead", label: "Cached", title: "Input read from the provider's prompt cache" },
  { key: "output", label: "Output", title: "Generated output" },
] as const;
function TokensSection({ totals, loading, id }: { readonly totals?: WebThreadUsage; readonly loading: boolean; readonly id: string }) {
  const total = totals?.total;
  const sub = totals?.subagents;
  const cells = (slice: WebUsageSlice, subLine = false) => {
    if (slice.tokens === undefined) return <td colSpan={3} className="is-unreported">{subLine ? "not reported" : "No token counts reported"}</td>;
    return tokenColumns.map(({ key }) => {
      const value = key === "input" ? slice.tokens!.input + slice.tokens!.cacheWrite : slice.tokens![key];
      return <td key={key} title={subLine && slice.tokensPartial
        ? sub?.runsWithTokens === undefined
          ? `At least. Some subagent runs didn't report tokens. ${exact(value)} reported.`
          : `At least. ${sub.runs - sub.runsWithTokens} of ${sub.runs} subagent runs didn't report tokens.`
        : exact(value)}
        aria-label={`${slice.tokensPartial ? "at least " : ""}${exact(value)}`}>
        {slice.tokensPartial ? "≥" : ""}{formatTokenCount(value)}
      </td>;
    });
  };
  return <section className="context-display-section" aria-labelledby={id} aria-busy={loading || undefined}>
    <h3 className="context-display-eyebrow" id={id}>Tokens processed</h3>
    {loading && totals === undefined ? <p className="context-display-empty">—</p> : total?.tokens === undefined && sub === undefined
      ? <p className="context-display-empty">No reply in this conversation reported token counts.</p>
      : <table className="context-display-tokens"><colgroup><col className="label" /><col /><col /><col /></colgroup>
        <thead><tr><th aria-label="Row" />{tokenColumns.map(({ key, label, title }) => <th key={key} scope="col" title={title}>{label}</th>)}</tr></thead>
        <tbody><tr><th scope="row">Total</th>{cells(total ?? {})}</tr>
          {sub && <tr className="is-sub"><th scope="row">incl. subagents</th>{cells(sub, true)}</tr>}
        </tbody></table>}
  </section>;
}

function CostSection({ totals, loading, id }: { readonly totals?: WebThreadUsage; readonly loading: boolean; readonly id: string }) {
  const total = totals?.total;
  const models = totals?.byModel ?? [];
  const duplicates = new Map<string, number>();
  for (const row of models) duplicates.set(modelName(row.model), (duplicates.get(modelName(row.model)) ?? 0) + 1);
  const cost = (slice: WebUsageSlice) => slice.costUsd === undefined ? "—" : `${slice.costPartial ? "≥" : ""}${formatUsd(slice.costUsd)}`;
  const more = models.slice(4).reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  return <section className="context-display-section" aria-labelledby={id} aria-busy={loading || undefined}>
    <div className="context-display-section-heading"><h3 className="context-display-eyebrow" id={id}>Estimated cost</h3>
      {(loading && totals === undefined || total?.costUsd !== undefined) && <span className="context-display-cost-total">{total === undefined ? "—" : cost(total)}</span>}
    </div>
    {loading && totals === undefined ? null : total?.costUsd === undefined
      ? <p className="context-display-empty">No cost was reported for this conversation.</p>
      : <dl className="context-display-cost">
        {totals?.subagents?.costUsd !== undefined && totals.subagents.costUsd > 0 &&
          <div className="context-display-cost-row is-sub"><dt>incl. subagents</dt><dd>{cost(totals.subagents)}</dd></div>}
        {models.length >= 2 && <><div className="context-display-cost-divider" aria-hidden="true" />
          {models.slice(0, 4).map((row, index) => <div className="context-display-cost-row is-model" key={`${row.model ?? "unknown"}-${index}`}>
            <dt title={row.model}>{modelName(row.model)}{duplicates.get(modelName(row.model))! > 1 && row.model?.includes(":") ? ` · ${row.model.split(":", 1)[0]}` : ""}</dt>
            <dd>{cost(row)}</dd>
          </div>)}
          {models.length > 4 && <div className="context-display-cost-row is-model"><dt>{models.length - 4} more models</dt><dd>{formatUsd(more)}</dd></div>}
        </>}
      </dl>}
  </section>;
}

function ProviderUsageSection({ agent, providerId, id }: { readonly agent: AgentSummary; readonly providerId: ProviderUsageId; readonly id: string }) {
  const { snapshot, loading } = useProviderUsage(agent);
  const usage = snapshot?.providers.find((provider) => provider.providerId === providerId);
  const label = usage?.label ?? PROVIDER_USAGE_LABELS[providerId];
  if (!loading && usage === undefined) return null;
  return <section className="context-display-section context-display-provider-usage" aria-labelledby={id}>
    <div className="context-display-provider-heading"><h3 className="context-display-eyebrow" id={id}>{label} plan</h3>
      <span className="context-display-plan-meta">
        {usage?.stale && <span className="context-display-meta" title={`Fetched ${new Date(usage.fetchedAt).toLocaleString()}`}>Last known</span>}
        {usage?.plan && <span className="provider-usage-plan">{usage.plan}</span>}
      </span></div>
    {loading ? <p className="context-display-provider-loading" role="status">Loading usage…</p>
      : <ProviderUsageMeters usage={usage} density="compact" />}
  </section>;
}

function CompactFooter({ id, compact, compacting, blocked, percent, result, error, measuredModel }: {
  readonly id: string; readonly compact: () => void; readonly compacting: boolean; readonly blocked: boolean;
  readonly percent?: number; readonly result: AgentManualCompactionResult | null; readonly error: string | null; readonly measuredModel?: string;
}) {
  const near = percent !== undefined && percent >= 80;
  const before = result?.tokensBefore;
  const after = result?.tokensAfter;
  const status = error ?? (compacting ? "Summarizing earlier turns…" : blocked ? "Available when this turn finishes."
    : result?.status === "succeeded" ? before === undefined || after === undefined ? "Compacted."
      : `Compacted · ${formatTokenCount(before)} → ${result.tokenCountsExact ? "" : "≈"}${formatTokenCount(after)}`
      : result?.status === "skipped" ? result.reason === "model_changed"
        ? `Switch back to ${measuredModel ?? "this conversation's model"} to compact this session.` : "Nothing to compact yet."
        : result?.status === "failed" ? "Compaction failed."
          : near ? "Context is nearly full." : "Summarizes earlier turns to free space.");
  const role = error !== null || result?.status === "failed" ? "alert"
    : compacting || result !== null ? "status" : undefined;
  const tone = error !== null || result?.status === "failed" ? "danger"
    : result?.status === "succeeded" ? "success" : near && !blocked ? "warning" : undefined;
  return <div className="context-display-compact">
    <p id={id} className="context-display-compact-status" role={role === "alert" ? "alert" : undefined} data-tone={tone}>{status}</p>
    <p className="sr-only" role="status" aria-atomic="true">{role === "status" ? status : ""}</p>
    <button className="context-display-compact-button" type="button" onClick={compact}
      aria-describedby={id} aria-disabled={blocked && !compacting ? true : undefined}
      aria-busy={compacting || undefined} disabled={compacting} data-emphasis={near && !blocked && !compacting ? "" : undefined}>
      {compacting && <span className="context-display-spinner" aria-hidden="true" />}{compacting ? "Compacting…" : "Compact"}
    </button>
  </div>;
}

export function ContextDisplay({ threadId, detail, compactThreadId, compactBlocked = false, running = false,
  contextLoading = false, context, totals: providedTotals, providerUsage, className }: ContextDisplayProps) {
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<AgentManualCompactionResult | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const loaded = useThreadUsage(threadId, open, running, detail);
  const totals = providedTotals ?? loaded.usage;
  const loading = providedTotals === undefined && loaded.loading;
  const used = context.usage === undefined ? undefined : count(context.usage.total);
  const size = windowSize(context.usage?.contextWindow);
  const percent = used === undefined || size === undefined ? undefined : Math.min(100, used / size * 100);
  const estimate = context.status === "awaiting_measurement" && context.compaction?.running !== true && used !== undefined;
  const last = context.status === "last_measured" || context.compaction?.running === true;
  const badge = percent === undefined ? "—" : `${estimate ? "≈" : ""}${percentText(percent)}`;
  const label = contextLoading ? "loading" : used === undefined ? "context size not reported"
    : size === undefined ? `${exact(used)} tokens; context window size not reported`
      : `${estimate ? "about " : last ? "last measured " : ""}${exact(used)} of ${exact(size)} tokens (${estimate ? "about " : ""}${percentText(percent!)}${estimate ? ") after compaction" : ")"}${context.status === "updating" || running ? ", updating" : ""}`;
  const ariaLabel = `Context usage: ${label}.${totals?.total.costUsd === undefined ? "" : ` Estimated cost ${formatUsd(totals.total.costUsd)}.`}`;
  const availableProviderUsage = providerUsage !== undefined && providerUsage.agent.supportsProviderUsage === true
    && providerUsage.agent.status !== "offline" && isProviderUsageId(providerUsage.providerId)
    ? { agent: providerUsage.agent, providerId: providerUsage.providerId } : undefined;
  const compact = async () => {
    if (compactThreadId === undefined || compacting || compactBlocked) return;
    setCompacting(true); setCompactError(null); setCompactResult(null);
    try { setCompactResult(await api.compactThread(compactThreadId)); }
    catch (error) { setCompactError(error instanceof ApiError ? error.message
      : "Connection lost — the outcome is unknown. Refresh this conversation."); }
    finally { setCompacting(false); }
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) { setCompactResult(null); setCompactError(null); }
  };
  const firstTurn = totals?.settledAssistantTurns === 0
    && totals.total.tokens === undefined && totals.total.costUsd === undefined
    && totals.subagents === undefined && totals.byModel.length === 0;
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger type="button" className={["context-display-trigger", className].filter(Boolean).join(" ")}
      data-slot="context-display-trigger" data-state={context.status} data-level={contextLevel(percent)}
      data-estimate={estimate ? "" : undefined} data-muted={last ? "" : undefined} aria-label={ariaLabel}>
      <ContextRing percent={percent} unknown={percent === undefined} />
      <span className="context-display-trigger-percent" data-slot="context-display-percent">{badge}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Backdrop className="context-display-backdrop" />
      <Popover.Positioner className="context-display-positioner" side="top" align="end" sideOffset={8} collisionPadding={12}>
        <Popover.Popup ref={popupRef} tabIndex={-1} initialFocus={() => popupRef.current} className="context-display-popover">
          <div className="context-display-header">
            <Popover.Title className="context-display-title">Context usage</Popover.Title>
            <Popover.Close className="context-display-close" aria-label="Close" type="button">✕</Popover.Close>
          </div>
          <ContextWindowSection context={context} running={running} loading={contextLoading} id={`${id}-window`} />
          {firstTurn ? <section className="context-display-section" aria-labelledby={`${id}-empty`}>
            <h3 className="context-display-eyebrow" id={`${id}-empty`}>Tokens &amp; cost</h3>
            <p className="context-display-empty">Totals appear when the first turn finishes.</p>
          </section> : <>
            <TokensSection totals={totals} loading={loading} id={`${id}-tokens`} />
            <CostSection totals={totals} loading={loading} id={`${id}-cost`} />
          </>}
          {open && availableProviderUsage && <ProviderUsageSection
            key={`${availableProviderUsage.agent.sourceId}:${availableProviderUsage.agent.generation ?? "unknown"}:${availableProviderUsage.providerId}`}
            agent={availableProviderUsage.agent} providerId={availableProviderUsage.providerId} id={`${id}-plan`} />}
          {compactThreadId !== undefined && <CompactFooter id={`${id}-compact`} compact={() => { void compact(); }}
            compacting={compacting} blocked={compactBlocked} percent={percent} result={compactResult} error={compactError} measuredModel={context.measuredModel ?? context.usage?.model} />}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
