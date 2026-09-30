import type { AgentSummary, ProviderAuthMethod, ProviderAuthProviderStatus } from "../../types";
import { ProviderUsageMeters } from "../ProviderUsageMeters";
import { Icon } from "../Icon";
import { relativeTime } from "../time";
import { providerAuthCheckPresentation, providerAuthCheckSummary, providerAuthPresentation, terminal } from "./provider-auth-presentation";
import { useProviderAuth } from "./use-provider-auth";

type State = ReturnType<typeof useProviderAuth>;
const disclosure = "Check access sends one small model request per configured authentication provider and may use quota or refresh OAuth.";

export function ProvidersSection({ agent, controller, compact = false }: { readonly agent: AgentSummary; readonly controller: State; readonly compact?: boolean }) {
  const state = controller;
  const actionDisclosure = `${agent.supportsProviderUsageRefresh && agent.supportsProviderUsage ? "Refresh usage reads subscription limits without inference. " : ""}${agent.supportsProviderAuthChecks ? disclosure : ""}`;
  if (agent.status === "offline" || agent.supportsProviderAuth !== true && agent.supportsProviderUsage !== true) return <div className="settings-group"><div className="settings-row">{agent.status === "offline" ? "Provider status needs a live connection" : "Not available on this agent."}</div></div>;
  return <>
    <div className="settings-section-actions"><div className="settings-section-actions-row">
      {agent.supportsProviderUsageRefresh === true && agent.supportsProviderUsage === true && <span className="settings-hit"><button className="settings-button is-compact" type="button" aria-label="Refresh usage" title="Refresh usage" aria-describedby="settings-provider-disclosure" aria-busy={state.usageRefreshing} disabled={state.usageRefreshing || state.busy || state.checkActive || state.session !== null && !terminal(state.session.state)} onClick={() => void state.refreshUsage()}><Icon name="refresh" size={12} className={state.usageRefreshing ? "provider-usage-refreshing" : undefined} />Refresh usage</button></span>}
      {agent.supportsProviderAuthChecks === true && <span className="settings-hit"><button className="settings-button is-compact" type="button" aria-label={state.checkActive ? "Cancel live provider checks" : "Check access"} title={actionDisclosure} aria-describedby="settings-provider-disclosure" disabled={state.busy || state.usageRefreshing || !state.checkActive && (state.status === null || state.session !== null && !terminal(state.session.state))} onClick={() => { void (state.checkActive ? state.cancelCheck() : state.startCheck()); }}>{state.checkActive ? "Cancel checks" : "Check access"}</button></span>}
    </div>{state.usageFeedback && <span className={`settings-usage-feedback is-${state.usageFeedback.tone}`}
      title={state.usageFeedback.fetchedAt === undefined ? undefined : `Fetched ${new Date(state.usageFeedback.fetchedAt).toLocaleString()}`}>{state.usageFeedback.text}</span>}
    {agent.supportsProviderAuthChecks === true && <span className="settings-disclosure">Check access may use quota</span>}<span className="sr-only" id="settings-provider-disclosure">{actionDisclosure}</span></div>
    {state.status === null && agent.supportsProviderAuth === true && state.authError === null && <p className="settings-row-note">Loading provider status…</p>}
    <div className="settings-group">
      {agent.supportsProviderAuth === true && state.status?.providers.map((provider) => <ProviderRow key={provider.providerId} agent={agent} provider={provider} state={state} compact={compact} />)}
      {agent.supportsProviderAuth !== true && !state.usage?.providers.length && <p className="settings-row-note">No subscription usage available.</p>}
      {agent.supportsProviderAuth !== true && state.usage?.providers.map((usage) => <article className="settings-provider" key={usage.providerId}><div className="settings-provider-head"><b className="settings-provider-name">{usage.label}</b>{usage.plan && <span className="provider-usage-plan">{usage.plan}</span>}</div>{usage.stale && <span className="settings-freshness is-stale" title={usage.fetchedAt}>Last known · {relativeTime(usage.fetchedAt)} ago</span>}<ProviderUsageMeters usage={usage} density={compact ? "compact" : "default"} /></article>)}
    </div>
    {state.restarting && <p className="settings-row-note">Restarting authentication…</p>}
    {state.check && <p className="provider-auth-check-summary">{providerAuthCheckSummary(state.check)}</p>}
    {state.authError && <p className="settings-row-note is-danger" role="alert">{state.authError}</p>}
  </>;
}

