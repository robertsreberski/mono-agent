import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type {
  AgentSummary,
  ProviderAuthCheckResult,
  ProviderAuthCheckSessionSnapshot,
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
    <div className="dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="agent-settings-dialog"
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
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close agent settings">
            <Icon name="close" size={16} />
          </button>
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

function ProviderAuthSection({ agent }: { readonly agent: AgentSummary }) {
  const [status, setStatus] = useState<ProviderAuthStatusSnapshot | null>(null);
  const [session, setSession] = useState<ProviderAuthSessionSnapshot | null>(null);
  const [check, setCheck] = useState<ProviderAuthCheckSessionSnapshot | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderAuthProviderStatus | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const sessionRef = useRef<ProviderAuthSessionSnapshot | null>(null);
  const checkRef = useRef<ProviderAuthCheckSessionSnapshot | null>(null);
  const sourceId = agent.sourceId;

  const adoptSession = (next: ProviderAuthSessionSnapshot | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const adoptCheck = (next: ProviderAuthCheckSessionSnapshot | null) => {
    checkRef.current = next;
    setCheck(next);
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
    const currentCheck = checkRef.current;
    if (currentCheck !== null && !checkTerminal(currentCheck.state)) {
      void api.cancelProviderAuthCheck(sourceId, currentCheck.id, AbortSignal.timeout(2_000)).catch(() => undefined);
    }
    sessionRef.current = null;
    checkRef.current = null;
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

  useEffect(() => {
    if (check === null || checkTerminal(check.state)) {
      if (check !== null) {
        void refresh().catch((caught) => setAuthError(caught instanceof Error ? caught.message : String(caught)));
      }
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.providerAuthCheck(sourceId, check.id, controller.signal).then((next) => {
        if (!controller.signal.aborted) adoptCheck(next);
      }).catch((caught) => {
        if (!controller.signal.aborted) setAuthError(caught instanceof Error ? caught.message : String(caught));
      });
    }, 1_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sourceId, check?.id, check?.state, check?.updatedAt]);

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

  const startCheck = async () => {
    setBusy(true);
    setAuthError(null);
    try {
      adoptCheck(await api.beginProviderAuthCheck(sourceId, crypto.randomUUID()));
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancelCheck = async () => {
    if (check === null) return;
    setBusy(true);
    setAuthError(null);
    try {
      await api.cancelProviderAuthCheck(sourceId, check.id);
      adoptCheck({ ...check, state: "cancelled", updatedAt: new Date().toISOString() });
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
      <div className="provider-auth-title-row">
        <h3>Provider authentication</h3>
        {agent.supportsProviderAuthChecks === true && (
          check !== null && !checkTerminal(check.state) ? (
            <button type="button" className="secondary-button provider-auth-neutral-button" aria-label="Cancel live provider checks" disabled={busy} onClick={() => void cancelCheck()}>
              Cancel checks
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button provider-auth-neutral-button"
              aria-label="Run live checks for all displayed providers"
              aria-describedby="provider-auth-check-disclosure"
              disabled={busy || status === null || session !== null && !terminal(session.state)}
              onClick={() => void startCheck()}
            >
              Run check
            </button>
          )
        )}
      </div>
      {agent.supportsProviderAuthChecks === true && (
        <p id="provider-auth-check-disclosure" className="provider-auth-check-disclosure">Runs one small request per displayed provider; this may use quota or refresh OAuth.</p>
      )}
      {status === null && authError === null && <p aria-live="polite">Loading provider status…</p>}
      <div className="provider-auth-list">
        {status?.providers.map((provider) => {
          const actionable = provider.methods.length > 0;
          const presentation = providerAuthPresentation(provider);
          const checkResult = check?.results.find((result) => result.providerId === provider.providerId);
          return (
            <article className="provider-auth-card" key={provider.providerId}>
              <div className="provider-auth-heading">
                <b>{provider.label}</b>
                <span className="provider-auth-badges">
                  {checkResult !== undefined && (
                    <span
                      className={"provider-auth-check-result " + providerAuthCheckPresentation(checkResult).className}
                      aria-label={`Live check for ${provider.label}${checkResult.model === undefined ? "" : ` using ${checkResult.model}`}: ${providerAuthCheckPresentation(checkResult).label}.`}
                    >
                      {providerAuthCheckPresentation(checkResult).label}
                    </span>
                  )}
                  <span className={"provider-auth-state " + presentation.className}>
                    <span aria-hidden="true">{presentation.glyph}</span> {presentation.label}
                  </span>
                </span>
              </div>
              {actionable && (
                <button type="button" className="secondary-button provider-auth-neutral-button" disabled={busy || session !== null && !terminal(session.state) || check !== null && !checkTerminal(check.state)} onClick={() => openFlow(provider)}>
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
      {check !== null && (
        <p className="provider-auth-check-summary" aria-live="polite">
          {providerAuthCheckSummary(check)}
        </p>
      )}
      {authError !== null && <p className="agent-settings-error" role="alert">{authError}</p>}
    </section>
  );
}

function terminal(state: ProviderAuthSessionSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function checkTerminal(state: ProviderAuthCheckSessionSnapshot["state"]): boolean {
  return state === "completed" || state === "cancelled";
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
  if (provider.verification === "verified_by_live_request" && provider.lastFailure === undefined) {
    return { className: "is-ok", glyph: "✓", label: "OK" };
  }
  return { className: "is-not-verified", glyph: "?", label: "Not verified" };
}

function providerAuthCheckPresentation(result: ProviderAuthCheckResult): {
  readonly className: string;
  readonly label: string;
} {
  switch (result.state) {
    case "pending": return { className: "is-neutral", label: "Pending" };
    case "running": return { className: "is-neutral", label: "Checking…" };
    case "passed": return { className: "is-passed", label: "Check passed" };
    case "auth_failed": return { className: "is-failed", label: "Auth failed" };
    case "network_failed": return { className: "is-neutral", label: "Network error" };
    case "quota_limited": return { className: "is-neutral", label: "Quota blocked" };
    case "model_not_entitled": return { className: "is-neutral", label: "Model unavailable" };
    case "inconclusive": return { className: "is-neutral", label: "Inconclusive" };
    case "unsupported": return { className: "is-neutral", label: "Not checked" };
    case "timeout": return { className: "is-neutral", label: "Timed out" };
    case "cancelled": return { className: "is-neutral", label: "Cancelled" };
    case "stale": return { className: "is-neutral", label: "Credential changed" };
    case "not_run": return { className: "is-neutral", label: "Not run" };
  }
}

function providerAuthCheckSummary(check: ProviderAuthCheckSessionSnapshot): string {
  const finished = check.results.filter((result) => result.state !== "pending" && result.state !== "running").length;
  if (!checkTerminal(check.state)) return `Checking providers: ${finished} of ${check.results.length} complete.`;
  const passed = check.results.filter((result) => result.state === "passed").length;
  return `Checks complete: ${passed} of ${check.results.length} passed.`;
}
