import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { RestartOperation, RestartProposalPart } from "../types";

export interface AgentRestartOptions {
  readonly sourceId: string;
  readonly proposal?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly partId: string;
    readonly restartable: NonNullable<RestartProposalPart["restartable"]>;
  };
  readonly initialOperation?: RestartOperation | null;
  readonly unavailableReason?: string;
}

export function shortReason(reason: unknown): string | undefined {
  return typeof reason === "string" && reason.length > 0 ? reason.slice(0, 280) : undefined;
}

export function useAgentRestart({ sourceId, proposal, initialOperation, unavailableReason }: AgentRestartOptions) {
  const [confirming, setConfirming] = useState(false);
  const [operation, setOperation] = useState<RestartOperation | null>(initialOperation ?? null);
  const [requesting, setRequesting] = useState(false);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [requestUnknown, setRequestUnknown] = useState<string | null>(null);
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
      : unavailableReason ?? (sourceId.length === 0 ? "Agent is unavailable." : undefined);

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
    setRequestUnknown(null);
    // Settings recovery baseline: the latest operation id BEFORE this click.
    // Comparing browser time with the server's requestedAt is unsafe (the
    // console may be opened from another machine with a skewed clock), so a
    // lost POST only adopts an operation whose id differs from this baseline.
    // `undefined` means the baseline is unknown, and nothing is adopted.
    let baselineId: string | null | undefined;
    if (proposal === undefined) {
      try {
        baselineId = (await api.latestAgentRestart(sourceId))?.id ?? null;
      } catch {
        baselineId = undefined;
      }
    }
    try {
      const result = proposal === undefined
        ? await api.requestAgentRestart(sourceId)
        : await api.restartFromProposal(proposal.threadId, proposal.messageId, proposal.partId);
      setOperation(result);
    } catch (error) {
      const definitive = error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status);
      if (definitive) {
        setRequestFailure(shortReason(error instanceof Error ? error.message : undefined) ?? "The agent refused the request.");
      } else {
        // A lost browser response does not establish an outcome. Recover the
        // server's durable operation, but never attach an unrelated old card
        // or settings operation merely because it belongs to the same agent.
        try {
          const latest = await api.latestAgentRestart(sourceId);
          if (latest !== null && (proposal === undefined
            ? baselineId !== undefined && latest.id !== baselineId
            : (await api.message(proposal.threadId, proposal.messageId)).parts.some((part) =>
                part.type === "restart_proposal" && part.id === proposal.partId
                && part.restartable?.state === "used" && part.restartable.operationId === latest.id))) {
            setOperation(latest);
          } else {
            setRequestUnknown("Couldn't confirm the request was received — check the agent. You can retry.");
          }
        } catch {
          setRequestUnknown("Couldn't confirm the request was received — check the agent. You can retry.");
        }
      }
    } finally {
      submitting.current = false;
      setRequesting(false);
    }
  };
  const outcome = currentOperation?.outcome ?? (requestFailure === null ? undefined : "failure");
  const outcomeReason = shortReason(currentOperation?.reason ?? requestFailure);
  const progressStage = currentOperation?.stage ?? "requesting";
  const restartAgain = () => {
    setOperation(null);
    setRequestFailure(null);
    setRequestUnknown(null);
    setPollWarning(null);
    setConfirming(true);
  };
  return { confirming, setConfirming, requesting, requestUnknown, pollWarning, operationId, disabled, submit, outcome, outcomeReason, progressStage, restartAgain };
}
