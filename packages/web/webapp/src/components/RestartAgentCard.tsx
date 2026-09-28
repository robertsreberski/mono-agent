import { shortReason, useAgentRestart } from "./use-agent-restart";
import type { RestartOperation, RestartProposalPart } from "../types";

export interface RestartAgentCardProps {
  readonly sourceId: string;
  readonly agentLabel: string;
  readonly reason?: string;
  /** A persisted proposal; absent for the selected agent's settings dialog. */
  readonly proposal?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly partId: string;
    readonly restartable: NonNullable<RestartProposalPart["restartable"]>;
  };
  /** From activeThreads.runningCounts, before POST; advisory, never a gate. */
  readonly approximateRunningCount?: number;
  /** Settings can restore this from GET /api/v1/agents/:id/restart. */
  readonly initialOperation?: RestartOperation | null;
  /** Settings only: retained outcomes may be followed by a fresh confirmed request. */
  readonly allowRestartAgain?: boolean;
  readonly unavailableReason?: string;
}

const STAGES: readonly { readonly key: RestartOperation["stage"]; readonly label: string }[] = [
  { key: "requesting", label: "Requesting" },
  { key: "restarting", label: "Restarting" },
  { key: "back_online", label: "Back online" },
];

export function RestartAgentCard({
  sourceId, agentLabel, reason, proposal, approximateRunningCount = 0, initialOperation,
  allowRestartAgain = false, unavailableReason,
}: RestartAgentCardProps) {
  const { confirming, setConfirming, requesting, requestUnknown, pollWarning, operationId, disabled, submit, outcome, outcomeReason, progressStage, restartAgain } = useAgentRestart({ sourceId, proposal, initialOperation, unavailableReason });
  return (
    <section className={`restart-agent-card${outcome === undefined ? "" : ` is-${outcome}`}`} aria-label="Agent restart" aria-live="polite">
      {outcome === undefined && !requesting && operationId === undefined && (
        <p className="restart-agent-copy">{shortReason(reason) ?? "Restart this agent when ready."}</p>
      )}
      {confirming && outcome === undefined && operationId === undefined ? (
        <div className="restart-agent-confirm">
          <p>Restarting may interrupt active conversations, jobs and monitors.</p>
          {approximateRunningCount > 0 && (
            <p>About {approximateRunningCount} running conversation{approximateRunningCount === 1 ? "" : "s"} will be interrupted (approximate).</p>
          )}
          <div className="restart-agent-actions">
            <button type="button" onClick={() => { void submit(); }} disabled={requesting}>Confirm restart</button>
            <button type="button" onClick={() => setConfirming(false)} disabled={requesting}>Cancel</button>
          </div>
        </div>
      ) : outcome === undefined && operationId === undefined && !requesting ? (
        <div className="restart-agent-actions">
          <button type="button" disabled={disabled !== undefined} onClick={() => setConfirming(true)}>
            Restart {agentLabel}
          </button>
          {disabled !== undefined && <span className="restart-agent-disabled">{disabled}</span>}
        </div>
      ) : null}
      {(requesting || operationId !== undefined) && outcome === undefined && (
        <ol className="restart-agent-stages" aria-label="Restart progress">
          {STAGES.map(({ key, label }) => (
            <li key={key} className={progressStage === key ? "is-current" : ""}
              {...(progressStage === key ? { "aria-current": "step" as const } : {})}>{label}</li>
          ))}
        </ol>
      )}
      {outcome === "success" && <p className="restart-agent-outcome">Restarted — agent is back online.</p>}
      {outcome === "failure" && <p className="restart-agent-outcome">Restart failed{outcomeReason === undefined ? "." : `: ${outcomeReason}`}</p>}
      {outcome === "not_confirmed" && <p className="restart-agent-outcome">Restart not confirmed — check the agent{outcomeReason === undefined ? "." : `. ${outcomeReason}`}</p>}
      {outcome !== undefined && allowRestartAgain && (
        <div className="restart-agent-actions">
          <button type="button" disabled={disabled !== undefined} onClick={restartAgain}>Restart {agentLabel} again</button>
          {disabled !== undefined && <span className="restart-agent-disabled">{disabled}</span>}
        </div>
      )}
      {requestUnknown !== null && outcome === undefined && <p className="restart-agent-disabled" role="status">{requestUnknown}</p>}
      {pollWarning !== null && outcome === undefined && <p className="restart-agent-disabled">{pollWarning}</p>}
    </section>
  );
}
