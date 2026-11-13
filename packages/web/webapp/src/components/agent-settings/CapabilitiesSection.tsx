import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AgentSummary, WebCapabilitySetupSnapshot } from "../../types";

type Card = WebCapabilitySetupSnapshot["cards"][number];
const statusLabel = { ok: "Ready", waiting: "Waiting", disabled: "Disabled", error: "Needs attention" } as const;

export function CapabilityCard({ card }: { readonly card: Card }) {
  const [variant, setVariant] = useState(card.selectedVariant ?? card.variants?.[0]?.id);
  const choice = card.variants?.find((item) => item.id === variant) ?? card;
  return <article className="settings-group capability-card" aria-labelledby={`capability-${card.id}`}>
    <div className="capability-heading"><h3 id={`capability-${card.id}`}>{card.title}</h3><span className={`capability-status is-${card.status}`}>{statusLabel[card.status]}</span></div>
    <p>{card.purpose}</p>
    {card.variants && <label className="capability-choice">Inspect memory tier (read-only)
      <select value={variant} onChange={(event) => setVariant(event.target.value)}>
        {card.variants.map((item) => <option key={item.id} value={item.id}>{item.title}{card.selectedVariant === item.id ? " · configured" : " · not selected"}</option>)}
      </select>
    </label>}
    {card.variants && <p>{choice.purpose} <span className={`capability-status is-${choice.status}`}>{statusLabel[choice.status]}</span></p>}
    <h4>What you need</h4><ul>{choice.requirements.map((item) => <li key={item}>{item}</li>)}</ul>
    <h4>Usage / cost</h4><p>{choice.usage}</p>
    <details><summary>Validation evidence</summary><ul>{card.evidence.map((item) => <li key={item.id}><code>{item.id}</code>: {item.status}</li>)}</ul></details>
    <details><summary>How to enable / next steps</summary>
      {choice.ownedConfigPaths.length > 0 && <p>Config fields: <code>{choice.ownedConfigPaths.join(", ")}</code></p>}
      <ol className="capability-steps">{choice.steps.map((step, index) => <li key={index}><pre>{step}</pre></li>)}</ol>
    </details>
  </article>;
}

export function CapabilitiesSection({ agent }: { readonly agent: AgentSummary }) {
  const [snapshot, setSnapshot] = useState<WebCapabilitySetupSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setError(false);
    if (agent.status !== "offline" && agent.supportsCapabilitySetup === true) {
      void api.capabilitySetup(agent.sourceId, controller.signal).then((result) => {
        if (!controller.signal.aborted) setSnapshot(result);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    }
    return () => controller.abort();
  }, [agent.sourceId, agent.generation, agent.status, agent.supportsCapabilitySetup, revision]);
  if (agent.status === "offline") return <div className="settings-notice">This agent is offline. Capability status is unavailable; no readiness is assumed.</div>;
  if (agent.supportsCapabilitySetup !== true) return <div className="settings-notice">This agent version doesn't report capabilities. Update the agent to view readiness and manual setup steps.</div>;
  if (error) return <div className="settings-notice">Capability validation is unavailable. Run <code>mono-agent validate</code> in the agent folder. <button className="settings-button" type="button" onClick={() => setRevision((value) => value + 1)}>Retry capability status</button></div>;
  if (snapshot === null) return <p>Reading capability status…</p>;
  return <>
    <p className="settings-section-summary">Read-only validation of {snapshot.observation === "loaded-snapshot" ? "the loaded startup snapshot (not later durable edits)" : "durable configuration inputs (which may differ from the loaded runtime)"} using the agent process's environment. Durable edits may need restart; .env edits need a new process. Readiness is not proof of message delivery.</p>
    <p className="settings-section-summary">Observed <time dateTime={snapshot.observedAt}>{new Date(snapshot.observedAt).toLocaleTimeString()}</time>. <button type="button" className="settings-button" onClick={() => setRevision((value) => value + 1)}>Refresh capability status</button></p>
    {snapshot.cards.map((card) => <CapabilityCard key={card.id} card={card} />)}
    {snapshot.hostPreflight && <details><summary>Host preflight (optional)</summary><ul>{snapshot.hostPreflight.checks.map((check) => <li key={check.id}>{check.id}: {check.status}</li>)}</ul></details>}
  </>;
}
