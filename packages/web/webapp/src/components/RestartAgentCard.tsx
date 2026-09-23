import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
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
}

const STAGES: readonly { readonly key: RestartOperation["stage"]; readonly label: string }[] = [
  { key: "requesting", label: "Requesting" },
  { key: "restarting", label: "Restarting" },
  { key: "back_online", label: "Back online" },
];

function shortReason(reason: unknown): string | undefined {
  return typeof reason === "string" && reason.length > 0 ? reason.slice(0, 280) : undefined;
}

export function RestartAgentCard({
  sourceId, agentLabel, reason, proposal, approximateRunningCount = 0, initialOperation,
}: RestartAgentCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [operation, setOperation] = useState<RestartOperation | null>(initialOperation ?? null);
  const [requesting, setRequesting] = useState(false);
  const [requestFailure, setRequestFailure] = useState<{ readonly outcome: "failure" | "not_confirmed"; readonly reason: string } | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const submitting = useRef(false);
  const linkedId = proposal?.restartable.state === "used"
    && typeof proposal.restartable.operationId === "string" && proposal.restartable.operationId.length > 0
    ? proposal.restartable.operationId : undefined;
  const operationId = linkedId ?? operation?.id;
  const currentOperation = operation?.id === operationId ? operation : null;
  const terminal = currentOperation?.outcome !== undefined || requestFailure !== null;
  const availability = proposal?.restartable;
  const disabled = availability?.state === "used" && linkedId === undefined
    ? "Restart status is unavailable."
    : availability !== undefined && availability.state !== "available" && availability.state !== "used"
      ? availability.reason ?? "Restart is unavailable."
      : sourceId.length === 0 ? "Agent is unavailable." : undefined;

  useEffect(() => {
    setOperation(initialOperation ?? null);
  }, [initialOperation]);

  useEffect(() => {
    if (operationId === undefined || terminal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const result = await api.restartStatus(sourceId, operationId, controller.signal);
        if (controller.signal.aborted) return;
        setOperation(result);
        setPollWarning(null);
        if (result.outcome !== undefined) return;
      } catch {
        if (controller.signal.aborted) return;
        // An unavailable read is not a verdict about the agent. Keep polling.
        setPollWarning("Restart status is temporarily unavailable.");
      }
      timer = setTimeout(() => { void refresh(); }, 2_000);
    };
    void refresh();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [sourceId, operationId, terminal]);

  const submit = async (): Promise<void> => {
    if (submitting.current || disabled !== undefined || operationId !== undefined) return;
    submitting.current = true;
    setRequesting(true);
    setConfirming(false);
    setRequestFailure(null);
    try {
      const result = proposal === undefined
        ? await api.requestAgentRestart(sourceId)
        : await api.restartFromProposal(proposal.threadId, proposal.messageId, proposal.partId);
      setOperation(result);
    } catch (error) {
      const definitive = error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status);
      setRequestFailure({ outcome: definitive ? "failure" : "not_confirmed",
        reason: shortReason(error instanceof Error ? error.message : undefined)
          ?? (definitive ? "The agent refused the request." : "The request may have reached the agent.") });
    } finally {
      submitting.current = false;
      setRequesting(false);
    }
  };

  const outcome = currentOperation?.outcome ?? requestFailure?.outcome;
  const outcomeReason = shortReason(currentOperation?.reason ?? requestFailure?.reason);
  const progressStage = currentOperation?.stage ?? "requesting";
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
      {pollWarning !== null && outcome === undefined && <p className="restart-agent-disabled">{pollWarning}</p>}
    </section>
  );
}
