// Fictional conversation-continuity traces: loading, validation and plan.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, ARM_IDS, BASELINE_ARM } from "./continuity-arms.mjs";
import { CATEGORIES, probePrompt, validateProbeScore } from "./continuity-score.mjs";
import { TOOL_NAMES } from "./continuity-tools.mjs";

export const CORPUS_DIR = fileURLToPath(new URL("../fixtures/continuity/", import.meta.url));
export const PLAN_SCHEMA = "continuity-benchmark-plan-v1";
export const DEFAULT_READER = "openai-codex:gpt-6-luna";
export const DEFAULT_ALTERNATE = "openai-codex:gpt-6.1-sol";
export const DEFAULT_JUDGE = "openai-codex:gpt-6.1-sol";

const ID = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const TURN_ID = /^t[0-9]{2,3}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MODEL_REF = /^[a-z0-9-]+:[A-Za-z0-9._/-]+$/u;

export const TRACE_RULES = Object.freeze({ minTurns: 30, minProbes: 10, maxProbes: 15, minToolCalls: 20 });

function fail(code, detail) {
  const error = new Error(detail === undefined ? code : `${code}:${detail}`);
  error.code = code;
  throw error;
}

/** Text that a reader sees outside tool results (owner text, steers, scripted replies). */
export function nonToolText(trace) {
  return trace.turns.flatMap((turn) => [turn.user, ...turn.steps.flatMap((step) => [step.reply, step.say, step.steer])])
    .filter((value) => typeof value === "string");
}
export function toolResultText(trace) {
  return trace.turns.flatMap((turn) => turn.steps.filter((step) => step.call).map((step) => step.call.result));
}

