import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { digest, makePlan, validateCorpus } from "./memory-e2e-dataset.mjs";
export { officialLocomoScore } from "./memory-e2e-locomo-score.mjs";

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
const MAX_RECONCILIATION_NEIGHBOURS = 5;
const MAX_CAPTURE_ENTITY_IDS = 16;
const MAX_CAPTURE_ENTITY_ID_BYTES = 96;
const MAX_CAPTURE_MEMORY_ID_BYTES = 69;
const MAX_JSON_NUMBER_BYTES = 32;
const MAX_RECONCILIATION_DISTANCE_BYTES = 16;
const RECONCILIATION_SERIALIZED_CONTROL_BYTES = 8_192;
const RECONCILIATION_FRAMING_AND_TOOL_TOKENS = 4_096;
const COMPLETED_TURN_CAPTURE_TEXT_MAX_BYTES = 512 * 1024;

/**
 * Versioned content-only source projection. One admission is one adjacent pair of
 * source utterances (the final odd utterance stands alone). Pair boundaries use
 * only source order: never questions, references, evidence ids, or outcomes.
 */
export const LOCOMO_ADAPTER_PROTOCOL = "locomo-adjacent-exchanges-v1";
export const LOCOMO_EXCHANGE_MAX_ENTRIES = 2;
export const LOCOMO_EXCHANGE_MAX_USER_BYTES = 8 * 1024;
export const LOCOMO_READER_PROMPT = Object.freeze({
  id: "locomo-evidence-reader-v1",
  text: "You are a careful evidence reader. Answer the current question concisely using only the conversation or memory evidence available to you. Do not invent personal details. If the evidence is insufficient, answer exactly: Insufficient evidence.\n",
});
export const LOCOMO_DEVELOPMENT_EXPERIMENT = "locomo-bujo-eval-v1-rank5-development-30";
export const LOCOMO_CONFIRMATION_EXPERIMENT = "locomo-bujo-eval-v1-rank6-confirmation-20";
const EXPERIMENTS = Object.freeze({
  [LOCOMO_DEVELOPMENT_EXPERIMENT]: Object.freeze({ role: "development", rank: 5, perCategory: 6, total: 30 }),
  [LOCOMO_CONFIRMATION_EXPERIMENT]: Object.freeze({ role: "confirmation", rank: 6, perCategory: 4, total: 20 }),
});
const CAPTURE_MODEL_OUTPUT_ATTEMPTS = 1;
const READER_MAX_TURNS = 4;

function reconciliationEstimatedInputTokensCeiling() {
  const widestCodePoint = "\u{10FFFF}";
  const entityIds = Array.from({ length: MAX_CAPTURE_ENTITY_IDS }, (_unused, index) => (
    `a:${String(index).padStart(2, "0")}${"a".repeat(MAX_CAPTURE_ENTITY_ID_BYTES - 4)}`
  ));
  const candidate = { type: "event", text: widestCodePoint.repeat(MAX_CAPTURE_MEMORY_CODE_POINTS), salience: 0, isInsight: false, entityIds };
  const existing = { id: `C-${"a".repeat(MAX_CAPTURE_MEMORY_ID_BYTES - 5)}-00`, distance: 0, text: widestCodePoint.repeat(MAX_RECONCILED_MEMORY_CODE_POINTS) };
  const input = Array.from({ length: MAX_CAPTURE_MEMORIES }, (_unused, index) => ({
    index, candidate, existing: Array.from({ length: MAX_RECONCILIATION_NEIGHBOURS }, () => existing),
  }));
  const emptyMessageBytes = Buffer.byteLength(JSON.stringify([{ role: "user", content: "" }]), "utf8");
  const nestedInputBytes = Buffer.byteLength(JSON.stringify([{ role: "user", content: JSON.stringify(input) }]), "utf8") - emptyMessageBytes;
  const numericExpansionBytes = MAX_CAPTURE_MEMORIES * (
    MAX_JSON_NUMBER_BYTES - 1 + MAX_RECONCILIATION_NEIGHBOURS * (MAX_RECONCILIATION_DISTANCE_BYTES - 1)
  );
  return Math.ceil((nestedInputBytes + numericExpansionBytes + RECONCILIATION_SERIALIZED_CONTROL_BYTES) / INPUT_ESTIMATE_DIVISOR)
    + RECONCILIATION_FRAMING_AND_TOOL_TOKENS;
}

