import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { LABELS, PRIVATE_CODES, PrivateError, opaqueId } from "./memory-e2e-private-input.mjs";

export const PRIVATE_ARMS = Object.freeze(["current-only", "follow-up-window", "length-only-abstention", "profile-on", "window-profile-on", "semantic-only", "historical-baseline"]);
export const LINE_KINDS = Object.freeze(["profile", "guidance", "similarity", "unclassified", "capture"]);
export const EVIDENCE_FLAGS = Object.freeze(["approximate_as_of", "diagnostic_present_store", "later_file_edit_possible", "later_status_or_supersession_possible", "rewrite_history_unknown", "timestamp_unknown", "later_graph_edit_possible"]);
const enumValue = (value, allowed) => { if (!allowed.includes(value)) throw new PrivateError("private_input_invalid"); return value; };
const id = (value) => { if (!opaqueId(value)) throw new PrivateError("private_input_invalid"); return value; };
const num = (value) => { if (!Number.isFinite(value)) throw new PrivateError("private_input_invalid"); return value; };
const bool = (value) => { if (typeof value !== "boolean") throw new PrivateError("private_input_invalid"); return value; };
const nullableNumber = (value) => value === null ? null : num(value);
const interval = (value) => value === null ? null : { difference: num(value.difference), low: num(value.low), high: num(value.high) };
const metricNames = Object.freeze(["usefulPrecision", "partialRate", "noiseRate", "staleRate", "usefulCoverage", "followUpUsefulCoverage", "directUsefulCoverage", "followUpNoiseRate", "usefulLines", "bytesPerTurn", "repeatedBytesPerTurn", "latencyMsPerTurn", "capturedLinesPerTurn", "captureUsefulPrecision", "capturePartialRate", "captureNoiseRate", "captureStaleRate", "chatCallsPerTurn", "embeddingRequestsPerTurn", "indexingEmbeddingRequestsPerTurn", "capturedLinesPerDay", "captureUsefulLinesPerDay", "captureNoiseLinesPerDay"]);
export const newReviewSeed = () => randomBytes(32).toString("hex");
export function reviewId(seed, ...coordinates) { return createHmac("sha256", seed).update(JSON.stringify(coordinates)).digest("hex").slice(0, 32); }
export function blindSheets(rows) {
  // Neither arm labels, source ids, text nor ordering by arm enter the sheets.
  return rows.flatMap((row) => row.lines.map((line) => ({ id: line.id, label: null }))).sort((a, b) => a.id.localeCompare(b.id));
}
export function safeObservation(row) {
  return { dayId: id(row.dayId), id: id(row.id), conversationId: id(row.conversationId), arm: enumValue(row.arm, PRIVATE_ARMS),
    followUp: bool(row.followUp), directQuestion: bool(row.directQuestion), contaminated: bool(row.contaminated),
    flags: row.flags.map((flag) => enumValue(flag, EVIDENCE_FLAGS)),
    status: enumValue(row.status, ["completed", "unsupported", ...PRIVATE_CODES]),
    bytes: num(row.bytes), repeatedBytes: num(row.repeatedBytes), latencyMs: num(row.latencyMs), chatCalls: num(row.chatCalls), embeddingRequests: num(row.embeddingRequests), indexingEmbeddingRequests: num(row.indexingEmbeddingRequests),
    lines: row.lines.map((line) => ({ id: id(line.id), kind: enumValue(line.kind, LINE_KINDS),
      bytes: num(line.bytes), repeated: bool(line.repeated), label: line.label === null ? null : enumValue(line.label, LABELS) })) };
}
function safeSummary(summary) {
  return { status: enumValue(summary.status, ["inconclusive", "measured"]),
    evidence: enumValue(summary.evidence, ["strict", "diagnostic"]),
    selectedTurns: num(summary.selectedTurns), followUps: num(summary.followUps), judgedFollowUpLines: num(summary.judgedFollowUpLines),
    contaminatedTurns: num(summary.contaminatedTurns), unjudgedLines: num(summary.unjudgedLines),
    arms: summary.arms.map((arm) => ({ arm: enumValue(arm.arm, PRIVATE_ARMS), status: enumValue(arm.status, ["completed", "unsupported", "inconclusive"]),
      turns: num(arm.turns), lines: num(arm.lines), judgedLines: num(arm.judgedLines),
      metrics: Object.fromEntries(metricNames.map((key) => [key, nullableNumber(arm.metrics[key])])) })),
    comparisons: summary.comparisons.map((pair) => ({ baseline: enumValue(pair.baseline, PRIVATE_ARMS), candidate: enumValue(pair.candidate, PRIVATE_ARMS),
      status: enumValue(pair.status, ["inconclusive", "measured", "unsupported"]), conversations: num(pair.conversations),
      metrics: Object.fromEntries(metricNames.map((key) => [key, interval(pair.metrics[key])])) })) };
}
/** The ONLY private artifact serializer. No recursive pass-through, redaction,
 * spread of provider objects, exception messages, paths or private manifests. */
