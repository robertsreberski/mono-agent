import { createHash } from "node:crypto";
import { parseConversationHistoryText } from "./continuity-observation-retrieval.mjs";
import { MAX_ROW_BYTES, fail, object, time, jsonLines } from "./continuity-observation-input.mjs";

export const REASONS = ["model_change", "legacy_unbound_model", "detached_context", "idle_timeout", "rollover", "cancelled", "resume", "continuation", "proactive", "cancelled_turn_reseed", "failed_turn_reseed", "cancelled_turn_resume", "failed_turn_resume", "unknown"];
export const CONTEXTS = ["retained", "reconstructed", "handoff", "unknown"];
export const COMPACTION_STATUSES = ["running", "succeeded", "failed", "skipped", "unknown"];
// pack.ts, continuity-reader.ts and continuity-contracts.ts define these values.
export const PACK_REASONS = ["none", "empty", "overflow", "snapshot_bounds", "headroom", "trigger_headroom", "coverage_gap", "upkeep_gap", "purge_pending", "source_changed", "source_unavailable", "boundary_unavailable", "unavailable", "scan_capacity", "other", "unknown"];
export const PACK_GAP_REASONS = ["coverage_gap", "upkeep_gap", "purge_pending", "source_changed", "source_unavailable", "boundary_unavailable", "unavailable"];
export const PACK_BOUNDED_REASONS = ["overflow", "snapshot_bounds", "headroom", "trigger_headroom"];
export const TRIGGERS = ["manual", "proactive", "reactive", "unknown"];
export const enumValue = (v, allowed) => allowed.includes(v) ? v : "unknown";
const TOOL_NAMES = ["ConversationHistory", "conversation_history", "mcp__mono-agent-conversation-history__ConversationHistory"];
const MAX_TURN_EVENTS = 8192;
export const stratumAt = (snapshot, timestamp) => snapshot.strata.find(p => timestamp >= p.start && timestamp < p.end);
export const sameStratum = (a, b) => a && b && a.closure === b.closure && a.soul === b.soul;
export function parseParts(row) {
  if (row?.oversized === 1) return { parts: [], invalid: 1, oversized: 1 };
  if (typeof row?.parts_json !== "string") return { parts: [], invalid: 1, oversized: 0 };
  try {
    const parts = JSON.parse(row.parts_json);
    if (!Array.isArray(parts) || parts.length > MAX_TURN_EVENTS) return { parts: [], invalid: 1, oversized: 0 };
    return { parts, invalid: 0, oversized: 0 };
  } catch { return { parts: [], invalid: 1, oversized: 0 }; }
}
export function statements(db) {
  return {
    threads: db.prepare("SELECT id,source_id,conversation_id,trigger_kind FROM threads ORDER BY id"),
    turns: db.prepare("SELECT id,status,started_at,finished_at FROM turns WHERE thread_id=? AND started_at>=? AND started_at<? ORDER BY started_at,id"),
    messages: db.prepare("SELECT id,role,status,seq,cron_suppressed FROM messages WHERE turn_id=? ORDER BY seq,id"),
    parts: db.prepare(`SELECT CASE WHEN length(CAST(parts_json AS BLOB))<=${MAX_ROW_BYTES} THEN parts_json ELSE NULL END AS parts_json, CASE WHEN length(CAST(parts_json AS BLOB))>${MAX_ROW_BYTES} THEN 1 ELSE 0 END AS oversized FROM messages WHERE id=?`),
    owner: db.prepare("SELECT 1 FROM messages WHERE turn_id=? AND role='user' AND cron_suppressed=0 LIMIT 1"),
    unassigned: db.prepare("SELECT id,role,status,seq,cron_suppressed,created_at,turn_id FROM messages WHERE thread_id=? AND created_at>=? AND created_at<? AND (turn_id IS NULL OR NOT EXISTS (SELECT 1 FROM turns WHERE turns.id=messages.turn_id)) ORDER BY id"),
    followup: db.prepare(`SELECT t.id,t.status,t.started_at,t.finished_at FROM turns t WHERE t.thread_id=? AND (t.started_at>? OR (t.started_at=? AND t.id>?)) AND t.started_at<? AND EXISTS (SELECT 1 FROM messages m WHERE m.turn_id=t.id AND m.role='user' AND m.cron_suppressed=0) ORDER BY t.started_at,t.id LIMIT 3`),
  };
}
// The only collection is per turn, never per database. Large/corrupt individual
// turns are refused rather than silently evicting dedup keys or losing events.
export function scanTurn(sql, turn) { return scanRows(sql, sql.messages.iterate(turn.id), true); }
export function scanRows(sql, rows, expectRows = false) {
  const events = [], seen = new Map();
  const stats = { messages: 0, userMessages: 0, assistantMessages: 0, systemMessages: 0, otherMessages: 0,
    missingRecords: 0, invalidRecords: 0, oversizedRecords: 0, duplicateRecords: 0, attachmentReferences: 0, markers: 0 };
  let position = 0;
  for (const row of rows) {
    stats.messages++;
    stats[({ user: "userMessages", assistant: "assistantMessages", system: "systemMessages" })[row.role] ?? "otherMessages"]++;
    const parsed = parseParts(sql.parts.get(row.id)); stats.invalidRecords += parsed.invalid; stats.oversizedRecords += parsed.oversized;
    for (let partIndex = 0; partIndex < parsed.parts.length; partIndex++) {
      const p = parsed.parts[partIndex]; position++;
      if (!object(p)) { stats.invalidRecords++; continue; }
      if (p.type === "attachment") stats.attachmentReferences++;
      if (p.type === "conversation-marker") stats.markers++;
      if (p.type === "telemetry" && p.event === "runtime_telemetry" && !object(p.data)
        && (p.kind === undefined || ["session_boundary", "context_compaction", "continuity_pack_injected", "continuity_pack_skipped"].includes(p.kind))) {
        stats.missingRecords++; continue;
      }
      let event;
      // Persisted envelope is telemetry -> runtime_telemetry(kind,data), not an
      // HTTP transcript or the raw runtime event. Never infer from prose.
      if (p.type === "telemetry" && object(p.data)
        && ["session_boundary", "context_compaction", "continuity_pack_injected", "continuity_pack_skipped"].includes(p.data.kind)) {
        if (p.data.type !== "runtime_telemetry" || !object(p.data.data)) { stats.invalidRecords++; continue; }
        event = { kind: p.data.kind, data: p.data.data };
      } else if (p.type === "tool-call" && TOOL_NAMES.includes(p.toolName)) {
        if (typeof p.toolCallId !== "string" || !p.toolCallId || p.toolCallId.length > 512) { stats.invalidRecords++; continue; }
        event = { kind: "retrieval", data: p };
      }
      if (!event) continue;
      const data = event.data;
      const identity = event.kind === "retrieval" ? [event.kind, data.toolCallId]
        : event.kind === "context_compaction" && typeof data.operationId === "string"
          ? [event.kind, data.operationId, data.status] : [event.kind, data];
      const key = createHash("sha256").update(JSON.stringify(identity, (_k, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)).digest("hex");
      const reduced = compactEvent(event);
      if (seen.has(key)) {
        stats.duplicateRecords++;
        const previous = events[seen.get(key)];
        if (event.kind === "retrieval" && previous.data.status === "running") previous.data = reduced.data;
        else if (event.kind === "retrieval" && data.status !== "running" && JSON.stringify(previous.data) !== JSON.stringify(reduced.data)) previous.data = { ...reduced.data, status: "conflict", structuredResult: undefined };
        continue;
      }
      seen.set(key, events.length);
      if (seen.size > MAX_TURN_EVENTS) fail("TURN_EVENT_LIMIT");
      if (typeof row.id !== "string" || row.id.length > 512) fail("INVALID_SOURCE_ID");
      events.push({ ...reduced, position, messageId: row.id, partIndex });
    }
  }
  if (expectRows && !stats.messages) stats.missingRecords++;
  return { events, stats };
}
function compactEvent(event) {
  const d = event.data;
  if (event.kind === "retrieval") {
    const r = structured(d), args = object(d.args) ? d.args : undefined;
    return { kind: event.kind, data: { toolCallId: d.toolCallId,
      status: enumValue(d.status, ["running", "complete", "error"]),
      args: args ? { action: enumValue(args.action, ["search", "get"]), ...(args.recordId === undefined ? {} : { recordId: "present" }) } : undefined,
      defaultAction: args?.action === undefined,
      structuredResult: r ? { status: enumValue(r.status, ["available", "unavailable", "tombstoned", "not_found"]),
        ...(r.error ? { error: { code: r.error.code === "history_unavailable" ? "history_unavailable" : "other" } } : {}) } : undefined,
      result: d.result?.isError === true ? { isError: true } : undefined,
      history: typeof d.history?.recordId === "string" && d.history.recordId.length <= 512 ? { recordId: d.history.recordId } : undefined } };
  }
  if (event.kind === "session_boundary") return { kind: event.kind, data: { kind: enumValue(d.kind, ["rollover", "isolated", "resume_replay"]), reason: enumValue(d.reason, REASONS), context: enumValue(d.context, CONTEXTS) } };
  if (event.kind === "context_compaction") return { kind: event.kind, data: { status: enumValue(d.status, COMPACTION_STATUSES), trigger: enumValue(d.trigger, TRIGGERS) } };
  const data = { degradedReason: typeof d.degradedReason === "string" ? (PACK_REASONS.includes(d.degradedReason) && d.degradedReason !== "unknown" ? d.degradedReason : "other") : "unknown" };
  for (const k of ["ownerEntries", "toolEntries", "summaryEntries", "evidenceEntries", "omittedCount", "tokens"]) data[k] = Number.isSafeInteger(d[k]) && d[k] >= 0 ? d[k] : undefined;
  return { kind: event.kind, data };
}
function structured(p) {
  const direct = object(p.structuredResult) ? p.structuredResult : object(p.result?.structuredContent) ? p.result.structuredContent : undefined;
  const parsed = parseConversationHistoryText(p.result);
  if (direct && parsed && (direct.status !== parsed.status || direct.error?.code !== parsed.error?.code)) return undefined;
  return direct ?? parsed;
}
export function retrieval(p, sidecar, conversationId, interval) {
  const args = object(p.args) ? p.args : undefined, result = structured(p);
  const action = ["get", "search"].includes(args?.action) ? args.action
    : args && p.defaultAction ? (args.recordId === undefined ? "search" : "get") : "unknown";
  let outcome = "unknown";
  if (result?.error?.code === "history_unavailable" || ["unavailable", "tombstoned", "not_found"].includes(result?.status)) outcome = "unavailable";
  // An explicit tool error wins except a positively identified store outage.
  if ((p.status === "error" || p.result?.isError === true || result?.error)
    && result?.error?.code !== "history_unavailable") outcome = "error";
  if (outcome === "unknown" && result?.status === "available" && ["complete", "completed"].includes(p.status)) outcome = "success";
  let reconciliation = "not_supplied";
  if (sidecar) {
    const history = object(p.history) ? p.history : {};
    const rows = typeof history.recordId === "string"
      ? sidecar.prepare(`SELECT c.state,c.failure_kind,c.started_at_ms,c.ended_at_ms FROM tool_records t JOIN tool_calls c ON c.conversation_id=t.conversation_id AND c.run_id=t.run_id AND c.tool_call_id=t.tool_call_id JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id WHERE t.record_id=? AND c.tool_call_id=? AND (c.conversation_id=? OR r.logical_id=?) LIMIT 2`).all(history.recordId, p.toolCallId, conversationId, conversationId)
      : sidecar.prepare(`SELECT c.state,c.failure_kind,c.started_at_ms,c.ended_at_ms FROM tool_calls c JOIN runs r ON r.conversation_id=c.conversation_id AND r.run_id=c.run_id WHERE (c.conversation_id=? OR r.logical_id=?) AND c.tool_call_id=? LIMIT 2`).all(conversationId, conversationId, p.toolCallId);
    reconciliation = rows.length === 0 ? "unmatched" : rows.length > 1 ? "ambiguous" : "matched";
    if (rows.length === 1) {
      const row = rows[0];
      const state = interval && (row.started_at_ms < Date.parse(interval.start) || row.started_at_ms >= Date.parse(interval.end)
        || !Number.isSafeInteger(row.ended_at_ms) || row.ended_at_ms >= Date.parse(interval.end)) ? undefined : row.state;
      if (["rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted"].includes(state)) {
        if (outcome === "success") { outcome = "unknown"; reconciliation = "conflict"; }
        else if (outcome === "unknown") outcome = "error";
      }
      // Lifecycle completion alone does not establish retrieval availability.
    }
  }
  return { action, outcome, reconciliation };
}
export function reviewWindow(sql, snapshot, thread, turn, boundary, scanned) {
  const stratum = stratumAt(snapshot, turn.started_at);
  const next = [...sql.followup.iterate(thread.id, turn.started_at, turn.started_at, turn.id, snapshot.interval.end)];
  let retrieved = scanned.events.some(e => e.kind === "retrieval" && e.position > boundary.position);
  let invalid = scanned.stats.invalidRecords > 0 || scanned.stats.missingRecords > 0;
  for (const t of next) {
    const s = scanTurn(sql, t);
    retrieved ||= s.events.some(e => e.kind === "retrieval"); invalid ||= s.stats.invalidRecords > 0 || s.stats.missingRecords > 0;
  }
  const changed = next.some(t => !sameStratum(stratum, stratumAt(snapshot, t.started_at)))
    || next.some(t => snapshot.strata.findIndex(p => p === stratumAt(snapshot, t.started_at)) !== snapshot.strata.indexOf(stratum));
  const cancelled = turn.status === "cancelled" || next.some(t => t.status === "cancelled");
  const complete = [turn, ...next].every(t => t.finished_at && time(t.finished_at) && t.finished_at < snapshot.interval.end && ["complete", "completed"].includes(t.status));
  const status = changed ? "stratum_changed" : cancelled ? "cancelled" : next.length < 3 ? "missing_followup" : !complete || invalid ? "incomplete" : "eligible";
  return { status, retrieved, ownerTurns: next.map(t => ({ turnId: t.id, status: t.status })), observedOwnerTurns: next.length };
}
export async function journalInventory(path, interval) {
  const counts = { records: 0, compactions: 0, toolCalls: 0, toolResults: 0 };
  let header = false, previous = null, seq = 0;
  const kinds = ["turn_start", "turn_end", "operation_start", "operation_end", "message", "tool_call", "tool_result", "compaction", "interruption", "rewind", "model_change", "input_queued", "input_consumed", "owner_binding", "handle_binding", "handle_retired"];
  for await (const r of jsonLines(path)) {
    if (!header) {
      if (r.format !== "mono-harness" || r.version !== 2 || r.ownershipSchemaVersion !== 1 || r.ownership?.kind !== "unbound"
        || typeof r.journalId !== "string" || typeof r.initialHandle?.id !== "string" || r.id !== r.initialHandle.id) fail("UNSUPPORTED_JOURNAL_SCHEMA");
      header = true; continue;
    }
    if (r.schemaVersion !== 2 || typeof r.id !== "string" || r.parentId !== previous || r.seq !== seq + 1
      || !Number.isSafeInteger(r.timestamp) || !object(r.payload) || !kinds.includes(r.kind)) fail("INVALID_JOURNAL_RECORD");
    previous = r.id; seq = r.seq;
    if (r.timestamp < Date.parse(interval.start) || r.timestamp >= Date.parse(interval.end)) continue;
    counts.records++;
    if (r.kind === "compaction") counts.compactions++;
    if (r.kind === "tool_call") counts.toolCalls++;
    if (r.kind === "tool_result") counts.toolResults++;
  }
  if (!header) fail("UNSUPPORTED_JOURNAL_SCHEMA");
  return counts;
}