export const LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS = reconciliationEstimatedInputTokensCeiling();
export const LOCOMO_EVALUATOR = Object.freeze({
  identity: "snap-research/locomo@3eb6f2c5:task_eval/evaluation.py",
  revision: LOCOMO.revision,
  path: "task_eval/evaluation.py",
  gitBlob: "8f597dd687e66832da1f6f04a169e05622049576",
  category5Rule: "output contains 'no information available' or 'not mentioned'",
});
export const LOCOMO_HOSTED_PROFILE = Object.freeze({
  reader: "openai-codex:gpt-5.6-luna",
  extractor: "openai-codex:gpt-5.6-luna",
  embeddingProvider: "ollama",
  embeddingModel: "bge-m3:latest",
  dimension: 1024,
  chatContextWindow: 272_000,
  datasetTransferAck: "selected-public-locomo-projection-to-hosted-luna",
});

function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function sessionNumber(key) { return Number(key.slice("session_".length)); }
function sessionKeys(conversation) {
  return Object.keys(conversation)
    .filter((key) => /^session_[1-9][0-9]*$/u.test(key) && Array.isArray(conversation[key]))
    .sort((left, right) => sessionNumber(left) - sessionNumber(right));
}
function experimentConfig(experiment) {
  const value = EXPERIMENTS[experiment];
  if (value === undefined) throw new Error("locomo_invalid_experiment");
  return value;
}

/** Fail closed unless the exact previously used comparison profile is selected. */
export function locomoExecutionProfile(profile, { allowHostedTransfer = false } = {}) {
  if (profile === null) {
    if (allowHostedTransfer) throw new Error("hosted_locomo_transfer_ack_requires_profile");
    return null;
  }
  const localChat = profile.reader.startsWith("ollama:") && profile.extractor.startsWith("ollama:")
    && profile.embeddingProvider === "ollama";
  if (!allowHostedTransfer) {
    if (!localChat) throw new Error("locomo_hosted_transfer_ack_required");
    return { ...profile, ollamaEndpoint: "http://127.0.0.1:11434", embeddingEndpoint: "http://127.0.0.1:11434", clientContextWindow: 65_536 };
  }
  const exact = profile.reader === LOCOMO_HOSTED_PROFILE.reader
    && profile.extractor === LOCOMO_HOSTED_PROFILE.extractor
    && profile.embeddingProvider === LOCOMO_HOSTED_PROFILE.embeddingProvider
    && profile.embeddingModel === LOCOMO_HOSTED_PROFILE.embeddingModel
    && profile.dimension === LOCOMO_HOSTED_PROFILE.dimension
    && nonempty(profile.piAuthPath);
  if (!exact) throw new Error("hosted_locomo_profile_mismatch");
  return {
    ...profile,
    embeddingEndpoint: "http://127.0.0.1:11434",
    hostedChatContextWindow: LOCOMO_HOSTED_PROFILE.chatContextWindow,
    locomoDatasetTransferAck: LOCOMO_HOSTED_PROFILE.datasetTransferAck,
  };
}

/** Parse the single upstream timestamp grammar without locale or host timezone dependence. */
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

function validateDialogueEntry(entry, seen) {
  if (!nonempty(entry?.dia_id) || seen.has(entry.dia_id) || !nonempty(entry?.speaker) || !nonempty(entry?.text)) {
    throw new Error("locomo_invalid_dialogue");
  }
  seen.add(entry.dia_id);
}

/**
 * Lossless chronological exchange projection. Both participants remain quoted
 * humans inside the user report; the synthetic assistant acknowledgement adds no
 * source claim. Original speaker and text bytes are not trimmed or rewritten.
 */