export function serializePrivateArtifact(kind, value) {
  let safe;
  if (kind === "observations") safe = value.map(safeObservation);
  else if (kind === "review") safe = value.map((row) => ({ id: id(row.id), label: row.label === null ? null : enumValue(row.label, LABELS) }));
  else if (kind === "code") {
    if (!/^[a-f0-9]{40}$/u.test(value.head) || !/^[a-f0-9]{64}$/u.test(value.buildDigest)) throw new PrivateError("private_input_invalid");
    safe = { head: value.head, buildDigest: value.buildDigest };
  }
  else if (kind === "protocol") safe = { id: id(value.id) };
  else if (kind === "seed") {
    if (!/^[a-f0-9]{64}$/u.test(value.seed)) throw new PrivateError("private_input_invalid");
    safe = { seed: value.seed };
  } else if (kind === "summary") safe = value.map(safeSummary);
  else if (kind === "error") safe = { code: enumValue(value.code, PRIVATE_CODES) };
  else throw new PrivateError("private_input_invalid");
  return JSON.stringify(safe, null, 2) + "\n";
}
export async function writePrivateArtifact(root, filename, kind, value) {
  if (!new Set(["observations.json", "review.json", "review-seed.json", "summary.json", "error.json", "model-review.json", "human-review.json", "summary-unjudged.json", "protocol.json", "code.json"]).has(filename)) throw new PrivateError("private_input_invalid");
  const content = serializePrivateArtifact(kind, value);
  const handle = await open(join(root, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); } finally { await handle.close(); }
}

const ratio = (a, b) => b === 0 ? null : a / b;
export function metrics(rows) {
  const allLines = rows.flatMap((row) => row.lines);
  const capture = allLines.filter((line) => line.kind === "capture");
  const days = new Set(rows.map((row) => row.dayId)).size;
  const captureJudged = capture.filter((line) => LABELS.includes(line.label));
  const lines = allLines.filter((line) => line.kind !== "capture");
  const judged = lines.filter((line) => LABELS.includes(line.label));
  const useful = judged.filter((line) => line.label === "useful").length;
  const covered = (row) => row.lines.some((line) => line.kind !== "capture" && line.label === "useful");
  const follows = rows.filter((row) => row.followUp), directs = rows.filter((row) => row.directQuestion);
  const followLines = follows.flatMap((row) => row.lines).filter((line) => line.kind !== "capture" && LABELS.includes(line.label));
  return {
    usefulPrecision: ratio(useful, judged.length), partialRate: ratio(judged.filter((line) => line.label === "partial").length, judged.length),
    noiseRate: ratio(judged.filter((line) => line.label === "noise").length, judged.length), staleRate: ratio(judged.filter((line) => line.label === "stale").length, judged.length),
    usefulCoverage: ratio(rows.filter(covered).length, rows.length), followUpUsefulCoverage: ratio(follows.filter(covered).length, follows.length),
    directUsefulCoverage: ratio(directs.filter(covered).length, directs.length),
    followUpNoiseRate: ratio(followLines.filter((line) => line.label === "noise").length, followLines.length), usefulLines: useful,
    bytesPerTurn: ratio(rows.reduce((sum, row) => sum + row.bytes, 0), rows.length),
    repeatedBytesPerTurn: ratio(rows.reduce((sum, row) => sum + row.repeatedBytes, 0), rows.length),
    latencyMsPerTurn: ratio(rows.reduce((sum, row) => sum + row.latencyMs, 0), rows.length),
    capturedLinesPerTurn: ratio(capture.length, rows.length),
    captureUsefulPrecision: ratio(captureJudged.filter((line) => line.label === "useful").length, captureJudged.length),
    capturePartialRate: ratio(captureJudged.filter((line) => line.label === "partial").length, captureJudged.length),
    captureNoiseRate: ratio(captureJudged.filter((line) => line.label === "noise").length, captureJudged.length),
    captureStaleRate: ratio(captureJudged.filter((line) => line.label === "stale").length, captureJudged.length),
    chatCallsPerTurn: ratio(rows.reduce((sum, row) => sum + row.chatCalls, 0), rows.length),
    embeddingRequestsPerTurn: ratio(rows.reduce((sum, row) => sum + row.embeddingRequests, 0), rows.length),
    indexingEmbeddingRequestsPerTurn: ratio(rows.reduce((sum, row) => sum + row.indexingEmbeddingRequests, 0), rows.length),
    capturedLinesPerDay: ratio(capture.length, days),
    captureUsefulLinesPerDay: ratio(captureJudged.filter((line) => line.label === "useful").length, days),
    captureNoiseLinesPerDay: ratio(captureJudged.filter((line) => line.label === "noise").length, days),
  };
}
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let n = state; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
/** Match cases first, then resample whole conversations together on both arms.
 * Never resample independent lines or unmatched turns. Percentile 95% intervals. */
