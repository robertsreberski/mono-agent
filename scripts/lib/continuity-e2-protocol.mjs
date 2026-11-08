// Explicit registration, never inference from private prose or source size.
import { fail, keys, object } from "./continuity-observation-input.mjs";
import { digest, validateSource } from "./continuity-recorded-schema.mjs";

export const LUNA = "openai-codex:gpt-6-luna", SOL = "openai-codex:gpt-6.1-sol";
export const PROTOCOL_SCHEMA = "continuity-e2-protocol-v1";
const integer = n => Number.isSafeInteger(n) && n >= 0;
const label = s => typeof s === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(s);
export function parts(row) {
  try { const v = JSON.parse(row.parts_json); if (Array.isArray(v)) return v; } catch { /* refusal below */ }
  fail("E2_SOURCE_PARTS_INVALID");
}
// Same reason/kind fallback as conversation/src/harness/session-events.ts.
export function historicalContext(event) {
  return event.context ?? (event.reason === "cancelled_turn_resume" || event.reason === "failed_turn_resume"
    ? "retained"
    : event.kind === "rollover" || event.kind === "isolated"
      || ["model_change", "legacy_unbound_model", "cancelled_turn_reseed", "failed_turn_reseed",
        "resume_error", "runtime_result", "detached_context"].includes(event.reason ?? "")
      ? "reconstructed" : undefined);
}
export function telemetry(part) {
  let value = part?.data;
  for (let i = 0; i < 8 && object(value); i++, value = value.data) {
    if (value.type === "session_boundary" || value.kind === "session_boundary") return value.kind === "session_boundary" ? value.data : value;
  }
  return null;
}
export function validateProtocol(p, source) {
  validateSource(source);
  const refuse = () => fail("E2_PROTOCOL_INVALID");
  if (!keys(p, ["schema", "branches"]) || p.schema !== PROTOCOL_SCHEMA || !Array.isArray(p.branches) || p.branches.length !== 2) refuse();
  const seen = new Set(), turnOrdinals = new Map(source.web.turns.map((t, i) => [t.id, i])), rowOrdinals = [];
  let following = -1;
  for (let i = source.web.messages.length - 1; i >= 0; i--) {
    const ordinal = turnOrdinals.get(source.web.messages[i].turn_id);
    if (ordinal !== undefined) following = ordinal;
    rowOrdinals[i] = ordinal ?? following;
  }
  for (const b of p.branches) {
    if (!keys(b, ["id", "startTurn", "endTurn", "models", "transitions", "checkpoints", "exclusions", "limits"])
      || !["main", "prefix"].includes(b.id) || seen.has(b.id) || !integer(b.startTurn) || !integer(b.endTurn)
      || b.startTurn !== 0 || b.startTurn > b.endTurn || !source.web.turns[b.endTurn]) refuse();
    seen.add(b.id);
    const expected = b.id === "main" ? [LUNA, SOL, LUNA, SOL] : [SOL, LUNA, SOL];
    if (!Array.isArray(b.models) || b.models.length !== expected.length || b.models.some((m, i) => !keys(m, ["model", "effort"])
      || m.model !== expected[i] || !["none", "low", "medium", "high", "xhigh"].includes(m.effort) || m.model === SOL && m.effort !== "high")) refuse();
    if (!Array.isArray(b.transitions) || !Array.isArray(b.checkpoints) || !b.checkpoints.length || b.checkpoints.length > 48) refuse();
    let last = b.startTurn - 1, switches = 0;
    const transitionNames = new Set();
    for (const t of b.transitions) {
      if (!keys(t, ["name", "turn", "kind", "evidence"], ["effort"]) || !label(t.name) || transitionNames.has(t.name) || !integer(t.turn) || t.turn < b.startTurn || t.turn > b.endTurn || t.turn < last
        || !["cold_model_switch", "warm_cancel_resume", "manual_compaction_skipped", "effort_only_non_boundary"].includes(t.kind)
        || !Array.isArray(t.evidence) || !t.evidence.length || t.evidence.length > 4) refuse();
      last = t.turn; transitionNames.add(t.name);
      if (t.kind !== "effort_only_non_boundary" && Object.hasOwn(t, "effort")) refuse();
      const evidence = t.evidence.map(e => {
        if (!keys(e, ["message", "part"]) || !integer(e.message) || !integer(e.part) || !source.web.messages[e.message]) refuse();
        const row = source.web.messages[e.message], part = parts(row)[e.part];
        if (!part || rowOrdinals[e.message] !== t.turn) refuse();
        // Markers may be unassigned system rows just before this turn. Never
        // allow an arbitrary marker elsewhere in the corpus to authorize it.
        const turn = source.web.turns[t.turn], previous = source.web.turns[t.turn - 1];
        if (row.turn_id !== turn.id && !(row.turn_id == null && row.created_at <= turn.started_at && (!previous || row.created_at >= previous.started_at))) refuse();
        return part;
      });
      const marker = evidence.find(v => v.type === "conversation-marker");
      if (t.kind === "cold_model_switch") {
        if (!marker || marker.kind !== "model" || !marker.before?.model || !marker.after?.model || marker.before.model === marker.after.model) refuse();
        switches++;
      } else if (t.kind === "effort_only_non_boundary") {
        if (!marker || marker.kind !== "model" || !marker.before?.model || marker.before.model !== marker.after?.model
          || marker.before.effort === marker.after.effort || !["none", "low", "medium", "high", "xhigh"].includes(t.effort)) refuse();
      } else if (t.kind === "manual_compaction_skipped") {
        if (!marker || marker.kind !== "compaction" || marker.trigger !== "manual" || marker.status !== "skipped" || marker.reason !== "model_changed") refuse();
      } else {
        const previous = source.web.turns[t.turn - 1];
        if (!previous || !["cancelled", "canceled"].includes(previous.status)
          || !evidence.some(v => { const data = telemetry(v); return data?.reason === "cancelled_turn_resume" && historicalContext(data) === "retained"; })) refuse();
      }
    }
    // Source semantics cannot hide an undeclared transition. Auxiliary telemetry
    // for a registered model marker is permitted, not a second boundary.
    for (const [message, row] of source.web.messages.entries()) {
      const ordinal = rowOrdinals[message];
      if (ordinal < b.startTurn || ordinal > b.endTurn) continue;
      for (const [partIndex, part] of parts(row).entries()) {
        const data = telemetry(part);
        let kind;
        if (part.type === "conversation-marker" && part.kind === "model") kind = part.before?.model === part.after?.model ? "effort_only_non_boundary" : "cold_model_switch";
        else if (part.type === "conversation-marker" && part.kind === "compaction" && part.trigger === "manual" && part.status === "skipped") kind = "manual_compaction_skipped";
        else if (data?.reason === "model_change") kind = "cold_model_switch";
        else if (data?.reason === "cancelled_turn_resume") kind = "warm_cancel_resume";
        if (kind && !b.transitions.some(t => t.turn === ordinal && t.kind === kind && (data || t.evidence.some(e => e.message === message && e.part === partIndex)))) refuse();
      }
    }
    if (switches !== expected.length - 1) refuse();
    if (b.id === "main") {
      const boundaries = b.transitions.filter(t => ["cold_model_switch", "warm_cancel_resume"].includes(t.kind));
      if (boundaries.map(t => t.name).join() !== "B1,B2,B3,B4" || boundaries.map(t => t.kind).join() !== "cold_model_switch,warm_cancel_resume,cold_model_switch,cold_model_switch"
        || b.transitions.filter(t => t.kind === "manual_compaction_skipped" && t.name === "B3a").length !== 1
        || b.transitions.filter(t => t.kind === "effort_only_non_boundary").length !== 1
        || b.transitions.findIndex(t => t.name === "B3a") >= b.transitions.findIndex(t => t.name === "B3")
        || b.transitions.findIndex(t => t.kind === "effort_only_non_boundary") <= b.transitions.findIndex(t => t.name === "B3")
        || b.transitions.findIndex(t => t.kind === "effort_only_non_boundary") >= b.transitions.findIndex(t => t.name === "B4")) refuse();
    }
    const names = new Set();
    for (const c of b.checkpoints) {
      if (!keys(c, ["name", "turn", "message"]) || !label(c.name) || names.has(c.name) || !integer(c.turn) || c.turn < b.startTurn || c.turn > b.endTurn
        || !integer(c.message) || source.web.messages[c.message]?.turn_id !== source.web.turns[c.turn].id) refuse();
      names.add(c.name);
    }
    for (const name of b.id === "main" ? ["B1", "B2", "B4"] : ["B3"]) if (!names.has(name)) refuse();
    if (!keys(b.exclusions, ["steps", "coverage"]) || ![b.exclusions.steps, b.exclusions.coverage].every(Array.isArray)
      || b.exclusions.steps.some(i => !integer(i) || !source.steps[i]) || b.exclusions.coverage.some(i => !integer(i) || !source.coverage[i])
      || new Set(b.exclusions.steps).size !== b.exclusions.steps.length || new Set(b.exclusions.coverage).size !== b.exclusions.coverage.length) refuse();
    if (!keys(b.limits, ["sourceRequests", "summaryRequests", "summaryRequestsPerCompaction", "probeRequests", "compactions", "timeoutMs"])
      || Object.values(b.limits).some(v => !integer(v) || v < 1) || b.limits.timeoutMs > 600_000) refuse();
  }
  return structuredClone(p);
}
export const protocolDigest = p => digest(JSON.stringify(p));
