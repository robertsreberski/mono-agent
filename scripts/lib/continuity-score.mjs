// Deterministic probe scoring and aggregation for the continuity benchmark.
// Pure functions: no provider, filesystem or clock access.

export const CATEGORIES = Object.freeze([
  "tool_identifier",
  "active_constraint",
  "superseded_current",
  "commitment_status",
  "artifact_status",
  "next_action",
  "abstention",
]);

export const SCORE_KINDS = Object.freeze(["identifier", "value", "choice", "constraint_recall", "constraint_task", "abstain", "next_action"]);

export const ABSTAIN_TOKEN = "UNKNOWN";
// Tool results are part of the conversation: without saying so, readers treat a
// value seen only in a tool result as "never discussed" and abstain.
export const ABSTAIN_INSTRUCTION = `If it never appeared anywhere in this conversation, including tool results, reply exactly ${ABSTAIN_TOKEN}.`;
export const PROBE_PREFIX = "Quick check about this conversation so far, including anything you looked up or that tools returned along the way (don't look anything up now):";

const ABSTAIN_PHRASES = /\b(?:never (?:came up|mentioned|stated|said|discussed|told)|(?:not|wasn'?t|was not|isn'?t|weren'?t) (?:mentioned|stated|discussed|specified|shared|given|provided)|no record|(?:don'?t|do not) (?:know|have (?:that|this|any))|(?:didn'?t|did not) (?:mention|say|come up|share|give)|not in our conversation|no information)\b/iu;

/** Exact model-visible probe message; the evaluator projection never enters it. */
export function probePrompt(probe) {
  return [PROBE_PREFIX, probe.question, probe.format, probe.abstainOption ? ABSTAIN_INSTRUCTION : null]
    .filter((part) => typeof part === "string" && part.length > 0).join(" ");
}

export function compactIdentifier(text) {
  return String(text).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

export function isAbstention(answer) {
  const text = String(answer ?? "");
  return new RegExp(`\\b${ABSTAIN_TOKEN}\\b`, "u").test(text) || ABSTAIN_PHRASES.test(text);
}

function regex(pattern) { return new RegExp(pattern, "iu"); }
function anyMatch(patterns, text) { return (patterns ?? []).some((pattern) => regex(pattern).test(text)); }
function allGroups(groups, text) { return (groups ?? []).every((group) => anyMatch(group, text)); }

/** Validate one probe's scoring contract; throws a stable code. */
export function validateProbeScore(probe) {
  const score = probe?.score;
  if (!score || !SCORE_KINDS.includes(score.kind)) throw new Error("invalid_probe_score");
  const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
  const groups = (value) => Array.isArray(value) && value.length > 0 && value.every(strings);
  const compiles = (patterns) => { for (const pattern of patterns ?? []) regex(pattern); return true; };
  switch (score.kind) {
    case "identifier":
      if (!strings(score.accept) || (score.reject !== undefined && !strings(score.reject))) throw new Error("invalid_probe_score");
      break;
    case "value":
      if (!strings(score.accept) || !strings(score.superseded) || !compiles(score.accept) || !compiles(score.superseded)) throw new Error("invalid_probe_score");
      break;
    case "choice":
      if (!strings(score.options) || !score.options.includes(score.expected)
        || score.options.some((option) => !/^[A-Z][A-Z_]*$/u.test(option))) throw new Error("invalid_probe_score");
      break;
    case "constraint_recall":
      if (!groups(score.requireAll) || !compiles(score.requireAll.flat())) throw new Error("invalid_probe_score");
      break;
    case "constraint_task":
      if (!strings(score.forbidden) || !compiles(score.forbidden)) throw new Error("invalid_probe_score");
      break;
    case "abstain":
      break;
    case "next_action":
      if (!groups(score.proxyAll) || typeof score.rubric !== "string" || score.rubric.length < 20 || !compiles(score.proxyAll.flat())) throw new Error("invalid_probe_score");
      break;
    default:
      throw new Error("invalid_probe_score");
  }
  return true;
}

/**
 * Score one answer. Outcomes:
 *  correct | stale (superseded/decoy only) | conflicted (both) | abstained |
 *  wrong | violation (constraint broken) | fabricated (answered an unstated fact)
 */
export function scoreAnswer(probe, answer) {
  const text = String(answer ?? "").trim();
  const abstained = isAbstention(text);
  const score = probe.score;
  const result = (pass, outcome, extra = {}) => ({ pass, outcome, abstained, falseAbstention: !pass && abstained && score.kind !== "abstain", ...extra });
  if (text.length === 0) return result(false, "empty");
  switch (score.kind) {
    case "identifier": {
      const compact = compactIdentifier(text);
      const hit = score.accept.some((value) => compact.includes(compactIdentifier(value)));
      const decoy = (score.reject ?? []).some((value) => compact.includes(compactIdentifier(value)));
      if (hit && !decoy) return result(true, "correct");
      if (hit && decoy) return result(false, "conflicted");
      if (decoy) return result(false, "stale");
      return result(false, abstained ? "abstained" : "wrong");
    }
    case "value": {
      const hit = anyMatch(score.accept, text);
      const stale = anyMatch(score.superseded, text);
      if (hit && !stale) return result(true, "correct");
      if (hit && stale) return result(false, "conflicted");
      if (stale) return result(false, "stale");
      return result(false, abstained ? "abstained" : "wrong");
    }
    case "choice": {
      // The first listed status token in the answer is the answer; models lead with it.
      const upper = text.toUpperCase();
      let first = null; let firstIndex = Infinity;
      for (const option of score.options) {
        const match = new RegExp(`(?<![A-Z0-9])${option.split("_").join("[\\s_-]+")}(?![A-Z0-9])`, "u").exec(upper);
        if (match && match.index < firstIndex) { first = option; firstIndex = match.index; }
      }
      if (first === score.expected) return result(true, "correct", { selected: first });
      if (first === null) return result(false, abstained ? "abstained" : "wrong", { selected: null });
      return result(false, "wrong", { selected: first });
    }
    case "constraint_recall":
      return allGroups(score.requireAll, text) ? result(true, "correct") : result(false, abstained ? "abstained" : "wrong");
    case "constraint_task": {
      const violated = score.forbidden.filter((pattern) => regex(pattern).test(text));
      if (violated.length > 0) return result(false, "violation", { violatedPatterns: violated.length });
      return result(true, "correct");
    }
    case "abstain":
      return abstained ? result(true, "correct") : result(false, "fabricated");
    case "next_action":
      return allGroups(score.proxyAll, text) ? result(true, "correct") : result(false, abstained ? "abstained" : "wrong");
    default:
      throw new Error("invalid_probe_score");
  }
}

/** Strict judge reply parser: one JSON object with verdict pass|fail. */
export function parseJudgeVerdict(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ""));
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return value?.verdict === "pass" || value?.verdict === "fail" ? value.verdict : null;
  } catch { return null; }
}