export function validateTrace(trace) {
  if (!trace || typeof trace !== "object") fail("invalid_trace");
  if (!ID.test(trace.id ?? "")) fail("invalid_trace_id");
  if (trace.fictional !== true) fail("trace_not_marked_fictional", trace.id);
  if (typeof trace.title !== "string" || typeof trace.owner?.displayName !== "string") fail("invalid_trace_header", trace.id);
  if (!Array.isArray(trace.turns) || trace.turns.length < TRACE_RULES.minTurns) fail("trace_too_short", trace.id);
  let previous = 0; let steers = 0; let calls = 0; const seen = new Set();
  for (const turn of trace.turns) {
    if (!TURN_ID.test(turn.id ?? "") || seen.has(turn.id)) fail("invalid_turn_id", `${trace.id}/${turn.id}`);
    seen.add(turn.id);
    if (!ISO.test(turn.at ?? "") || Date.parse(turn.at) <= previous) fail("invalid_turn_time", `${trace.id}/${turn.id}`);
    previous = Date.parse(turn.at);
    if (typeof turn.user !== "string" || turn.user.trim().length === 0) fail("invalid_turn_user", `${trace.id}/${turn.id}`);
    if (!Array.isArray(turn.steps) || turn.steps.length === 0) fail("invalid_turn_steps", `${trace.id}/${turn.id}`);
    turn.steps.forEach((step, index) => {
      const last = index === turn.steps.length - 1;
      if (last !== (typeof step.reply === "string")) fail("turn_must_end_with_single_reply", `${trace.id}/${turn.id}`);
      if (step.call !== undefined) {
        if (step.reply !== undefined) fail("invalid_step", `${trace.id}/${turn.id}`);
        if (!TOOL_NAMES.includes(step.call.tool) || typeof step.call.result !== "string" || step.call.result.length === 0
          || !step.call.args || typeof step.call.args !== "object" || Array.isArray(step.call.args)) fail("invalid_tool_step", `${trace.id}/${turn.id}`);
        calls += 1;
      } else if (!last) fail("invalid_step", `${trace.id}/${turn.id}`);
      if (step.steer !== undefined) {
        if (step.call === undefined || typeof step.steer !== "string" || step.steer.trim().length === 0) fail("steer_requires_tool_step", `${trace.id}/${turn.id}`);
        steers += 1;
      }
    });
  }
  if (steers < 1) fail("trace_missing_mid_turn_steer", trace.id);
  if (calls < TRACE_RULES.minToolCalls) fail("trace_too_few_tool_results", trace.id);
  const mid = trace.turns.findIndex((turn) => turn.id === trace.midCheckpoint);
  if (mid < 1 || mid > trace.turns.length - 6) fail("invalid_mid_checkpoint", trace.id);
  if (trace.turns[mid].steps.length !== 1) fail("mid_checkpoint_must_be_tool_free", trace.id);
  if (!ISO.test(trace.probeAt ?? "") || Date.parse(trace.probeAt) <= previous) fail("invalid_probe_time", trace.id);
  if (!Array.isArray(trace.probes) || trace.probes.length < TRACE_RULES.minProbes || trace.probes.length > TRACE_RULES.maxProbes) fail("invalid_probe_count", trace.id);
  const probeIds = new Set();
  const visible = nonToolText(trace).join("\n");
  const visibleCompact = visible.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  const toolCompact = toolResultText(trace).join("\n").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  for (const probe of trace.probes) {
    if (!/^p[0-9]{2}$/u.test(probe.id ?? "") || probeIds.has(probe.id)) fail("invalid_probe_id", `${trace.id}/${probe.id}`);
    probeIds.add(probe.id);
    if (!CATEGORIES.includes(probe.category)) fail("invalid_probe_category", `${trace.id}/${probe.id}`);
    if (typeof probe.question !== "string" || probe.question.length < 10) fail("invalid_probe_question", `${trace.id}/${probe.id}`);
    if (probe.format !== undefined && typeof probe.format !== "string") fail("invalid_probe_format", `${trace.id}/${probe.id}`);
    if (typeof probe.abstainOption !== "boolean") fail("invalid_probe_abstain_option", `${trace.id}/${probe.id}`);
    validateProbeScore(probe);
    const expectedKind = { tool_identifier: ["identifier"], active_constraint: ["constraint_recall", "constraint_task"], superseded_current: ["value"],
      commitment_status: ["choice"], artifact_status: ["choice"], next_action: ["next_action"], abstention: ["abstain"] }[probe.category];
    if (!expectedKind.includes(probe.score.kind)) fail("probe_kind_category_mismatch", `${trace.id}/${probe.id}`);
    if (probe.category === "tool_identifier") {
      // Tool-only: present in a tool result, absent from every owner/assistant/steer text.
      for (const value of probe.score.accept) {
        const compact = value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
        if (!toolCompact.includes(compact)) fail("identifier_not_in_tool_output", `${trace.id}/${probe.id}`);
        if (visibleCompact.includes(compact)) fail("identifier_not_tool_only", `${trace.id}/${probe.id}`);
      }
    }
    if (probe.category === "abstention" && !probe.abstainOption) fail("abstention_probe_needs_option", `${trace.id}/${probe.id}`);
  }
  for (const category of CATEGORIES) {
    if (!trace.probes.some((probe) => probe.category === category)) fail("trace_missing_probe_category", `${trace.id}/${category}`);
  }
  const constraintTasks = trace.probes.filter((probe) => probe.score.kind === "constraint_task");
  if (constraintTasks.length < 1) fail("trace_missing_constraint_violation_probe", trace.id);
  return true;
}

/** The replay projection: no probes, expected answers, rubrics or categories. */
export function sourceOnly(trace) {
  return {
    id: trace.id,
    owner: { displayName: trace.owner.displayName },
    midCheckpoint: trace.midCheckpoint,
    probeAt: trace.probeAt,
    turns: trace.turns.map((turn) => ({
      id: turn.id, at: turn.at, user: turn.user,
      steps: turn.steps.map((step) => ({
        ...(step.say === undefined ? {} : { say: step.say }),
        ...(step.call === undefined ? {} : { call: { tool: step.call.tool, args: step.call.args, result: step.call.result } }),
        ...(step.steer === undefined ? {} : { steer: step.steer }),
        ...(step.reply === undefined ? {} : { reply: step.reply }),
      })),
    })),
  };
}

/** Reader-visible probe projection: id and exact prompt only. */
export function probeSource(probe) { return { id: probe.id, prompt: probePrompt(probe) }; }

export async function loadTraces({ dir = CORPUS_DIR } = {}) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) fail("empty_corpus");
  const hash = createHash("sha256");
  const traces = [];
  for (const name of names) {
    const bytes = await readFile(join(dir, name));
    hash.update(`${name}\0${bytes.length}\0`); hash.update(bytes);
    const trace = JSON.parse(bytes.toString("utf8"));
    validateTrace(trace);
    if (`${trace.id}.json` !== name) fail("trace_file_name_mismatch", name);
    traces.push(trace);
  }
  return { traces, sha256: hash.digest("hex") };
}

