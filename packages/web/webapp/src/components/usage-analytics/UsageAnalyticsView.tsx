import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { ProviderUsageHistory } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics } from "../../../../src/contracts";
import { formatTokenCount } from "../../usage";
import { QuotaHistoryChart, UsageBucketChart } from "./UsageCharts";
import { formatAnalyticsCost, knownSpend, partialSpend, tokenTotal } from "./usage-chart-geometry";
import "./usage-analytics.css";

export type AnalyticsRange = "6h" | "24h" | "7d" | "30d" | "90d";
export interface UsageAnalyticsViewProps {
  readonly agentLabel: string;
  readonly range: AnalyticsRange;
  readonly data: WebUsageAnalytics | null;
  readonly history: ProviderUsageHistory | null;
  readonly loading?: boolean;
  readonly dataError?: string | null;
  readonly historyError?: string | null;
  readonly feedback?: string | null;
  readonly busy?: boolean;
  readonly onRange: (range: AnalyticsRange) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  readonly onOpenConversation?: (id: string) => void;
  readonly onOpenProject?: (id: string) => void;
  readonly onVendorRefresh?: () => void;
  readonly onClear?: () => Promise<void>;
}

const spend = formatAnalyticsCost;

function RangeToolbar(props: Pick<
  UsageAnalyticsViewProps, "range" | "onRange" | "onRefresh" | "loading" | "busy"
>) {
  return (
    <div className="usage-toolbar">
      <fieldset>
        <legend>Range</legend>
        <div className="usage-actions">
          {(["6h", "24h", "7d", "30d", "90d"] as const).map(range => (
            <button
              key={range}
              type="button"
              aria-pressed={props.range === range}
              onClick={() => props.onRange(range)}
            >
              {range}
            </button>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        className="settings-button"
        disabled={props.loading || props.busy}
        onClick={props.onRefresh}
      >
        Refresh analytics
      </button>
    </div>
  );
}

function SummaryCards({ data }: { readonly data: WebUsageAnalytics }) {
  return (
    <div className="usage-summary">
      <article>
        <h2>{partialSpend(data.total) && knownSpend(data.total) !== null ? "Known spend" : "Recorded spend"}</h2>
        <strong>{spend(data.total)}</strong>
        {data.coverage.costPartial && <p>Total cost is incomplete.</p>}
      </article>
      <article>
        <h2>Reported tokens</h2>
        <strong>
          {data.total.tokens ? formatTokenCount(tokenTotal(data.total)) : "Not reported"}
        </strong>
        <p>
          {data.total.tokensPartial ? "Counters incomplete. " : ""}
          {data.coverage.messages} assistant observations
          {data.coverage.containsRunningUsage ? " · includes running work" : ""}
        </p>
      </article>
    </div>
  );
}

function ClearQuotaHistoryDialog(props: {
  readonly open: boolean;
  readonly clearError: boolean;
  readonly busy: boolean | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Trigger className="settings-button" disabled={props.busy}>
        Clear quota history
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="usage-dialog-backdrop" />
        <Dialog.Popup className="usage-confirm">
          <Dialog.Title>Clear quota history?</Dialog.Title>
          <Dialog.Description>
            Remove this agent's activated providers' quota history for the configured sign-in
            scope. Conversation tokens and cost stay unchanged. An in-flight real check can
            create a fresh sample.
          </Dialog.Description>
          {props.clearError && (
            <p role="alert">
              Could not clear history. Refresh to check its state before trying again.
            </p>
          )}
          <div className="usage-actions">
            <Dialog.Close className="settings-button">Cancel</Dialog.Close>
            <button
              type="button"
              className="settings-button"
              disabled={props.busy}
              onClick={props.onConfirm}
            >
              Confirm clear
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function QuotaHistorySection(props: Pick<
  UsageAnalyticsViewProps, "history" | "historyError" | "onVendorRefresh" | "busy"
> & { readonly clearDialog: ReactNode }) {
  const { history } = props;
  return (
    <section aria-labelledby="quota-history-heading">
      <div className="usage-section-heading">
        <h2 id="quota-history-heading">Subscription quota history</h2>
        <div className="usage-actions">
          {props.onVendorRefresh && (
            <button type="button" disabled={props.busy} onClick={props.onVendorRefresh}>
              Refresh usage
            </button>
          )}
          {props.clearDialog}
        </div>
      </div>
      <p className="usage-muted">
        Quota history for this agent's sign-in. A marker shows where a different account was
        detected. Anthropic account changes cannot be detected. Samples are on demand, not
        background monitoring; percentages are not dollars.
      </p>
      {props.historyError && <p className="usage-warning">{props.historyError}</p>}
      {history?.storage === "unavailable" && (
        <p className="usage-warning">
          Quota history storage is unavailable. Live quota checks can still work.
        </p>
      )}
      {history?.storage === "ready" && (history.providers.length ? (
        <div className="usage-quota-grid">
          {history.providers.map(provider => (
            <QuotaHistoryChart key={provider.providerId} provider={provider} history={history} />
          ))}
        </div>
      ) : (
        <p>No activated provider history is available yet.</p>
      ))}
    </section>
  );
}

function TopRankings(props: Pick<
  UsageAnalyticsViewProps, "onOpenConversation" | "onOpenProject"
> & { readonly data: WebUsageAnalytics }) {
  const { data } = props;
  return (
    <div className="usage-rankings">
      <section className="usage-card">
        <h2>Top conversations</h2>
        <p className="usage-muted">
          Ranked by known spend, including archived and background work.
        </p>
        {data.topConversations.length ? (
          <ol>
            {data.topConversations.map(row => (
              <li key={row.threadId}>
                <a
                  href={`?thread=${encodeURIComponent(row.threadId)}`}
                  onClick={event => {
                    if (props.onOpenConversation && !event.metaKey && !event.ctrlKey
                      && !event.shiftKey && !event.altKey) {
                      event.preventDefault();
                      props.onOpenConversation(row.threadId);
                    }
                  }}
                >
                  {row.title}
                </a>
                <strong>{spend(row.usage)}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p>No priced or token observations yet.</p>
        )}
      </section>
      <section className="usage-card">
        <h2>Top projects</h2>
        <p className="usage-muted">
          All retained member spend. Active-conversation basis excludes archived members and
          detached jobs, matching existing project summaries for the same UTC-month range.
          Membership is current, not historical.
        </p>
        {data.topProjects.length ? (
          <ol>
            {data.topProjects.map(row => (
              <li key={row.projectId}>
                <button
                  type="button"
                  className="usage-link"
                  onClick={() => props.onOpenProject?.(row.projectId)}
                >
                  {row.name}
                </button>
                <strong>{spend(row.usage)}</strong>
                <small>Active-conversation basis: {spend(row.projectSummaryUsage)}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p>No project observations yet.</p>
        )}
        <p className="usage-muted">Unassigned: {spend(data.unassignedUsage)}</p>
      </section>
    </div>
  );
}

export function UsageAnalyticsView(props: UsageAnalyticsViewProps) {
  const [confirm, setConfirm] = useState(false);
  const [clearError, setClearError] = useState(false);
  const { data } = props;
  const timeZone = data?.bucket === "day"
    ? data.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status = props.busy ? "Usage action in progress…"
    : props.loading ? "Loading usage analytics…"
      : props.feedback ?? (data ? "Usage analytics loaded." : "");

  return (
    <section className="usage-analytics" data-modal-surface="settings" aria-label="Usage analytics">
      <header className="usage-header">
        <div>
          <p className="eyebrow">{props.agentLabel} · Agent settings</p>
          <h1 tabIndex={-1}>Usage analytics</h1>
        </div>
        <button type="button" className="settings-button" onClick={props.onClose}>
          Close analytics
        </button>
      </header>
      <main className="usage-content">
        <RangeToolbar {...props} />
        <p className="usage-muted">
          Retained conversations for this agent, across sign-ins. Day buckets use the viewer
          timezone ({timeZone}); hourly boundaries are UTC and labels use local time. Deleted
          conversations and non-console runs are not included.
        </p>
        <div className="usage-status" role="status" aria-live="polite">{status}</div>
        {props.dataError && (
          <p className="usage-warning" role="alert">
            {props.dataError}{" "}
            <button type="button" onClick={() => props.onRange("6h")}>Use 6h range</button>
          </p>
        )}
        {data && <SummaryCards data={data} />}
        <QuotaHistorySection
          {...props}
          clearDialog={props.onClear ? (
            <ClearQuotaHistoryDialog
              open={confirm}
              clearError={clearError}
              busy={props.busy}
              onOpenChange={setConfirm}
              onConfirm={() => {
                setClearError(false);
                void props.onClear!().then(() => setConfirm(false)).catch(error => {
                  if ((error as { name?: unknown } | null)?.name === "AbortError") {
                    setConfirm(false);
                    props.onRefresh();
                  } else setClearError(true);
                });
              }}
            />
          ) : null}
        />
        {data && (
          <>
            {data.coverage.messages === 0 && (
              <p className="usage-empty">
                No retained usage observations in this range. Choose another range after a
                conversation records usage.
              </p>
            )}
            <UsageBucketChart data={data} />
            <TopRankings {...props} data={data} />
            <p className="usage-muted">
              Observations use the containing message's creation time, including long-running
              job totals. Compaction and continuity upkeep keep their recorded extraction
              models; upkeep is counted once per thread/range. Top lists show at most 10 of
              {" "}{data.coverage.conversations} conversations and {data.coverage.projects} projects.
              {" "}Calculated <time dateTime={data.computedAt}>
                {new Date(data.computedAt).toLocaleString()}
              </time>.
            </p>
          </>
        )}
      </main>
    </section>
  );
}
