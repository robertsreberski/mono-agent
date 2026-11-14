import { CredentialControls, CREDENTIAL_SAVE_UNCERTAIN, type CredentialNotice } from "./CredentialControls";
import type { ReactNode } from "react";
import { CapabilityActionControls, CAPABILITY_SAVE_UNCERTAIN, type CapabilityRestartState, type CapabilitySavedState } from "./CapabilityActionControls";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { AgentSummary, WebCapabilitySetupSnapshot, WebCapabilityActionsSnapshot, WebCredentialSaveRequest } from "../../types";

type Card = WebCapabilitySetupSnapshot["cards"][number];
const statusLabel = { ok: "Ready", waiting: "Waiting", disabled: "Disabled", error: "Needs attention" } as const;
const statusIcon = { ok: "✓", waiting: "◷", disabled: "−", error: "!" } as const;
function Status({ status }: { readonly status: Card["status"] }) {
  return <span className={`capability-status is-${status}`}><span aria-hidden="true">{statusIcon[status]}</span> {statusLabel[status]}</span>;
}
function nextStep(card: Card): string {
  if (card.id === "tracing" && card.status === "ok") return "Inspect local run evidence with mono-agent runs.";
  if (card.status === "error") return "Run mono-agent validate to diagnose configuration before restarting.";
  if (card.status === "waiting") return "Complete the prerequisites below, then run mono-agent validate.";
  if (card.status === "disabled") {
    const field = card.ownedConfigPaths[0];
    if (field !== undefined) {
      const hasEnv = card.steps.some((step) => /^[A-Z_][A-Z0-9_]*=/m.test(step));
      return `${hasEnv ? "Set the .env tokens and add" : "Add"} the ${field} block, then validate and restart.`;
    }
    return card.steps[0] ?? card.requirements[0] ?? "Run mono-agent validate.";
  }
  return "Configuration checks passed. Run mono-agent validate to check live readiness.";
}

interface InstructionStep {
  readonly prose: string;
  readonly blocks: { readonly kind: "json" | "env"; readonly text: string }[];
}

/** Older agents send strings: group examples for display without changing the wire. */
function instructionSteps(steps: readonly string[]): InstructionStep[] {
  const result: InstructionStep[] = [];
  const envLine = /^(?:export\s+)?[A-Z_][A-Z0-9_]*=/;
  const addBlock = (kind: "json" | "env", text: string) => {
    if (result.length === 0) result.push({ prose: "Review this example in the owner terminal.", blocks: [] });
    result[result.length - 1]!.blocks.push({ kind, text });
  };
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.trimStart().startsWith("{")) {
      try { JSON.parse(step); addBlock("json", step); continue; } catch { /* Not JSON: retain the prose. */ }
    }
    const lines: string[] = [];
    let cursor = index;
    while (cursor < steps.length && steps[cursor]!.split("\n").every((line) => line.trim() === "" || line.trimStart().startsWith("#") || envLine.test(line))) {
      lines.push(steps[cursor++]!);
    }
    if (lines.some((line) => line.split("\n").some((item) => envLine.test(item)))) {
      addBlock("env", lines.join("\n")); index = cursor - 1; continue;
    }
    result.push({ prose: step, blocks: [] });
  }
  return result;
}

export function CapabilityCard({ card, children, actionNext }: { readonly card: Card; readonly children?: ReactNode; readonly actionNext?: string | undefined }) {
  const [variant, setVariant] = useState(card.selectedVariant ?? card.variants?.[0]?.id);
  const choice = card.variants?.find((item) => item.id === variant) ?? card;
  return <article className="settings-group capability-card" aria-labelledby={`capability-${card.id}`}>
    <div className="capability-heading"><h3 id={`capability-${card.id}`}>{card.title}</h3><Status status={card.status} /></div>
    <p className="capability-purpose" title={card.purpose}>{card.purpose}</p>
    <p className="capability-next"><strong>Next:</strong> {actionNext ?? nextStep(card)}</p>
    {children}
    <details className="capability-details"><summary>Details &amp; manual setup</summary>
      {card.variants && <>
        <label className="capability-choice">Inspect memory tier (read-only)
          <select value={variant} onChange={(event) => setVariant(event.target.value)}>
            {card.variants.map((item) => <option key={item.id} value={item.id}>{item.title}{card.selectedVariant === item.id ? " · configured" : " · not selected"}</option>)}
          </select>
        </label>
        <p><Status status={choice.status} /></p>
      </>}
      <p>{choice.purpose}</p>
      <h4>What you need</h4><ul>{choice.requirements.map((item) => <li key={item}>{item}</li>)}</ul>
      <h4>Usage / cost</h4><p>{choice.usage}</p>
      <h4>Validation evidence</h4><ul>{card.evidence.map((item) => <li key={item.id}><code>{item.id}</code>: {item.status}</li>)}</ul>
      <h4>How to enable / next steps</h4>
      {choice.ownedConfigPaths.length > 0 && <p>Config fields: <code>{choice.ownedConfigPaths.join(", ")}</code></p>}
      <ol className="capability-steps">{instructionSteps(choice.steps).map((step, index) => <li key={index}>
        <p className="capability-step-prose">{step.prose}</p>
        {step.blocks.map((block, blockIndex) => <pre key={blockIndex} aria-label={block.kind === "json" ? "JSON configuration example" : ".env placeholders"}><code>{block.text}</code></pre>)}
      </li>)}</ol>
    </details>
  </article>;
}

