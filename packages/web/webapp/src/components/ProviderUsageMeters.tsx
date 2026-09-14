import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentSummary, ProviderUsage, ProviderUsageSnapshot } from "../types";

/** Isolated from auth status/login: slow or failed quota reads never hide auth controls. */
export function useProviderUsage(agent: AgentSummary, authRevision?: string) {
  const [snapshot, setSnapshot] = useState<ProviderUsageSnapshot | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (agent.supportsProviderUsage !== true || agent.status === "offline") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let delay = 300_000;
      try {
        const next = await api.providerUsage(agent.sourceId, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next);
        // A stale response started a coalesced refresh; read its result once soon.
        if (next.providers.some((provider) => provider.stale && !provider.error)) delay = 15_000;
      } catch {
        // No provider credential evidence on a transport failure. Retain only
        // already-known providers, using a fixed message instead of raw errors.
        if (!controller.signal.aborted) setSnapshot((previous) => previous === null ? null : ({ ...previous, providers: previous.providers.map((provider) => ({
          ...provider, stale: true, error: { code: "unavailable", message: "Provider usage is unavailable." },
        })) }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, delay);
      }
    };
    void load();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [agent.sourceId, agent.generation, agent.status, agent.supportsProviderUsage, authRevision]);
  return snapshot;
}
function countdown(reset: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(reset) - now) / 60_000));
  if (minutes === 0) return "Reset due";
  if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${minutes}m`;
}
export function ProviderUsageMeters({ usage }: { readonly usage?: ProviderUsage }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!usage) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [usage]);
  if (!usage) return null;
  return <div className="provider-usage" aria-label={`${usage.label} subscription usage`}>
    {(usage.plan || usage.stale) && <div className="provider-usage-meta">
      {usage.plan && <span className="provider-usage-plan">{usage.plan}</span>}
      {usage.stale && <span title={`Fetched ${new Date(usage.fetchedAt).toLocaleString()}`}>Last known usage</span>}
    </div>}
    {usage.windows.map((window) => <div className="provider-usage-window" key={window.kind}>
      <div className="provider-usage-label"><span>{window.label}</span><span>{window.usedPercent}%</span></div>
      <progress aria-label={`${usage.label} ${window.label} used`} max={100} value={window.usedPercent} />
      {window.resetsAt && <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{countdown(window.resetsAt, now)}</time>}
    </div>)}
    {usage.error && <p className="provider-usage-error" role="status">Usage unavailable — {usage.error.message}</p>}
  </div>;
}
