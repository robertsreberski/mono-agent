import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BUILD_POLICY } from "./memory-e2e-build.mjs";

export const ARMS = Object.freeze(["recent-only", "full-history", "lite", "journal", "bujo"]);
export const PROTOCOL = "memory-e2e-v1";
export const LIMITS = Object.freeze({
  // Capture/reconcile provenance and absolute-time guidance enlarges prompt reservations.
  development: { chatSteps: 46, embeddingCalls: 100, estimatedInputTokens: 282000, outputTokens: 50000, runtimeMs: 900000 },
  evaluation: { chatSteps: 138, embeddingCalls: 300, estimatedInputTokens: 846000, outputTokens: 150000, runtimeMs: 2400000 },
});
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/**
 * Selectable fictional corpora. A closed allow-list, never a caller-supplied
 * path: the name only ever indexes this map.
 *
 * `fictional-v1` keeps its exact prior shape and semantics (four turns per
 * group, all five arms). A corpus may narrow those two axes for a different
 * question; everything else — build, digest, budget, provider, cleanup and
 * redaction paths — is shared unchanged.
 */
export const CORPORA = Object.freeze(["fictional-v1", "bujo-learning-v1", "capture-fidelity-v1"]);
const ADAPTER_CORPORA = Object.freeze(["locomo-v1"]);
const ALL_CORPORA = Object.freeze([...CORPORA, ...ADAPTER_CORPORA]);

export async function loadCorpus(name = "fictional-v1") {
  if (!CORPORA.includes(name)) throw new Error("invalid_corpus_name");
  const bytes = await readFile(new URL(`../fixtures/memory-e2e/${name}.json`, import.meta.url), "utf8");
  const corpus = JSON.parse(bytes);
  validateCorpus(corpus);
  if (corpus.name !== name) throw new Error("invalid_corpus");
  return { corpus, sha256: digest(bytes) };
}

/** Per-group turn bounds. Absent means the original exact-four contract. */
function turnBounds(corpus) {
  const declared = corpus.turnsPerGroup ?? { min: 4, max: 4 };
  const { min, max } = declared;
  const maximum = corpus.name === "locomo-v1" ? 1024 : 8;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max > maximum || min > max) {
    throw new Error("invalid_turn_bounds");
  }
  return { min, max };
}

/** Arms this corpus exercises. Absent means every arm, as before. */
export function armsFor(corpus) {
  const declared = corpus.arms ?? ARMS;
  if (!Array.isArray(declared) || declared.length === 0 || new Set(declared).size !== declared.length
    || !declared.every((arm) => ARMS.includes(arm))) {
    throw new Error("invalid_arms");
  }
  return declared;
}

function text(value) { return typeof value === "string" && value.trim().length > 0; }
function instant(value) { return text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function questionsFor(group) {
  if (Array.isArray(group.questions)) return group.questions;
  return [{ id: group.id, source: group.source?.question, evaluation: group.evaluation }];
}

function validateTurns(values, { min, max }, error) {
  if (!Array.isArray(values) || values.length < min || values.length > max) throw new Error(error);
  let previous = -Infinity;
  const ids = new Set();
  for (const turn of values) {
    if (!text(turn.id) || ids.has(turn.id) || !text(turn.sessionId) || !text(turn.speaker) || !text(turn.user)
      || !text(turn.assistant) || !instant(turn.timestamp) || Date.parse(turn.timestamp) < previous) throw new Error("invalid_turn");
    ids.add(turn.id);
    previous = Date.parse(turn.timestamp);
  }
  return { ids, previous };
}

export function validateCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || !ALL_CORPORA.includes(corpus.name) || !Array.isArray(corpus.groups)) throw new Error("invalid_corpus");
  const bounds = turnBounds(corpus);
  armsFor(corpus);
  const ids = new Set();
  for (const group of corpus.groups) {
    if (!/^[a-z0-9-]+$/u.test(group.id) || ids.has(group.id) || !Object.hasOwn(LIMITS, group.split)) throw new Error("invalid_group");
    ids.add(group.id);
    const validated = validateTurns(group.source?.turns, bounds, "invalid_turns");
    let capture = validated;
    if (group.source?.captureTurns !== undefined) {
      if (corpus.name !== "locomo-v1") throw new Error("invalid_capture_turns");
      capture = validateTurns(group.source.captureTurns, { min: 1, max: 1024 }, "invalid_capture_turns");
    }
    const questions = questionsFor(group);
    if (questions.length === 0 || new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("invalid_questions");
    for (const question of questions) {
      if (!text(question.id) || !text(question.source?.text) || !instant(question.source.timestamp) || Date.parse(question.source.timestamp) < validated.previous) throw new Error("invalid_question");
      const evaluation = question.evaluation;
      if (typeof evaluation?.answerable !== "boolean" || !Array.isArray(evaluation.accepted) || !evaluation.accepted.every(text)
        || !Array.isArray(evaluation.forbidden) || !evaluation.forbidden.every(text)
        || !Array.isArray(evaluation.evidenceTurnIds) || !evaluation.evidenceTurnIds.every((id) => validated.ids.has(id))
        || (evaluation.evidenceCaptureTurnIds !== undefined && (!Array.isArray(evaluation.evidenceCaptureTurnIds)
          || !evaluation.evidenceCaptureTurnIds.every((id) => capture.ids.has(id))))) throw new Error("invalid_evaluation");
    }
  }
}