export function projectLocomoExchangeSession(conversation, key) {
  const timestamp = parseLocomoTimestamp(conversation[`${key}_date_time`]);
  const dialogue = conversation[key];
  if (!Array.isArray(dialogue) || dialogue.length === 0) throw new Error("locomo_invalid_session");
  const seen = new Set();
  for (const entry of dialogue) validateDialogueEntry(entry, seen);
  const exchanges = [];
  for (let index = 0; index < dialogue.length; index += LOCOMO_EXCHANGE_MAX_ENTRIES) {
    const entries = dialogue.slice(index, index + LOCOMO_EXCHANGE_MAX_ENTRIES);
    const reports = entries.map((entry) => `${entry.speaker} said: ${entry.text}`);
    const user = reports.join("\n");
    if (Buffer.byteLength(user, "utf8") > LOCOMO_EXCHANGE_MAX_USER_BYTES) {
      throw new Error("locomo_exchange_exceeds_bound");
    }
    const number = exchanges.length + 1;
    const id = `${key}-exchange-${String(number).padStart(3, "0")}`;
    exchanges.push({
      id,
      sessionId: id,
      timestamp,
      speaker: "LoCoMo human dialogue",
      user,
      assistant: "The human dialogue exchange was recorded without adding claims.",
      dialogue: entries.map((entry) => ({ id: entry.dia_id, speaker: entry.speaker, text: entry.text })),
    });
  }
  return exchanges;
}

function projectQuestion(sample, entry, originalQaIndex, dialogueIndex, finalTimestamp) {
  const category = entry?.category;
  if (!Number.isSafeInteger(category) || !Object.hasOwn(CATEGORY_NAMES, category) || !nonempty(entry.question)) {
    throw new Error("locomo_invalid_question");
  }
  const evidenceDialogIds = Array.isArray(entry.evidence) ? entry.evidence : [];
  if (!evidenceDialogIds.every(nonempty)) throw new Error("locomo_invalid_evidence");
  const evidence = evidenceDialogIds.map((id) => dialogueIndex.get(id));
  const resolvedEvidence = evidence.filter((value) => value !== undefined);
  const unresolvedEvidenceCount = evidence.length - resolvedEvidence.length;
  const imageAssociatedEvidenceCount = resolvedEvidence.filter((value) => value.hasImage).length;
  const reference = category === 5 ? null
    : nonempty(entry.answer) ? entry.answer.trim()
      : Number.isFinite(entry.answer) ? String(entry.answer) : null;
  if (category !== 5 && reference === null) throw new Error("locomo_missing_reference");
  return {
    id: `qa-${originalQaIndex}`,
    source: { text: entry.question, timestamp: finalTimestamp },
    evaluation: {
      answerable: category !== 5,
      accepted: reference === null ? [] : [reference],
      forbidden: [],
      evidenceTurnIds: [...new Set(resolvedEvidence.map((value) => value.exchangeId))],
      category: CATEGORY_NAMES[category],
      locomoCategory: category,
      originalQaIndex,
      selectionHash: sha(`${sample.sample_id}:${originalQaIndex}`),
      evidenceDialogIds,
      imageAssociation: {
        evidenceCount: evidenceDialogIds.length,
        unresolvedEvidenceCount,
        imageAssociatedEvidenceCount,
        dependency: imageAssociatedEvidenceCount === 0 ? "none_observed" : "unknown",
      },
    },
  };
}

