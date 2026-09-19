import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BUILD_POLICY } from "./memory-e2e-build.mjs";

export const ARMS = Object.freeze(["recent-only", "full-history", "lite", "journal", "bujo"]);
export const PROTOCOL = "memory-e2e-v1";
export const LIMITS = Object.freeze({
  development: { chatSteps: 46, embeddingCalls: 100, estimatedInputTokens: 250000, outputTokens: 50000, runtimeMs: 900000 },
  evaluation: { chatSteps: 138, embeddingCalls: 300, estimatedInputTokens: 750000, outputTokens: 150000, runtimeMs: 2400000 },
});
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
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max > 8 || min > max) {
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
export function validateCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || !CORPORA.includes(corpus.name) || !Array.isArray(corpus.groups)) throw new Error("invalid_corpus");
  const bounds = turnBounds(corpus);
  armsFor(corpus);
  const ids = new Set();
  for (const group of corpus.groups) {
    if (!/^[a-z-]+$/u.test(group.id) || ids.has(group.id) || !Object.hasOwn(LIMITS, group.split)) throw new Error("invalid_group");
    ids.add(group.id);
    if (!Array.isArray(group.source?.turns)
      || group.source.turns.length < bounds.min || group.source.turns.length > bounds.max) throw new Error("invalid_turns");
    let previous = -Infinity;
    const turns = new Set();
    for (const turn of group.source.turns) {
      if (!text(turn.id) || turns.has(turn.id) || !text(turn.sessionId) || !text(turn.speaker) || !text(turn.user) || !text(turn.assistant) || !instant(turn.timestamp) || Date.parse(turn.timestamp) < previous) throw new Error("invalid_turn");
      turns.add(turn.id);
      previous = Date.parse(turn.timestamp);
    }
    if (!text(group.source.question?.text) || !instant(group.source.question.timestamp) || Date.parse(group.source.question.timestamp) < previous) throw new Error("invalid_question");
    if (typeof group.evaluation?.answerable !== "boolean" || !Array.isArray(group.evaluation.accepted) || !Array.isArray(group.evaluation.forbidden) || !group.evaluation.evidenceTurnIds.every((id) => turns.has(id))) throw new Error("invalid_evaluation");
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
  return {
    id: group.id,
    turns: group.source.turns.map(({ id, sessionId, timestamp, speaker, user, assistant }) => ({ id, sessionId, timestamp, speaker, user, assistant })),
    question: { text: group.source.question.text, timestamp: group.source.question.timestamp },
  };
}

export function contextFor(source, arm) {
  const turns = arm === "full-history" ? source.turns : source.turns.slice(-1);
  const messages = turns.flatMap((turn) => [
    { role: "user", name: turn.speaker, timestamp: turn.timestamp, content: turn.user },
    { role: "assistant", timestamp: turn.timestamp, content: turn.assistant },
  ]);
  // Never slice UTF-8 or individual facts. The fixed recent fixture fits; reject oversized input.
  if (arm !== "full-history" && Buffer.byteLength(JSON.stringify(messages)) > 2048) throw new Error("recent_context_overflow");
  return messages;
}

export function makePlan({ corpus, sha256, split = "development", profile = null, codeRevision = null }) {
  if (!Object.hasOwn(LIMITS, split)) throw new Error("invalid_split");
  const groups = corpus.groups.filter((group) => group.split === split);
  const turns = groups.reduce((sum, group) => sum + group.source.turns.length, 0);
  const arms = armsFor(corpus);
  const manifest = {
    protocol: PROTOCOL, realBuildPolicy: BUILD_POLICY, corpus: corpus.name, corpusSha256: sha256, split, codeRevision,
    groupIds: groups.map((group) => group.id), arms, repeats: 1, order: "fixed-listed-order",
    profile: serializableProfile(profile), limits: LIMITS[split],
    workload: { questions: groups.length, trials: groups.length * arms.length, historicalTurnsPerMemoryArm: turns, captureStepsMaximum: turns * 2, readerStepsMaximum: groups.length * arms.length * 3 },
    perCall: { readerOutputTokens: 512, extractorOutputTokens: 2048, readerEstimatedInputTokens: 16384, extractorEstimatedInputTokens: 8192, framingAndToolAllowance: 4096, callTimeoutMs: 60000, embeddingTimeoutMs: 10000, readinessTimeoutMs: 120000, cleanupTimeoutMs: 10000 },
    limitations: ["controlled-text input estimates, not native payload limits", "transport attempt count unknown unless provider reports it", "fixed arm order; cache warmth uncontrolled", "one repeat; quality/human grading unmeasured"],
  };
  return { ...manifest, confirmation: digest(manifest) };
}