/**
 * Plan-safe profile projection. The raw execution-only Pi auth path never
 * enters the manifest: it is replaced by a deterministic SHA-256 fingerprint
 * of its lexically resolved form, so changing the auth selection invalidates
 * the dry-run confirmation digest without recording the path, credential
 * bytes, content or mtime. No filesystem or credential access happens here.
 */
export function serializableProfile(profile) {
  if (profile === null || profile === undefined) return profile;
  const { piAuthPath, ...rest } = profile;
  if (piAuthPath === undefined) return { ...rest };
  return { ...rest, piAuthFingerprint: digest(resolve(piAuthPath)) };
}

/** Closed projection: never forward annotations, unknown fields, or original group objects. */
export function sourceOnly(group) {
  const projectTurns = (turns) => turns.map(
    ({ id, sessionId, timestamp, speaker, user, assistant }) => ({ id, sessionId, timestamp, speaker, user, assistant }),
  );
  const source = {
    id: group.id,
    turns: projectTurns(group.source.turns),
    ...(Array.isArray(group.source.captureTurns) ? { captureTurns: projectTurns(group.source.captureTurns) } : {}),
    ...(group.source.contextPolicy === "memory-only" ? { contextPolicy: "memory-only" } : {}),
  };
  if (Array.isArray(group.questions)) {
    return { ...source, questions: group.questions.map((question) => ({ id: question.id, text: question.source.text, timestamp: question.source.timestamp })) };
  }
  return { ...source, question: { text: group.source.question.text, timestamp: group.source.question.timestamp } };
}

export function contextFor(source, arm) {
  const turns = source.contextPolicy === "memory-only" && arm !== "full-history" ? [] : arm === "full-history" ? source.turns : source.turns.slice(-1);
  const messages = turns.flatMap((turn) => [
    { role: "user", name: turn.speaker, timestamp: turn.timestamp, content: turn.user },
    { role: "assistant", timestamp: turn.timestamp, content: turn.assistant },
  ]);
  // Never slice UTF-8 or individual facts. The fixed recent fixture fits; reject oversized input.
  if (arm !== "full-history" && Buffer.byteLength(JSON.stringify(messages)) > 2048) throw new Error("recent_context_overflow");
  return messages;
}

function budgetEnforcementFor(profile) {
  const references = [profile?.reader, profile?.extractor].filter((value) => typeof value === "string");
  const codexWireCapUnsupported = references.some((value) => value.startsWith("openai-codex:"));
  const measuredOutput = profile?.outputBudgetMode === "measured";
  return {
    providerTransport: {
      requested: "sse",
      piMaxRetries: 0,
      automaticWebSocketFallback: false,
      observedAttempts: "unknown_unless_provider_reports",
    },
    outputTokens: {
      accounting: measuredOutput ? "pre_admission_reservation_plus_observed_usage" : "pre_admission_reservation",
      providerHint: "providerCheckMaxTokens",
      wireCap: references.length === 0
        ? "not_applicable_to_scripted_run"
        : codexWireCapUnsupported ? "unsupported_by_selected_openai_codex_provider" : "unverified_for_selected_provider",
      strictRealExecutionSupported: references.length === 0 ? null : codexWireCapUnsupported ? false : null,
      executionMode: measuredOutput ? "measured_output_explicit_opt_in" : "strict_output_cap_required",
    },
  };
}

export function makePlan({ corpus, sha256, split = "development", profile = null, codeRevision = null, limits = LIMITS[split], perCall = {} }) {
  if (!Object.hasOwn(LIMITS, split)) throw new Error("invalid_split");
  const groups = corpus.groups.filter((group) => group.split === split);
  if (groups.length === 0) throw new Error("empty_corpus_split");
  const turns = groups.reduce((sum, group) => sum + group.source.turns.length, 0);
  const questions = groups.flatMap(questionsFor);
  const arms = armsFor(corpus);
  const manifest = {
    protocol: PROTOCOL, realBuildPolicy: BUILD_POLICY, corpus: corpus.name, corpusSha256: sha256, split, codeRevision,
    groupIds: groups.map((group) => group.id), arms, repeats: 1, order: "fixed-listed-order",
    profile: serializableProfile(profile), limits,
    workload: { questions: questions.length, trials: questions.length * arms.length, historicalTurnsPerMemoryArm: turns, captureStepsMaximum: turns * 2, readerStepsMaximum: questions.length * arms.length * 3 },
    perCall: { readerMaxTurns: 3, readerOutputTokens: 512, extractorOutputTokens: 2048, readerEstimatedInputTokens: 16384, extractorEstimatedInputTokens: 8192, readerHistoryHeadroomMessages: 8, framingAndToolAllowance: 4096, callTimeoutMs: 60000, embeddingTimeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS, readinessTimeoutMs: 120000, cleanupTimeoutMs: 10000, ...perCall },
    budgetEnforcement: budgetEnforcementFor(profile),
    limitations: ["controlled-text token reservations are conservative ceilings, not actual provider spend", "providerCheckMaxTokens is not a universal wire-enforced output cap", profile?.outputBudgetMode === "measured" ? "explicit measured-output mode records observed usage but does not enforce a wire output cap" : "strict real execution is refused for a selected provider known to omit that cap", "native payload/context limits require an explicit capability probe", "transport attempt count unknown unless provider reports it", "fixed arm order; cache warmth uncontrolled", "one repeat; quality/human grading unmeasured"],
  };
  return { ...manifest, confirmation: digest(manifest) };
}
