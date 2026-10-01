import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary } from "../../types";
import { useConsoleStore } from "../../console-store";
import { clearSettingsDraftIfEqual, discardSettingsDraft, setSettingsDraft, useSettingsDraft } from "../../settings-drafts";
import { ModelSelector } from "../assistant-ui/ModelSelector";
import { buildSelectorModels, effectiveModelForAgent, effortLevelsForAgentModel, findCatalogModel, providerOfModel } from "../model-catalog";
import { settingsEffortName, settingsModelName } from "./settings-labels";

export function NewConversationsSection({ agent, onNotice, onSaveError }: { readonly agent: AgentSummary; readonly onNotice: (message: string) => void; readonly onSaveError?: (message: string) => void }) {
  const store = useConsoleStore();
  const draft = useSettingsDraft(agent.sourceId);
  const saved = { model: agent.runSettings.override?.model ?? "", effort: agent.runSettings.override?.effort ?? "", context1M: agent.runSettings.override?.context1M ?? null };
  const model = draft?.model ?? saved.model;
  const effort = draft?.effort ?? saved.effort;
  const context1M = draft === null ? saved.context1M : draft.context1M ?? null;
  const dirty = draft !== null && (draft.model !== saved.model || draft.effort !== saved.effort || context1M !== saved.context1M);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerFieldRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const sourceRef = useRef(agent.sourceId);
  sourceRef.current = agent.sourceId;
  const pendingCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pendingCleanupRef.current?.(), []);
  const catalogModels = useMemo(() => Object.fromEntries(Object.entries(store.catalogByProvider).map(([provider, state]) => [provider, state.models])), [store.catalogByProvider]);
  const models = useMemo(() => buildSelectorModels({ agent, modelOptions: agent.models ?? [], defaultEffort: agent.runSettings.config.effort ?? agent.defaultEffort ?? "", catalogByProvider: catalogModels, selectedModel: model }), [agent, catalogModels, model]);
  const providerStatus = useMemo(() => Object.fromEntries(Object.entries(store.catalogByProvider).map(([provider, state]) => [provider, state.status])), [store.catalogByProvider]);
  const startModel = settingsModelName(agent, model || agent.runSettings.config.model || agent.defaultModel, catalogModels);
  const startEffort = settingsEffortName(effort || agent.runSettings.config.effort || agent.defaultEffort);
  useEffect(() => {
    const providers = new Set((agent.models ?? []).map(providerOfModel));
    for (const provider of agent.providers ?? []) providers.add(provider.id);
    for (const provider of providers) void store.ensureProviderCatalog(provider);
  }, [agent.sourceId]);
  useEffect(() => { clearSettingsDraftIfEqual(agent.sourceId, saved); }, [agent.sourceId, saved.model, saved.effort, saved.context1M]);
  const update = (nextModel: string, nextEffort: string, nextContext1M: boolean | null | undefined = context1M) => { setError(null); setSettingsDraft(agent.sourceId, { model: nextModel, effort: nextEffort, context1M: nextContext1M ?? null }); };
  const chooseModel = (next: string) => {
    const effective = effectiveModelForAgent(agent, next) ?? "";
    const allowed = effortLevelsForAgentModel(agent, effective, findCatalogModel(catalogModels, effective));
    const selected = models.find((row) => row.id === next);
    update(next, effort && !allowed.includes(effort) ? "" : effort, selected?.supportsContext1M ? context1M : null);
  };
  const save = async () => {
    if (!dirty || saving || agent.status === "offline" && (model !== "" || effort !== "")) return;
    const sourceId = agent.sourceId;
    const button = saveButtonRef.current;
    const section = button?.closest('[data-settings-target="new-conversations"]');
    let moved = false;
    let restoreQueued = false;
    const onFocus = (event: FocusEvent) => { if (!section?.contains(event.target as Node)) moved = true; };
    const onInput = (event: Event) => { if (!section?.contains(event.target as Node)) moved = true; };
    const cleanup = () => {
      if (pendingCleanupRef.current === cleanup) pendingCleanupRef.current = null;
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("wheel", onInput, true);
      document.removeEventListener("touchstart", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    };
    pendingCleanupRef.current?.();
    pendingCleanupRef.current = cleanup;
    document.addEventListener("focusin", onFocus);
    for (const type of ["pointerdown", "wheel", "touchstart", "keydown"]) document.addEventListener(type, onInput, true);
    setSaving(true); setError(null);
    try {
      if (model === "" && effort === "" && context1M == null) await store.clearAgentRunDefaults();
      else if (context1M == null) await store.setAgentRunDefaults(model || null, effort || null);
      else await store.setAgentRunDefaults(model || null, effort || null, context1M);
      // Do not remove a newer draft made while this request was in flight.
      clearSettingsDraftIfEqual(sourceId, { model, effort, context1M: context1M ?? null });
      if (sourceRef.current === sourceId && store.selectedAgent?.sourceId === sourceId) onNotice(`New conversations will start with ${startModel} · ${startEffort}.`);
      restoreQueued = true;
      window.setTimeout(() => {
        if (!moved && sourceRef.current === sourceId && store.selectedAgent?.sourceId === sourceId
          && pickerFieldRef.current?.isConnected && (document.activeElement === button || !button?.isConnected && document.activeElement === document.body)) {
          pickerFieldRef.current.querySelector<HTMLElement>(".model-selector__trigger")?.focus();
        }
        cleanup();
      }, 0);
    } catch (caught) { const detail = caught instanceof Error ? caught.message : String(caught); setError(detail); onSaveError?.(`Saving failed. ${detail}`); }
    finally { setSaving(false); if (!restoreQueued) cleanup(); }
  };
  const saveBar = <div className={`settings-savebar${error ? " is-error" : ""}`}><div className="settings-savebar-text">{error ? `Couldn't save: ${error}` : <><span className="settings-dot" /> Unsaved <b>{startModel} · {startEffort}</b></>}</div>
      <button type="button" className="settings-button is-ghost" disabled={saving} onClick={(event) => { const button = event.currentTarget; const sourceId = agent.sourceId; discardSettingsDraft(sourceId); setError(null); window.setTimeout(() => { if (sourceRef.current === sourceId && store.selectedAgent?.sourceId === sourceId && pickerFieldRef.current?.isConnected && (document.activeElement === button || document.activeElement === document.body)) pickerFieldRef.current.querySelector<HTMLElement>(".model-selector__trigger")?.focus(); }, 0); }}>Discard</button>
      <button type="button" ref={saveButtonRef} className="settings-button is-primary" aria-label="Save for new conversations" disabled={saving || agent.status === "offline" && (model !== "" || effort !== "")} onClick={(event) => { event.currentTarget.focus(); void save(); }}>{saving ? "Saving…" : error ? "Retry" : "Save"}</button>
    </div>;
  return <>
    <div className="settings-field" ref={pickerFieldRef}>
      <div className="dashboard-section-label">START WITH <span className={`settings-chip${dirty ? " is-warning" : ""}`}>{saving ? "Saving…" : dirty ? "Unsaved" : agent.runSettings.override ? "Custom override" : "Agent config"}</span></div>
      <ModelSelector models={models} agentProviders={agent.providers} value={model} effort={effort} onValueChange={chooseModel} onEffortChange={(next) => update(model, next)} context1M={context1M} onContext1MChange={(next) => update(model, effort, next)} disabled={saving || agent.status === "offline"} agentDefaultId={agent.defaultModel} providerStatus={providerStatus} onProviderRequest={(provider) => { void store.ensureProviderCatalog(provider); }} conciseValue />
      {agent.status === "offline" && <p className="settings-field-note is-warning">Reconnect {agent.label} to pick a model. Using the agent config works offline.</p>}
    </div>
    <div className="settings-group">
      <div className="settings-kv"><span className="settings-kv-label">Agent config</span><div className="settings-kv-value"><span>{settingsModelName(agent, agent.runSettings.config.model || agent.defaultModel, catalogModels)} · {settingsEffortName(agent.runSettings.config.effort || agent.defaultEffort)}</span><code>{agent.runSettings.config.model ?? "provider default"} · {agent.runSettings.config.effort ?? "provider default"}</code></div></div>
      <div className="settings-kv"><span className="settings-kv-label">Console override</span><div className="settings-kv-value">{agent.runSettings.override ? <><span>{settingsModelName(agent, agent.runSettings.effective.model || agent.runSettings.config.model || agent.defaultModel, catalogModels)} · {settingsEffortName(agent.runSettings.effective.effort || agent.runSettings.config.effort || agent.defaultEffort)}</span><code>{saved.model || (agent.runSettings.config.model ? `agent config: ${agent.runSettings.config.model}` : "provider default")} · {saved.effort || (agent.runSettings.config.effort ? `agent config: ${agent.runSettings.config.effort}` : "provider default")}</code></> : "None"}{dirty && <small className="is-warning">{model === "" && effort === "" && context1M == null ? "Removed on save" : agent.runSettings.override ? "Replaced on save" : "Set on save"}</small>}</div>
        {(model !== "" || effort !== "" || agent.runSettings.override !== null) && <button className="settings-button is-ghost is-inline" type="button" disabled={saving} onClick={() => update("", "", null)}>Use agent config</button>}
      </div>
    </div>
    <p className="settings-field-note">A fallback or model mismatch is shown on the run it affected.</p>
    {dirty && saveBar}
  </>;
}