function selectedQuestions(sample, dialogueIndex, finalTimestamp, config) {
  const ranked = sample.qa.map((entry, originalQaIndex) => ({
    entry, originalQaIndex, selectionHash: sha(`${sample.sample_id}:${originalQaIndex}`),
  }));
  const picked = [];
  const pickedIndexes = new Set();
  for (let category = 1; category <= 5; category += 1) {
    const candidates = ranked.filter(({ entry }) => entry?.category === category)
      .sort((left, right) => left.selectionHash.localeCompare(right.selectionHash));
    for (const candidate of candidates.slice(0, config.perCategory)) {
      picked.push(candidate); pickedIndexes.add(candidate.originalQaIndex);
    }
  }
  if (picked.length < config.total) {
    const remainder = ranked.filter(({ originalQaIndex }) => !pickedIndexes.has(originalQaIndex))
      .sort((left, right) => left.selectionHash.localeCompare(right.selectionHash));
    picked.push(...remainder.slice(0, config.total - picked.length));
  }
  if (picked.length !== config.total) throw new Error("locomo_question_target_unavailable");
  picked.sort((left, right) => left.originalQaIndex - right.originalQaIndex);
  return picked.map(({ entry, originalQaIndex }) => projectQuestion(sample, entry, originalQaIndex, dialogueIndex, finalTimestamp));
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
    for (const key of keys) projectLocomoExchangeSession(sample.conversation, key);
  }
}

export function projectLocomo(data, { experiment = LOCOMO_DEVELOPMENT_EXPERIMENT } = {}) {
  const config = experimentConfig(experiment);
  validateRaw(data);
  const ordered = data.map((sample) => ({ sample, partitionHash: sha(`locomo-v1:${sample.sample_id}`) }))
    .sort((left, right) => left.partitionHash.localeCompare(right.partitionHash));
  const partition = ordered.map(({ sample, partitionHash }, index) => ({
    id: sample.sample_id,
    partitionHash,
    rank: index + 1,
    observedLegacyUse: [1, 4, 5].includes(index + 1) ? "executed" : index + 1 === 3 ? "protocol_selected_status_uncertain" : "none_observed",
  }));
  const selected = ordered[config.rank - 1];
  const sample = selected.sample;
  const keys = sessionKeys(sample.conversation);
  const projected = keys.flatMap((key) => projectLocomoExchangeSession(sample.conversation, key));
  for (let index = 1; index < projected.length; index += 1) {
    if (Date.parse(projected[index].timestamp) < Date.parse(projected[index - 1].timestamp)) throw new Error("locomo_reordered_sessions");
  }
  const dialogueIndex = new Map();
  for (const turn of projected) for (const entry of turn.dialogue) {
    if (dialogueIndex.has(entry.id)) throw new Error("locomo_duplicate_dialogue_id");
    const raw = sample.conversation[keys.find((key) => sample.conversation[key].some((candidate) => candidate.dia_id === entry.id))]
      .find((candidate) => candidate.dia_id === entry.id);
    dialogueIndex.set(entry.id, { exchangeId: turn.id, hasImage: Object.hasOwn(raw, "img_url") });
  }
  const finalTimestamp = new Date(Date.parse(projected.at(-1).timestamp) + 1000).toISOString();
  const questions = selectedQuestions(sample, dialogueIndex, finalTimestamp, config);
  const turns = projected.map(({ dialogue: _dialogue, ...turn }) => turn);
  const group = {
    id: sample.sample_id,
    split: "evaluation",
    partitionRank: config.rank,
    partitionHash: selected.partitionHash,
    source: { turns, contextPolicy: "memory-only" },
    questions,
  };
  const categoryCounts = Object.fromEntries([1, 2, 3, 4, 5].map((category) => [category, data.reduce((sum, item) => sum + item.qa.filter((entry) => entry.category === category).length, 0)]));
  const corpus = {
    schemaVersion: 1,
    name: LOCOMO.corpus,
    arms: ["full-history", "bujo"],
    turnsPerGroup: { min: 1, max: 1024 },
    partition,
    stats: {
      conversations: data.length,
      sessions: data.reduce((sum, item) => sum + sessionKeys(item.conversation).length, 0),
      dialogueTurns: data.reduce((sum, item) => sum + sessionKeys(item.conversation).reduce((inner, key) => inner + item.conversation[key].length, 0), 0),
      qa: data.reduce((sum, item) => sum + item.qa.length, 0),
      categories: categoryCounts,
    },
    groups: [group],
  };
  validateCorpus(corpus);
  return corpus;
}