function ProviderRow({ agent, provider, state, compact }: { readonly agent: AgentSummary; readonly provider: ProviderAuthProviderStatus; readonly state: State; readonly compact: boolean }) {
  const presentation = providerAuthPresentation(provider);
  const result = state.check?.results.find((entry) => entry.providerId === provider.providerId);
  const usage = state.usage?.providers.find((entry) => entry.providerId === provider.providerId);
  const flowOpen = state.sessionProvider?.providerId === provider.providerId || state.methodProvider?.providerId === provider.providerId;
  return <article className={`settings-provider${usage?.stale ? " is-stale" : ""}`}>
    <div className="settings-provider-head">
      <b className="settings-provider-name">{provider.label}</b>
      <span className="settings-provider-meta">{usage?.plan && <span className="provider-usage-plan">{usage.plan}</span>}
        <span className={`provider-auth-state ${presentation.className}`}><span aria-hidden="true">{presentation.glyph}</span> {presentation.label}</span>
        {result && <span className={`provider-auth-check-result ${providerAuthCheckPresentation(result).className}`} aria-label={`Live check for ${provider.label}: ${providerAuthCheckPresentation(result).label}.`}>{providerAuthCheckPresentation(result).label}</span>}
        {usage?.stale && <span className="settings-freshness is-stale" title={`Fetched ${new Date(usage.fetchedAt).toLocaleString()}`}>Last known · {relativeTime(usage.fetchedAt)} ago</span>}
      </span>
      {provider.methods.length > 0 && <span className="settings-hit"><button type="button" className={`settings-button is-compact ${provider.state === "missing" ? "is-accent" : "is-ghost"}`} aria-label={`${provider.state === "missing" ? "Authenticate" : "Re-authenticate"} ${provider.label}`} disabled={state.usageRefreshing || state.busy || state.checkActive} onClick={() => state.openFlow(provider)}>{provider.state === "missing" ? "Authenticate" : "Re-authenticate"}</button></span>}
    </div>
    {usage ? <ProviderUsageMeters usage={usage} density={compact ? "compact" : "default"} /> : agent.supportsProviderUsage && provider.state === "missing" ? <p className="settings-provider-empty">Sign in to read subscription limits.</p> : provider.state === "missing" && <p className="settings-provider-empty">Sign in to use this provider.</p>}
    {flowOpen && <ProviderAuthFlow provider={provider} state={state} />}
  </article>;
}

function confirmAuthReplacement(provider: ProviderAuthProviderStatus, method: ProviderAuthMethod): boolean {
  if (provider.providerId !== "openai" || provider.credentialType === undefined || provider.credentialType === method.authType || provider.source !== "stored") return true;
  return window.confirm(`Replace the stored OpenAI ${provider.credentialType === "oauth" ? "ChatGPT sign-in" : "API key"} with ${method.authType === "oauth" ? "ChatGPT sign-in" : "an API key"}? The existing credential remains until authentication succeeds.`);
}

function ProviderAuthFlow({ provider, state }: { readonly provider: ProviderAuthProviderStatus; readonly state: State }) {
  const session = state.sessionProvider?.providerId === provider.providerId ? state.session : null;
  const methodProvider = state.methodProvider?.providerId === provider.providerId ? state.methodProvider : null;
  return <div className="settings-provider-flow">
    {methodProvider !== null && methodProvider.methods.length > 1 && !state.checkActive && <div className="settings-provider-flow-row">{methodProvider.methods.map((method) => <button key={`${method.authType}:${method.strategy}`} type="button" className="settings-button" disabled={state.busy} onClick={() => { if (confirmAuthReplacement(methodProvider, method)) void state.start(methodProvider, method); }}>{method.label}</button>)}</div>}
    {session?.authUrl && <><p>{session.authUrl.instructions}</p><a href={session.authUrl.url} target="_blank" rel="noopener noreferrer">Open authentication page</a></>}
    {session?.deviceCode && <div className="provider-device-code-row"><a href={session.deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">Open device page</a><code className="provider-device-code">{session.deviceCode.userCode}</code></div>}
    {session?.progress && <p>{session.progress}</p>}
    {session?.prompt && <form onSubmit={(event) => { event.preventDefault(); void state.submit(); }}><label htmlFor={`provider-auth-${session.prompt.id}`}>{session.prompt.message}</label>
      {session.prompt.type === "select" ? <select id={`provider-auth-${session.prompt.id}`} ref={(node) => { state.inputRef.current = node; }} value={state.inputValue} onChange={(event) => state.setInputValue(event.target.value)}><option value="">Choose…</option>{session.prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        : session.prompt.type === "manual_code" ? <textarea id={`provider-auth-${session.prompt.id}`} ref={(node) => { state.inputRef.current = node; }} value={state.inputValue} onChange={(event) => state.setInputValue(event.target.value)} placeholder={session.prompt.placeholder} autoComplete="off" spellCheck={false} />
          : <input id={`provider-auth-${session.prompt.id}`} ref={(node) => { state.inputRef.current = node; }} type={session.prompt.type === "secret" ? "password" : "text"} value={state.inputValue} onChange={(event) => state.setInputValue(event.target.value)} placeholder={session.prompt.placeholder} autoComplete="off" spellCheck={false} />}
      <button type="submit" className="settings-button is-primary" disabled={state.busy || state.inputValue.length === 0 && session.prompt.allowEmpty !== true}>Submit once</button></form>}
    {session?.error && <p className="settings-row-note is-danger">{session.error.message}</p>}
    {session?.error?.code === "device_code_unavailable" && (() => { const method = provider.methods.find((item) => item.strategy === "paste_back"); return method ? <button type="button" className="settings-button" disabled={state.busy || state.checkActive} onClick={() => void state.start(provider, method)}>Retry with browser paste-back</button> : null; })()}
    {session !== null && (terminal(session.state) ? <button type="button" className="settings-button" onClick={() => { state.adoptSession(null); state.setSessionProvider(null); state.setMethodProvider(null); }}>Close authentication</button> : <button type="button" className="settings-button" disabled={state.busy} onClick={() => void state.cancel()}>Cancel authentication</button>)}
  </div>;
}
