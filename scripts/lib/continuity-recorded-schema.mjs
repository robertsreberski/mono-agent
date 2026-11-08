// Recorded data is private source material, never a fictional benchmark dataset.
import { createHash } from "node:crypto";
import { fail, keys, object } from "./continuity-observation-input.mjs";

export const SOURCE_SCHEMA = "continuity-recorded-source-v2";
export const QUESTIONS_SCHEMA = "continuity-recorded-questions-v1";
export const EVALUATOR_SCHEMA = "continuity-recorded-evaluator-keys-v1";
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_RECORDS = 100_000;
export const digest = value => createHash("sha256").update(value).digest("hex");
export const bytes = value => typeof value === "string" ? value : JSON.stringify(value);
// Same canonical name/arguments binding as continuity-tools.mjs:callKey.
export function callKey(name, args) {
  const stable = v => Array.isArray(v) ? v.map(stable) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return `${name}\0${JSON.stringify(stable(args ?? {}))}`;
}
export function emptyQuestions() { return { schema: QUESTIONS_SCHEMA, questions: [] }; }
export function emptyKeys() { return { schema: EVALUATOR_SCHEMA, keys: [] }; }
export function validateQuestions(v) {
  if (!keys(v, ["schema", "questions"]) || v.schema !== QUESTIONS_SCHEMA || !Array.isArray(v.questions) || v.questions.length) fail("RECORDED_QUESTIONS_STUB_REQUIRED");
  return v;
}
export function validateKeys(v) {
  if (!keys(v, ["schema", "keys"]) || v.schema !== EVALUATOR_SCHEMA || !Array.isArray(v.keys) || v.keys.length) fail("RECORDED_KEYS_STUB_REQUIRED");
  return v;
}
export const contentBlocks = value => Array.isArray(value) && value.length > 0
  && value.every(block => object(block) && typeof block.type === "string" && block.type.length > 0);
export function resultEnvelope(tool) {
  if (!Object.hasOwn(tool, "result")) fail("RECORDED_RESULT_MISSING");
  const r = tool.result, isError = tool.isError === true || object(r) && r.isError === true;
  const structuredContent = object(r) && r.structuredContent !== undefined ? r.structuredContent : tool.structuredResult;
  const structured = structuredContent === undefined ? {} : { structuredContent };
  if (object(r) && contentBlocks(r.content)) return { content: r.content, ...structured, isError };
  if (contentBlocks(r)) return { content: r, ...structured, isError };
  return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }], ...structured, isError };
}
export function ambiguousSteps(source) {
  return source.steps.filter(step => {
    const seen = new Map();
    for (const index of step.calls) {
      const tool = source.tools[index];
      if (!Object.hasOwn(tool, "result")) continue;
      const key = callKey(tool.name, tool.args), hash = digest(JSON.stringify([digest(bytes(tool.result)), tool.isError === true, Object.hasOwn(tool, "structuredResult") ? [tool.structuredResult] : []]));
      if (seen.has(key) && seen.get(key) !== hash) return true;
      seen.set(key, hash);
    }
    return false;
  });
}
export function validateSource(s) {
  if (!keys(s, ["schema", "dataClass", "conversationId", "provenance", "web", "sidecar", "journal", "tools", "steps", "outcomes", "coverage", "transport"])
    || s.schema !== SOURCE_SCHEMA || s.dataClass !== "private-recorded" || typeof s.conversationId !== "string"
    || !object(s.web) || !Array.isArray(s.web.threads) || !Array.isArray(s.web.turns) || !Array.isArray(s.web.messages)
    || !Array.isArray(s.tools) || !Array.isArray(s.steps) || !Array.isArray(s.coverage) || !Array.isArray(s.outcomes)
    || !Array.isArray(s.provenance) || !object(s.transport)) fail("INVALID_RECORDED_SOURCE");
  for (const t of s.tools) if (!object(t) || typeof t.id !== "string" || typeof t.name !== "string" || !t.name
    || !Array.isArray(t.provenance) || !Array.isArray(t.gaps)) fail("INVALID_RECORDED_TOOL");
  const used = new Set();
  for (const step of s.steps) {
    if (!object(step) || !Array.isArray(step.calls) || !Array.isArray(step.gaps)) fail("INVALID_RECORDED_STEP");
    for (const index of step.calls) {
      if (!Number.isInteger(index) || !s.tools[index] || used.has(index)) fail("INVALID_RECORDED_STEP");
      used.add(index);
    }
  }
  for (const gap of s.coverage) if (!keys(gap, ["code", "location", "tier"]) || !object(gap.location) || gap.tier !== gapTier(gap.code)) fail("INVALID_RECORDED_GAP");
  return s;
}
export const INVENTORY_FIELDS = ["threads", "turns", "messages", "tools", "steps", "attachments", "subagentOutcomes", "markers", "telemetry", "steers", "partialTurns", "failedTools", "matched", "conflicts", "webOnly", "sidecarOnly", "journalOnly", "representationDifferences", "truncated", "malformedParts", "missingResults", "ambiguousParallelGroups", "coverageGaps", "replayGaps", "itemGaps", "fidelityGaps", "sidecarRedacted", "sidecarRedactedUnverified", "webEffectiveArguments", "recoveredResults", "journalRecords"];
export const GAP_TIERS = Object.freeze(Object.fromEntries([
  ...["partial_turn", "partial_message", "unassigned_message", "cross_thread_order_unknown", "malformed_parts", "malformed_part", "malformed_tool", "malformed_native_call", "journal_rewind_requires_branch_selection", "native_interruption", "arguments_missing", "arguments_not_object", "arguments_truncated", "native_result_missing_or_ambiguous", "tool_terminal_state_unknown", "result_missing", "duplicate_web_conflict", "journal_arguments_conflict", "journal_result_conflict", "journal_state_conflict", "duplicate_native_identity", "ambiguous_sidecar_identity", "sidecar_conflict", "ambiguous_parallel_results", "assistant_step_boundaries_unknown", "mixed_step_order_unknown"].map(code => [code, "replay"]),
  ...["attachment_bytes_unavailable", "subagent_outcome_missing", "subagent_outcome_truncated", "subagent_terminal_state_unknown"].map(code => [code, "item"]),
  ...["source_truncated", "sidecar_truncated", "arguments_may_include_host_defaults", "web_effective_arguments", "sidecar_redacted", "sidecar_redacted_unverified", "malformed_sidecar_payload", "sidecar_phase_missing", "sidecar_only_tool"].map(code => [code, "fidelity"]),
]));
export function gapTier(code) { if (!Object.hasOwn(GAP_TIERS, code)) fail("INVALID_RECORDED_GAP"); return GAP_TIERS[code]; }
export function inventory(source, counts) {
  validateSource(source);
  const result = { schema: "continuity-recorded-inventory-v2" };
  for (const key of INVENTORY_FIELDS) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail("INVALID_RECORDED_INVENTORY");
    result[key] = counts[key];
  }
  return result;
}
