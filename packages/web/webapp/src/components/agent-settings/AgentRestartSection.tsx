import type { AgentSummary } from "../../types";
import { RestartAgentCard } from "../RestartAgentCard";
import { useLatestRestart } from "./use-latest-restart";

export function AgentRestartSection({ agent, approximateRunningCount }: {
  readonly agent: AgentSummary;
  readonly approximateRunningCount: number;
}) {
  const { initialOperation, readState } = useLatestRestart(agent.sourceId);
  const unavailableReason = readState === "error"
    ? "Restart status is unavailable. Try reopening settings."
    : agent.status === "offline" ? "The agent is offline."
      : agent.restart?.supported === true ? undefined : agent.restart?.reason ?? "This agent cannot restart from the console.";
  return (
    <section className="agent-settings-restart" aria-label="Restart agent settings">
      <h3>Restart agent</h3>
      {readState === "loading"
        ? <p role="status">Checking restart status…</p>
        : <RestartAgentCard sourceId={agent.sourceId} agentLabel={agent.label}
            approximateRunningCount={approximateRunningCount}
            initialOperation={initialOperation} allowRestartAgain
            {...(unavailableReason === undefined ? {} : { unavailableReason })} />}
    </section>
  );
}
