import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { digest, makePlan, validateCorpus } from "./memory-e2e-dataset.mjs";

export const LOCOMO = Object.freeze({
  corpus: "locomo-v1",
  revision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
  path: "data/locomo10.json",
  gitBlob: "d95b872480b413d935821fdc3c84f8a8f5f29e73",
  bytes: 2_805_274,
  sha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
  license: "CC BY-NC 4.0",
  source: "https://github.com/snap-research/locomo",
});

const CATEGORY_NAMES = Object.freeze({ 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" });
const MONTHS = Object.freeze({ january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 });
const MAX_CAPTURE_MEMORIES = 8;
const MAX_CAPTURE_MEMORY_CODE_POINTS = 160;
const MAX_RECONCILED_MEMORY_CODE_POINTS = 280;
const MAX_RECALL_QUERY_CODE_POINTS = 4_000;
const UTF8_BYTES_PER_CODE_POINT = 4;
const INPUT_ESTIMATE_DIVISOR = 3;

export const LOCOMO_EVALUATOR = Object.freeze({
  revision: LOCOMO.revision,
  path: "task_eval/evaluation.py",
  gitBlob: "8f597dd687e66832da1f6f04a169e05622049576",
  category5Rule: "output contains 'no information available' or 'not mentioned'",
});

function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function sessionNumber(key) { return Number(key.slice("session_".length)); }
function sessionKeys(conversation) {
  return Object.keys(conversation)
    .filter((key) => /^session_[1-9][0-9]*$/u.test(key) && Array.isArray(conversation[key]))
    .sort((left, right) => sessionNumber(left) - sessionNumber(right));
}

/** Parse the single upstream timestamp grammar without locale or host-timezone dependence. */
export function parseLocomoTimestamp(value) {
  const match = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/u.exec(value);
  if (!match) throw new Error("locomo_invalid_timestamp");
  const [, hourText, minuteText, meridiem, dayText, monthText, yearText] = match;
  const month = MONTHS[monthText.toLowerCase()];
  let hour = Number(hourText);
  const minute = Number(minuteText); const day = Number(dayText); const year = Number(yearText);
  if (month === undefined || hour < 1 || hour > 12 || minute > 59 || day < 1 || day > 31) throw new Error("locomo_invalid_timestamp");
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) throw new Error("locomo_invalid_timestamp");
  return date.toISOString();
}

/**
 * One completed-turn episode per upstream session. Every human utterance remains
 * a reported statement in the user payload; neither human is recast as the host
 * assistant. Image URLs, captions, queries, summaries and annotations are omitted.
 */
export function projectLocomoSession(conversation, key) {
  const timestamp = parseLocomoTimestamp(conversation[`${key}_date_time`]);
  const dialogue = conversation[key];
  if (!Array.isArray(dialogue) || dialogue.length === 0) throw new Error("locomo_invalid_session");
  const seen = new Set();
  const reports = dialogue.map((entry) => {
    if (!nonempty(entry?.dia_id) || seen.has(entry.dia_id) || !nonempty(entry?.speaker) || !nonempty(entry?.text)) throw new Error("locomo_invalid_dialogue");
    seen.add(entry.dia_id);
    return `${entry.speaker.trim()} reported: ${entry.text.trim()}`;
  });
  return {
    id: key,
    sessionId: key,
    timestamp,
    speaker: "LoCoMo transcript",
    user: reports.join("\n"),
    assistant: "The session transcript was recorded without adding claims.",
    dialogueIds: dialogue.map((entry) => entry.dia_id),
  };
}

function selectedQuestions(sample, dialogueToSession, finalTimestamp) {
  const selected = [];
  const missingCategories = [];
  for (let category = 1; category <= 5; category += 1) {
    const candidates = sample.qa
      .map((entry, originalQaIndex) => ({ entry, originalQaIndex, selectionHash: sha(`${sample.sample_id}:${originalQaIndex}`) }))
      .filter(({ entry }) => entry?.category === category)
      .sort((left, right) => left.selectionHash.localeCompare(right.selectionHash));
    if (candidates.length === 0) { missingCategories.push(category); continue; }
    const { entry, originalQaIndex, selectionHash } = candidates[0];
    if (!nonempty(entry.question)) throw new Error("locomo_invalid_question");
    const evidenceDialogIds = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (!evidenceDialogIds.every(nonempty)) throw new Error("locomo_invalid_evidence");
    const evidence = evidenceDialogIds.map((id) => dialogueToSession.get(id));
    if (evidence.some((value) => value === undefined)) throw new Error("locomo_unknown_evidence");
    const imageAssociatedEvidenceCount = evidenceDialogIds.filter((id) => dialogueToSession.get(id).hasImage).length;
    // Upstream category 5 is graded only by an explicit abstention phrase. Its
    // adversarial_answer is a plausible false answer, never a truth reference.
    const reference = category === 5 ? null : entry.answer;
    if (category !== 5 && !nonempty(reference)) throw new Error("locomo_missing_reference");
    selected.push({
      id: `qa-${originalQaIndex}`,
      source: { text: entry.question, timestamp: finalTimestamp },
      evaluation: {
        answerable: category !== 5,
        accepted: reference === null ? [] : [reference],
        forbidden: [],
        evidenceTurnIds: [...new Set(evidence.map((value) => value.sessionId))],
        category: CATEGORY_NAMES[category],
        locomoCategory: category,
        originalQaIndex,
        selectionHash,
        evidenceDialogIds,
        imageAssociation: {
          evidenceCount: evidenceDialogIds.length,
          imageAssociatedEvidenceCount,
          dependency: imageAssociatedEvidenceCount === 0 ? "none_observed" : "unknown",
        },
      },
    });
  }
  return { selected, missingCategories };
}

function validateRaw(data) {
  if (!Array.isArray(data) || data.length !== 10) throw new Error("locomo_invalid_conversation_count");
  const ids = new Set();
  for (const sample of data) {
    if (!nonempty(sample?.sample_id) || ids.has(sample.sample_id) || !sample.conversation || !Array.isArray(sample.qa)) throw new Error("locomo_invalid_sample");
    ids.add(sample.sample_id);
    if (!nonempty(sample.conversation.speaker_a) || !nonempty(sample.conversation.speaker_b)) throw new Error("locomo_invalid_speakers");
    const keys = sessionKeys(sample.conversation);
    if (keys.length === 0) throw new Error("locomo_invalid_session_count");
    for (const key of keys) projectLocomoSession(sample.conversation, key);
  }
}

export function projectLocomo(data) {
  validateRaw(data);
  const ordered = data.map((sample) => ({ sample, partitionHash: sha(`locomo-v1:${sample.sample_id}`) }))
    .sort((left, right) => left.partitionHash.localeCompare(right.partitionHash));
  const partition = ordered.map(({ sample, partitionHash }, index) => ({
    id: sample.sample_id,
    split: index < 2 ? "development" : "evaluation",
    partitionHash,
    rank: index + 1,
  }));
  const chosen = [
    { ...ordered[0], split: "development" },
    { ...ordered[2], split: "evaluation" },
  ];
  const groups = chosen.map(({ sample, partitionHash, split }) => {
    const keys = sessionKeys(sample.conversation);
    const projected = keys.map((key) => projectLocomoSession(sample.conversation, key));
    const dialogueToSession = new Map();
    for (const key of keys) for (const entry of sample.conversation[key]) {
      if (dialogueToSession.has(entry.dia_id)) throw new Error("locomo_duplicate_dialogue_id");
      dialogueToSession.set(entry.dia_id, { sessionId: key, hasImage: Object.hasOwn(entry, "img_url") });
    }
    for (let index = 1; index < projected.length; index += 1) {
      if (Date.parse(projected[index].timestamp) < Date.parse(projected[index - 1].timestamp)) throw new Error("locomo_reordered_sessions");
    }
    const finalTimestamp = new Date(Date.parse(projected.at(-1).timestamp) + 1000).toISOString();
    const { selected, missingCategories } = selectedQuestions(sample, dialogueToSession, finalTimestamp);
    const turns = projected.map(({ dialogueIds: _dialogueIds, ...turn }) => turn);
    return {
      id: sample.sample_id,
      split,
      partitionHash,
      missingCategories,
      source: { turns, contextPolicy: "memory-only" },
      questions: selected,
    };
  });
  const categoryCounts = Object.fromEntries([1, 2, 3, 4, 5].map((category) => [category, data.reduce((sum, sample) => sum + sample.qa.filter((entry) => entry.category === category).length, 0)]));
  const corpus = {
    schemaVersion: 1,
    name: LOCOMO.corpus,
    arms: ["full-history", "bujo"],
    turnsPerGroup: { min: 1, max: 64 },
    partition,
    stats: {
      conversations: data.length,
      sessions: data.reduce((sum, sample) => sum + sessionKeys(sample.conversation).length, 0),
      dialogueTurns: data.reduce((sum, sample) => sum + sessionKeys(sample.conversation).reduce((inner, key) => inner + sample.conversation[key].length, 0), 0),
      qa: data.reduce((sum, sample) => sum + sample.qa.length, 0),
      imageTurns: data.reduce((sum, sample) => sum + sessionKeys(sample.conversation).reduce((inner, key) => inner + sample.conversation[key].filter((entry) => Object.hasOwn(entry, "img_url")).length, 0), 0),
      categories: categoryCounts,
    },
    groups,
  };
  validateCorpus(corpus);
  return corpus;
}

export async function loadLocomo(path) {
  if (!nonempty(path)) throw new Error("locomo_dataset_required");
  const absolute = resolve(path);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error("locomo_dataset_not_private");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length !== LOCOMO.bytes || sha(bytes) !== LOCOMO.sha256) throw new Error("locomo_dataset_identity_mismatch");
  const corpus = projectLocomo(JSON.parse(bytes));
  return { corpus, sha256: LOCOMO.sha256 };
}

