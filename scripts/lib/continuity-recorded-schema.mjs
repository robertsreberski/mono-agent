// Recorded data is private source material, never a fictional benchmark dataset.
import { createHash } from "node:crypto";
import { fail, keys, object } from "./continuity-observation-input.mjs";

export const SOURCE_SCHEMA = "continuity-recorded-source-v1";
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
export function resultEnvelope(tool) {
  if (!Object.hasOwn(tool, "result")) fail("RECORDED_RESULT_MISSING");
  const r = tool.result;
  if (object(r) && Array.isArray(r.content)) return { content: r.content, ...(r.structuredContent === undefined ? {} : { structuredContent: r.structuredContent }), isError: r.isError === true || tool.isError === true };
  if (Array.isArray(r) && r.every(b => object(b) && typeof b.type === "string")) return { content: r, isError: tool.isError === true };
  return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
    ...(tool.structuredResult === undefined ? {} : { structuredContent: tool.structuredResult }), isError: tool.isError === true };
}
export function ambiguousSteps(source) {
  return source.steps.filter(step => {
    const seen = new Map();
    for (const index of step.calls) {
      const tool = source.tools[index];
      if (!Object.hasOwn(tool, "result")) continue;
      const key = callKey(tool.name, tool.args), hash = digest(JSON.stringify([digest(bytes(tool.result)), tool.isError === true, tool.structuredResult ?? null]));
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
  return s;
}
export const INVENTORY_FIELDS = ["threads", "turns", "messages", "tools", "steps", "attachments", "subagentOutcomes", "markers", "telemetry", "steers", "partialTurns", "failedTools", "matched", "conflicts", "webOnly", "sidecarOnly", "journalOnly", "representationDifferences", "truncated", "malformedParts", "missingResults", "ambiguousParallelGroups", "coverageGaps", "journalRecords"];
export function inventory(source, counts) {
  validateSource(source);
  const result = { schema: "continuity-recorded-inventory-v1" };
  for (const key of INVENTORY_FIELDS) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail("INVALID_RECORDED_INVENTORY");
    result[key] = counts[key];
  }
  return result;
}
