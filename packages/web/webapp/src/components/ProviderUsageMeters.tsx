import { useEffect, useRef, useState } from "react";
import { formatProviderUsageLead, projectProviderUsageWindow } from "@mono-agent/agent-contracts/provider-usage";
import { api } from "../api";
import type { AgentSummary, ProviderUsage, ProviderUsageSnapshot } from "../types";

/** Isolated from auth status/login: slow or failed quota reads never hide auth controls. */
export function useProviderUsage(agent: AgentSummary, authRevision?: string) {
  const [snapshot, setSnapshot] = useState<ProviderUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const owner = useRef<{ scope: string; refresh: () => Promise<void> } | null>(null);
  const scope = `${agent.sourceId}:${agent.generation ?? "unknown"}:${authRevision ?? ""}`;
  useEffect(() => {
    setSnapshot(null);
    setRefreshing(false);
    setFeedback(null);
    const canLoad = agent.supportsProviderUsage === true && agent.status !== "offline";
    setLoading(canLoad);
    if (!canLoad) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let manualFlight = false;
    let retained: ProviderUsageSnapshot | null = null;
    const load = async (manual = false) => {
      // Timer reads cannot supersede a pending manual request. A manual request
      // can supersede an older GET, even if that GET ignores its AbortSignal.
      if (manualFlight) return;
      if (manual) {
        manualFlight = true;
        setRefreshing(true);
        setFeedback("Refreshing usage…");
      }
      if (timer !== undefined) clearTimeout(timer);
      const request = ++sequence;
      let delay = 300_000;
      try {
        const next = await (manual ? api.refreshProviderUsage(agent.sourceId, controller.signal) : api.providerUsage(agent.sourceId, controller.signal));
        if (controller.signal.aborted || request !== sequence) return;
        const missing = retained?.providers.some((previous) => !next.providers.some((item) => item.providerId === previous.providerId));
        retained = next;
        setSnapshot(next);
        if (manual) {
          if (next.providers.some((item) => item.stale || item.error) || missing) {
            setFeedback("Some usage could not be refreshed. Last known meters are retained where available.");
          } else if (next.providers.length === 0) {
            setFeedback("No subscription usage is available.");
          } else {
            const oldest = Math.min(...next.providers.map((item) => Date.parse(item.fetchedAt)));
            setFeedback(`Usage refreshed. Last fetched ${new Date(oldest).toLocaleString()}.`);
          }
        }
        // A stale automatic response started a coalesced refresh; read it once soon.
        if (next.providers.some((provider) => provider.stale && !provider.error)) delay = 15_000;
      } catch {
        if (controller.signal.aborted || request !== sequence) return;
        // Fixed transport error, preserving last-good values and fetchedAt.
        setSnapshot((previous) => previous === null ? null : ({ ...previous, providers: previous.providers.map((provider) => ({
          ...provider, stale: true, error: { code: "unavailable", message: "Provider usage is unavailable." },
        })) }));
        if (manual) setFeedback("Usage refresh failed. Last known meters are retained where available.");
      } finally {
        if (!controller.signal.aborted && request === sequence) {
          if (!manual) setLoading(false);
          if (manual) { manualFlight = false; setRefreshing(false); }
          timer = setTimeout(() => { void load(); }, delay);
        }
      }
    };
    owner.current = { scope, refresh: () => load(true) };
    void load();
    return () => {
      controller.abort();
      owner.current = null;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [scope, agent.status, agent.supportsProviderUsage]);
  return {
    snapshot,
    loading,
    refreshing,
    feedback,
    refresh: () => agent.supportsProviderUsageRefresh === true && agent.status !== "offline" && owner.current?.scope === scope
      ? owner.current.refresh() : Promise.resolve(),
  };
}

function countdown(reset: string, now: number): string {
  const diffMs = Date.parse(reset) - now;
  if (Math.max(0, Math.ceil(diffMs / 60_000)) === 0) return "Reset due";
  return `Resets in ${formatProviderUsageLead(diffMs)}`;
}
// How early the window runs out is the decision, so it rides on the countdown
// line as one fragment. The absolute instant stays in the title.
const earlyLine = (leadMs: number): string => `empty ${formatProviderUsageLead(leadMs)} early`;
/** The plan chip is rendered inline by the provider heading; this shows only the meters. */
export function ProviderUsageMeters({ usage }: { readonly usage?: ProviderUsage }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!usage) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [usage]);
  if (!usage) return null;
  return <div className="provider-usage" aria-label={`${usage.label} subscription usage`}>
    {usage.stale && <div className="provider-usage-meta">
      <span title={`Fetched ${new Date(usage.fetchedAt).toLocaleString()}`}>Last known usage</span>
    </div>}
    {usage.windows.map((window) => {
      // One shared derivation, anchored at the measurement: a window is never both ahead and under.
      const projection = projectProviderUsageWindow(window, usage.fetchedAt);
      const alert = projection !== undefined && projection.exhaustsAt !== undefined && projection.leadMs !== undefined
        && (projection.severity === "ahead" || projection.severity === "unsustainable") ? projection : undefined;
      const unused = alert === undefined && projection?.projectedUnusedPercent !== undefined && projection.projectedUnusedPercent >= 5
        ? Math.round(projection.projectedUnusedPercent) : undefined;
      const chip = projection !== undefined && projection.confidence === "normal"
        ? { text: `${projection.pace.toFixed(1)}×`, tier: projection.severity === "ok" ? "is-steady" : `is-${projection.severity}` } : undefined;
      const name = projection === undefined ? `${usage.label} ${window.label} used`
        : `${usage.label} ${window.label} used, ${window.usedPercent} %, ${Math.round(projection.elapsedFraction * 100)} % of the window elapsed, pace ${projection.pace.toFixed(1)}x`
          + (alert === undefined ? "" : `, projected to run out before reset (${alert.severity})`);
      return <div className="provider-usage-window" key={window.kind}>
        <div className="provider-usage-label"><span>{window.label}</span><span>{window.usedPercent}%{chip !== undefined && <> <span className={`provider-usage-pace ${chip.tier}`}>{chip.text}</span></>}</span></div>
        <span className="provider-usage-bar">
          <progress aria-label={name} max={100} value={window.usedPercent} />
          {projection !== undefined && <span className="provider-usage-tick" aria-hidden="true" style={{ left: `${projection.elapsedFraction * 100}%` }} />}
        </span>
        {window.resetsAt && <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>
          {countdown(window.resetsAt, now)}
          {alert?.exhaustsAt !== undefined && alert.leadMs !== undefined
            ? <span className={`provider-usage-projection is-${alert.severity}`}
              title={`Projected to run out ${new Date(alert.exhaustsAt).toLocaleString()} at current pace ${alert.pace.toFixed(2)}x`}> · {earlyLine(alert.leadMs)}</span>
            : unused !== undefined
              ? <span className="provider-usage-projection is-unused"
                title={`At this pace about ${unused} % of the window is left unused at reset`}> · {unused}% unused</span> : null}
        </time>}
      </div>;
    })}
    {usage.error && <p className="provider-usage-error" role="status">Usage unavailable — {usage.error.message}</p>}
  </div>;
}
