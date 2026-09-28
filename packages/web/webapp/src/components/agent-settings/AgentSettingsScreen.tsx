import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentSummary } from "../../types";
import { useConsoleStore } from "../../console-store";
import { clearSettingsDraftIfEqual } from "../../settings-drafts";
import type { SettingsSection } from "../../mobile-history";
import { Icon } from "../Icon";
import { runningCountFor } from "../running-count";
import { AgentAbout, AgentPinRow, AgentSection } from "./AgentSection";
import { NewConversationsSection } from "./NewConversationsSection";
import { ProvidersSection } from "./ProvidersSection";
import { checkTerminal } from "./provider-auth-presentation";
import { useRestartOwner } from "./RestartOwner";
import { useProviderAuth } from "./use-provider-auth";

type ProviderState = ReturnType<typeof useProviderAuth>;
type RestartState = ReturnType<typeof useRestartOwner>;
// The two async owners must remount on their own lifetime boundaries, but the
// screen (focus, announcer, picker) must NOT be their render-prop child.
const ProvidersOwnerBridge = memo(function ProvidersOwnerBridge({ agent, onChange }: {
  readonly agent: AgentSummary; readonly onChange: (key: string, state: ProviderState) => void;
}) {
  const state = useProviderAuth(agent);
  useEffect(() => onChange(`${agent.sourceId}:${agent.generation ?? "unknown"}`, state), [agent.sourceId, agent.generation, state, onChange]);
  return null;
});
const RestartOwnerBridge = memo(function RestartOwnerBridge({ agent, onChange }: {
  readonly agent: AgentSummary; readonly onChange: (key: string, state: RestartState) => void;
}) {
  const state = useRestartOwner(agent);
  useEffect(() => onChange(agent.sourceId, state), [agent.sourceId, state, onChange]);
  return null;
});

