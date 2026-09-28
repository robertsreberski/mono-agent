import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentSummary } from "../../types";
import { useConsoleStore } from "../../console-store";
import { clearSettingsDraftIfEqual, useSettingsDraft } from "../../settings-drafts";
import type { SettingsSection } from "../../mobile-history";
import { Icon, type IconName } from "../Icon";
import { runningCountFor } from "../running-count";
import { relativeTime } from "../time";
import { AgentSection } from "./AgentSection";
import { NewConversationsSection } from "./NewConversationsSection";
import { ProvidersSection } from "./ProvidersSection";
import { checkTerminal, providersSummary } from "./provider-auth-presentation";
import { useRestartOwner } from "./RestartOwner";
import { settingsEffortName, settingsModelName } from "./settings-labels";
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

const sections: readonly { id: SettingsSection; label: string; icon: IconName; description: string }[] = [
  { id: "new-conversations", label: "New conversations", icon: "new", description: "The model and effort new conversations start with. Existing conversations keep theirs." },
  { id: "providers", label: "Providers", icon: "key", description: "Sign-in and subscription usage for this agent." },
  { id: "agent", label: "Agent", icon: "agent", description: "Pinning, restart and agent capabilities." },
];

export function AgentSettingsScreen({ section, layout, onSection, onBack, onClose, onNotice }: {
  readonly section: SettingsSection | null;
  readonly layout: "split" | "stacked";
  readonly onSection: (section: SettingsSection) => void;
  readonly onBack: () => void;
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
      event.preventDefault(); event.stopPropagation();
      if (layout === "stacked") onBack(); else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout, onBack, onClose]);
  if (agent === null) return <div className="settings-screen" data-modal-surface="settings"><p>This agent is no longer available.</p><button type="button" onClick={onClose}>Close</button></div>;
  const providerKey = `${agent.sourceId}:${agent.generation ?? "unknown"}`;
  return <>
    <RestartOwnerBridge key={agent.sourceId} agent={agent} onChange={onRestartChange} />
    <ProvidersOwnerBridge key={providerKey} agent={agent} onChange={onProviderChange} />
    <SettingsContent agent={agent} section={section} layout={layout} provider={providerOwner?.key === providerKey ? providerOwner.state : null} restart={restartOwner?.key === agent.sourceId ? restartOwner.state : null} onSection={onSection} onBack={onBack} onClose={onClose} onNotice={onNotice} runningCount={agent.status === "offline" ? undefined : runningCountFor(agent, store.activeThreads)} />
  </>;
}

