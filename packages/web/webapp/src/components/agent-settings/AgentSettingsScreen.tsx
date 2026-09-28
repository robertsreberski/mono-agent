import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { providersSummary } from "./provider-auth-presentation";
import { RestartOwner } from "./RestartOwner";
import { settingsEffortName, settingsModelName } from "./settings-labels";
import { useProviderAuth } from "./use-provider-auth";

type ProviderState = ReturnType<typeof useProviderAuth>;
function ProvidersOwner({ agent, children }: { readonly agent: AgentSummary; readonly children: (state: ProviderState) => ReactNode }) {
  const state = useProviderAuth(agent);
  return <>{children(state)}</>;
}

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
  if (agent === null) return <div className="settings-screen" data-modal-surface="settings"><p>This agent is no longer available.</p><button type="button" onClick={onClose}>Close</button></div>;
  return <RestartOwner key={agent.sourceId} agent={agent}>{(restart) =>
    <ProvidersOwner key={`${agent.sourceId}:${agent.generation ?? "unknown"}`} agent={agent}>{(provider) =>
      <SettingsContent agent={agent} section={section} layout={layout} provider={provider} restart={restart} onSection={onSection} onBack={onBack} onClose={onClose} onNotice={onNotice} runningCount={runningCountFor(agent, store.activeThreads)} />
    }</ProvidersOwner>
  }</RestartOwner>;
}

function SettingsContent({ agent, section, layout, provider, restart, onSection, onBack, onClose, onNotice, runningCount }: {
  readonly agent: AgentSummary; readonly section: SettingsSection | null; readonly layout: "split" | "stacked";
  readonly provider: ProviderState; readonly restart: Parameters<Parameters<typeof RestartOwner>[0]["children"]>[0];
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
  const restartProgress = restart.operationId !== undefined && restart.outcome === undefined;
  const restartSummary = restartProgress ? "Restarting…" : restart.readState === "error" ? "Restart status unavailable"
    : restart.initialOperation?.outcome === "failure" ? `Last restart failed · ${relativeTime(restart.initialOperation.requestedAt)} ago`
    : `${agent.pinned ? "Pinned" : "Not pinned"} · ${agent.status === "offline" ? "restart needs a live connection" : restart.initialOperation?.outcome === "success" ? `restarted ${relativeTime(restart.initialOperation.requestedAt)} ago` : agent.restart?.supported === true ? "restart available" : "restart not available"}`;
  const providerSummary = agent.status === "offline" ? "Needs a live connection" : agent.supportsProviderAuth !== true && agent.supportsProviderUsage !== true ? "Not available" : agent.supportsProviderAuth !== true ? provider.usage?.providers.length ? "Usage available" : "No subscription usage available" : provider.checkActive ? "Checking access…" : providersSummary(provider.status);
  const summaries: Record<SettingsSection, string> = { "new-conversations": dirty ? "Unsaved change" : saved ? "Custom override" : "Agent config", providers: providerSummary, agent: restartSummary };
  const active = sections.find((item) => item.id === section) ?? sections[0]!;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [footerNode, setFooterNode] = useState<HTMLDivElement | null>(null);
  const previousSection = useRef<SettingsSection | null | undefined>(undefined);
  useEffect(() => {
    if (previousSection.current === undefined) titleRef.current?.focus();
    else if (previousSection.current !== section) {
      if (layout === "stacked" && section === null && previousSection.current !== null) document.querySelector<HTMLElement>(`[data-settings-section="${previousSection.current}"]`)?.focus();
      else if (layout === "stacked") titleRef.current?.focus();
    }
    previousSection.current = section;
  }, [section, layout]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[data-slot="model-selector-content"], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      if (layout === "stacked") onBack(); else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout, onBack, onClose]);
  const facts = <div className={layout === "stacked" ? "settings-facts-card" : "settings-facts"}>
    {layout === "stacked" && <div className="settings-fact"><span className="settings-fact-label">Status</span><span className="settings-fact-value"><span className={`chat-status is-${agent.status === "online" ? "ready" : agent.status}`}><i aria-hidden="true" />{agent.status}</span></span></div>}
    <div className="settings-fact is-model"><span className="settings-fact-label">New conversations</span><span className="settings-fact-value">{effectiveModel} · {effectiveEffort}</span></div>
    <div className="settings-fact"><span className="settings-fact-label">Running</span><span className="settings-fact-value">{runningCount === undefined ? "—" : runningCount}</span></div>
  </div>;
  const nav = <nav className={layout === "stacked" ? "settings-nav-group" : "settings-rail"} aria-label="Agent settings sections">{sections.map((item) =>
    <button type="button" key={item.id} data-settings-section={item.id} className={layout === "stacked" ? "settings-nav-row" : "settings-rail-item"} aria-current={layout === "split" && active.id === item.id ? "page" : undefined} onClick={() => onSection(item.id)}>
      <span className={layout === "stacked" ? "settings-nav-icon" : "settings-rail-icon"}><Icon name={item.icon} size={17} /></span>
      <span className={layout === "stacked" ? "settings-nav-copy" : "settings-rail-copy"}><span className={layout === "stacked" ? "settings-nav-label" : "settings-rail-label"}>{item.label}</span><span className={layout === "stacked" ? "settings-nav-summary" : "settings-rail-summary"}>{summaries[item.id]}</span></span>
      {(item.id === "new-conversations" && dirty || item.id === "agent" && restartProgress) && <span className="settings-dot" aria-hidden="true" />}
      {layout === "stacked" && <Icon name="chevron" size={14} />}
    </button>,
  )}</nav>;
  return <div className="settings-screen" data-modal-surface="settings" data-section={section ?? "index"}>
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
        {active.id === "new-conversations" && <NewConversationsSection agent={agent} onNotice={onNotice} {...(layout === "stacked" ? { footerNode } : {})} />}
        {active.id === "providers" && <ProvidersSection agent={agent} controller={provider} compact={layout === "stacked"} />}
        {active.id === "agent" && <AgentSection agent={agent} restart={restart} runningCount={runningCount} />}
      </div></main>
    </div>}
    {layout === "stacked" && section === "new-conversations" && dirty && <div className="settings-footer" ref={setFooterNode} />}
  </div>;
}
