// Offline importer. No runtime/product/provider imports; every input is explicit.
import { readFileSync, statSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { ROOT, MAX_ROW_BYTES, fail, keys, object, within, inputPath, openSnapshot, sourceStamps, assertUnchanged, jsonLines } from "./continuity-observation-input.mjs";
import { SOURCE_SCHEMA, MAX_SOURCE_BYTES, MAX_RECORDS, INVENTORY_FIELDS, bytes, callKey, digest, emptyQuestions, emptyKeys, inventory, validateSource, ambiguousSteps } from "./continuity-recorded-schema.mjs";

export function readRecordedManifest(path) {
  path = inputPath(process.cwd(), path);
  if (statSync(path).size > MAX_ROW_BYTES) fail("RECORDED_MANIFEST_TOO_LARGE");
  let m;
  try { m = JSON.parse(readFileSync(path, "utf8")); } catch { fail("INVALID_RECORDED_MANIFEST"); }
  if (!keys(m, ["schema", "web"], ["agent", "sidecar", "journal"]) || m.schema !== "continuity-recorded-manifest-v1"
    || (m.agent !== undefined && (typeof m.agent !== "string" || !m.agent))) fail("INVALID_RECORDED_MANIFEST");
  const base = dirname(path);
  if (m.journal !== undefined && (!keys(m.journal, ["path", "conversationId"]) || typeof m.journal.conversationId !== "string" || !m.journal.conversationId)) fail("INVALID_RECORDED_JOURNAL_BINDING");
  return { ...m, manifestPath: path, web: inputPath(base, m.web),
    ...(m.sidecar === undefined ? {} : { sidecar: inputPath(base, m.sidecar) }),
    ...(m.journal === undefined ? {} : { journal: { ...m.journal, path: inputPath(base, m.journal.path) } }) };
}
export function privateOutput(path, protectedPaths = []) {
  if (typeof path !== "string" || !path || path.includes("\0")) fail("RECORDED_OUTPUT_REFUSED");
  const lexical = resolve(path);
  if (within(ROOT, lexical)) fail("RECORDED_OUTPUT_REFUSED");
  const parent = realpathSync(dirname(lexical)), target = join(parent, basename(lexical)), s = statSync(parent);
  if (within(ROOT, target) || protectedPaths.some(p => within(target, realpathSync(p)))
    || typeof process.getuid !== "function" || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700) fail("RECORDED_OUTPUT_REFUSED");
  if (existsSync(target)) fail("EEXIST");
  return target;
}
function requireColumns(db, table, columns) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!Object.entries(columns).every(([name, type]) => actual.some(c => c.name === name && c.type.toUpperCase() === type))) fail("UNSUPPORTED_RECORDED_SCHEMA");
}
// Bound TEXT/BLOB allocations before selecting a row, including optional columns.
function* rows(db, table, where, args, order, retain) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  const rowBytes = columns.map(c => `coalesce(length(CAST(${quote(c.name)} AS BLOB)),0)`).join("+");
  if (db.prepare(`SELECT 1 FROM ${table} WHERE (${where}) AND (${rowBytes})>${MAX_ROW_BYTES} LIMIT 1`).get(...args)) fail("RECORDED_ROW_TOO_LARGE");
  for (const row of db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}`).iterate(...args)) {
    retain(row); yield row;
  }
}
function parsePayload(record) {
  if (!record) return { present: false };
  try {
    if (digest(record.payload_json) !== record.payload_sha256 || ![0, 1].includes(record.truncated)
      || record.retained_bytes !== Buffer.byteLength(record.payload_json) || !Number.isSafeInteger(record.original_bytes) || record.original_bytes < 0) return { present: false, malformed: true };
    return { present: true, value: JSON.parse(record.payload_json), truncated: record.truncated === 1 };
  }
  catch { return { present: false, malformed: true }; }
}
function textResult(value) {
  if (typeof value === "string") return value;
  const content = Array.isArray(value) ? value : value?.content;
  return Array.isArray(content) && content.every(p => p?.type === "text" && typeof p.text === "string") ? content.map(p => p.text).join("\n") : undefined;
}
function compare(aPresent, a, bPresent, b) {
  if (!aPresent || !bPresent) return "missing";
  if (bytes(a) === bytes(b)) return "exact";
  if (textResult(a) !== undefined && textResult(a) === textResult(b)) return "text_equivalent";
  return "different";
}
const failed = state => ["error", "rejected", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted"].includes(state);

export async function readRecordedSource(manifest, conversationId) {
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 512 || conversationId.includes("\0")) fail("INVALID_RECORDED_CONVERSATION");
  const m = typeof manifest === "string" ? readRecordedManifest(manifest) : manifest;
  if (m.journal && m.journal.conversationId !== conversationId) fail("RECORDED_JOURNAL_BINDING_MISMATCH");
  const paths = [m.manifestPath, m.web, m.sidecar, m.journal?.path].filter(Boolean), stamps = sourceStamps(paths);
  let size = 0, records = 0;
  const retain = row => {
    size += Buffer.byteLength(JSON.stringify(row)); records++;
    if (size > MAX_SOURCE_BYTES || records > MAX_RECORDS) fail("RECORDED_CAPACITY_EXCEEDED");
  };
  const counts = Object.fromEntries(INVENTORY_FIELDS.map(k => [k, 0]));
  const source = { schema: SOURCE_SCHEMA, dataClass: "private-recorded", conversationId,
    provenance: paths.map((path, index) => ({ index, path, stamp: stamps[index][1] })),
    web: { threads: [], turns: [], messages: [] }, sidecar: null, journal: null, tools: [], steps: [], outcomes: [], coverage: [],
    transport: { identity: "name-canonical-arguments-fifo", identityReason: "packages/turn/src/tools/mcp/tools.ts:178-179 omits toolCallId from MCP requests", arguments: "unchanged", schemas: "unavailable-unless-explicitly-supplied", resultAdaptation: "native-content-or-text-envelope", byteEquivalence: "not-claimed", clipping: "must-be-measured-by-replay" } };
  const gap = (code, location, blocking = true) => source.coverage.push({ code, location, blocking });
  let web, sidecar;
  try {
    web = openSnapshot(m.web, "web");
    for (const thread of rows(web, "threads", "conversation_id=?", [conversationId], "id", retain)) {
      if (m.agent !== undefined && thread.source_id !== m.agent) continue;
      source.web.threads.push(thread);
      for (const turn of rows(web, "turns", "thread_id=?", [thread.id], "started_at,id", retain)) source.web.turns.push(turn);
      for (const message of rows(web, "messages", "thread_id=?", [thread.id], "seq,id", retain)) source.web.messages.push(message);
    }
    if (!source.web.threads.length) fail("RECORDED_CONVERSATION_NOT_FOUND");
    if (new Set(source.web.threads.map(t => t.source_id)).size !== 1) fail("RECORDED_AGENT_AMBIGUOUS");
    counts.threads = source.web.threads.length; counts.turns = source.web.turns.length; counts.messages = source.web.messages.length;
    for (const turn of source.web.turns) {
      if (!["complete", "completed"].includes(turn.status)) { counts.partialTurns++; gap("partial_turn", { turnId: turn.id }); }
    }
    if (source.web.threads.length > 1) gap("cross_thread_order_unknown", { source: "web" });
    const turnIds = new Set(source.web.turns.map(t => t.id));
    const byId = new Map(), webSteps = [], steerIds = new Set(), subagentIds = new Set(), outcomesAdded = new Set();
    for (const row of source.web.messages) {
      try { for (const part of JSON.parse(row.parts_json)) if (part?.type === "subagent" || part?.type === "tool-call" && part.toolName === "Agent") subagentIds.add(part.toolCallId); } catch { /* diagnosed below */ }
    }
    for (const row of source.web.messages) {
      if (!turnIds.has(row.turn_id)) gap("unassigned_message", { messageId: row.id });
      let parts;
      try { parts = JSON.parse(row.parts_json); } catch { /* retain the original malformed string */ }
      if (!Array.isArray(parts)) { counts.malformedParts++; gap("malformed_parts", { messageId: row.id }); continue; }
      const step = { origin: "web-message-conservative", messageId: row.id, turnId: row.turn_id, calls: [], gaps: [] };
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index], provenance = { source: "web", messageId: row.id, turnId: row.turn_id, partIndex: index };
        if (!object(part) || typeof part.type !== "string") { counts.malformedParts++; gap("malformed_part", provenance); continue; }
        if (part.type === "attachment") { counts.attachments++; gap("attachment_bytes_unavailable", provenance); }
        if (part.type === "conversation-marker") counts.markers++;
        if (part.type === "telemetry") counts.telemetry++;
        if (part.type === "steer" || part.type === "live-input") {
          const id = part.inputId ?? `${row.id}:${index}`;
          if (!steerIds.has(id)) { counts.steers++; steerIds.add(id); }
        }
        if (part.type === "subagent" || part.type === "tool-call" && part.toolName === "Agent") {
          if (outcomesAdded.has(part.toolCallId)) continue;
          outcomesAdded.add(part.toolCallId); counts.subagentOutcomes++;
          source.outcomes.push({ role: "assistant", kind: "recorded-subagent-outcome", toolCallId: part.toolCallId ?? null,
            ...(Object.hasOwn(part, "result") ? { result: part.result } : {}), status: part.status ?? "unknown", provenance,
            childrenReplayed: false });
          if (!Object.hasOwn(part, "result")) gap("subagent_outcome_missing", provenance);
          if (part.argsTruncated === true || part.resultTruncated === true || part.history?.truncated === true) { counts.truncated++; gap("subagent_outcome_truncated", provenance); }
          if (!["complete", "completed", "error"].includes(part.status)) gap("subagent_terminal_state_unknown", provenance);
          continue; // Child calls stay opaque in raw parts, never enter the parent queue.
        }
        if (part.type !== "tool-call" || subagentIds.has(part.toolCallId)) continue;
        if (typeof part.toolCallId !== "string" || !part.toolCallId || typeof part.toolName !== "string" || !part.toolName) { counts.malformedParts++; gap("malformed_tool", provenance); continue; }
        const tool = { id: part.toolCallId, name: part.toolName, ...(Object.hasOwn(part, "args") ? { args: part.args } : {}),
          ...(Object.hasOwn(part, "result") ? { result: part.result } : {}), ...(Object.hasOwn(part, "structuredResult") ? { structuredResult: part.structuredResult } : {}), state: part.status ?? "unknown",
          isError: part.status === "error" || part.result?.isError === true, history: part.history ?? null, provenance: [provenance], gaps: [], reconciliation: "web_only" };
        if (!Object.hasOwn(tool, "args")) tool.gaps.push("arguments_missing");
        else if (!object(tool.args)) tool.gaps.push("arguments_not_object");
        if (!["complete", "completed", "error"].includes(tool.state)) tool.gaps.push("tool_terminal_state_unknown");
        if (!Object.hasOwn(tool, "result")) { tool.gaps.push("result_missing"); counts.missingResults++; }
        if (part.argsTruncated === true || part.resultTruncated === true || part.history?.truncated === true) { tool.gaps.push("source_truncated"); counts.truncated++; }
        // Repeated materializations of a call are references, not a second execution.
        const oldIndex = byId.get(tool.id), old = source.tools[oldIndex];
        if (old) {
          old.provenance.push(provenance);
          if (callKey(old.name, old.args) !== callKey(tool.name, tool.args) || bytes(old.result) !== bytes(tool.result)) old.gaps.push("duplicate_web_conflict");
          continue;
        }
        byId.set(tool.id, source.tools.length); step.calls.push(source.tools.length); source.tools.push(tool);
      }
      if (step.calls.length) webSteps.push(step);
    }
    if (m.journal) {
      source.journal = { header: null, records: [], binding: "caller-asserted", conversationId };
      let previous = null, seq = 0;
      const inputTurns = new Set(), recordIds = new Set();
      const kinds = ["turn_start", "turn_end", "operation_start", "operation_end", "message", "tool_call", "tool_result", "compaction", "interruption", "rewind", "model_change", "input_queued", "input_consumed", "owner_binding", "handle_binding", "handle_retired"];
      for await (const r of jsonLines(m.journal.path)) {
        retain(r);
        if (!source.journal.header) {
          if (r.format !== "mono-harness" || r.version !== 2 || r.ownershipSchemaVersion !== 1 || r.ownership?.kind !== "unbound" || typeof r.journalId !== "string" || typeof r.initialHandle?.id !== "string" || r.id !== r.initialHandle.id) fail("UNSUPPORTED_JOURNAL_SCHEMA");
          source.journal.header = r; continue;
        }
        if (r.schemaVersion !== 2 || typeof r.id !== "string" || !r.id || recordIds.has(r.id) || typeof r.turnId !== "string" || !r.turnId
          || (r.operationId !== undefined && (typeof r.operationId !== "string" || !r.operationId))
          || r.parentId !== previous || r.seq !== seq + 1 || !Number.isSafeInteger(r.timestamp) || !object(r.payload) || !kinds.includes(r.kind)) fail("INVALID_JOURNAL_RECORD");
        recordIds.add(r.id); previous = r.id; seq = r.seq; source.journal.records.push(r);
        if (r.kind === "rewind") gap("journal_rewind_requires_branch_selection", { recordId: r.id });
        if (r.kind === "interruption") gap("native_interruption", { recordId: r.id, turnId: r.turnId });
        if (r.kind === "input_consumed") {
          if (inputTurns.has(r.turnId) && !steerIds.has(r.payload.inputId)) { counts.steers++; steerIds.add(r.payload.inputId); }
          inputTurns.add(r.turnId);
        }
      }
      if (!source.journal.header) fail("UNSUPPORTED_JOURNAL_SCHEMA");
      counts.journalRecords = source.journal.records.length;
      const nativeResults = new Map();
      for (const r of source.journal.records) {
        const msg = r.payload.message;
        if ((r.kind === "message" || r.kind === "tool_result" && r.payload.phase === "returned") && msg?.role === "toolResult") {
          const key = `${r.operationId ?? r.turnId}\0${msg.toolCallId}`;
          if (!nativeResults.has(key)) nativeResults.set(key, []);
          const candidates = nativeResults.get(key), receipt = candidates.find(c => c.r.kind !== r.kind && bytes(c.msg.content) === bytes(msg.content) && c.msg.isError === msg.isError && c.msg.toolName === msg.toolName);
          if (receipt) { receipt.refs.push(r.id); if (r.kind === "message") { receipt.r = r; receipt.msg = msg; } }
          else candidates.push({ r, msg, refs: [r.id] });
        }
      }
      const placed = new Set();
      for (const r of source.journal.records) {
        const msg = r.payload.message;
        if (r.kind !== "message" || msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        const step = { origin: "journal-assistant-message", messageId: r.id, turnId: r.turnId, operationId: r.operationId ?? null, calls: [], gaps: [] };
        for (const part of msg.content.filter(p => p?.type === "toolCall")) {
          if (typeof part.id !== "string" || typeof part.name !== "string") { gap("malformed_native_call", { recordId: r.id }); continue; }
          const provenance = { source: "journal", recordId: r.id, turnId: r.turnId, operationId: r.operationId ?? null };
          if (subagentIds.has(part.id) || part.name === "Agent") {
            if (!subagentIds.has(part.id)) {
              const results = nativeResults.get(`${r.operationId ?? r.turnId}\0${part.id}`) ?? [];
              source.outcomes.push({ role: "assistant", kind: "recorded-subagent-outcome", toolCallId: part.id,
                ...(results.length === 1 ? { result: results[0].msg.content } : {}), status: "unknown", provenance, childrenReplayed: false });
              counts.subagentOutcomes++;
              if (results.length !== 1) gap("subagent_outcome_missing", provenance);
              subagentIds.add(part.id);
            }
            continue;
          }
          let index = byId.get(part.id), tool = source.tools[index];
          const results = nativeResults.get(`${r.operationId ?? r.turnId}\0${part.id}`) ?? [];
          if (!tool) {
            counts.journalOnly++;
            tool = { id: part.id, name: part.name, ...(Object.hasOwn(part, "arguments") ? { args: part.arguments } : {}), ...(results.length === 1 && Object.hasOwn(results[0].msg, "content") ? { result: results[0].msg.content } : {}), state: typeof results[0]?.msg.isError === "boolean" ? (results[0].msg.isError ? "error" : "complete") : "unknown", isError: results[0]?.msg.isError === true, history: null, provenance: [], gaps: [], reconciliation: "journal_only" };
            if (!object(tool.args)) tool.gaps.push("arguments_not_object");
            if (!Object.hasOwn(tool, "result")) counts.missingResults++;
            if (tool.state === "unknown") tool.gaps.push("tool_terminal_state_unknown");
            if (results.length !== 1 || !Object.hasOwn(tool, "result")) tool.gaps.push("native_result_missing_or_ambiguous");
            index = source.tools.length; byId.set(tool.id, index); source.tools.push(tool);
          } else {
            if (callKey(tool.name, tool.args) !== callKey(part.name, part.arguments)) tool.gaps.push("journal_arguments_conflict");
            if (results.length === 1) {
              const comparison = compare(Object.hasOwn(tool, "result"), tool.result, true, results[0].msg.content);
              if (comparison === "different") tool.gaps.push("journal_result_conflict");
              if (typeof results[0].msg.isError === "boolean" && results[0].msg.isError !== tool.isError) tool.gaps.push("journal_state_conflict");
              if (comparison === "text_equivalent") counts.representationDifferences++;
            } else tool.gaps.push("native_result_missing_or_ambiguous");
          }
          tool.provenance.push(provenance, ...results.map(result => ({ source: "journal", phase: "result", recordIds: result.refs })));
          if (placed.has(index)) { tool.gaps.push("duplicate_native_identity"); continue; }
          placed.add(index); step.calls.push(index);
        }
        if (step.calls.length) source.steps.push(step);
      }
      for (const step of webSteps) {
        step.calls = step.calls.filter(i => !placed.has(i));
        if (step.calls.length) { step.gaps.push("assistant_step_boundaries_unknown", "mixed_step_order_unknown"); source.steps.push(step); }
      }
    } else source.steps = webSteps.map(s => ({ ...s, gaps: ["assistant_step_boundaries_unknown"] }));
    if (m.sidecar) {
      sidecar = openSnapshot(m.sidecar, "sidecar");
      requireColumns(sidecar, "tool_records", { payload_json: "TEXT", truncated: "INTEGER", seq: "INTEGER", payload_sha256: "TEXT", original_bytes: "INTEGER", retained_bytes: "INTEGER" });
      requireColumns(sidecar, "tool_calls", { start_seq: "INTEGER", end_seq: "INTEGER" });
      source.sidecar = { runs: [], calls: [], records: [] };
      for (const run of rows(sidecar, "runs", "conversation_id=? OR logical_id=?", [conversationId, conversationId], "conversation_id,run_id", retain)) {
        source.sidecar.runs.push(run);
        for (const call of rows(sidecar, "tool_calls", "conversation_id=? AND run_id=?", [run.conversation_id, run.run_id], "start_seq,tool_call_id", retain)) source.sidecar.calls.push(call);
        for (const record of rows(sidecar, "tool_records", "conversation_id=? AND run_id=?", [run.conversation_id, run.run_id], "seq,record_id", retain)) source.sidecar.records.push(record);
      }
      const consumed = new Set(), callsById = new Map(), recordsByCall = new Map(), recordsById = new Map();
      const identity = r => JSON.stringify([r.conversation_id, r.run_id, r.tool_call_id]);
      for (const call of source.sidecar.calls) {
        if (!callsById.has(call.tool_call_id)) callsById.set(call.tool_call_id, []);
        callsById.get(call.tool_call_id).push(call);
      }
      for (const record of source.sidecar.records) {
        const key = identity(record);
        if (!recordsByCall.has(key)) recordsByCall.set(key, []);
        recordsByCall.get(key).push(record); recordsById.set(record.record_id, record);
      }
      for (const tool of source.tools) {
        const binding = tool.history?.recordId ? recordsById.get(tool.history.recordId) : null;
        const candidates = (callsById.get(tool.id) ?? []).filter(c => !tool.history?.recordId || binding && identity(binding) === identity(c));
        if (candidates.length !== 1) {
          if (candidates.length > 1) { tool.reconciliation = "conflict"; tool.gaps.push("ambiguous_sidecar_identity"); }
          continue;
        }
        const c = candidates[0]; consumed.add(c);
        const records = recordsByCall.get(identity(c)) ?? [];
        tool.provenance.push({ source: "sidecar", conversationId: c.conversation_id, runId: c.run_id, recordIds: records.map(r => r.record_id) });
        const invocation = records.filter(r => r.phase === "invocation"), results = records.filter(r => r.phase === "result");
        const a = parsePayload(invocation[0]), b = parsePayload(results[0]);
        tool.comparison = { arguments: a.present && Object.hasOwn(tool, "args") ? (callKey(tool.name, tool.args) === callKey(tool.name, a.value) ? "exact" : "different") : "missing",
          result: compare(Object.hasOwn(tool, "result"), tool.result, b.present, b.value), state: c.state === "success" || failed(c.state) ? (failed(c.state) === tool.isError ? "compatible" : "different") : "missing" };
        if (a.truncated || b.truncated) { tool.gaps.push("sidecar_truncated"); counts.truncated++; }
        if (a.malformed || b.malformed) tool.gaps.push("malformed_sidecar_payload");
        if (invocation.length > 1 || results.length > 1 || c.tool_name !== tool.name || Object.values(tool.comparison).includes("different")) { tool.reconciliation = "conflict"; tool.gaps.push("sidecar_conflict"); }
        else if (Object.values(tool.comparison).includes("missing")) { tool.reconciliation = "incomplete"; tool.gaps.push("sidecar_phase_missing"); }
        else if (tool.comparison.result === "text_equivalent") { tool.reconciliation = "representation_difference"; counts.representationDifferences++; }
        else tool.reconciliation = "matched";
      }
      for (const call of source.sidecar.calls) if (!consumed.has(call)) { counts.sidecarOnly++; gap("sidecar_only_tool", { conversationId: call.conversation_id, runId: call.run_id, toolCallId: call.tool_call_id }); }
    }
    for (const step of ambiguousSteps(source)) { counts.ambiguousParallelGroups++; step.gaps.push("ambiguous_parallel_results"); }
    for (const step of source.steps) for (const code of step.gaps) gap(code, { messageId: step.messageId });
    for (const tool of source.tools) {
      if (tool.reconciliation === "web_only") counts.webOnly++;
      if (tool.reconciliation === "matched") counts.matched++;
      if (tool.reconciliation === "conflict" || tool.gaps.some(code => code.endsWith("_conflict"))) counts.conflicts++;
      if (tool.isError) counts.failedTools++;
      for (const code of tool.gaps) gap(code, { toolCallId: tool.id });
    }
    counts.tools = source.tools.length; counts.steps = source.steps.length; counts.coverageGaps = source.coverage.length;
    assertUnchanged(stamps);
    return { source: validateSource(source), inventory: inventory(source, counts) };
  } finally { sidecar?.close(); web?.close(); }
}

export async function importRecorded({ manifest, conversation, output }) {
  const m = readRecordedManifest(manifest);
  const target = privateOutput(output, [m.manifestPath, m.web, m.sidecar, m.journal?.path].filter(Boolean));
  const result = await readRecordedSource(m, conversation);
  let created = false;
  try {
    mkdirSync(target, { mode: 0o700 }); created = true;
    for (const [name, value] of [["source.json", result.source], ["reader-questions.json", emptyQuestions()], ["evaluator-keys.json", emptyKeys()], ["inventory.json", result.inventory]]) {
      writeFileSync(join(target, name), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    }
  } catch (e) { if (created) rmSync(target, { recursive: true, force: true }); throw e; }
  return result.inventory; // The sole exportable artifact; never return text/paths on stdout.
}
