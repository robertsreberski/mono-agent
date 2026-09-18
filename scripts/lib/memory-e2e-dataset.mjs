import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

export async function loadCorpus() {
  const bytes = await readFile(new URL("../fixtures/memory-e2e/fictional-v1.json", import.meta.url), "utf8");
  const corpus = JSON.parse(bytes);
  validateCorpus(corpus);
  return { corpus, sha256: digest(bytes) };
}

function text(value) { return typeof value === "string" && value.trim().length > 0; }
function instant(value) { return text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function validateCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || corpus.name !== "fictional-v1" || !Array.isArray(corpus.groups)) throw new Error("invalid_corpus");
  const ids = new Set();
  for (const group of corpus.groups) {
    if (!/^[a-z-]+$/u.test(group.id) || ids.has(group.id) || !Object.hasOwn(LIMITS, group.split)) throw new Error("invalid_group");
    ids.add(group.id);
    if (!Array.isArray(group.source?.turns) || group.source.turns.length !== 4) throw new Error("invalid_turns");
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
  const manifest = {
    protocol: PROTOCOL, realBuildPolicy: BUILD_POLICY, corpus: corpus.name, corpusSha256: sha256, split, codeRevision,
    groupIds: groups.map((group) => group.id), arms: ARMS, repeats: 1, order: "fixed-listed-order",
    profile, limits: LIMITS[split],
    workload: { questions: groups.length, trials: groups.length * ARMS.length, historicalTurnsPerMemoryArm: turns, captureStepsMaximum: turns * 2, readerStepsMaximum: groups.length * ARMS.length * 3 },
    perCall: { readerOutputTokens: 512, extractorOutputTokens: 2048, readerEstimatedInputTokens: 16384, extractorEstimatedInputTokens: 8192, framingAndToolAllowance: 4096, callTimeoutMs: 60000, embeddingTimeoutMs: 10000, readinessTimeoutMs: 120000, cleanupTimeoutMs: 10000 },
    limitations: ["controlled-text input estimates, not native payload limits", "transport attempt count unknown unless provider reports it", "fixed arm order; cache warmth uncontrolled", "one repeat; quality/human grading unmeasured"],
  };
  return { ...manifest, confirmation: digest(manifest) };
}