export function judgePrompt(probe, answer) {
  return [
    "You grade one answer from an assistant in a fictional evaluation conversation.",
    "Pass when the answer states the reference's essential action and deadline, even if it omits optional details or adds correct extra detail. Fail when the action or deadline is wrong, superseded or missing, or the answer is UNKNOWN.",
    `Reference (evaluator-only): ${probe.score.rubric}`,
    `Question asked: ${probe.question}`,
    `Answer to grade:\n<<<\n${String(answer ?? "")}\n>>>`,
    'Reply with exactly one JSON object and nothing else: {"verdict":"pass"} or {"verdict":"fail"}.',
  ].join("\n\n");
}

function mean(values) { return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleSd(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}
const round = (value, digits = 4) => (value === null ? null : Number(value.toFixed(digits)));

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
export function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, unknownCostCalls: 0, unknownTokenCalls: 0 };
}
export function addUsage(total, usage) {
  if (!usage) return total;
  total.calls += usage.calls ?? 1;
  let unknownTokens = false;
  for (const field of USAGE_FIELDS) {
    if (typeof usage[field] === "number") total[field] += usage[field]; else unknownTokens = true;
  }
  if (unknownTokens) total.unknownTokenCalls += usage.unknownTokenCalls ?? 1;
  if (typeof usage.estimatedCostUsd === "number") total.estimatedCostUsd += usage.estimatedCostUsd;
  else total.unknownCostCalls += usage.unknownCostCalls ?? 1;
  return total;
}

