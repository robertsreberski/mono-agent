import { useEffect, useState } from "react";
import { effortLevelsForAgentModel, useConsoleStore } from "../console-store";
import { DeviceNotificationControl } from "../notifications";
import { BottomSheet } from "./sheets/BottomSheet";

export function AgentDefaultsPanel({ sourceId }: { readonly sourceId: string }) {
  const store = useConsoleStore();
  const agent = store.agents.find((candidate) => candidate.sourceId === sourceId);
  const [model, setModel] = useState(agent?.runDefaults?.model ?? "");
  const [effort, setEffort] = useState(agent?.runDefaults?.effort ?? "");
  useEffect(() => {
    setModel(agent?.runDefaults?.model ?? "");
    setEffort(agent?.runDefaults?.effort ?? "");
  }, [agent?.runDefaults?.effort, agent?.runDefaults?.model, sourceId]);
  if (agent === undefined) return <p>Agent unavailable.</p>;
  const effectiveModel = model || agent.defaultModel || agent.models?.[0] || "";
  const efforts = effortLevelsForAgentModel(agent, effectiveModel);
  const disabled = agent.status === "offline";
  const save = (nextModel: string, nextEffort: string) => void store.setAgentRunDefaults(
    sourceId,
    nextModel.length === 0 && nextEffort.length === 0
      ? null
      : { ...(nextModel.length === 0 ? {} : { model: nextModel }), ...(nextEffort.length === 0 ? {} : { effort: nextEffort }) },
  ).catch(() => undefined);
  return (
    <div className="agent-defaults-panel">
      <p>New conversations with <strong>{agent.label}</strong> start with these console defaults.</p>
      <label>Default model<select disabled={disabled} value={model} onChange={(event) => { const next = event.target.value; setModel(next); const nextEffort = effortLevelsForAgentModel(agent, next || agent.defaultModel || agent.models?.[0] || "").includes(effort) ? effort : ""; setEffort(nextEffort); save(next, nextEffort); }}><option value="">Agent default{agent.defaultModel ? ` · ${agent.defaultModel}` : ""}</option>{agent.models?.map((reference) => <option key={reference} value={reference}>{agent.modelOptions?.[reference]?.label ?? reference}</option>)}</select></label>
      <fieldset disabled={disabled}><legend>Default effort</legend><div className="effort-segments"><button type="button" className={effort === "" ? "is-active" : ""} onClick={() => { setEffort(""); save(model, ""); }}>Default · {agent.defaultEffort === undefined ? "Provider" : agent.defaultEffort === "xhigh" ? "Extra high" : agent.defaultEffort}</button>{efforts.map((value) => <button key={value} type="button" className={effort === value ? "is-active" : ""} onClick={() => { setEffort(value); save(model, value); }}>{value === "xhigh" ? "Extra high" : value}</button>)}</div></fieldset>
      {disabled && <small>Bring this agent online to set defaults. Clearing remains available.</small>}
      {(model || effort) && <button type="button" className="text-button" onClick={() => { setModel(""); setEffort(""); void store.setAgentRunDefaults(sourceId, null); }}>Reset to agent config</button>}
    </div>
  );
}

export function AgentDefaultsSheet({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const store = useConsoleStore();
  const [sourceId, setSourceId] = useState(store.selectedAgentId ?? store.agents[0]?.sourceId ?? "");
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Settings & agent defaults">
      <div className="sheet-agent-chips">{store.agents.map((agent) => <button key={agent.sourceId} type="button" className={sourceId === agent.sourceId ? "is-active" : ""} onClick={() => setSourceId(agent.sourceId)}>{agent.label}</button>)}</div>
      {sourceId && <AgentDefaultsPanel sourceId={sourceId} />}
      <div className="device-settings"><h3>This device</h3><DeviceNotificationControl compact={false} /></div>
    </BottomSheet>
  );
}
