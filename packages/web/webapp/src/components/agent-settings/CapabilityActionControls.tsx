import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { AgentSummary, WebCapabilityActionsSnapshot, WebCapabilityActionPreview } from "../../types";
import type { useRestartOwner } from "./RestartOwner";

export type CapabilitySavedState = { startedAt: string; restartId?: string | null; restartAttempted?: boolean; uncertain?: boolean; configuredOnly?: boolean };
export const CAPABILITY_SAVE_UNCERTAIN = "A save may have completed; inspect the configuration before retrying. No automatic rollback was attempted.";
type Action = WebCapabilityActionsSnapshot["actions"][number];
export type CapabilityRestartState = ReturnType<typeof useRestartOwner> | null;
const reasons = {
  "eligible": "Review the owned settings before saving.", "already-configured": "Already saved in configuration.",
  "memory-configured": "Memory is configured. Tier changes require manual preparation; no migration is offered.",
  "memory-root-unsafe": "The standard memory root is not empty or verified Lite. Inspect it in the owner terminal; no data will be changed.",
  "no-valid-jobs": "Prepare valid cron jobs first. Enable never creates or enables jobs or schedules.",
  "env-shadowed": "An environment setting conflicts with this action. Resolve it in the owner terminal.",
  "subagents-denied": "The tool policy denies Agent. Removing denies is out of scope; resolve it in the owner terminal.",
  "subagents-unconfigured": "Configure at least one subagent profile first. Enable never authors profiles.",
  "undo-unavailable": "No console save is available to undo.",
  "undo-stale": "The configuration changed since the last console save. Undo is unavailable; inspect it in the owner terminal.",
};
export function CapabilityActionControls({ agent, action, process, restart, refresh, saved, setSaved, isCurrent = () => true }: {
  readonly agent: AgentSummary; readonly action: Action; readonly process: WebCapabilityActionsSnapshot["process"];
  readonly isCurrent?: () => boolean;
  readonly restart: CapabilityRestartState; readonly refresh: () => void; readonly saved: CapabilitySavedState | null; readonly setSaved: (saved: CapabilitySavedState) => void;
}) {
  const [preview, setPreview] = useState<WebCapabilityActionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = `${agent.sourceId}:${agent.generation}:${process.startedAt}`;
  const current = useRef(identity); current.current = identity;
  useEffect(() => { setPreview(null); setBusy(false); setError(null); }, [identity]);
  const handleError = (error: unknown, phase: "preview" | "save") => {
    setPreview(null);
    const code = error instanceof ApiError ? error.code : undefined;
    if (code === "capability_action_unavailable" || code === "capability_actions_unsupported") {
      setError("This action is unavailable. Refresh availability or use manual setup guidance."); refresh();
    } else if (code === "agent_offline") {
      setError("The agent is offline. Reconnect or use setup guidance in the owner terminal."); refresh();
    } else if (phase === "preview") {
      setError("Could not read the preview; nothing was saved. Refresh capability status and try again.");
      if (code === "agent_generation_changed" || code === "capability_action_conflict") refresh();
    } else if (code === "capability_action_conflict") {
      setError("Settings changed. Refreshed availability; review a new preview before saving."); refresh();
    } else {
      // Keep uncertainty above the process-bound controls so a new generation cannot erase it.
      setSaved({ startedAt: process.startedAt, uncertain: true }); setError(null); refresh();
    }
  };
  const readPreview = async () => {
    if (busy) return; const owner = identity; setBusy(true); setError(null);
    try { const result = await api.previewCapabilityAction(agent.sourceId, { action: action.id, process }); if (current.current === owner && isCurrent()) setPreview(result); }
    catch (error) { if (current.current === owner && isCurrent()) handleError(error, "preview"); }
    finally { if (current.current === owner && isCurrent()) setBusy(false); }
  };
  const save = async () => {
    if (busy || preview === null) return; const owner = identity; setBusy(true); setError(null);
    try {
      await api.saveCapabilityAction(agent.sourceId, { action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true });
      if (current.current !== owner || !isCurrent()) { setSaved({ startedAt: process.startedAt, uncertain: true }); refresh(); return; }
      setSaved({ startedAt: process.startedAt, ...(restart?.readState === "ready" ? { restartId: restart.operationId ?? null } : {}) }); setPreview(null); refresh();
    } catch (error) {
      if (current.current === owner && isCurrent()) handleError(error, "save");
      else { setSaved({ startedAt: process.startedAt, uncertain: true }); refresh(); }
    }
    finally { if (current.current === owner && isCurrent()) setBusy(false); }
  };
  const active = action.active && (saved === null || process.startedAt !== saved.startedAt);
  const confirmedSave = saved !== null && saved.uncertain !== true && saved.configuredOnly !== true;
  const unavailable = !action.available && action.reason !== "already-configured";
  const enableLabel = action.id === "memory-lite" ? "Enable Memory Lite…" : action.id === "cron-controls" ? "Enable cron controls…" : action.id === "subagents-enable" ? "Enable subagents…" : "Undo last console save…";
  const freshStart = saved !== null && process.startedAt !== saved.startedAt;
  const newRestart = saved !== null && saved.restartId !== undefined && restart?.operationId !== undefined && restart.operationId !== saved.restartId;
  const restarting = (saved?.restartAttempted === true && restart?.requesting === true) || (newRestart && restart?.outcome === undefined);
  return <div className="capability-action" aria-live="polite">
    {active ? <p><strong>Active</strong> · Loaded at this start. Check readiness evidence below.</p> : unavailable ? <p>{reasons[action.reason]}</p> : confirmedSave || action.reason === "already-configured" ? <>
      <p><strong>{!confirmedSave ? restarting ? "Configured; restarting…" : "Configured; not active at this start" : freshStart ? "Saved, but not active at this start — check evidence" : restarting ? "Saved; restarting…" : "Saved; applies on next start"}</strong></p>
      {(newRestart || saved?.restartAttempted) && (restart?.requestUnknown || (restart?.outcome && restart.outcome !== "success")) && <p>{restart?.requestUnknown ? "Restart not confirmed — check the agent before retrying. Saved settings remain; no automatic rollback." : "Restart failed or was not confirmed. Saved settings remain; no automatic rollback."}</p>}
      {agent.restart?.supported === true && !restarting && <button className="settings-button" type="button" disabled={restart?.readState !== "ready"} onClick={() => {
        setSaved({ ...saved, startedAt: saved?.startedAt ?? process.startedAt, restartId: restart?.operationId ?? null, restartAttempted: true, ...(!confirmedSave ? { configuredOnly: true } : {}) });
        restart?.restartAgain();
        const target = document.querySelector<HTMLElement>('[data-settings-target="agent"]'); target?.scrollIntoView({ block: "start" }); target?.focus({ preventScroll: true });
      }}>Restart to apply…</button>}
      {newRestart && restart?.outcome === "success" && <p>Back online. Refresh capability status to verify activation at the new start.</p>}
    </> : <>
      <p>{reasons[action.reason]}</p>
      {action.available && <button className="settings-button" type="button" disabled={busy} onClick={() => void readPreview()}>{busy ? "Checking…" : enableLabel}</button>}
    </>}
    {preview && <div role="group" aria-label="Confirm capability settings">
      <p><strong>{preview.noOp ? "Already configured; no write is needed." : "Review changes, then confirm Save."}</strong></p>
      {preview.changes.map((change) => <div key={change.field}><code>{change.field}</code><pre aria-label="Owned-field preview"><code>{change.value}</code></pre></div>)}
      <p>JSON formatting normalizes to two-space indentation. Unrelated settings are preserved. One private, ignored .bak keeps the prior bytes. Saving does not restart the agent or activate settings.</p>
      {preview.action === "cron-controls" && <p>Only operator controls are enabled. Jobs and schedules are unchanged.</p>}
      {preview.action === "subagents-enable" && <p>Only delegation is enabled. Profiles and deny rules are unchanged.</p>}
      {preview.action === "config-undo" && <p>Undo restores the exact prior bytes and consumes the one-level slot. Dotenv credentials and memory data are untouched; credential cards may still show set.</p>}
      <button type="button" className="settings-button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>{" "}
      <button type="button" className="settings-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Confirm Save"}</button>
    </div>}
    {saved?.uncertain && <p role="alert">{CAPABILITY_SAVE_UNCERTAIN}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