function accuracyBlock(trials, repeats) {
  const perRepeat = repeats.map((repeat) => {
    const rows = trials.filter((trial) => trial.repeat === repeat);
    return { repeat, n: rows.length, correct: rows.filter((trial) => trial.score.pass).length };
  }).filter((row) => row.n > 0);
  const accuracies = perRepeat.map((row) => row.correct / row.n);
  return {
    n: trials.length,
    correct: trials.filter((trial) => trial.score.pass).length,
    accuracy: round(mean(accuracies)),
    repeatSd: round(sampleSd(accuracies)),
    repeatRange: accuracies.length ? [round(Math.min(...accuracies)), round(Math.max(...accuracies))] : null,
    perRepeat,
  };
}

/** Aggregate scored trials into per-arm, per-category accuracy with deltas, variance and spend. */
export function summarize(trials, { arms, baselineArm, repeats, extraUsage = [] }) {
  const scored = trials.filter((trial) => trial.status === "completed");
  const repeatList = [...new Set(repeats ?? trials.map((trial) => trial.repeat))].sort((a, b) => a - b);
  const byArm = {};
  for (const arm of arms) {
    const armTrials = scored.filter((trial) => trial.arm === arm);
    const categories = {};
    for (const category of CATEGORIES) categories[category] = accuracyBlock(armTrials.filter((trial) => trial.category === category), repeatList);
    const outcomes = {};
    for (const trial of armTrials) outcomes[trial.score.outcome] = (outcomes[trial.score.outcome] ?? 0) + 1;
    const keyed = new Map();
    for (const trial of armTrials) {
      const key = `${trial.traceId}\0${trial.probeId}`;
      keyed.set(key, [...(keyed.get(key) ?? []), trial.score.pass]);
    }
    const repeated = [...keyed.values()].filter((values) => values.length >= 2);
    const usage = emptyUsage(); const compactionUsage = emptyUsage();
    for (const trial of trials.filter((row) => row.arm === arm)) {
      addUsage(usage, trial.usage);
      if (trial.compactionUsage?.calls) addUsage(compactionUsage, trial.compactionUsage);
    }
    for (const extra of extraUsage.filter((row) => row.arm === arm)) {
      addUsage(usage, extra.usage);
      if (extra.compactionUsage?.calls) addUsage(compactionUsage, extra.compactionUsage);
    }
    const allArm = trials.filter((trial) => trial.arm === arm);
    byArm[arm] = {
      overall: accuracyBlock(armTrials, repeatList),
      categories,
      outcomes,
      falseAbstentions: armTrials.filter((trial) => trial.score.falseAbstention).length,
      flipRate: repeated.length ? round(repeated.filter((values) => new Set(values).size > 1).length / repeated.length) : null,
      flipSamples: repeated.length,
      excluded: {
        boundaryUnverified: allArm.filter((trial) => trial.status === "boundary_unverified").length,
        failed: allArm.filter((trial) => !["completed", "boundary_unverified"].includes(trial.status)).length,
      },
      usage,
      compactionUsage,
    };
  }
  const baseline = byArm[baselineArm];
  for (const arm of arms) {
    const row = byArm[arm];
    const delta = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : round(a - b));
    row.deltaVsBaseline = {
      overall: delta(row.overall.accuracy, baseline?.overall.accuracy),
      categories: Object.fromEntries(CATEGORIES.map((category) => [category, delta(row.categories[category].accuracy, baseline?.categories[category].accuracy)])),
    };
  }
  const judged = scored.filter((trial) => trial.category === "next_action" && (trial.judge?.verdict === "pass" || trial.judge?.verdict === "fail"));
  const judge = {
    judgedSamples: judged.length,
    invalidOrMissing: scored.filter((trial) => trial.category === "next_action" && trial.judge && !["pass", "fail"].includes(trial.judge.verdict)).length,
    agreementWithDeterministicProxy: judged.length ? round(judged.filter((trial) => (trial.judge.verdict === "pass") === trial.score.pass).length / judged.length) : null,
    judgePassOnlyCount: judged.filter((trial) => trial.judge.verdict === "pass" && !trial.score.pass).length,
    proxyPassOnlyCount: judged.filter((trial) => trial.judge.verdict === "fail" && trial.score.pass).length,
    byArm: Object.fromEntries(arms.map((arm) => {
      const rows = judged.filter((trial) => trial.arm === arm);
      return [arm, { n: rows.length, judgeAccuracy: rows.length ? round(rows.filter((trial) => trial.judge.verdict === "pass").length / rows.length) : null,
        proxyAccuracy: rows.length ? round(rows.filter((trial) => trial.score.pass).length / rows.length) : null }];
    })),
  };
  return { baselineArm, repeats: repeatList, arms: byArm, judge };
}

