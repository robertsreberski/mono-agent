import type { ReactNode } from "react";
import type { AgentSummary } from "../../types";
import { useAgentRestart } from "../use-agent-restart";
import { useLatestRestart } from "./use-latest-restart";

export function RestartOwner({ agent, children }: { readonly agent: AgentSummary; readonly children: (state: ReturnType<typeof useRestartOwner>) => ReactNode }) {
  const state = useRestartOwner(agent);
  return <>{children(state)}</>;
}

export function useRestartOwner(agent: AgentSummary) {
  const latest = useLatestRestart(agent.sourceId);
  const unavailableReason = agent.status === "offline" ? `${agent.label} is offline.` : agent.restart?.supported === true ? undefined : agent.restart?.reason ?? "This agent cannot restart from the console.";
  const restart = useAgentRestart({ sourceId: agent.sourceId, initialOperation: latest.initialOperation, unavailableReason });
  return { ...latest, ...restart, unavailableReason, restartedThisVisit: restart.currentOperation !== null && restart.currentOperation.id !== latest.initialOperation?.id };
}