const credentialCardsFor: Readonly<Record<string, readonly WebCredentialSaveRequest["card"][]>> = {
  "channel:telegram": ["telegram"], "channel:slack": ["slack"], "channel:openai-api": ["openai-api"],
  "channel:a2a": ["a2a"], memory: ["embeddings"], tools: ["parallel-search", "parallel-fetch", "ollama-search"],
};

export function CapabilitiesSection({ agent, restart = null }: { readonly agent: AgentSummary; readonly restart?: CapabilityRestartState }) {
  const identity = JSON.stringify([agent.sourceId, agent.generation]);
  const identityRef = useRef(identity);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const [report, setReport] = useState<{ identity: string; snapshot: WebCapabilitySetupSnapshot } | null>(null);
  const snapshot = report?.identity === identity ? report.snapshot : null;
  const [actions, setActions] = useState<{ identity: string; snapshot: WebCapabilityActionsSnapshot } | null>(null);
  const [actionsError, setActionsError] = useState(false);
  const [saved, setSaved] = useState<Record<string, CapabilitySavedState>>({});
  const [credentialNotices, setCredentialNotices] = useState<Record<string, { sourceId: string; identity: string; notice: CredentialNotice | null }>>({});
  const credentialWarning = Object.values(credentialNotices).some((value) => value.sourceId === agent.sourceId && value.notice?.outcome === "unknown") ? <p role="alert">{CREDENTIAL_SAVE_UNCERTAIN}</p> : null;
  const credentialNotice = (card: string) => {
    const stored = credentialNotices[JSON.stringify([agent.sourceId, card])];
    if (stored?.identity === identity) return stored.notice;
    // Preserve ambiguity, not a previous generation’s presence observation.
    return stored?.notice?.outcome === "unknown" ? { outcome: "unknown" as const, ...(stored.notice.inFlight ? { inFlight: true as const } : {}) } : null;
  };
  const retainCredentialNotice = (card: string, value: CredentialNotice | null) => setCredentialNotices((prior) => ({
    ...prior, [JSON.stringify([agent.sourceId, card])]: { sourceId: agent.sourceId, identity,
      notice: value && currentIdentity.current !== identity && !["refused", "too-long"].includes(value.outcome) ? { outcome: "unknown" } : value },
  }));
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (identityRef.current !== identity) { setReport(null); identityRef.current = identity; }
    setError(false);
    if (agent.status === "online" && agent.supportsCapabilitySetup === true) {
      void api.capabilitySetup(agent.sourceId, controller.signal).then((result) => {
        if (!controller.signal.aborted) setReport({ identity, snapshot: result });
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    }
    return () => controller.abort();
  }, [identity, agent.sourceId, agent.status, agent.supportsCapabilitySetup, revision]);
  useEffect(() => {
    const controller = new AbortController(); setActionsError(false); setActions(null);
    if (agent.status === "online" && agent.supportsCapabilityActions === true) {
      void api.capabilityActions(agent.sourceId, controller.signal).then((snapshot) => { if (!controller.signal.aborted) {
        setActions({ identity, snapshot });
        setSaved((prior) => Object.fromEntries(Object.entries(prior).filter(([id, value]) => value.uncertain || snapshot.actions.some((action) => action.id === id && (action.active || action.reason === "already-configured")))));
      } })
        .catch(() => { if (!controller.signal.aborted) setActionsError(true); });
    }
    return () => controller.abort();
  }, [identity, agent.sourceId, agent.status, agent.supportsCapabilityActions, revision]);
  const actionSnapshot = agent.supportsCapabilityActions === true && actions?.identity === identity ? actions.snapshot : null;
  if (agent.status === "offline") return <>{credentialWarning}<div className="settings-notice">This agent is offline. Capability status is unavailable; no readiness is assumed.</div></>;
  if (agent.status === "degraded") return <>{credentialWarning}<div className="settings-notice">This agent’s connection is degraded. Capability status cannot be confirmed; check the connection and try again. No readiness is assumed.</div></>;
  if (agent.supportsCapabilitySetup !== true) return <>{credentialWarning}<div className="settings-notice">This agent version doesn't report capabilities. Update the agent to view readiness and manual setup steps.</div></>;
  const errorNotice = <div className="settings-notice">Capability validation is unavailable. {snapshot !== null && "Showing the last report below, not a fresh check. "}Run <code>mono-agent validate</code> in the agent folder. <button className="settings-button" type="button" onClick={() => setRevision((value) => value + 1)}>Retry capability status</button></div>;
  if (snapshot === null) return <>{credentialWarning}{error ? errorNotice : <p>Reading capability status…</p>}</>;
  return <>
    {error && errorNotice}
    <p className="settings-section-summary">Explore optional features. Eligible Memory Lite and cron controls can be previewed and saved. Supported cards also offer write-only credential entry; other setup uses manual instructions.</p>
    <p className="settings-notice capability-scope">Provider, embedding, browser and server liveness is not probed here. Ready means local configuration checks passed, not live readiness or message delivery. Run <code>mono-agent validate</code> in the owner terminal for live checks.</p>
    <p className="settings-section-summary">Checked <time dateTime={snapshot.observedAt}>{new Date(snapshot.observedAt).toLocaleTimeString()}</time>. {snapshot.observation === "loaded-snapshot" ? "Uses settings from the agent’s last start, not later edits." : "Uses saved settings."} Restart the agent after editing settings or .env. <button type="button" className="settings-button" onClick={() => setRevision((value) => value + 1)}>Refresh capability status</button></p>
    {agent.supportsCapabilityActions !== true && <p className="settings-notice">This agent version has no console Enable actions. Use manual setup or update the agent.</p>}
    {actionsError && <p className="settings-notice">Enable availability could not be verified. Refresh capability status; no write is assumed.</p>}
    {!actionSnapshot && Object.values(saved).some((value) => value.uncertain) && <p role="alert">{CAPABILITY_SAVE_UNCERTAIN}</p>}
    <div className="capability-grid">{snapshot.cards.map((card) => {
      const action = actionSnapshot?.actions.find((item) => item.id === (card.id === "memory" ? "memory-lite" : card.id === "channel:cron" ? "cron-controls" : ""));
      const actionNext = action?.active ? "Inspect readiness evidence below."
        : action?.reason === "already-configured" || (action?.available && saved[action.id] && !saved[action.id]?.uncertain) ? "Check saved settings and activation below; saving does not restart the agent."
        : action?.available ? "Review and Save below, or use manual setup. Saving does not activate the feature." : undefined;
      const credentialCards = credentialCardsFor[card.id] ?? [];
      return <CapabilityCard key={`${agent.sourceId}:${card.id}`} card={card} actionNext={actionNext}>{action && actionSnapshot && <CapabilityActionControls agent={agent} action={action} process={actionSnapshot.process} restart={restart} refresh={() => setRevision((value) => value + 1)} saved={saved[action.id] ?? null} isCurrent={() => currentIdentity.current === identity} setSaved={(value) => setSaved((prior) => ({ ...prior, [action.id]: currentIdentity.current === identity ? value : { ...value, uncertain: true } }))} />}{agent.supportsCredentialSetup === true && credentialCards.map((credentialCard) => <CredentialControls key={credentialCard} agent={agent} card={credentialCard} restart={restart} notice={credentialNotice(credentialCard)} setNotice={(value) => retainCredentialNotice(credentialCard, value)} />)}</CapabilityCard>;
    })}</div>
    {snapshot.hostPreflight && <details><summary>Host preflight (optional)</summary><ul>{snapshot.hostPreflight.checks.map((check) => <li key={check.id}>{check.id}: {check.status}</li>)}</ul></details>}
  </>;
}