export function inventory(traces) {
  const rows = traces.map((trace) => {
    const categories = Object.fromEntries(CATEGORIES.map((category) => [category, trace.probes.filter((probe) => probe.category === category).length]));
    return {
      id: trace.id, turns: trace.turns.length,
      toolCalls: trace.turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.call).length, 0),
      steers: trace.turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.steer).length, 0),
      sessions: new Set(trace.turns.map((turn) => turn.at.slice(0, 10))).size,
      probes: trace.probes.length, categories,
    };
  });
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category, rows.reduce((sum, row) => sum + row.categories[category], 0)]));
  return { traces: rows, totals, probes: rows.reduce((sum, row) => sum + row.probes, 0) };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

/**
 * The confirmed workload. Execution-only choices (concurrency, chunk
 * selection, output directory) are deliberately outside the digest; a chunk
 * may only select a subset of the confirmed plan.
 */
export function makePlan({ traces, sha256, codeRevision = null, profile = {}, repeats = 1, arms = ARM_IDS, probeLimit = null, piAuthFingerprint = null }) {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) fail("invalid_repeats");
  if (!Array.isArray(arms) || arms.length === 0 || arms.some((arm) => !ARM_IDS.includes(arm)) || new Set(arms).size !== arms.length) fail("invalid_arms");
  if (!arms.includes(BASELINE_ARM)) fail("baseline_arm_required");
  if (probeLimit !== null && (!Number.isSafeInteger(probeLimit) || probeLimit < 1 || probeLimit > 15)) fail("invalid_probe_limit");
  const reader = profile.reader ?? DEFAULT_READER;
  const alternate = profile.alternate ?? DEFAULT_ALTERNATE;
  const judge = profile.judge === undefined ? DEFAULT_JUDGE : profile.judge;
  for (const ref of [reader, alternate, ...(judge === null ? [] : [judge])]) if (!MODEL_REF.test(ref)) fail("invalid_model_reference");
  if (reader === alternate) fail("alternate_must_differ_from_reader");
  const readerEffort = profile.readerEffort ?? "low";
  const judgeEffort = profile.judgeEffort ?? "low";
  const selectedArms = ARMS.filter((arm) => arms.includes(arm.id));
  const probesPerTrace = traces.map((trace) => ({ id: trace.id, probes: trace.probes.slice(0, probeLimit ?? undefined).map((probe) => probe.id) }));
  const probeCount = probesPerTrace.reduce((sum, row) => sum + row.probes.length, 0);
  const nextActionCount = traces.reduce((sum, trace) => sum + trace.probes.slice(0, probeLimit ?? undefined).filter((probe) => probe.category === "next_action").length, 0);
  const midArms = selectedArms.filter((arm) => arm.midCheckpoint !== null).length;
  const probeTurns = probeCount * selectedArms.length * repeats;
  const midTurns = traces.length * midArms * repeats;
  const compactions = repeats * (probeCount * selectedArms.reduce((sum, arm) => sum + arm.expect.probeCompactions, 0)
    + traces.length * selectedArms.reduce((sum, arm) => sum + arm.expect.midCompactions, 0));
  const judgeCalls = judge === null ? 0 : nextActionCount * selectedArms.length * repeats;
  const plan = {
    schema: PLAN_SCHEMA,
    corpus: { sha256, traces: probesPerTrace, probeLimit },
    arms: selectedArms.map((arm) => ({ id: arm.id, label: arm.label, replayBinding: arm.replayBinding, midCheckpoint: arm.midCheckpoint, probeRuntime: arm.probeRuntime, expect: arm.expect })),
    baselineArm: BASELINE_ARM,
    repeats,
    reader: { model: reader, effort: readerEffort },
    alternateBinding: { model: alternate, servedBy: "scripted-history-only" },
    judge: judge === null ? null : { model: judge, effort: judgeEffort, scope: "next_action" },
    workload: { probeTurns, midCheckpointLiveTurns: midTurns, liveTurns: probeTurns + midTurns, expectedCompactions: compactions, judgeCalls },
    limits: {
      maxLiveTurns: probeTurns + midTurns,
      perLiveTurnTimeoutMs: 240000,
      // Observed (not reserved) uncached+cached input per invocation; admission stops when crossed.
      maxObservedInputTokensPerInvocation: 6000000,
    },
    accounting: "observed-runtime-usage; cost is the Pi catalog list-price estimate when reported, unknown otherwise; subscription billing is not metered per token",
    codeRevision,
    piAuthFingerprint,
  };
  return { ...plan, confirmation: digest(plan) };
}
