// Fictional conversation-continuity traces: loading, validation and plan.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, BASELINE_ARM, DEFAULT_ARMS, assertRunnableArms } from "./continuity-arms.mjs";
import { GENERATOR_VERSION, HARD_SEEDS, LONG_RULES, generateTrace, generateDistractorTrace, outsideColdBounds, traceShape } from "./continuity-generator.mjs";
import { CATEGORIES, ORIGINAL_CATEGORIES, probePrompt, validateProbeScore } from "./continuity-score.mjs";
import { TOOL_NAMES } from "./continuity-tools.mjs";

export const CORPUS_DIR = fileURLToPath(new URL("../fixtures/continuity/", import.meta.url));
export const PLAN_SCHEMA = "continuity-benchmark-plan-v2";
export const SUITES = Object.freeze(["original", "hard", "hard-distractors"]);
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

export function traceFamily(trace) { return trace?.family === "long" ? "long" : "original"; }

export function validateTrace(trace) {
  if (!trace || typeof trace !== "object") fail("invalid_trace");
  if (!ID.test(trace.id ?? "")) fail("invalid_trace_id");
  if (trace.fictional !== true) fail("trace_not_marked_fictional", trace.id);
  if (typeof trace.title !== "string" || typeof trace.owner?.displayName !== "string") fail("invalid_trace_header", trace.id);
  const long = traceFamily(trace) === "long";
  if (trace.family !== undefined && !["original", "long"].includes(trace.family)) fail("invalid_trace_family", trace.id);
  if (!Array.isArray(trace.turns) || trace.turns.length < (long ? LONG_RULES.minTurns : TRACE_RULES.minTurns)) fail("trace_too_short", trace.id);
  if (long && trace.turns.length > LONG_RULES.maxTurns) fail("trace_too_long", trace.id);
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
        if (long) {
          const bytes = Buffer.byteLength(step.call.result);
          if (bytes < LONG_RULES.minResultBytes || bytes > LONG_RULES.maxResultBytes) fail("long_trace_result_size", `${trace.id}/${turn.id}`);
        }
        calls += 1;
      } else if (!last) fail("invalid_step", `${trace.id}/${turn.id}`);
      if (step.steer !== undefined) {
        if (step.call === undefined || typeof step.steer !== "string" || step.steer.trim().length === 0) fail("steer_requires_tool_step", `${trace.id}/${turn.id}`);
        steers += 1;
      }
    });
  }
  if (steers < 1) fail("trace_missing_mid_turn_steer", trace.id);
  if (long && steers < LONG_RULES.minSteers) fail("long_trace_needs_multiple_steers", trace.id);
  if (calls < (long ? LONG_RULES.minToolCalls : TRACE_RULES.minToolCalls)) fail("trace_too_few_tool_results", trace.id);
  if (long && calls > LONG_RULES.maxToolCalls) fail("trace_too_many_tool_results", trace.id);
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
    if (!(long ? CATEGORIES : ORIGINAL_CATEGORIES).includes(probe.category)) fail("invalid_probe_category", `${trace.id}/${probe.id}`);
    if (typeof probe.question !== "string" || probe.question.length < 10) fail("invalid_probe_question", `${trace.id}/${probe.id}`);
    if (probe.format !== undefined && typeof probe.format !== "string") fail("invalid_probe_format", `${trace.id}/${probe.id}`);
    if (typeof probe.abstainOption !== "boolean") fail("invalid_probe_abstain_option", `${trace.id}/${probe.id}`);
    validateProbeScore(probe);
    const expectedKind = { tool_identifier: ["identifier"], active_constraint: ["constraint_recall", "constraint_task"], superseded_current: ["value"],
      commitment_status: ["choice"], artifact_status: ["choice"], next_action: ["next_action"], abstention: ["abstain"], redaction: ["redaction"] }[probe.category];
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
    if (probe.category === "redaction") {
      const secret = probe.score.secret.toUpperCase().replace(/[^A-Z0-9]/gu, "");
      if (!toolCompact.includes(secret)) fail("secret_not_in_tool_output", `${trace.id}/${probe.id}`);
      if (visibleCompact.includes(secret)) fail("secret_not_tool_only", `${trace.id}/${probe.id}`);
    }
    if (probe.pressure === "outside_window_and_projection" && !outsideColdBounds(trace, probe.sourceTurn)) fail("identifier_inside_cold_bounds", `${trace.id}/${probe.id}`);
  }
  if (long && !trace.probes.some((probe) => probe.pressure === "outside_window_and_projection")) fail("long_trace_needs_out_of_bounds_identifier", trace.id);
  for (const category of long ? CATEGORIES : ORIGINAL_CATEGORIES) {
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

async function loadOriginal(dir) {
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
  return { traces, sha256: hash.digest("hex"), source: { kind: "checked-in", dir: "scripts/fixtures/continuity" } };
}

/** Parse `101,102` or `101-124` into a seed list. */
export function parseSeeds(text) {
  const seeds = [];
  for (const part of String(text).split(",").map((value) => value.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range) { for (let seed = Number(range[1]); seed <= Number(range[2]); seed += 1) seeds.push(seed); }
    else if (/^\d+$/u.test(part)) seeds.push(Number(part));
    else fail("invalid_seeds");
  }
  if (seeds.length === 0 || seeds.length > 64 || new Set(seeds).size !== seeds.length || seeds.some((seed) => seed < 1)) fail("invalid_seeds");
  return seeds;
}

/**
 * Load a suite. `original` is the four checked-in hand-written traces; `hard`
 * is generated deterministically from seeds and validated like any other trace.
 */
export async function loadTraces({ dir = CORPUS_DIR, suite = "original", seeds = HARD_SEEDS } = {}) {
  if (!SUITES.includes(suite)) fail("invalid_suite");
  if (suite === "original") return { suite, ...(await loadOriginal(dir)) };
  const traces = seeds.map((seed) => suite === "hard-distractors" ? generateDistractorTrace(seed) : generateTrace(seed));
  for (const trace of traces) validateTrace(trace);
  return { suite, traces, sha256: digest({ generator: GENERATOR_VERSION, traces }), source: { kind: "generated", generator: GENERATOR_VERSION, seeds: [...seeds], ...(suite === "hard-distractors" ? { variant: "distractors" } : {}) } };
}

export function inventory(traces) {
  const rows = traces.map((trace) => {
    const categories = Object.fromEntries(CATEGORIES.map((category) => [category, trace.probes.filter((probe) => probe.category === category).length]));
    const shape = traceShape(trace);
    return {
      id: trace.id, family: traceFamily(trace), turns: trace.turns.length, messages: shape.messages,
      toolBytes: shape.toolBytes, totalBytes: shape.totalBytes, estimatedTokens: shape.estimatedTokens,
      minResultBytes: shape.minResultBytes, maxResultBytes: shape.maxResultBytes,
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
export function makePlan({ traces, sha256, suite = "original", source = null, codeRevision = null, profile = {}, repeats = 1, arms, probeLimit = null, piAuthFingerprint = null }) {
  if (!SUITES.includes(suite)) fail("invalid_suite");
  arms ??= DEFAULT_ARMS[suite];
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) fail("invalid_repeats");
  if (!Array.isArray(arms) || arms.length === 0 || arms.some((arm) => !ARMS.some((row) => row.id === arm)) || new Set(arms).size !== arms.length) fail("invalid_arms");
  if (!arms.includes(BASELINE_ARM)) fail("baseline_arm_required");
  const families = [...new Set(traces.map(traceFamily))];
  assertRunnableArms(arms, families);
  if (probeLimit !== null && (!Number.isSafeInteger(probeLimit) || probeLimit < 1 || probeLimit > 15)) fail("invalid_probe_limit");
  const reader = profile.reader ?? DEFAULT_READER;
  const alternate = profile.alternate ?? DEFAULT_ALTERNATE;
  const judge = profile.judge === undefined ? DEFAULT_JUDGE : profile.judge;
  for (const ref of [reader, alternate, profile.extractionModel ?? reader, ...(judge === null ? [] : [judge])]) if (!MODEL_REF.test(ref)) fail("invalid_model_reference");
  if (reader === alternate) fail("alternate_must_differ_from_reader");
  const readerEffort = profile.readerEffort ?? "low";
  const judgeEffort = profile.judgeEffort ?? "low";
  const selectedArms = ARMS.filter((arm) => arms.includes(arm.id));
  const probesPerTrace = traces.map((trace) => ({ id: trace.id, family: traceFamily(trace), toolRecords: traceShape(trace).toolCalls,
    probes: trace.probes.slice(0, probeLimit ?? undefined).map((probe) => probe.id) }));
  const probeCount = probesPerTrace.reduce((sum, row) => sum + row.probes.length, 0);
  const nextActionCount = traces.reduce((sum, trace) => sum + trace.probes.slice(0, probeLimit ?? undefined).filter((probe) => probe.category === "next_action").length, 0);
  const preparations = [
    { binding: alternate, maxInputTokens: 128000, maxOutputTokens: 4096, budget: "bootstrap" },
    { binding: reader, maxInputTokens: 64000, maxOutputTokens: 4096, budget: "incremental" },
    { binding: alternate, maxInputTokens: 64000, maxOutputTokens: 4096, budget: "incremental" },
  ];
  const upkeepCalls = traces.length * selectedArms.filter(arm => arm.ledgerUpkeep).length * repeats * preparations.length;
  const midArms = selectedArms.filter((arm) => arm.midCheckpoint !== null).length;
  const probeTurns = probeCount * selectedArms.length * repeats;
  const midCompactions = traces.length * midArms * repeats;
  const compactions = repeats * (probeCount * selectedArms.reduce((sum, arm) => sum + arm.expect.probeCompactions, 0)
    + traces.length * selectedArms.reduce((sum, arm) => sum + arm.expect.midCompactions, 0));
  const judgeCalls = judge === null ? 0 : nextActionCount * selectedArms.length * repeats;
  const long = families.includes("long");
  const plan = {
    schema: PLAN_SCHEMA,
    suite,
    corpus: { sha256, source, traces: probesPerTrace, probeLimit },
    arms: selectedArms.map((arm) => ({ id: arm.id, label: arm.label, replayBinding: arm.replayBinding, ...(arm.ledgerUpkeep ? { ledgerUpkeep: true } : {}), midCheckpoint: arm.midCheckpoint,
      restart: arm.restart, probeConfig: arm.probeConfig, expect: arm.expect, pressure: arm.pressure })),
    baselineArm: BASELINE_ARM,
    repeats,
    reader: { model: reader, effort: readerEffort },
    upkeep: { degradedStagePolicy: "allowlisted_product_ledger_or_pack", eligibilitySkipPolicy: "integrity_failure", unknownUsagePolicy: "full_reserve_catalog_accounting", model: profile.extractionModel ?? reader, requireRequestCap: profile.requireRequestCap === true, maxInputTokens: 128000, incrementalMaxInputTokens: 64000, maxOutputTokens: 4096, timeoutMs: 60000,
      capEnforcement: (profile.extractionModel ?? reader).startsWith("openai-codex:") ? "stream_abort" : "request_or_skip", reasoning: "lowest_supported", callsPerTraceRepeat: preparations.length, preparations,
      reservations: upkeepCalls ? traces.flatMap(trace => Array.from({ length: repeats }, (_, repeat) => preparations.map((step, index) => ({ traceId: trace.id, repeat: repeat + 1, preparation: index + 1, ...step }))).flat()) : [] },
    alternateBinding: { model: alternate, servedBy: "scripted-history-only" },
    judge: judge === null ? null : { model: judge, effort: judgeEffort, scope: "next_action" },
    workload: { ...(upkeepCalls ? { upkeepCalls } : {}), probeTurns, midCheckpointCompactions: midCompactions, liveTurns: probeTurns, expectedCompactions: compactions, judgeCalls },
    limits: {
      maxLiveTurns: probeTurns + midCompactions + upkeepCalls,
      perLiveTurnTimeoutMs: long ? 600000 : 240000,
      // Observed (not reserved) uncached+cached input per invocation; admission stops when crossed.
      maxObservedInputTokensPerInvocation: long ? 400_000_000 : 6_000_000,
    },
    accounting: "observed-runtime-usage; known cost is the Pi catalog list-price estimate; unknown upkeep usage charges full reserved input plus planned output separately; not an invoice guarantee",
    codeRevision,
    piAuthFingerprint,
  };
  return { ...plan, confirmation: digest(plan) };
}

const OVERHEAD_TOKENS = 4000;
const ANSWER_OUTPUT_TOKENS = 300;
const tokensOf = (bytes) => Math.ceil(bytes / 4);

/** Rough per-probe token shapes for the cost estimate (Pi's chars/4 heuristic). */
export function traceTokenShape(trace) {
  const shape = traceShape(trace);
  const textBytes = shape.totalBytes - shape.toolBytes;
  // Summary preparation keeps ~2,000 characters of each tool result.
  const serialized = tokensOf(textBytes + shape.toolCalls * 2100) + OVERHEAD_TOKENS;
  let messages = 0; let coldTextBytes = 0;
  for (const turn of [...trace.turns].reverse()) {
    const texts = [turn.user, ...turn.steps.flatMap((step) => [step.steer, step.reply])].filter((value) => typeof value === "string");
    if (messages + texts.length > 64) break;
    messages += texts.length; coldTextBytes += texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  }
  let records = 0; let projection = 0;
  for (const call of [...shape.calls].reverse()) {
    // Tool history keeps the first 16 KiB of an oversized result.
    const retained = Math.min(call.bytes, 16 * 1024);
    if (records >= 32 || projection + retained > 64 * 1024) break;
    records += 1; projection += retained;
  }
  return { full: shape.estimatedTokens + OVERHEAD_TOKENS, serialized, cold: tokensOf(coldTextBytes + projection) + OVERHEAD_TOKENS };
}

/**
 * List-price cost estimate before a paid run. Upper bound assumes no prompt
 * cache; `expected` assumes forks of one checkpoint reuse the cached prefix.
 */
export function estimateCost(plan, traces, prices) {
  const reader = prices[plan.reader.model] ?? null;
  const upkeepPrice = prices[plan.upkeep?.model] ?? null;
  if (plan.arms.some(arm => arm.ledgerUpkeep) && !upkeepPrice) return { status: "unknown_price", upkeep: plan.upkeep?.model };
  const judgePrice = plan.judge ? prices[plan.judge.model] ?? null : null;
  if (reader === null) return { status: "unknown_price", reader: plan.reader.model };
  const usd = (input, output, cacheRead = 0, price = reader) => (input * price.input + output * price.output + cacheRead * price.cacheRead) / 1_000_000;
  const rows = {};
  for (const armRow of plan.arms) {
    let upper = 0; let expected = 0; let inputTokens = 0; let upkeepBudgetUsd = 0;
    for (const trace of traces) {
      const t = traceTokenShape(trace);
      const probes = plan.corpus.traces.find((row) => row.id === trace.id).probes.length * plan.repeats;
      const perProbe = (() => {
        switch (armRow.id) {
          case "native": return { input: t.full, output: ANSWER_OUTPUT_TOKENS, cacheable: t.full };
          case "cold-rebuild": return { input: t.cold, output: ANSWER_OUTPUT_TOKENS, cacheable: t.cold };
          case "compaction-1": return { input: t.serialized + 2000 + 4000 + OVERHEAD_TOKENS, output: 2000 + ANSWER_OUTPUT_TOKENS, cacheable: t.serialized };
          case "compaction-2": return { input: Math.ceil(t.serialized * 0.5) + 2000 + 4000 + OVERHEAD_TOKENS, output: 2000 + ANSWER_OUTPUT_TOKENS, cacheable: Math.ceil(t.serialized * 0.5) };
          case "ceiling": return { input: t.serialized + 10880 + 20000 + OVERHEAD_TOKENS, output: 10880 + ANSWER_OUTPUT_TOKENS, cacheable: t.serialized };
          case "restart-switch-compact": return { input: t.cold * 2, output: 2000 + ANSWER_OUTPUT_TOKENS, cacheable: t.cold };
          // Store arms: the cold or compacted context plus up to two ConversationHistory rounds.
          case "continuity-store": return { input: t.cold * 3 + 4000, output: 3 * ANSWER_OUTPUT_TOKENS, cacheable: t.cold * 3 };
          // Same retrieval allowance, plus the bounded 8k pack on each request; no upkeep call.
          case "continuity-ledger-cold":
          case "continuity-pack-cold":
          case "continuity-pack-boundary": return { input: (t.cold + 8000) * 3 + 4000, output: 3 * ANSWER_OUTPUT_TOKENS, cacheable: (t.cold + 8000) * 3 };
          case "continuity-store-compaction": return { input: t.serialized + 3 * (2000 + 4000 + OVERHEAD_TOKENS) + 4000, output: 2000 + 3 * ANSWER_OUTPUT_TOKENS, cacheable: t.serialized };
          default: return { input: t.full, output: ANSWER_OUTPUT_TOKENS, cacheable: 0 };
        }
      })();
      const mid = armRow.midCheckpoint === null ? 0 : plan.repeats;
      upper += probes * usd(perProbe.input, perProbe.output) + mid * usd(Math.ceil(t.serialized * 0.6), 2000);
      const repeatsWithCold = plan.repeats;
      expected += repeatsWithCold * usd(perProbe.input, perProbe.output)
        + (probes - repeatsWithCold) * usd(perProbe.input - perProbe.cacheable, perProbe.output, perProbe.cacheable)
        + mid * usd(Math.ceil(t.serialized * 0.6), 2000);
      const upkeep = armRow.ledgerUpkeep ? plan.repeats * plan.upkeep.preparations.reduce((sum, step) => sum + usd(step.maxInputTokens, step.maxOutputTokens, 0, upkeepPrice), 0) : 0;
      upper += upkeep; expected += upkeep; upkeepBudgetUsd += upkeep;
      inputTokens += probes * perProbe.input + (armRow.ledgerUpkeep ? plan.upkeep.preparations.reduce((sum, step) => sum + step.maxInputTokens, 0) * plan.repeats : 0);
    }
    rows[armRow.id] = { ...(armRow.ledgerUpkeep ? { upkeepBudgetUsd: Number(upkeepBudgetUsd.toFixed(4)), upkeepCalls: traces.length * plan.repeats * plan.upkeep.callsPerTraceRepeat } : {}), inputTokens, upperUsd: Number(upper.toFixed(4)), expectedUsd: Number(expected.toFixed(4)) };
  }
  const judgeUsd = judgePrice ? plan.workload.judgeCalls * (600 * judgePrice.input + 20 * judgePrice.output) / 1_000_000 : null;
  const sum = (key) => Object.values(rows).reduce((total, row) => total + row[key], 0) + (judgeUsd ?? 0);
  return { status: "estimated", basis: "Pi catalog list prices; chars/4 token heuristic; summaries at their output cap and deterministic packs at 8k for the upper bound",
    upkeepCaveat: "4096 is a planning output budget, not a hard server limit under Codex stream_abort: hidden reasoning/remote work can overrun. Subscription/quota is not dollar metering.",
    arms: rows, judgeUsd: judgeUsd === null ? null : Number(judgeUsd.toFixed(4)),
    upperUsd: Number(sum("upperUsd").toFixed(2)), expectedUsd: Number(sum("expectedUsd").toFixed(2)) };
}