export function pairedBootstrap(baseline, candidate, { iterations = 2000, seed = 1729 } = {}) {
  const candidateById = new Map(candidate.map((row) => [row.id, row]));
  const groups = new Map();
  for (const row of baseline) {
    const other = candidateById.get(row.id);
    if (!other || other.conversationId !== row.conversationId) continue;
    if (!groups.has(row.conversationId)) groups.set(row.conversationId, { baseline: [], candidate: [] });
    groups.get(row.conversationId).baseline.push(row); groups.get(row.conversationId).candidate.push(other);
  }
  const conversations = [...groups.values()];
  const pointA = metrics(conversations.flatMap((group) => group.baseline));
  const pointB = metrics(conversations.flatMap((group) => group.candidate));
  const samples = Object.fromEntries(metricNames.map((key) => [key, []])); const random = randomGenerator(seed);
  if (conversations.length >= 2) for (let iteration = 0; iteration < iterations; iteration += 1) {
    const selected = Array.from({ length: conversations.length }, () => conversations[Math.floor(random() * conversations.length)]);
    const a = metrics(selected.flatMap((group) => group.baseline)), b = metrics(selected.flatMap((group) => group.candidate));
    for (const key of metricNames) if (a[key] !== null && b[key] !== null) samples[key].push(b[key] - a[key]);
  }
  return { conversations: conversations.length, metrics: Object.fromEntries(metricNames.map((key) => {
    const values = samples[key].sort((a, b) => a - b);
    // Undefined precision in many bootstrap samples is not a confident estimate.
    return [key, pointA[key] === null || pointB[key] === null || values.length < iterations * 0.95 ? null : {
      difference: pointB[key] - pointA[key], low: values[Math.floor((values.length - 1) * 0.025)], high: values[Math.ceil((values.length - 1) * 0.975)],
    }];
  })) };
}
export function summarizePrivate(rows, registration, evidence = "diagnostic") {
  const completed = rows.filter((row) => row.status === "completed" && (evidence === "diagnostic" || !row.contaminated));
  const base = completed.filter((row) => row.arm === "current-only");
  const followUps = base.filter((row) => row.followUp).length;
  const judgedFollowUpLines = base.filter((row) => row.followUp).flatMap((row) => row.lines).filter((line) => line.kind !== "capture" && line.label !== null).length;
  const unjudgedLines = completed.flatMap((row) => row.lines).filter((line) => line.label === null).length;
  const enough = (cases, follow, judged) => cases >= registration.minimumTurns && follow >= registration.minimumFollowUps && judged >= registration.minimumJudgedFollowUpLines;
  const status = enough(base.length, followUps, judgedFollowUpLines) && unjudgedLines === 0 ? "measured" : "inconclusive";
  const arms = PRIVATE_ARMS.filter((arm) => rows.some((row) => row.arm === arm)).map((arm) => {
    const selected = completed.filter((row) => row.arm === arm), lines = selected.flatMap((row) => row.lines);
    const unsupported = rows.filter((row) => row.arm === arm).every((row) => row.status === "unsupported");
    return { arm, status: unsupported ? "unsupported" : selected.length === base.length && selected.length > 0 ? "completed" : "inconclusive",
      turns: selected.length, lines: lines.length, judgedLines: lines.filter((line) => line.label !== null).length, metrics: metrics(selected) };
  });
  const pairs = [["current-only", "follow-up-window"], ["length-only-abstention", "follow-up-window"], ["current-only", "profile-on"], ["follow-up-window", "window-profile-on"], ["current-only", "semantic-only"], ["historical-baseline", "current-only"]];
  const comparisons = pairs.filter(([a, b]) => arms.some((row) => row.arm === a) && arms.some((row) => row.arm === b)).map(([baseline, candidate]) => {
    const a = completed.filter((row) => row.arm === baseline), b = completed.filter((row) => row.arm === candidate);
    const match = new Set(b.map((row) => row.id)); const paired = a.filter((row) => match.has(row.id));
    const pairedFollow = paired.filter((row) => row.followUp);
    // The pre-registered evidence minimum uses the current-only reference,
    // not the deliberately zero-line abstention arm. Zero injections are real
    // coverage observations, but their precision remains undefined.
    const pairedIds = new Set(paired.map((row) => row.id));
    const judged = base.filter((row) => pairedIds.has(row.id) && row.followUp).flatMap((row) => row.lines).filter((line) => line.kind !== "capture" && line.label !== null).length;
    const allJudged = [...paired, ...b.filter((row) => paired.some((other) => other.id === row.id))].every((row) => row.lines.every((line) => line.label !== null));
    const bootstrap = pairedBootstrap(a, b);
    const unsupported = [baseline, candidate].some((arm) => arms.find((row) => row.arm === arm)?.status === "unsupported");
    return { baseline, candidate, ...bootstrap, status: unsupported ? "unsupported" : enough(paired.length, pairedFollow.length, judged) && allJudged && bootstrap.conversations >= 2 ? "measured" : "inconclusive" };
  });
  return { status, evidence, selectedTurns: base.length, followUps, judgedFollowUpLines, unjudgedLines,
    contaminatedTurns: rows.filter((row) => row.arm === "current-only" && row.contaminated).length, arms, comparisons };
}
