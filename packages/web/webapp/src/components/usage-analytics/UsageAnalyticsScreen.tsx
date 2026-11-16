import { useEffect, useRef, useState } from "react";
import type { ProviderUsageHistory, UsageHistoryRange } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics } from "../../../../src/contracts";
import { consoleHandoffTarget } from "../../settings-navigation";
import { api } from "../../api";
import { useConsoleStore } from "../../console-store";
import { UsageAnalyticsView, type AnalyticsRange } from "./UsageAnalyticsView";

interface State { owner: string; data: WebUsageAnalytics | null; history: ProviderUsageHistory | null; dataError: string | null; historyError: string | null; loading: boolean }
const days = { "6h": 0.25, "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
export function UsageAnalyticsScreen({ onClose, onOpenConversation, onOpenProject }: { readonly onClose: () => void; readonly onOpenConversation: (id: string) => void; readonly onOpenProject: (id: string) => void }) {
  const store = useConsoleStore(), agent = store.selectedAgent;
  const [range, setRange] = useState<AnalyticsRange>("24h"), [revision, setRevision] = useState(0);
  const owner = `${agent?.sourceId}:${agent?.generation}:${range}`;
  const current = useRef(owner); current.current = owner;
  const action = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ owner, data: null, history: null, dataError: null, historyError: null, loading: true });
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [agent?.sourceId, onClose]);
  useEffect(() => { setFeedback(null); }, [owner]);
  useEffect(() => {
    const controller = new AbortController(); action.current?.abort(); setBusy(false);
    if (!agent) return () => controller.abort();
    const end = Date.now() + 1;
    const query: UsageHistoryRange = { from: new Date(end - days[range] * 86_400_000).toISOString(), to: new Date(end).toISOString(), bucket: (range === "24h" || range === "6h") ? "hour" : "day", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    setState({ owner, data: null, history: null, dataError: null, historyError: null, loading: true });
    const update = (patch: Partial<State>) => { if (!controller.signal.aborted && current.current === owner) setState(before => ({ ...before, ...patch })); };
    const local = api.usageAnalytics(agent.sourceId, query, controller.signal).then(data => update({ data })).catch(error => { if (!controller.signal.aborted) update({ dataError: error instanceof Error ? error.message : "Usage analytics could not be loaded." }); });
    const history = agent.status === "offline" ? Promise.resolve(update({ historyError: "Quota history needs a live agent connection. Retained conversation accounting is still available." }))
      : !agent.supportsProviderUsageHistory ? Promise.resolve(update({ historyError: "This agent version does not support quota history." }))
      : api.providerUsageHistory(agent.sourceId, query, controller.signal).then(history => update({ history })).catch(() => update({ historyError: "Quota history could not be loaded. Refresh analytics to try again." }));
    void Promise.all([local, history]).then(() => update({ loading: false }));
    return () => { controller.abort(); action.current?.abort(); };
  }, [owner, revision, agent?.status, agent?.supportsProviderUsageHistory]);
  const visible = state.owner === owner ? state : { data: null, history: null, dataError: null, historyError: null, loading: true };
  async function mutate(kind: "refresh" | "clear") {
    if (!agent || busy) return;
    const controller = new AbortController(); action.current = controller; setBusy(true); setFeedback(null);
    try {
      if (kind === "clear") await api.clearProviderUsageHistory(agent.sourceId, controller.signal);
      else {
        const snapshot = await api.refreshProviderUsage(agent.sourceId, controller.signal);
        if (current.current === owner) setFeedback(snapshot.providers.some(p => p.error || p.stale) ? "Some quota checks are unavailable; history retains actual successful checks." : "Quota usage check completed.");
      }
      if (!controller.signal.aborted && current.current === owner) setRevision(before => before + 1);
    } catch (error) {
      if (controller.signal.aborted || current.current !== owner) {
        throw new DOMException("Usage action interrupted; refresh history to check its state.", "AbortError");
      }
      if (!controller.signal.aborted && current.current === owner) setFeedback(kind === "clear" ? "Clear was not confirmed. Refresh history to check the result." : "Usage could not be refreshed. Existing backoff still applies.");
      if (kind === "clear") throw error;
    } finally { if (current.current === owner) setBusy(false); }
  }
  if (!agent) return <section className="usage-analytics" data-modal-surface="settings"><h1>Usage analytics</h1><p>{consoleHandoffTarget(window.location.href) ? "Waiting for the requested agent to be discovered. No other agent has been selected." : "Select an agent first."}</p><button type="button" onClick={onClose}>Close analytics</button></section>;
  return <div ref={root} className="usage-screen"><UsageAnalyticsView key={`${agent.sourceId}:${agent.generation}`} agentLabel={agent.label} range={range} {...visible} busy={busy} feedback={feedback}
    onRange={setRange} onRefresh={() => { if (current.current === owner) setRevision(before => before + 1); }} onClose={onClose}
    onOpenConversation={onOpenConversation} onOpenProject={onOpenProject}
    {...(agent.status !== "offline" && agent.supportsProviderUsageRefresh ? { onVendorRefresh: () => { void mutate("refresh").catch(() => undefined); } } : {})}
    {...(agent.status !== "offline" && agent.supportsProviderUsageHistoryClear ? { onClear: () => mutate("clear") } : {})} /></div>;
}