function SettingsContent({ agent, section, layout, provider, restart, onSection, onBack, onClose, onNotice, runningCount }: {
  readonly agent: AgentSummary; readonly section: SettingsSection | null; readonly layout: "split" | "stacked";
  readonly provider: ProviderState | null; readonly restart: RestartState | null;
  readonly onSection: (section: SettingsSection) => void; readonly onBack: () => void; readonly onClose: () => void;
  readonly onNotice: (message: string) => void; readonly runningCount: number | undefined;
}) {
  const store = useConsoleStore();
  const catalogModels = Object.fromEntries(Object.entries(store.catalogByProvider).map(([provider, state]) => [provider, state.models]));
  const effectiveModel = settingsModelName(agent, agent.runSettings.effective.model || agent.runSettings.config.model || agent.defaultModel, catalogModels);
  const effectiveEffort = settingsEffortName(agent.runSettings.effective.effort || agent.runSettings.config.effort || agent.defaultEffort);
  const draft = useSettingsDraft(agent.sourceId);
  const saved = agent.runSettings.override;
  useEffect(() => { clearSettingsDraftIfEqual(agent.sourceId, { model: saved?.model ?? "", effort: saved?.effort ?? "" }); }, [agent.sourceId, saved?.model, saved?.effort]);
  const dirty = draft !== null && (draft.model !== (saved?.model ?? "") || draft.effort !== (saved?.effort ?? ""));
  const restartProgress = restart?.operationId !== undefined && restart?.outcome === undefined;
  const lastOperation = restartProgress ? restart?.initialOperation : restart?.currentOperation ?? restart?.initialOperation;
  const lastRestartTime = lastOperation?.outcome ? relativeTime(lastOperation.requestedAt) : null;
  const lastRestartAgo = lastRestartTime === "now" ? "just now" : `${lastRestartTime} ago`;
  const restartRefused = restart?.outcome === "failure" && restart.currentOperation === null;
  const restartWarning = lastOperation?.outcome === "failure" || restartRefused || restart?.readState === "error" || Boolean(restart?.pollWarning);
  const restartSummary = restartProgress ? "Restarting…"
    : restartRefused ? "Restart failed"
    : lastOperation?.outcome === "failure" ? `Last restart failed · ${lastRestartAgo}`
    : restart?.readState === "error" ? "Restart status unavailable"
    : `${agent.pinned ? "Pinned" : "Not pinned"} · ${agent.status === "offline" ? "restart needs a live connection" : lastOperation?.outcome === "success" ? `restarted ${lastRestartAgo}` : agent.restart?.supported === true ? "restart available" : "restart not available"}`;
  const providerWarning = agent.status !== "offline" && provider?.authError != null && provider.status === null;
  const providerSummary = agent.status === "offline" ? "Needs a live connection" : agent.supportsProviderAuth !== true && agent.supportsProviderUsage !== true ? "Not available" : provider === null ? "Loading provider status…" : agent.supportsProviderAuth !== true ? provider.usage?.providers.length ? "Usage available" : "No subscription usage available" : providerWarning ? "Provider status unavailable" : provider.checkActive ? "Checking access…" : providersSummary(provider.status);
  const summaries: Record<SettingsSection, string> = { "new-conversations": dirty ? "Unsaved change" : saved ? "Custom override" : "Agent config", providers: providerSummary, agent: restartSummary };
  const active = sections.find((item) => item.id === section) ?? sections[0]!;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [footerNode, setFooterNode] = useState<HTMLDivElement | null>(null);
  const previousSection = useRef<SettingsSection | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const eventState = { usageRefreshing: provider?.usageRefreshing, usageFeedback: provider?.usageFeedback,
    check: provider?.check, session: provider?.session, restartStage: restart?.progressStage,
    restartOutcome: restart?.outcome, restartUnknown: restart?.requestUnknown };
  const previousEvents = useRef<typeof eventState | null>(null);
  useEffect(() => { previousEvents.current = null; setAnnouncement(""); }, [agent.sourceId]);
  useEffect(() => {
    const previous = previousEvents.current;
    previousEvents.current = eventState;
    if (previous === null) return; // Initial server state is not a user-triggered event.
    if (eventState.restartOutcome && previous.restartOutcome !== eventState.restartOutcome) setAnnouncement(`Restart ${eventState.restartOutcome}.`);
    else if (eventState.restartUnknown && previous.restartUnknown !== eventState.restartUnknown) setAnnouncement(eventState.restartUnknown);
    else if (eventState.restartStage && previous.restartStage !== eventState.restartStage) setAnnouncement(`Restart: ${eventState.restartStage.replace("_", " ")}.`);
    else if (eventState.check && (eventState.check.id !== previous.check?.id || eventState.check.state !== previous.check?.state)) setAnnouncement(checkTerminal(eventState.check.state) ? "Provider access checks finished." : "Provider access checks started.");
    else if (eventState.session && (eventState.session.id !== previous.session?.id || eventState.session.state !== previous.session?.state)) setAnnouncement(`Sign-in ${eventState.session.state.replaceAll("_", " ")}.`);
    else if (eventState.usageFeedback && eventState.usageFeedback !== previous.usageFeedback) setAnnouncement(/fail|unavailable|error/i.test(eventState.usageFeedback) ? "Subscription limits could not be refreshed." : "Subscription limits refreshed.");
    else if (eventState.usageRefreshing && !previous.usageRefreshing) setAnnouncement("Usage refresh started.");
  }, [provider?.usageRefreshing, provider?.usageFeedback, provider?.check, provider?.session, restart?.progressStage, restart?.outcome, restart?.requestUnknown]);
  useEffect(() => {
    if (previousSection.current === undefined) titleRef.current?.focus();
    else if (previousSection.current !== section) {
      if (layout === "stacked" && section === null && previousSection.current !== null) document.querySelector<HTMLElement>(`[data-settings-section="${previousSection.current}"]`)?.focus();
      else if (layout === "stacked") titleRef.current?.focus();
    }
    previousSection.current = section;
  }, [section, layout]);
  const facts = <div className={layout === "stacked" ? "settings-facts-card" : "settings-facts"}>
    {layout === "stacked" && <div className="settings-fact"><span className="settings-fact-label">Status</span><span className="settings-fact-value"><span className={`chat-status is-${agent.status === "online" ? "ready" : agent.status}`}><i aria-hidden="true" />{agent.status}</span></span></div>}
    <div className="settings-fact is-model"><span className="settings-fact-label">New conversations</span><span className="settings-fact-value">{effectiveModel} · {effectiveEffort}</span></div>
    <div className="settings-fact"><span className="settings-fact-label">Running</span><span className="settings-fact-value">{runningCount === undefined ? "—" : runningCount}</span></div>
  </div>;
  const nav = <nav className={layout === "stacked" ? "settings-nav-group" : "settings-rail"} aria-label="Agent settings sections">{sections.map((item) =>
    <button type="button" key={item.id} data-settings-section={item.id} className={layout === "stacked" ? "settings-nav-row" : "settings-rail-item"} aria-current={layout === "split" && active.id === item.id ? "page" : undefined} onClick={() => onSection(item.id)}>
      <span className={`${layout === "stacked" ? "settings-nav-icon" : "settings-rail-icon"}${(item.id === "agent" && restartWarning && !restartProgress || item.id === "providers" && providerWarning) ? " is-warning" : ""}`}><Icon name={item.icon} size={17} /></span>
      <span className={layout === "stacked" ? "settings-nav-copy" : "settings-rail-copy"}><span className={layout === "stacked" ? "settings-nav-label" : "settings-rail-label"}>{item.label}</span><span className={`${layout === "stacked" ? "settings-nav-summary" : "settings-rail-summary"}${(item.id === "agent" && restartWarning && !restartProgress || item.id === "providers" && providerWarning) ? " is-warning" : ""}`}>{summaries[item.id]}</span></span>
      {(item.id === "new-conversations" && dirty || item.id === "agent" && restartProgress) && <span className="settings-dot" aria-hidden="true" />}
      {layout === "stacked" && <Icon name="chevron" size={14} />}
    </button>,
  )}</nav>;
  return <div className="settings-screen" data-modal-surface="settings" data-section={section ?? "index"}>
    <div className="sr-only" role="status" aria-atomic="true">{announcement}</div>
    {layout === "stacked" && section !== null ? <header className="settings-header"><button type="button" className="project-back" onClick={onBack}><Icon name="chevron-left" size={16} /> {agent.label} settings</button></header>
      : layout === "stacked" ? <header className="settings-header settings-phone-index-header">
        <button type="button" className="project-back" aria-label="Close settings" onClick={onClose}><Icon name="chevron-left" size={18} /></button>
        <div className="settings-phone-index-title"><span className="eyebrow"><Icon name="settings" size={12} /> Agent settings</span><h1 className="settings-agent-name" ref={titleRef} tabIndex={-1}>{agent.label}</h1></div>
      </header>
      : <header className="settings-header">
        <div className="settings-identity"><span className="settings-agent-tile" aria-hidden="true">{agent.label.slice(0, 2).toUpperCase()}</span><div className="settings-title-block"><span className="eyebrow">Agent settings</span><div className="settings-title-row"><h1 className="settings-agent-name" ref={titleRef} tabIndex={-1}>{agent.label}</h1><span className={`chat-status is-${agent.status === "online" ? "ready" : agent.status}`}><i aria-hidden="true" />{agent.status}</span></div></div></div>
        {facts}<span className="settings-header-actions"><button type="button" className="icon-button" aria-label="Close agent settings" onClick={onClose}><Icon name="close" size={16} /></button></span>
      </header>}
    {layout === "stacked" && section === null ? <main className="settings-scroll">{facts}{nav}</main> : <div className={layout === "split" ? "settings-layout" : "settings-scroll"}>
      {layout === "split" && nav}
      <main className={layout === "split" ? "settings-content" : "settings-content settings-phone-content"}><div className="settings-pane">
        <div className="settings-section-head"><div><h2 className="settings-section-title" tabIndex={-1} ref={layout === "stacked" ? titleRef : undefined}>{active.label}</h2><p className="settings-section-summary">{active.description}</p></div></div>
        {agent.status === "offline" && <div className="settings-notice">{agent.label} is offline. Changes that need the agent are paused. Using the agent config still works.</div>}
        {active.id === "new-conversations" && <NewConversationsSection agent={agent} onNotice={(message) => { setAnnouncement(message); onNotice(message); }} onSaveError={setAnnouncement} {...(layout === "stacked" ? { footerNode } : {})} />}
        {active.id === "providers" && (provider === null ? <div className="settings-row">Loading provider status…</div> : <ProvidersSection agent={agent} controller={provider} compact={layout === "stacked"} />)}
        {active.id === "agent" && (restart === null ? <div className="settings-row">Checking restart status…</div> : <AgentSection agent={agent} restart={restart} runningCount={runningCount} />)}
      </div></main>
    </div>}
    {layout === "stacked" && section === "new-conversations" && dirty && <div className="settings-footer" ref={setFooterNode} />}
  </div>;
}
