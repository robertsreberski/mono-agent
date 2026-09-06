import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type {
  AgentSummary,
  ConfigurationSession,
  ProviderAuthMethod,
  ProviderAuthProviderStatus,
  ProviderAuthSessionSnapshot,
  ProviderAuthStatusSnapshot,
} from "../types";
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
            <p>Applies only to conversations created after you save. Existing conversations and other channels are unchanged. The model that actually runs, including any fallback, appears on that run.</p>
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
          <ProviderAuthSection key={`${agent.sourceId}:${agent.generation ?? "unknown"}`} agent={agent} />
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

function ProviderAuthSection({ agent }: { readonly agent: AgentSummary }) {
  const [status, setStatus] = useState<ProviderAuthStatusSnapshot | null>(null);
  const [session, setSession] = useState<ProviderAuthSessionSnapshot | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderAuthProviderStatus | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const sessionRef = useRef<ProviderAuthSessionSnapshot | null>(null);
  const sourceId = agent.sourceId;

  const adoptSession = (next: ProviderAuthSessionSnapshot | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const refresh = async (signal?: AbortSignal) => {
    setStatus(await api.providerAuthStatus(sourceId, signal));
  };

  useEffect(() => {
    if (agent.supportsProviderAuth !== true || agent.status === "offline") return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setAuthError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => controller.abort();
  }, [sourceId, agent.generation, agent.status, agent.supportsProviderAuth]);

  useEffect(() => () => {
    const current = sessionRef.current;
    if (current !== null && !terminal(current.state)) {
      void api.cancelProviderAuth(sourceId, current.id, AbortSignal.timeout(2_000)).catch(() => undefined);
    }
    sessionRef.current = null;
  }, [sourceId, agent.generation]);

  useEffect(() => {
    if (session === null || terminal(session.state)) {
      if (session?.state === "succeeded") {
        void refresh().catch((caught) => setAuthError(caught instanceof Error ? caught.message : String(caught)));
      }
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.providerAuthSession(sourceId, session.id, controller.signal).then((next) => {
        if (!controller.signal.aborted) adoptSession(next);
      }).catch((caught) => {
        if (!controller.signal.aborted) setAuthError(caught instanceof Error ? caught.message : String(caught));
      });
    }, 1_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sourceId, session?.id, session?.state, session?.updatedAt]);

  if (agent.supportsProviderAuth !== true) {
    return (
      <section className="provider-auth-section">
        <div><h3>Provider authentication</h3><p className="provider-auth-unavailable">Not available on this agent.</p></div>
      </section>
    );
  }

  const start = async (provider: ProviderAuthProviderStatus, method: ProviderAuthMethod) => {
    setBusy(true);
    setAuthError(null);
    setInputValue("");
    try {
      adoptSession(await api.beginProviderAuth(sourceId, provider.providerId, method));
      setSelectedProvider(provider);
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const openFlow = (provider: ProviderAuthProviderStatus) => {
    setSelectedProvider(provider);
    setAuthError(null);
    const recommended = provider.methods.find((method) => method.recommended);
    if (provider.methods.length === 1 || provider.providerId === "openai-codex" && recommended !== undefined) {
      void start(provider, provider.methods.length === 1 ? provider.methods[0]! : recommended!);
    }
  };

  const submit = async () => {
    if (session?.prompt === undefined || inputValue.length === 0 && session.prompt.allowEmpty !== true) return;
    const value = inputValue;
    if (inputRef.current !== null) inputRef.current.value = "";
    setInputValue("");
    setBusy(true);
    setAuthError(null);
    try {
      adoptSession(await api.submitProviderAuth(sourceId, session.id, { promptId: session.prompt.id, value }));
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (session === null) return;
    setBusy(true);
    try {
      await api.cancelProviderAuth(sourceId, session.id);
      adoptSession({ ...session, state: "cancelled", updatedAt: new Date().toISOString() });
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="provider-auth-section">
      <h3>Provider authentication</h3>
      {status === null && authError === null && <p aria-live="polite">Loading provider status…</p>}
      <div className="provider-auth-list">
        {status?.providers.map((provider) => {
          const actionable = provider.methods.length > 0
            && (provider.state === "missing" || provider.state === "expired" || provider.lastFailure?.kind === "provider_auth");
          const presentation = providerAuthPresentation(provider);
          return (
            <article className="provider-auth-card" key={provider.providerId}>
              <div className="provider-auth-heading">
                <b>{provider.label}</b>
                <span className={"provider-auth-state " + presentation.className}>
                  <span aria-hidden="true">{presentation.glyph}</span> {presentation.label}
                </span>
              </div>
              {actionable && (
                <button type="button" className="secondary-button" disabled={busy || session !== null && !terminal(session.state)} onClick={() => openFlow(provider)}>
                  {provider.state === "missing" ? "Authenticate" : "Re-authenticate"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {selectedProvider !== null && session === null && selectedProvider.methods.length > 1 && (
        <div className="provider-auth-flow">
          {selectedProvider.methods.map((method) => (
            <button key={method.authType + ":" + method.strategy} type="button" className="secondary-button" disabled={busy} onClick={() => void start(selectedProvider, method)}>
              {method.label}
            </button>
          ))}
        </div>
      )}
      {session !== null && (
        <div className="provider-auth-flow" aria-live="polite">
          {session.authUrl !== undefined && (
            <>
              <p>{session.authUrl.instructions}</p>
              <a href={session.authUrl.url} target="_blank" rel="noopener noreferrer">Open authentication page</a>
            </>
          )}
          {session.deviceCode !== undefined && (
            <div className="provider-device-code-row">
              <a href={session.deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">Open device page</a>
              <code className="provider-device-code">{session.deviceCode.userCode}</code>
            </div>
          )}
          {session.progress !== undefined && <p>{session.progress}</p>}
          {session.prompt !== undefined && (
            <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <label htmlFor={`provider-auth-${session.prompt.id}`}>{session.prompt.message}</label>
              {session.prompt.type === "select" ? (
                <select id={`provider-auth-${session.prompt.id}`} ref={(node) => { inputRef.current = node; }} value={inputValue} onChange={(event) => setInputValue(event.target.value)}>
                  <option value="">Choose…</option>
                  {session.prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              ) : session.prompt.type === "manual_code" ? (
                <textarea id={`provider-auth-${session.prompt.id}`} ref={(node) => { inputRef.current = node; }} value={inputValue} onChange={(event) => setInputValue(event.target.value)} placeholder={session.prompt.placeholder} autoComplete="off" spellCheck={false} />
              ) : (
                <input id={`provider-auth-${session.prompt.id}`} ref={(node) => { inputRef.current = node; }} type={session.prompt.type === "secret" ? "password" : "text"} value={inputValue} onChange={(event) => setInputValue(event.target.value)} placeholder={session.prompt.placeholder} autoComplete="off" spellCheck={false} />
              )}
              <button type="submit" className="primary-button" disabled={busy || inputValue.length === 0 && session.prompt.allowEmpty !== true}>Submit once</button>
            </form>
          )}
          {session.error !== undefined && <p className="agent-settings-error">{session.error.message}</p>}
          {session.error?.code === "device_code_unavailable" && selectedProvider !== null && (() => {
            const pasteBack = selectedProvider.methods.find((method) => method.strategy === "paste_back");
            return pasteBack === undefined ? null : (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void start(selectedProvider, pasteBack)}>
                Retry with browser paste-back
              </button>
            );
          })()}
          {!terminal(session.state) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancel()}>Cancel authentication</button>}
          {terminal(session.state) && <button type="button" className="secondary-button" onClick={() => { adoptSession(null); setSelectedProvider(null); }}>Close authentication</button>}
        </div>
      )}
      {authError !== null && <p className="agent-settings-error" role="alert">{authError}</p>}
    </section>
  );
}

function terminal(state: ProviderAuthSessionSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function providerAuthPresentation(provider: ProviderAuthProviderStatus): {
  readonly className: string;
  readonly glyph: string;
  readonly label: string;
} {
  if (provider.state === "not_applicable") {
    return { className: "is-not-applicable", glyph: "–", label: "Not applicable" };
  }
  if (provider.state !== "present" || provider.lastFailure?.kind === "provider_auth") {
    return { className: "is-needs-action", glyph: "⚠", label: "Needs action" };
  }
  return { className: "is-ok", glyph: "✓", label: "OK" };
}
