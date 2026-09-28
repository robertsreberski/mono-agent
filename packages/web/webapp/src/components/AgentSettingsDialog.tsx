import { type RefObject, useEffect, useMemo, useState } from "react";
import { useConsoleStore } from "../console-store";
import { buildSelectorModels, effectiveModelForAgent, effortLevelsForAgentModel, findCatalogModel, providerOfModel } from "./model-catalog";
import { ModelSelector } from "./assistant-ui/ModelSelector";
import { Icon } from "./Icon";
import { AgentRestartSection } from "./agent-settings/AgentRestartSection";
import { ProviderAuthSection } from "./agent-settings/ProviderAuthSection";

export function AgentSettingsDialog({
  open,
  onClose,
  dialogRef,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly dialogRef: RefObject<HTMLElement | null>;
}) {
  const store = useConsoleStore();
  const agent = store.selectedAgent;
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !agent) return;
    setModel(agent.runSettings.override?.model ?? "");
    setEffort(agent.runSettings.override?.effort ?? "");
    setError(null);
    const providers = new Set((agent.models ?? []).map(providerOfModel));
    for (const provider of agent.providers ?? []) providers.add(provider.id);
    for (const provider of providers) void store.ensureProviderCatalog(provider);
  }, [agent?.sourceId, open]);

  const catalogModels = useMemo(
    () => Object.fromEntries(Object.entries(store.catalogByProvider).map(([provider, state]) => [provider, state.models])),
    [store.catalogByProvider],
  );
  const models = useMemo(() => buildSelectorModels({
    agent,
    modelOptions: agent?.models ?? [],
    defaultEffort: agent?.runSettings.config.effort ?? agent?.defaultEffort ?? "",
    catalogByProvider: catalogModels,
    selectedModel: model,
  }), [agent, catalogModels, model]);
  const providerStatus = useMemo(
    () => Object.fromEntries(Object.entries(store.catalogByProvider).map(([provider, state]) => [provider, state.status])),
    [store.catalogByProvider],
  );
  if (!open || !agent) return null;
  const settings = agent.runSettings;
  const inactive = saving || agent.status === "offline";

  const chooseModel = (next: string) => {
    setModel(next);
    const effective = effectiveModelForAgent(agent, next) ?? "";
    const allowed = effortLevelsForAgentModel(agent, effective, findCatalogModel(catalogModels, effective));
    if (effort && !allowed.includes(effort)) setEffort("");
  };

  const save = async () => {
    if (model === "" && effort === "") return;
    setSaving(true);
    setError(null);
    try {
      await store.setAgentRunDefaults(model || null, effort || null);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    setSaving(true);
    setError(null);
    try {
      await store.clearAgentRunDefaults();
      setModel("");
      setEffort("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-layer agent-settings-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="sheet agent-settings-dialog agent-settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <h2 id="agent-settings-title">{agent.label} settings</h2>
          </div>
          <div className="agent-settings-header-actions">
            {/* Favourites sort first on the Dashboard's strip. The star is here,
                with the agent's other settings, and in the command palette. */}
            <button
              type="button"
              className={`icon-button agent-pin-toggle${agent.pinned ? " is-pinned" : ""}`}
              aria-pressed={Boolean(agent.pinned)}
              aria-label={agent.pinned ? `Unpin ${agent.label}` : `Pin ${agent.label} first`}
              title={agent.pinned ? "Remove from favorites" : "Add to favorites"}
              onClick={() => { void Promise.resolve(store.setAgentPinned(agent.sourceId, !agent.pinned)).catch(() => undefined); }}
            >
              <Icon name="star" size={16} fill={agent.pinned ? "currentColor" : "none"} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close agent settings">
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        <div className="agent-settings-body">
          <div>
            <h3>New conversation defaults</h3>
            <p>Applies only to conversations created after you save. Existing conversations and other channels are unchanged. Any model mismatch or fallback appears on that run.</p>
          </div>
          <ModelSelector
            models={models}
            agentProviders={agent.providers}
            value={model}
            effort={effort}
            onValueChange={chooseModel}
            onEffortChange={setEffort}
            disabled={inactive}
            badge={model || effort ? "custom" : "default"}
            agentDefaultId={agent.defaultModel}
            providerStatus={providerStatus}
            onProviderRequest={(provider) => { void store.ensureProviderCatalog(provider); }}
          />
          <p className="agent-settings-config">
            Config default: <code>{settings.config.model ?? "provider"}</code> · <code>{settings.config.effort ?? "provider"}</code>
          </p>
          {agent.status === "offline" && <p className="agent-settings-warning">Reconnect this agent before saving. Revert remains available.</p>}
          <AgentRestartSection key={agent.sourceId} agent={agent}
            approximateRunningCount={store.activeThreads?.runningCounts[agent.sourceId] ?? 0} />
          <ProviderAuthSection key={`${agent.sourceId}:${agent.generation ?? "unknown"}`} agent={agent} />
          {error && <p className="agent-settings-error" role="alert">{error}</p>}
        </div>
        <footer>
          {settings.override && (
            <button type="button" className="secondary-button" disabled={saving} onClick={() => void revert()}>
              <Icon name="restore" size={14} /> Revert to config
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={inactive || (model === "" && effort === "")}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save for new conversations"}
          </button>
        </footer>
      </section>
    </div>
  );
}
