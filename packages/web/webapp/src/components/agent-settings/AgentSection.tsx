import { useEffect, useState } from "react";
import { Switch } from "@base-ui/react/switch";
import type { AgentSummary } from "../../types";
import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";
import { relativeTime } from "../time";
import type { useRestartOwner } from "./RestartOwner";

// Independent of the restart owner: pin is usable while restart status loads.
export function AgentPinRow({ agent }: { readonly agent: AgentSummary }) {
  const store = useConsoleStore();
  const [requestedPin, setRequestedPin] = useState<boolean | null>(null);
  const [pinPending, setPinPending] = useState(false);
  useEffect(() => { if (!pinPending) setRequestedPin(null); }, [agent.pinned, pinPending]);
  const togglePin = () => {
    if (pinPending) return;
    const next = !Boolean(agent.pinned);
    setRequestedPin(next); setPinPending(true);
    void Promise.resolve().then(() => store.setAgentPinned(agent.sourceId, next)).catch(() => undefined).finally(() => { setPinPending(false); setRequestedPin(null); });
  };
  return <div className="settings-group settings-pin"><label className="settings-row settings-switch-row">
    <Icon name="star" size={18} />
    <span className="settings-row-copy"><span id="settings-pin-label" className="settings-row-title">Pin {agent.label} first</span><span className="settings-row-note">Pinned agents sort first on the agent strip.</span></span>
    <Switch.Root className="settings-switch" aria-labelledby="settings-pin-label" checked={requestedPin ?? Boolean(agent.pinned)} disabled={pinPending} aria-busy={pinPending} onCheckedChange={togglePin}><Switch.Thumb className="settings-switch-thumb" /></Switch.Root>
  </label></div>;
}

export function AgentSection({ agent, runningCount, restart }: { readonly agent: AgentSummary; readonly runningCount: number | undefined; readonly restart: ReturnType<typeof useRestartOwner> }) {
  const inProgress = restart.operationId !== undefined && restart.outcome === undefined;
  // An in-flight operation is not a past outcome, even when it was restored
  // from the latest-operation endpoint after reopening the screen.
  const lastOperation = inProgress ? restart.initialOperation : restart.currentOperation ?? restart.initialOperation;
  const last = lastOperation?.outcome ? lastOperation : null;
  const lastAge = last ? relativeTime(last.requestedAt) : null;
  const lastWhen = lastAge === "now" ? "just now" : `${lastAge} ago`;
  const successfulNow = restart.restartedThisVisit && restart.outcome === "success";
  const stage = restart.progressStage;
  return <>
    <div className="settings-group">
      {restart.readState === "loading" && <div className="settings-row">Checking restart status…</div>}
      {restart.readState === "error" && <div className="settings-row"><span className="settings-row-copy"><b className="settings-row-title">Couldn't read restart status</b></span><button className="settings-button" type="button" onClick={restart.retry}>Retry</button></div>}
      {restart.readState === "ready" && <div className="settings-row">
        <span className="settings-row-copy"><b className="settings-row-title">{restart.confirming ? `Restart ${agent.label} now?` : inProgress ? `Restarting ${agent.label}` : successfulNow ? `${agent.label} is back online` : `Restart ${agent.label}`}</b>
          {restart.confirming ? <span className="settings-row-note">Restarting may interrupt active conversations, jobs and monitors.{runningCount !== undefined && runningCount > 0 && <> About {runningCount} running conversation{runningCount === 1 ? "" : "s"} will be interrupted (approximate).</>}</span> : successfulNow ? <span className="settings-row-note">Restarted just now.</span> : <span className="settings-row-note">Relaunches the agent process. Running conversations, jobs and monitors are interrupted.</span>}
          {inProgress && <ol className="settings-stepper" aria-label="Restart progress">{(["requesting", "restarting", "back_online"] as const).map((step) => <li key={step} aria-current={stage === step ? "step" : undefined} className={step === stage ? "" : "is-done"}><i />{step === "back_online" ? "Back online" : step === "requesting" ? "Requesting" : "Restarting"}</li>)}</ol>}
          {restart.requestUnknown && <span className="settings-row-note is-warning">{restart.requestUnknown}</span>}
          {restart.outcome === "not_confirmed" && <span className="settings-row-note is-warning">Restart not confirmed — check the agent{restart.outcomeReason ? `. ${restart.outcomeReason}` : "."}</span>}
          {restart.outcome === "failure" && restart.currentOperation === null && <span className="settings-row-note is-danger">Restart failed: {restart.outcomeReason ?? "The agent refused the request."}</span>}
          {restart.pollWarning && <span className="settings-row-note is-warning">{restart.pollWarning}</span>}
        </span>
        {!inProgress && <span className="settings-row-actions">{restart.confirming ? <><button type="button" className="settings-button" onClick={() => restart.setConfirming(false)}>Cancel</button><button type="button" className="settings-button is-danger" disabled={restart.requesting} onClick={() => void restart.submit()}>Confirm restart</button></> : <button className="settings-button" type="button" aria-label={`Restart ${agent.label}`} disabled={restart.disabled !== undefined} onClick={() => { restart.restartAgain(); }}>{"Restart…"}</button>}</span>}
        {restart.disabled && <span className="settings-row-note is-warning">{restart.disabled}</span>}
      </div>}
      <div className="settings-row settings-agent-fact-row"><span className="settings-row-copy"><b className="settings-row-title">Running now</b></span><span className="settings-row-value">{runningCount === undefined ? "—" : runningCount === 0 ? "None" : `${runningCount} conversation${runningCount === 1 ? "" : "s"}`}</span></div>
      {restart.readState === "ready" && !successfulNow && (!inProgress || last !== null) && <div className="settings-row settings-agent-fact-row"><span className="settings-row-copy"><b className="settings-row-title">Last restart</b></span><span className="settings-row-value" title={last?.requestedAt}>{last ? `${last.outcome === "failure" ? "Failed" : last.outcome === "success" ? "Back online" : "Not confirmed"} · ${lastWhen}${last.outcome === "failure" && last.reason ? ` · ${last.reason}` : ""}` : "No recent restart"}</span></div>}
    </div>
  </>;
}

export function AgentAbout({ agent }: { readonly agent: AgentSummary }) {
  const capabilities = [
    [agent.supportsAttachments, "Attachments"], [agent.supportsManualCompaction, "Manual compaction"],
    [agent.cron?.read, "Automations"], [agent.supportsProviderAuth, "Provider sign-in"],
    [agent.supportsProviderUsage, "Usage limits"], [agent.restart?.supported, "Console restart"],
  ] as const;
  return <>
    <div className="settings-group"><div className="settings-row settings-agent-fact-row"><span className="settings-row-copy"><b className="settings-row-title">Source</b></span><code className="settings-row-value">{agent.sourceId}</code></div><div className="settings-row"><span className="settings-row-copy"><b className="settings-row-title">Supports</b></span><span className="settings-chips">{capabilities.filter(([available]) => available === true).map(([, label]) => <span className="settings-chip" key={label}>{label}</span>)}</span></div></div>
  </>;
}