export function AgentSettingsScreen({ section, layout, onClose, onNotice }: {
  readonly section: SettingsSection | null;
  readonly layout: "split" | "stacked";
  readonly onClose: () => void;
  readonly onNotice: (message: string) => void;
}) {
  const store = useConsoleStore();
  const agent = store.selectedAgent;
  const [providerOwner, setProviderOwner] = useState<{ key: string; state: ProviderState } | null>(null);
  const [restartOwner, setRestartOwner] = useState<{ key: string; state: RestartState } | null>(null);
  const onProviderChange = useCallback((key: string, state: ProviderState) => setProviderOwner({ key, state }), []);
  const onRestartChange = useCallback((key: string, state: RestartState) => setRestartOwner({ key, state }), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[data-slot="model-selector-content"], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  if (agent === null) return <div className="settings-screen" data-modal-surface="settings"><p>This agent is no longer available.</p><button type="button" onClick={onClose}>Close</button></div>;
  const providerKey = `${agent.sourceId}:${agent.generation ?? "unknown"}`;
  return <>
    <RestartOwnerBridge key={agent.sourceId} agent={agent} onChange={onRestartChange} />
    <ProvidersOwnerBridge key={providerKey} agent={agent} onChange={onProviderChange} />
    <SettingsContent agent={agent} section={section} layout={layout} provider={providerOwner?.key === providerKey ? providerOwner.state : null} restart={restartOwner?.key === agent.sourceId ? restartOwner.state : null} onClose={onClose} onNotice={onNotice} runningCount={agent.status === "offline" ? undefined : runningCountFor(agent, store.activeThreads)} />
  </>;
}

function SettingsContent({ agent, section, layout, provider, restart, onClose, onNotice, runningCount }: {
  readonly agent: AgentSummary; readonly section: SettingsSection | null; readonly layout: "split" | "stacked";
  readonly provider: ProviderState | null; readonly restart: RestartState | null;
  readonly onClose: () => void; readonly onNotice: (message: string) => void; readonly runningCount: number | undefined;
}) {
  const saved = agent.runSettings.override;
  useEffect(() => { clearSettingsDraftIfEqual(agent.sourceId, { model: saved?.model ?? "", effort: saved?.effort ?? "" }); }, [agent.sourceId, saved?.model, saved?.effort]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<string | null>(null);
  const targetRef = useRef<SettingsSection | null | undefined>(undefined);
  const userMovedRef = useRef(false);
  const providerReadyRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const eventState = { usageRefreshing: provider?.usageRefreshing, usageFeedback: provider?.usageFeedback,
    check: provider?.check, session: provider?.session, restartStage: restart?.progressStage,
    restartOutcome: restart?.outcome, restartUnknown: restart?.requestUnknown };
  const previousEvents = useRef<typeof eventState | null>(null);
  useEffect(() => { previousEvents.current = null; setAnnouncement(""); }, [agent.sourceId]);
  useEffect(() => {
    const previous = previousEvents.current;
    previousEvents.current = eventState;
    if (previous === null) return;
    if (eventState.restartOutcome && previous.restartOutcome !== eventState.restartOutcome) setAnnouncement(`Restart ${eventState.restartOutcome}.`);
    else if (eventState.restartUnknown && previous.restartUnknown !== eventState.restartUnknown) setAnnouncement(eventState.restartUnknown);
    else if (eventState.restartStage && previous.restartStage !== eventState.restartStage) setAnnouncement(`Restart: ${eventState.restartStage.replace("_", " ")}.`);
    else if (eventState.check && (eventState.check.id !== previous.check?.id || eventState.check.state !== previous.check?.state)) setAnnouncement(checkTerminal(eventState.check.state) ? "Provider access checks finished." : "Provider access checks started.");
    else if (eventState.session && (eventState.session.id !== previous.session?.id || eventState.session.state !== previous.session?.state)) setAnnouncement(`Sign-in ${eventState.session.state.replaceAll("_", " ")}.`);
    else if (eventState.usageFeedback && eventState.usageFeedback !== previous.usageFeedback) setAnnouncement(/fail|unavailable|error/i.test(eventState.usageFeedback) ? "Subscription limits could not be refreshed." : "Subscription limits refreshed.");
    else if (eventState.usageRefreshing && !previous.usageRefreshing) setAnnouncement("Usage refresh started.");
  }, [provider?.usageRefreshing, provider?.usageFeedback, provider?.check, provider?.session, restart?.progressStage, restart?.outcome, restart?.requestUnknown]);
  // Only an opening or an explicit section intent moves focus. Async owner updates
  // and process-generation refreshes must not steal focus from the Dashboard.
  useLayoutEffect(() => {
    if (sourceRef.current !== agent.sourceId) {
      if (sourceRef.current !== null) (scrollRef.current!.scrollTop = 0);
      providerReadyRef.current = false;
      sourceRef.current = agent.sourceId;
      if (targetRef.current !== undefined) { targetRef.current = section; return; }
    }
    if (targetRef.current === section) return;
    targetRef.current = section;
    userMovedRef.current = false;
    const target = section === null ? titleRef.current : scrollRef.current?.querySelector<HTMLElement>(`[data-settings-target="${section}"]`);
    target?.focus({ preventScroll: true });
    if (section !== null && target && scrollRef.current) scrollRef.current.scrollTop = target.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top + scrollRef.current.scrollTop - 12;
    else if (section === null) (scrollRef.current!.scrollTop = 0);
  }, [agent.sourceId, section]);
  // A late provider response can expand the content above Restart. Reposition
  // once, only while the initial target is still active and untouched by the user.
  useLayoutEffect(() => {
    const ready = provider !== null;
    if (ready && !providerReadyRef.current && section === "agent" && !userMovedRef.current) {
      const scroller = scrollRef.current;
      const target = scroller?.querySelector<HTMLElement>('[data-settings-target="agent"]');
      if (scroller && target) scroller.scrollTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    }
    providerReadyRef.current = ready;
  }, [provider !== null, section]);
  return <div className="settings-screen" data-modal-surface="settings" data-section={section ?? "index"}>
    <div className="sr-only" role="status" aria-atomic="true">{announcement}</div>
    <header className="settings-header">
      {layout === "stacked" && <button type="button" className="project-back settings-back" aria-label="Back from agent settings" onClick={onClose}><Icon name="chevron-left" size={18} /></button>}
      <div className="settings-identity"><span className="settings-agent-tile" aria-hidden="true">{agent.label.slice(0, 2).toUpperCase()}</span><div className="settings-title-block"><span className="eyebrow">Agent settings</span><h1 className="settings-agent-name" ref={titleRef} tabIndex={-1}>{agent.label}</h1></div></div>
      <span className={`chat-status is-${agent.status === "online" ? "ready" : agent.status}`}><i aria-hidden="true" />{agent.status}</span>
      {layout === "split" && <span className="settings-header-actions"><button type="button" className="icon-button" aria-label="Close agent settings" onClick={onClose}><Icon name="close" size={16} /></button></span>}
    </header>
    <main className="settings-content" ref={scrollRef} onWheel={() => { userMovedRef.current = true; }} onTouchMove={() => { userMovedRef.current = true; }} onKeyDown={() => { userMovedRef.current = true; }}>
      <div className="settings-pane">
        {agent.status === "offline" && <div className="settings-notice">{agent.label} is offline. Changes that need the agent are paused. Using the agent config still works.</div>}
        <AgentPinRow key={agent.sourceId} agent={agent} />
        <section className="settings-page-section" data-settings-target="new-conversations" tabIndex={-1} aria-labelledby="settings-new-title"><div className="settings-section-head"><h2 id="settings-new-title" className="settings-section-title">New conversations</h2><p className="settings-section-summary">The model and effort new conversations start with. Existing conversations keep theirs.</p></div>
          <NewConversationsSection agent={agent} onNotice={(message) => { setAnnouncement(message); onNotice(message); }} onSaveError={setAnnouncement} />
        </section>
        <section className="settings-page-section" data-settings-target="providers" tabIndex={-1} aria-labelledby="settings-providers-title"><div className="settings-section-head"><h2 id="settings-providers-title" className="settings-section-title">Providers</h2><p className="settings-section-summary">Sign-in and subscription usage for this agent.</p></div>
          {provider === null ? <div className="settings-row">Loading provider status…</div> : <ProvidersSection agent={agent} controller={provider} compact={layout === "stacked"} />}
        </section>
        <section className="settings-page-section" data-settings-target="agent" tabIndex={-1} aria-labelledby="settings-restart-title"><div className="settings-section-head"><h2 id="settings-restart-title" className="settings-section-title">Restart</h2><p className="settings-section-summary">Restart this agent and review its latest operation.</p></div>
          {restart === null ? <div className="settings-row">Checking restart status…</div> : <AgentSection agent={agent} restart={restart} runningCount={runningCount} />}
        </section>
        <section className="settings-page-section" aria-labelledby="settings-about-title"><div className="settings-section-head"><h2 id="settings-about-title" className="settings-section-title">About</h2></div><AgentAbout agent={agent} /></section>
      </div>
    </main>
  </div>;
}