function pct(value) { return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`; }
function pp(value) { return value === null || value === undefined ? "–" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`; }

/** Human-readable Markdown tables (fictional content only; no paths). */
export function renderMarkdown(summary, { qualityMeasured, armLabels = {}, judgeUsage = null }) {
  const arms = Object.keys(summary.arms);
  const lines = [];
  lines.push(qualityMeasured ? "# Continuity benchmark results" : "# Continuity benchmark contract run (NOT model quality)");
  lines.push("");
  lines.push(`Baseline arm: \`${summary.baselineArm}\`. Repeats: ${summary.repeats.join(", ")}. Accuracy is the mean of per-repeat accuracies; SD is across repeats.`);
  lines.push("");
  lines.push("| Arm | n | Accuracy | Δ vs baseline (pp) | Repeat SD | Flip rate | Boundary-unverified | Failed |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const arm of arms) {
    const row = summary.arms[arm];
    lines.push(`| ${armLabels[arm] ?? arm} | ${row.overall.n} | ${pct(row.overall.accuracy)} | ${pp(row.deltaVsBaseline.overall)} | ${pct(row.overall.repeatSd)} | ${pct(row.flipRate)} | ${row.excluded.boundaryUnverified} | ${row.excluded.failed} |`);
  }
  lines.push("");
  lines.push(`| Category | ${arms.map((arm) => armLabels[arm] ?? arm).join(" | ")} |`);
  lines.push(`| --- | ${arms.map(() => "---:").join(" | ")} |`);
  for (const category of CATEGORIES) {
    lines.push(`| ${category}${category === "next_action" ? " (proxy)" : ""} | ${arms.map((arm) => {
      const cell = summary.arms[arm].categories[category];
      const delta = arm === summary.baselineArm ? "" : ` (${pp(summary.arms[arm].deltaVsBaseline.categories[category])})`;
      return `${pct(cell.accuracy)}${delta} n=${cell.n}`;
    }).join(" | ")} |`);
  }
  lines.push("");
  lines.push("| Arm | Live calls | Input | Cache read | Cache write | Output | Est. cost USD | Unknown-cost calls | of which compaction calls / est. USD |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const arm of arms) {
    const usage = summary.arms[arm].usage; const compaction = summary.arms[arm].compactionUsage;
    lines.push(`| ${armLabels[arm] ?? arm} | ${usage.calls} | ${usage.inputTokens} | ${usage.cacheReadTokens} | ${usage.cacheWriteTokens} | ${usage.outputTokens} | ${usage.estimatedCostUsd.toFixed(4)} | ${usage.unknownCostCalls} | ${compaction.calls} / ${compaction.estimatedCostUsd.toFixed(4)} |`);
  }
  if (judgeUsage) lines.push(`| judge | ${judgeUsage.calls} | ${judgeUsage.inputTokens} | ${judgeUsage.cacheReadTokens} | ${judgeUsage.cacheWriteTokens} | ${judgeUsage.outputTokens} | ${judgeUsage.estimatedCostUsd.toFixed(4)} | ${judgeUsage.unknownCostCalls} | – |`);
  lines.push("");
  const judge = summary.judge;
  lines.push(`Judge (next_action only): ${judge.judgedSamples} judged, ${judge.invalidOrMissing} invalid/missing, agreement with deterministic proxy ${pct(judge.agreementWithDeterministicProxy)} (judge-only pass ${judge.judgePassOnlyCount}, proxy-only pass ${judge.proxyPassOnlyCount}).`);
  lines.push("");
  lines.push(`| Arm | next_action judge accuracy | next_action proxy accuracy | n |`);
  lines.push("| --- | ---: | ---: | ---: |");
  for (const arm of arms) {
    const row = judge.byArm[arm];
    lines.push(`| ${armLabels[arm] ?? arm} | ${pct(row.judgeAccuracy)} | ${pct(row.proxyAccuracy)} | ${row.n} |`);
  }
  lines.push("");
  return lines.join("\n");
}
