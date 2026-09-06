import { type RefObject, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type { ConfigurationSession } from "../types";
import { buildSelectorModels, effectiveModelForAgent, effortLevelsForAgentModel, findCatalogModel, providerOfModel } from "./model-catalog";
import { ModelSelector } from "./assistant-ui/ModelSelector";
import { Icon } from "./Icon";

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
  const [configurationMode, setConfigurationMode] = useState(false);
  const [configuration, setConfiguration] = useState<ConfigurationSession | null>(null);
  const [configurationText, setConfigurationText] = useState("");
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const configurationSessionId = configuration?.id;

  useEffect(() => () => {
    if (configurationSessionId !== undefined) {
      void api.closeConfigurationSession(configurationSessionId).catch(() => undefined);
    }
  }, [configurationSessionId]);

  useEffect(() => {
    if (!open || !agent) return;
    setModel(agent.runSettings.override?.model ?? "");
    setEffort(agent.runSettings.override?.effort ?? "");
    setError(null);
    setConfigurationMode(false);
    setConfiguration(null);
    setConfigurationText("");
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

  const openConfiguration = async () => {
    setConfigurationMode(true);
    setConfigurationBusy(true);
    setError(null);
    try {
      setConfiguration(await api.createConfigurationSession(agent.sourceId));
    } catch (caught) {
      setConfigurationMode(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConfigurationBusy(false);
    }
  };

  const closeConfiguration = () => {
    setConfigurationMode(false);
    setConfiguration(null);
    setConfigurationText("");
  };

  const closeDialog = () => {
    closeConfiguration();
    onClose();
  };

  const sendConfigurationTurn = async () => {
    if (configuration === null || configurationText.trim().length === 0) return;
    const text = configurationText;
    setConfigurationBusy(true);
    setConfigurationText("");
    setError(null);
    try {
      setConfiguration(await api.continueConfigurationSession(configuration.id, text));
    } catch (caught) {
      setConfigurationText(text);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConfigurationBusy(false);
    }
  };

  const settleConfiguration = async (decision: "approve" | "reject") => {
    if (configuration?.proposal === undefined) return;
    setConfigurationBusy(true);
    setError(null);
    try {
      setConfiguration(await api.settleConfigurationSession(
        configuration.id,
        configuration.proposal.id,
        decision,
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConfigurationBusy(false);
    }
  };

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={closeDialog}>
      <section
        ref={dialogRef}
        className={`agent-settings-dialog${configurationMode ? " configuration-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Agent settings</span>
            <h2 id="agent-settings-title">{agent.label} settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={closeDialog} aria-label="Close agent settings">
            <Icon name="close" size={16} />
          </button>
        </header>
        {configurationMode ? (
          <>
            <div className="configuration-body">
              <div className="configuration-boundary">
                <b>SELF-CONFIG</b>
                <span>Changes require an explicit proposal and approval. Network reachability is this console's access boundary.</span>
              </div>
              {configurationBusy && configuration === null && <p className="configuration-loading">Opening verified session…</p>}
              {configuration !== null && (
                <>
                  <p className="configuration-target">Role target: <code>{configuration.roleLocation}</code></p>
                  <div className="configuration-transcript" aria-live="polite">
                    {configuration.messages.map((message, index) => (
                      <article key={index} className={`configuration-message is-${message.role}`}>
                        <b>{message.role}</b>
                        <p>{message.text}</p>
                      </article>
                    ))}
                  </div>
                  {configuration.proposal !== undefined && (
                    <section className="configuration-proposal">
                      <span className="eyebrow">Approval required</span>
                      <h3>{configuration.proposal.title}</h3>
                      <p>{configuration.proposal.rationale}</p>
                      <ul>{configuration.proposal.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                      {configuration.proposal.role !== undefined && (
                        <details>
                          <summary>Review Role replacement</summary>
                          <pre>{configuration.proposal.role.proposedBody}</pre>
                        </details>
                      )}
                      <div>
                        <button type="button" className="secondary-button" disabled={configurationBusy} onClick={() => void settleConfiguration("reject")}>Reject</button>
                        <button type="button" className="primary-button" disabled={configurationBusy} onClick={() => void settleConfiguration("approve")}>Approve and restart</button>
                      </div>
                    </section>
                  )}
                  {configuration.proposal === undefined && (
                    <form className="configuration-composer" onSubmit={(event) => { event.preventDefault(); void sendConfigurationTurn(); }}>
                      <textarea
                        value={configurationText}
                        onChange={(event) => setConfigurationText(event.target.value)}
                        placeholder="Describe one adjustment or answer the agent's question"
                        disabled={configurationBusy}
                        maxLength={200000}
                      />
                      <button type="submit" className="primary-button" disabled={configurationBusy || configurationText.trim().length === 0}>
                        {configurationBusy ? "Working…" : "Send"}
                      </button>
                    </form>
                  )}
                </>
              )}
              {error && <p className="agent-settings-error" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" className="secondary-button" disabled={configurationBusy} onClick={closeConfiguration}>End SELF-CONFIG</button>
            </footer>
          </>
        ) : (
          <>
        <div className="agent-settings-body">
          <div>
            <h3>New conversation defaults</h3>
            <p>Applies only to conversations created after you save. Existing conversations and other channels are unchanged.</p>
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
          <dl className="agent-settings-effective">
            <div>
              <dt>Effective model</dt>
              <dd><span>{settings.effective.model ?? "Provider default"}</span><b>{settings.effective.modelSource}</b></dd>
            </div>
            <div>
              <dt>Effective effort</dt>
              <dd><span>{settings.effective.effort ?? "Provider default"}</span><b>{settings.effective.effortSource}</b></dd>
            </div>
          </dl>
          <p className="agent-settings-config">
            Config default: <code>{settings.config.model ?? "provider"}</code> · <code>{settings.config.effort ?? "provider"}</code>
          </p>
          {agent.status === "offline" && <p className="agent-settings-warning">Reconnect this agent before saving. Revert remains available.</p>}
          {error && <p className="agent-settings-error" role="alert">{error}</p>}
          {agent.supportsConfiguration === true && (
            <section className="configuration-entry">
              <div>
                <h3>Agent configuration</h3>
                <p>Open a dedicated guided session. Every file change is shown for approval before the host applies and verifies it.</p>
              </div>
              <button type="button" className="secondary-button" disabled={inactive || configurationBusy} onClick={() => void openConfiguration()}>
                Configure agent
              </button>
            </section>
          )}
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
          </>
        )}
      </section>
    </div>
  );
}
