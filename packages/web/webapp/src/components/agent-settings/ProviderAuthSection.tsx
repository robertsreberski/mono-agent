import type { AgentSummary } from "../../types";
import { ProviderUsageMeters } from "../ProviderUsageMeters";
import { Icon } from "../Icon";
import { providerAuthPresentation, providerAuthCheckPresentation, providerAuthCheckSummary, terminal } from "./provider-auth-presentation";
import { useProviderAuth } from "./use-provider-auth";

export function ProviderAuthSection({ agent }: { readonly agent: AgentSummary }) {
  const { status, session, check, usage, usageRefreshing, usageFeedback, refreshUsage, sessionProvider, methodProvider, inputValue, setInputValue, busy, restarting, authError, inputRef, adoptSession, setSessionProvider, setMethodProvider, start, startCheck, cancelCheck, openFlow, submit, cancel, checkActive } = useProviderAuth(agent);
  if (agent.supportsProviderAuth !== true && agent.supportsProviderUsage !== true) {
    return (
      <section className="provider-auth-section">
        <div><h3>Provider authentication</h3><p className="provider-auth-unavailable">Not available on this agent.</p></div>
      </section>
    );
  }
  return (
    <section className="provider-auth-section">
      <div className="provider-auth-title-row">
        <h3>{agent.supportsProviderAuth === true ? "Provider authentication" : "Subscription usage"}</h3>
        <div className="provider-auth-header-actions">
        {agent.supportsProviderUsageRefresh === true && agent.supportsProviderUsage === true && (
          <button type="button" className="secondary-button provider-auth-neutral-button" title="Refresh usage" aria-label="Refresh usage"
            aria-describedby="provider-actions-disclosure" aria-busy={usageRefreshing}
            disabled={agent.status === "offline" || usageRefreshing || busy || checkActive || session !== null && !terminal(session.state)}
            onClick={() => void refreshUsage()}>
            <Icon name="refresh" size={12} className={usageRefreshing ? "provider-usage-refreshing" : undefined} />
            Refresh usage
          </button>
        )}
        {agent.supportsProviderAuthChecks === true && (
          checkActive ? (
            <button type="button" className="secondary-button provider-auth-neutral-button" aria-label="Cancel live provider checks" disabled={busy} onClick={() => void cancelCheck()}>
              Cancel checks
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button provider-auth-neutral-button"
              aria-label="Check access"
              aria-describedby="provider-actions-disclosure"
              disabled={usageRefreshing || busy || status === null || session !== null && !terminal(session.state)}
              onClick={() => void startCheck()}
            >
              Check access
            </button>
          )
        )}
        </div>
      </div>
      {(agent.supportsProviderUsageRefresh === true || agent.supportsProviderAuthChecks === true) && (
        <p id="provider-actions-disclosure" className="provider-auth-check-disclosure">
          {agent.supportsProviderUsageRefresh === true && "Refresh usage reads subscription limits without inference."}
          {agent.supportsProviderUsageRefresh === true && agent.supportsProviderAuthChecks === true && " "}
          {agent.supportsProviderAuthChecks === true && "Check access sends one small model request per configured authentication provider and may use quota or refresh OAuth."}
        </p>
      )}
      {usageFeedback !== null && <p role="status" className="provider-auth-check-disclosure">{usageFeedback}</p>}
      {agent.supportsProviderAuth === true && status === null && authError === null && <p aria-live="polite">Loading provider status…</p>}
      <div className="provider-auth-list">
        {agent.supportsProviderAuth === true && status?.providers.map((provider) => {
          const actionable = provider.methods.length > 0;
          const presentation = providerAuthPresentation(provider);
          const checkResult = check?.results.find((result) => result.providerId === provider.providerId);
          const providerUsage = usage?.providers.find((item) => item.providerId === provider.providerId);
          return (
            <article className="provider-auth-card" key={provider.providerId}>
              <div className="provider-auth-controls">
              <div className="provider-auth-heading">
                <b>{provider.label}</b>
                <span className="provider-auth-badges">
                  {providerUsage?.plan !== undefined && <span className="provider-usage-plan">{providerUsage.plan}</span>}
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
                <button type="button" className="secondary-button provider-auth-neutral-button" disabled={usageRefreshing || busy || checkActive} onClick={() => openFlow(provider)}>
                  {provider.state === "missing" ? "Authenticate" : "Re-authenticate"}
                </button>
              )}
              </div>
              <ProviderUsageMeters usage={providerUsage} />
            </article>
          );
        })}
        {agent.supportsProviderUsage === true && agent.supportsProviderAuth !== true && usage?.providers.map((provider) => (
          <article className="provider-auth-card" key={provider.providerId}>
            <div className="provider-auth-heading">
              <b>{provider.label}</b>
              {provider.plan !== undefined && <span className="provider-usage-plan">{provider.plan}</span>}
            </div>
            <ProviderUsageMeters usage={provider} />
          </article>
        ))}
      </div>
      {methodProvider !== null && methodProvider.methods.length > 1 && !checkActive && (
        <div className="provider-auth-flow">
          {methodProvider.methods.map((method) => (
            <button key={method.authType + ":" + method.strategy} type="button" className="secondary-button" disabled={busy || checkActive} onClick={() => void start(methodProvider, method)}>
              {method.label}
            </button>
          ))}
        </div>
      )}
      {restarting && <p aria-live="polite">Restarting authentication…</p>}
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
          {session.error?.code === "device_code_unavailable" && sessionProvider !== null && (() => {
            const pasteBack = sessionProvider.methods.find((method) => method.strategy === "paste_back");
            return pasteBack === undefined ? null : (
              <button type="button" className="secondary-button" disabled={busy || checkActive} onClick={() => void start(sessionProvider, pasteBack)}>
                Retry with browser paste-back
              </button>
            );
          })()}
          {!terminal(session.state) && <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancel()}>Cancel authentication</button>}
          {terminal(session.state) && <button type="button" className="secondary-button" onClick={() => { adoptSession(null); setSessionProvider(null); setMethodProvider(null); }}>Close authentication</button>}
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