export async function loadLocomo(path, { experiment = LOCOMO_DEVELOPMENT_EXPERIMENT } = {}) {
  experimentConfig(experiment);
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
  return { corpus: projectLocomo(JSON.parse(bytes), { experiment }), sha256: LOCOMO.sha256, experiment };
}

function selectedArms(arm) {
  if (arm === undefined || arm === null || arm === "both") return ["full-history", "bujo"];
  if (arm === "full-history" || arm === "bujo") return [arm];
  throw new Error("locomo_invalid_arm");
}

export function makeLocomoPlan({ corpus, sha256, split, profile = null, codeRevision = null, experiment, arm = "both" }) {
  const config = experimentConfig(experiment);
  if (split !== "evaluation") throw new Error("locomo_experiment_requires_evaluation");
  const groups = corpus.groups.filter((group) => group.partitionRank === config.rank);
  if (groups.length !== 1 || groups[0].questions.length !== config.total) throw new Error("locomo_frozen_selection_mismatch");
  const arms = selectedArms(arm);
  const captureAdmissions = arms.includes("bujo") ? groups[0].source.turns.length : 0;
  const questions = groups[0].questions.length;
  const extractionModelSteps = captureAdmissions * CAPTURE_MODEL_OUTPUT_ATTEMPTS;
  const reconciliationModelSteps = captureAdmissions * CAPTURE_MODEL_OUTPUT_ATTEMPTS;
  const captureModelSteps = extractionModelSteps + reconciliationModelSteps;
  const readerInvocations = questions * arms.length;
  const readerModelSteps = readerInvocations * READER_MAX_TURNS;
  const extractionInputTokensReserved = extractionModelSteps * 8_192;
  const reconciliationInputTokensReserved = reconciliationModelSteps * LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS;
  const readerInputTokensReserved = readerModelSteps * 49_152;
  const chatInputTokensReserved = extractionInputTokensReserved + reconciliationInputTokensReserved + readerInputTokensReserved;
  const captureSearchEmbeddingInput = Math.ceil(MAX_CAPTURE_MEMORIES * MAX_CAPTURE_MEMORY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const captureWriteEmbeddingInput = Math.ceil(MAX_CAPTURE_MEMORIES * MAX_RECONCILED_MEMORY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const queryEmbeddingInput = Math.ceil(MAX_RECALL_QUERY_CODE_POINTS * UTF8_BYTES_PER_CODE_POINT / INPUT_ESTIMATE_DIVISOR);
  const readerRecallCalls = arms.includes("bujo") ? questions * READER_MAX_TURNS : 0;
  const embeddingInputTokens = captureAdmissions * CAPTURE_MODEL_OUTPUT_ATTEMPTS * (captureSearchEmbeddingInput + captureWriteEmbeddingInput)
    + readerRecallCalls * queryEmbeddingInput;
  const runtimeMs = arms.length === 1 && arms[0] === "full-history"
    ? 2 * 60 * 60_000 : config.role === "development" ? 8 * 60 * 60_000 : 10 * 60 * 60_000;
  const limits = {
    chatSteps: captureModelSteps + readerModelSteps,
    embeddingCalls: captureModelSteps + readerRecallCalls,
    estimatedInputTokens: chatInputTokensReserved + embeddingInputTokens,
    embeddingInputTokens,
    outputTokens: captureModelSteps * 2_048 + readerModelSteps * 512,
    runtimeMs,
  };
  // Whole comparison phase: one full-history reader plus one BuJo capture/reader
  // at each of the baseline and candidate revisions. The candidate identity is
  // frozen later, but its maximum work is protocol-identical and known now.
  const comparisonSourceAdmissions = groups[0].source.turns.length;
  const comparisonCaptureStepsPerRevision = comparisonSourceAdmissions * 2;
  const comparisonReaderSteps = questions * 3 * READER_MAX_TURNS;
  const comparisonBujoReaderRecallCalls = questions * READER_MAX_TURNS;
  const comparisonEmbeddingInputPerBujo = comparisonSourceAdmissions * (captureSearchEmbeddingInput + captureWriteEmbeddingInput)
    + comparisonBujoReaderRecallCalls * queryEmbeddingInput;
  const comparisonChatInputPerBujo = comparisonSourceAdmissions * (8_192 + LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS)
    + questions * READER_MAX_TURNS * 49_152;
  const comparisonFullHistoryReaderInput = questions * READER_MAX_TURNS * 49_152;
  const comparisonPhaseCeilings = {
    bujoRevisions: 2,
    fullHistoryReaders: 1,
    uniqueQuestions: questions,
    answerInvocations: questions * 3,
    captureAdmissions: comparisonSourceAdmissions * 2,
    extractionModelSteps: comparisonSourceAdmissions * 2,
    reconciliationModelSteps: comparisonSourceAdmissions * 2,
    captureModelSteps: comparisonCaptureStepsPerRevision * 2,
    readerModelSteps: comparisonReaderSteps,
    chatSteps: comparisonCaptureStepsPerRevision * 2 + comparisonReaderSteps,
    embeddingCalls: (comparisonCaptureStepsPerRevision + comparisonBujoReaderRecallCalls) * 2,
    estimatedInputTokens: comparisonChatInputPerBujo * 2 + comparisonFullHistoryReaderInput + comparisonEmbeddingInputPerBujo * 2,
    embeddingInputTokens: comparisonEmbeddingInputPerBujo * 2,
    outputTokens: comparisonCaptureStepsPerRevision * 2 * 2_048 + comparisonReaderSteps * 512,
    runtimeMs: (config.role === "development" ? 8 : 10) * 2 * 60 * 60_000 + 2 * 60 * 60_000,
    semanticJudgeInvocations: 0,
  };
  const planCorpus = { ...corpus, arms, groups: groups.map((group) => ({ ...group, split })) };
  const made = makePlan({
    corpus: planCorpus, sha256, split, profile, codeRevision, limits,
    perCall: {
      readerMaxTurns: READER_MAX_TURNS,
      readerEstimatedInputTokens: 49_152,
      reconciliationEstimatedInputTokens: LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS,
      readerHistoryHeadroomMessages: 8,
      callTimeoutMs: 180_000,
      readinessTimeoutMs: 240_000,
      captureModelOutputAttempts: CAPTURE_MODEL_OUTPUT_ATTEMPTS,
    },
  });
  const readerPrompt = { ...LOCOMO_READER_PROMPT, sha256: sha(LOCOMO_READER_PROMPT.text) };
  const questionIdentity = groups[0].questions.map((question) => ({
    id: question.id,
    originalQaIndex: question.evaluation.originalQaIndex,
    selectionHash: question.evaluation.selectionHash,
  }));
  const sourceIdentity = digest(groups[0].source.turns);
  const protocolIdentity = digest({
    adapter: LOCOMO_ADAPTER_PROTOCOL,
    experiment,
    codeRevision,
    corpusSha256: sha256,
    partitionRank: config.rank,
    sourceIdentity,
    questionIdentity,
    profile: made.profile,
    arms,
    readerPrompt,
    evaluator: LOCOMO_EVALUATOR.identity,
  });
  const hosted = profile?.locomoDatasetTransferAck === LOCOMO_HOSTED_PROFILE.datasetTransferAck;
  const { confirmation: _confirmation, ...base } = made;
  const plan = {
    ...base,
    workload: { ...base.workload, captureStepsMaximum: captureModelSteps, readerStepsMaximum: readerModelSteps },
    readerPrompt,
    locomo: {
      protocol: LOCOMO_ADAPTER_PROTOCOL,
      protocolIdentity,
      experiment: {
        id: experiment,
        role: config.role,
        partitionRank: config.rank,
        questionSet: `${config.perCategory}-per-category-by-preoutcome-hash`,
        questionTarget: config.total,
        selectionFrozenBeforeInference: true,
        tuningAfterConfirmationForbidden: config.role === "confirmation",
        priorObservedExecutedRanks: [1, 4, 5],
        priorStatusUncertainRanks: [3],
      },
      source: {
        identitySha256: sourceIdentity,
        sessions: sessionKeysFromTurns(groups[0].source.turns),
        dialogueExchanges: groups[0].source.turns.length,
        maxEntriesPerExchange: LOCOMO_EXCHANGE_MAX_ENTRIES,
        maxUserBytesPerExchange: LOCOMO_EXCHANGE_MAX_USER_BYTES,
        completedTurnCaptureTextMaxBytes: COMPLETED_TURN_CAPTURE_TEXT_MAX_BYTES,
        losslessRule: "ordered non-overlapping adjacent source pairs; final odd entry stands alone; no trimming or truncation",
        participants: "quoted_humans_never_assistant_or_tool_claims",
      },
      selected: {
        partitionRank: config.rank,
        conversationIdentitySha256: sha(groups[0].id),
        questionIdentitySha256: digest(questionIdentity),
        categoryDenominators: Object.fromEntries([1, 2, 3, 4, 5].map((category) => [
          category, groups[0].questions.filter((question) => question.evaluation.locomoCategory === category).length,
        ])),
        answerableQuestions: groups[0].questions.filter((question) => question.evaluation.answerable).length,
        category5Questions: groups[0].questions.filter((question) => !question.evaluation.answerable).length,
        imageAssociatedQuestions: groups[0].questions.filter((question) => question.evaluation.imageAssociation.imageAssociatedEvidenceCount > 0).length,
        imageDependency: "unknown_when_associated",
      },
      evaluator: LOCOMO_EVALUATOR,
      comparisonPhaseCeilings,
      ceilings: {
        captureAdmissions,
        captureModelOutputAttemptsPerAdmission: CAPTURE_MODEL_OUTPUT_ATTEMPTS,
        extractionModelSteps,
        reconciliationModelSteps,
        captureModelSteps,
        readerInvocations,
        readerMaxTurnsPerInvocation: READER_MAX_TURNS,
        readerModelSteps,
        readerRecallCalls,
        extractionInputTokensReserved,
        reconciliationInputTokensReserved,
        readerInputTokensReserved,
        chatInputTokensReserved,
        embeddingInputTokensReserved: embeddingInputTokens,
        combinedInputTokensReserved: chatInputTokensReserved + embeddingInputTokens,
        semanticJudgeInvocations: 0,
        imageFetches: 0,
      },
      datasetTransfer: hosted ? {
        acknowledged: true,
        acknowledgement: LOCOMO_HOSTED_PROFILE.datasetTransferAck,
        chatRoute: LOCOMO_HOSTED_PROFILE.reader,
        scope: ["selected_projected_dialogue_exchanges", "selected_question_text", "provider_derived_bujo_memory"],
        excluded: ["reference_answers", "adversarial_answers", "evidence_annotations", "images", "summaries", "observations", "unselected_conversations"],
        localEmbeddingsOnly: true,
      } : { acknowledged: false, chatRoute: "local_only", scope: [], excluded: ["all_dataset_content_from_hosted_chat"], localEmbeddingsOnly: true },
      executionGate: hosted ? {
        status: "ready_for_parent_review_hosted_transfer_not_executed",
        sourceCatalogContextWindow: LOCOMO_HOSTED_PROFILE.chatContextWindow,
        largestReservedPromptAndOutput: Math.max(49_152 + 512, 8_192 + 2_048, LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS + 2_048),
        sourceCatalogAdmissionFits: true,
        compactionDisabled: true,
        referencesExcludedFromProviderProjection: true,
        realDatasetInferencePerformed: false,
      } : { status: "blocked_pending_local_capability_probe", modelMetadataIsNotExecutionProof: true },
      review: {
        rubric: "human-semantic-v1: correct | partial | incorrect | abstained",
        blindArmLabels: true,
        paidAutomaticJudge: false,
      },
    },
  };
  return { ...plan, confirmation: digest(plan) };
}

function sessionKeysFromTurns(turns) {
  return new Set(turns.map((turn) => turn.id.split("-exchange-")[0])).size;
}

function normalizeAnswer(value) {
  return value.toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(?:a|an|the)\b/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

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
