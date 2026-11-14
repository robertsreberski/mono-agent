import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { AgentSummary, WebCredentialSnapshot, WebCredentialSaveRequest } from "../../types";
import type { CapabilityRestartState } from "./CapabilityActionControls";

type CardId = WebCredentialSaveRequest["card"];
export type CredentialNotice = { readonly outcome: "saved" | "saved-config-pending" | "unknown" | "refused" | "too-long"; readonly inFlight?: true; readonly reconciliation?: string };
export const CREDENTIAL_SAVE_UNCERTAIN = "Save outcome uncertain. Do not automatically resend credentials.";
const labels = { bot: "Bot credential", app: "App credential", bearer: "Client bearer" };
export function CredentialControls({ agent, card, restart, notice, setNotice }: { readonly agent: AgentSummary; readonly card: CardId; readonly restart: CapabilityRestartState; readonly notice: CredentialNotice | null; readonly setNotice: (value: CredentialNotice | null) => void }) {
  const [report, setReport] = useState<{ identity: string; snapshot: WebCredentialSnapshot } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const manualRefresh = useRef(false);
  const noticeRef = useRef(notice); noticeRef.current = notice;
  const publishRef = useRef(setNotice); publishRef.current = setNotice;
  const identity = `${agent.sourceId}:${agent.generation}`;
  const snapshot = report?.identity === identity ? report.snapshot : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; form.current?.reset(); }; }, []);
  useEffect(() => {
    form.current?.reset(); setLoading(true); setReadError(false);
    const reconcile = manualRefresh.current; manualRefresh.current = false;
    const controller = new AbortController();
    void api.credentials(agent.sourceId, controller.signal).then((result) => { if (!controller.signal.aborted) {
      setReport({ identity, snapshot: result });
      const fresh = result.cards.find((item) => item.id === card);
      if (noticeRef.current?.outcome === "unknown" && reconcile && fresh) publishRef.current({ outcome: "unknown", reconciliation: fresh.fields.map((field) => `${labels[field.id]}: ${field.state === "set" ? "set" : "not set"}`).join(" · ") });
      else if (fresh?.configReady && !fresh.configPending && noticeRef.current?.outcome === "saved-config-pending") publishRef.current({ outcome: "saved" });
    } }).catch(() => { if (!controller.signal.aborted) setReadError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); form.current?.reset(); };
  }, [identity, agent.sourceId, card, revision]);
  const status = snapshot?.cards.find((item) => item.id === card);
  const dispatch = async (retry: boolean) => {
    if (inFlight.current || notice?.inFlight || loading || snapshot === null) return;
    const base = { card, process: snapshot.process, fence: snapshot.fence, confirmed: true as const };
    const fields: WebCredentialSaveRequest["fields"] = {};
    if (!retry && form.current) {
      const data = new FormData(form.current);
      for (const key of ["bot", "app", "bearer", "allowedIds"] as const) { const value = data.get(key); if (typeof value === "string" && value.trim()) fields[key] = value; }
    }
    form.current?.reset(); // Clear DOM before dispatch. Values never enter React/application state or storage.
    if (Object.values(fields).some((value) => new TextEncoder().encode(value).length > 4096)) { setNotice({ outcome: "too-long" }); return; }
    inFlight.current = true; setBusy(true);
    // Hoisted before dispatch: a generation-driven card unmount cannot erase ambiguity.
    setNotice({ outcome: "unknown", inFlight: true });
    try {
      const result = await (retry ? api.retryCredentialConfig(agent.sourceId, base) : api.saveCredentials(agent.sourceId, { ...base, fields }));
      setNotice({ outcome: result.outcome });
    } catch (error) {
      setNotice({ outcome: error instanceof ApiError && ["credential_conflict", "credential_invalid", "credential_unavailable", "agent_not_found"].includes(error.code ?? "") ? "refused" : "unknown" });
    } finally {
      inFlight.current = false; form.current?.reset();
      if (mounted.current) { setBusy(false); setRevision((value) => value + 1); }
    }
  };
  const pending = notice?.outcome === "saved-config-pending" || status?.configPending;
  const disabled = busy || notice?.inFlight === true || loading;
  return <div className="capability-action" aria-live="polite">
    <h4>Write-only credentials</h4>
    <p>Saved only to the agent’s owner-only dotenv. Values are never shown again. Saving does not activate settings.</p>
    {status ? <>
      <p>{status.fields.map((field) => `${labels[field.id]}: ${field.state === "set" ? "set" : "not set"}`).join(" · ")}</p>
      {status.environmentOverrides && <p>Environment overrides some settings. Save stores credentials; overridden settings are not changed. Resolve overrides in the owner terminal to change them.</p>}
      {status.configReady && <p>Configuration prerequisites are satisfied. Check readiness after the next start.</p>}
      {!status.available && <p>{status.reason === "no-reloadable-source" ? "Unavailable: this host has no reloadable dotenv source." : status.reason === "env-shadowed" ? "Unavailable: shell/environment credentials shadow this action. Resolve them in the owner terminal." : "Unavailable: resolve configuration prerequisites in the owner terminal."}</p>}
      {status.available && !pending && <form className="credential-form" ref={form} autoComplete="off" onSubmit={(event) => { event.preventDefault(); void dispatch(false); }} aria-label={`Save ${card} credentials`}>
        {status.fields.map((field) => <label className="capability-choice" key={field.id}>{labels[field.id]}<input name={field.id} type="password" autoComplete="new-password" maxLength={4096} spellCheck={false} aria-label={labels[field.id]} /></label>)}
        {card !== "openai-api" && <label className="capability-choice">Allowed {card === "telegram" ? "chat" : "channel"} IDs<input name="allowedIds" autoComplete="off" maxLength={4096} placeholder="Comma-separated; blank keeps existing allowlist" /></label>}
        <p>Confirm Save to replace entered credentials and save eligible channel settings. Blank credential fields keep existing values. Telegram and Slack require an allowlist or an existing explicit allow-all setting. Environment overrides are not changed. No vendor calls are made.</p>
        <button className="settings-button" disabled={disabled} type="submit">{busy || notice?.inFlight ? "Saving…" : "Confirm Save credentials"}</button>
      </form>}
    </> : !loading && readError ? <p>Credential status unavailable. No saved state is assumed.</p> : <p>Reading credential status…</p>}
    {loading && status && <p>Refreshing credential status…</p>}
    {readError && status && <p>Could not refresh credential status. Showing the previous status, not a fresh check.</p>}
    {pending && <p><strong>Saved; config pending.</strong> Credential values are already saved. <button type="button" className="settings-button" disabled={disabled || !status?.available} onClick={() => void dispatch(true)}>Retry configuration only</button></p>}
    {notice?.outcome === "saved" && <p><strong>Saved; applies on next start.</strong> {agent.restart?.supported === true && <button type="button" className="settings-button" disabled={restart?.readState !== "ready"} onClick={() => { restart?.restartAgain(); document.querySelector<HTMLElement>('[data-settings-target="agent"]')?.scrollIntoView({ block: "start" }); }}>Restart to apply…</button>}</p>}
    {notice?.outcome === "unknown" && !busy && (notice.reconciliation ? <p role="alert">Previous outcome was uncertain; status now shows {notice.reconciliation}. This confirms presence, not which value was saved. <button type="button" className="settings-button" onClick={() => setNotice(null)}>Dismiss uncertainty note</button></p> : <p role="alert"><strong>{CREDENTIAL_SAVE_UNCERTAIN}</strong> Refresh status and inspect the agent’s dotenv in the owner terminal before choosing whether to replace again.</p>)}
    {notice?.outcome === "refused" && <p role="alert">Save refused; refreshed status. Review prerequisites and enter values again only if needed.</p>}
    {notice?.outcome === "too-long" && <p role="alert">Value too long. Each field must be at most 4096 UTF-8 bytes. Enter shorter values; nothing was sent.</p>}
    <button type="button" className="settings-button" disabled={disabled} onClick={() => { form.current?.reset(); manualRefresh.current = true; setRevision((value) => value + 1); }}>Refresh credential status</button>
  </div>;
}