export function makeLocomoPlan({ corpus, sha256, split, profile = null, codeRevision = null }) {
  const groups = corpus.groups.filter((group) => group.split === split);
  if (groups.length !== 1) throw new Error("locomo_invalid_split");
  const sessions = groups.reduce((sum, group) => sum + group.source.turns.length, 0);
  const questions = groups.reduce((sum, group) => sum + group.questions.length, 0);
  const captureModelSteps = sessions * 2;
  const readerInvocations = questions * corpus.arms.length;
  const readerModelSteps = readerInvocations * 3;
  const runtimeMs = split === "development" ? 18 * 60_000 : 12 * 60_000;
  const chatInputTokensReserved = captureModelSteps * 8192 + readerModelSteps * 49152;
  // Metering estimates UTF-8 bytes / 3. Capture embeds one batch of at most
  // eight 160-code-point candidates for similarity and one batch of at most
  // eight 280-code-point reconciled writes per session. Each question allows
  // three independently metered recall queries clamped to 4,000 code points.
  const captureSearchEmbeddingInput = Math.ceil(MAX_CAPTURE_MEMORIES * MAX_CAPTURE_MEMORY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const captureWriteEmbeddingInput = Math.ceil(MAX_CAPTURE_MEMORIES * MAX_RECONCILED_MEMORY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const queryEmbeddingInput = Math.ceil(MAX_RECALL_QUERY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const embeddingInputTokens = sessions * (captureSearchEmbeddingInput + captureWriteEmbeddingInput) + questions * 3 * queryEmbeddingInput;
  const limits = {
    chatSteps: captureModelSteps + readerModelSteps,
    embeddingCalls: captureModelSteps + questions * 3,
    estimatedInputTokens: chatInputTokensReserved + embeddingInputTokens,
    embeddingInputTokens,
    outputTokens: captureModelSteps * 2048 + readerModelSteps * 512,
    runtimeMs,
  };
  const plan = makePlan({ corpus, sha256, split, profile, codeRevision, limits, perCall: { readerEstimatedInputTokens: 49152, readerHistoryHeadroomMessages: 8 } });
  const locomo = {
    revision: LOCOMO.revision,
    path: LOCOMO.path,
    gitBlob: LOCOMO.gitBlob,
    rawBytes: LOCOMO.bytes,
    rawSha256: LOCOMO.sha256,
    license: LOCOMO.license,
    stats: corpus.stats,
    partition: corpus.partition,
    selected: groups.map((group) => ({
      conversationId: group.id,
      sessions: group.source.turns.length,
      missingCategories: group.missingCategories,
      questions: group.questions.map((question) => ({
        id: question.id,
        category: question.evaluation.locomoCategory,
        originalQaIndex: question.evaluation.originalQaIndex,
        selectionHash: question.evaluation.selectionHash,
        imageAssociation: question.evaluation.imageAssociation,
      })),
    })),
    evaluator: LOCOMO_EVALUATOR,
    ceilings: {
      captureAdmissions: sessions,
      captureModelSteps,
      readerInvocations,
      readerModelSteps,
      chatInputTokensReserved,
      embeddingInputTokensReserved: embeddingInputTokens,
      combinedInputTokensReserved: chatInputTokensReserved + embeddingInputTokens,
      semanticJudgeInvocations: 0,
      rerankerCalls: 0,
      imageFetches: 0,
    },
    evaluationCaveats: {
      imageAssociatedQuestionsRemainInTextOnlyDenominator: true,
      visualDependency: "unknown",
      category5ExactF1: "not_applicable",
      category5Diagnostic: "deterministic_upstream_abstention_phrase_only",
    },
    executionGate: {
      status: "blocked_pending_synthetic_native_context_probe",
      explicitLoopbackEndpoint: true,
      clientContextWindow: profile?.clientContextWindow ?? null,
      readerInputReservation: plan.perCall.readerEstimatedInputTokens,
      readerOutputReservation: plan.perCall.readerOutputTokens,
      nativeNumCtxConfigured: false,
      redirectsRejectedByExistingAdapter: false,
      silentNativeTruncationDetectable: false,
      modelMetadataIsNotExecutionProof: true,
    },
  };
  const { confirmation: _confirmation, ...base } = plan;
  return { ...base, locomo, confirmation: digest({ ...base, locomo }) };
}

function normalizeAnswer(value) {
  return value.toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(?:a|an|the)\b/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

/** Exact upstream category-5 phrase rule, kept separate from truth-reference metrics. */
export function locomoCategory5Abstains(prediction) {
  const output = prediction.toLowerCase();
  return output.includes("no information available") || output.includes("not mentioned");
}

/** Deterministic local lexical diagnostic; references must never enter provider inputs. */
export function lexicalAnswerScore(prediction, references) {
  const predicted = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const score = (reference) => {
    const expected = normalizeAnswer(reference).split(" ").filter(Boolean);
    if (predicted.length === 0 || expected.length === 0) return predicted.length === expected.length ? 1 : 0;
    const counts = new Map();
    for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
    let overlap = 0;
    for (const token of predicted) if ((counts.get(token) ?? 0) > 0) { overlap += 1; counts.set(token, counts.get(token) - 1); }
    if (overlap === 0) return 0;
    const precision = overlap / predicted.length; const recall = overlap / expected.length;
    return (2 * precision * recall) / (precision + recall);
  };
  const f1 = Math.max(...references.map(score), 0);
  const exact = references.some((reference) => normalizeAnswer(reference) === normalizeAnswer(prediction));
  return { exact, f1 };
}
