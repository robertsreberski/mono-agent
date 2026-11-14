import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { AgentSummary, WebCredentialSnapshot, WebCredentialSaveRequest } from "../../types";
import type { CapabilityRestartState } from "./CapabilityActionControls";

type CardId = WebCredentialSaveRequest["card"];
const labels = { bot: "Bot credential", app: "App credential", bearer: "Client bearer" };
export function CredentialControls({ agent, card, restart }: { readonly agent: AgentSummary; readonly card: CardId; readonly restart: CapabilityRestartState }) {
  const [snapshot, setSnapshot] = useState<WebCredentialSnapshot | null>(null);
  const [notice, setNotice] = useState<"saved" | "saved-config-pending" | "unknown" | "refused" | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const identity = `${agent.sourceId}:${agent.generation}`;
  const current = useRef(identity); current.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; form.current?.reset(); }; }, []);
  useEffect(() => {
    form.current?.reset(); setSnapshot(null);
    const controller = new AbortController();
    void api.credentials(agent.sourceId, controller.signal).then((result) => { if (!controller.signal.aborted) {
      setSnapshot(result);
      const fresh = result.cards.find((item) => item.id === card);
      if (fresh?.configReady && !fresh.configPending) setNotice((prior) => prior === "saved-config-pending" ? "saved" : prior);
    } }).catch(() => { /* No readiness is inferred. */ });
    return () => { controller.abort(); form.current?.reset(); };
  }, [identity, agent.sourceId, card, revision]);
  const status = snapshot?.cards.find((item) => item.id === card);
  const dispatch = async (retry: boolean) => {
    if (busy || snapshot === null) return;
    const owner = identity;
    const base = { card, process: snapshot.process, fence: snapshot.fence, confirmed: true as const };
    const fields: WebCredentialSaveRequest["fields"] = {};
    if (!retry && form.current) {
      const data = new FormData(form.current);
      for (const key of ["bot", "app", "bearer", "allowedIds"] as const) { const value = data.get(key); if (typeof value === "string" && value.trim()) fields[key] = value; }
    }
    form.current?.reset(); // Clear DOM before dispatch. Values never enter React/application state or storage.
    setBusy(true); setNotice(null);
    try {
      const result = await (retry ? api.retryCredentialConfig(agent.sourceId, base) : api.saveCredentials(agent.sourceId, { ...base, fields }));
      if (mounted.current) setNotice(current.current === owner ? result.outcome : "unknown");
    } catch (error) {
      if (mounted.current) setNotice(error instanceof ApiError && ["credential_conflict", "credential_invalid", "credential_unavailable"].includes(error.code ?? "") ? "refused" : "unknown");
    } finally {
      form.current?.reset();
      if (mounted.current) { setBusy(false); setRevision((value) => value + 1); }
    }
  };
  const pending = notice === "saved-config-pending" || status?.configPending;
  return <div className="capability-action" aria-live="polite">
    <h4>Write-only credentials</h4>
    <p>Saved only to the agent’s owner-only dotenv. Values are never shown again. Saving does not activate settings.</p>
    {status ? <>
      <p>{status.fields.map((field) => `${labels[field.id]}: ${field.state === "set" ? "set" : "not set"}`).join(" · ")}</p>
      {status.configReady && <p>Configuration prerequisites are saved. Check readiness after the next start.</p>}
      {!status.available && <p>{status.reason === "no-reloadable-source" ? "Unavailable: this host has no reloadable dotenv source." : status.reason === "env-shadowed" ? "Unavailable: shell/environment settings shadow this action. Resolve them in the owner terminal." : "Unavailable: resolve configuration prerequisites in the owner terminal."}</p>}
      {status.available && !pending && <form className="credential-form" ref={form} autoComplete="off" onSubmit={(event) => { event.preventDefault(); void dispatch(false); }} aria-label={`Save ${card} credentials`}>
        {status.fields.map((field) => <label className="capability-choice" key={field.id}>{labels[field.id]}<input name={field.id} type="password" autoComplete="new-password" maxLength={4096} spellCheck={false} aria-label={labels[field.id]} /></label>)}
        {card !== "openai-api" && <label className="capability-choice">Allowed {card === "telegram" ? "chat" : "channel"} IDs<input name="allowedIds" autoComplete="off" maxLength={4096} placeholder="Comma-separated; blank keeps existing allowlist" /></label>}
        <p>Confirm Save to replace the entered credentials and enable this channel. Blank credential fields keep existing values. Explicit allowlists are required for Telegram and Slack. No vendor calls are made.</p>
        <button className="settings-button" disabled={busy} type="submit">{busy ? "Saving…" : "Confirm Save credentials"}</button>
      </form>}
    </> : <p>Credential status unavailable. No saved state is assumed.</p>}
    {pending && <p><strong>Saved; config pending.</strong> Credential values are already saved. <button type="button" className="settings-button" disabled={busy || !status?.available} onClick={() => void dispatch(true)}>Retry configuration only</button></p>}
    {notice === "saved" && <p><strong>Saved; applies on next start.</strong> {agent.restart?.supported === true && <button type="button" className="settings-button" disabled={restart?.readState !== "ready"} onClick={() => { restart?.restartAgain(); document.querySelector<HTMLElement>('[data-settings-target="agent"]')?.scrollIntoView({ block: "start" }); }}>Restart to apply…</button>}</p>}
    {notice === "unknown" && <p role="alert"><strong>Save outcome uncertain.</strong> Do not automatically resend credentials. Refresh status and inspect the agent’s dotenv in the owner terminal before choosing whether to replace again.</p>}
    {notice === "refused" && <p role="alert">Save refused; refreshed status. Review prerequisites and enter values again only if needed.</p>}
    <button type="button" className="settings-button" disabled={busy} onClick={() => { form.current?.reset(); setRevision((value) => value + 1); }}>Refresh credential status</button>
  </div>;
}
