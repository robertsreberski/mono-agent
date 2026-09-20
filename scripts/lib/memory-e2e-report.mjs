import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digest, ARMS } from "./memory-e2e-dataset.mjs";
import { checkpointForBundle } from "./memory-e2e-checkpoint.mjs";
import { lexicalAnswerScore, locomoCategory5Abstains, officialLocomoScore } from "./memory-e2e-locomo.mjs";

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), unit: "ms", method: "nearest-rank", exploratory: sorted.length < 20 };
}
export function ratio(numerator, denominator) { return { value: denominator ? numerator / denominator : null, numerator, denominator }; }

/** Local deterministic scoring only; non-LoCoMo cases remain lexical diagnostics. */
export function lexicalDiagnostic(answer, evaluation, kind) {
  if (kind !== "real") return { status: "not_applicable_scripted", value: null };
  if (evaluation.locomoCategory === 5) {
    const abstained = locomoCategory5Abstains(answer);
    return {
      status: "locomo_official_pinned",
      metric: "category_5_abstention_accuracy",
      officialScore: officialLocomoScore(answer, null, 5),
      exact: null,
      f1: null,
      abstained,
    };
  }
  if (!evaluation.accepted.length) return { status: "requires_semantic_annotation", value: null };
  if (Number.isSafeInteger(evaluation.locomoCategory)) return {
    status: "locomo_official_pinned",
    metric: evaluation.locomoCategory === 1 ? "comma_split_partial_f1" : "porter_token_f1",
    officialScore: officialLocomoScore(answer, evaluation.accepted[0], evaluation.locomoCategory),
    secondaryNormalizedDiagnostic: lexicalAnswerScore(answer, evaluation.accepted),
  };
  const text = answer.toLowerCase();
  const forbidden = evaluation.forbidden.some((word) => text.includes(word.toLowerCase()));
  const negated = /\b(?:not|never|no|isn't|wasn't|don't|cannot)\b/iu.test(text);
  return { status: "lexical_only", value: !forbidden && !negated && evaluation.accepted.some((word) => text.includes(word.toLowerCase())) };
}
function officialScoreSummary(rows) {
  const completed = rows.filter((row) => row.status === "completed"
    && Number.isFinite(row.lexicalDiagnostic?.officialScore));
  const valid = rows.length > 0 && completed.length === rows.length;
  return {
    value: valid ? completed.reduce((sum, row) => sum + row.lexicalDiagnostic.officialScore, 0) / completed.length : null,
    status: rows.length === 0 ? "not_applicable" : valid ? "complete" : "invalid_incomplete",
    scheduled: rows.length,
    completed: completed.length,
  };
}

function pairedDelta(left, right) {
  if (left.status === "not_applicable" && right.status === "not_applicable") {
    return { value: null, status: "not_applicable" };
  }
  return left.status === "complete" && right.status === "complete"
    ? { value: right.value - left.value, status: "complete" }
    : { value: null, status: "invalid_incomplete" };
}

function locomoOfficialSummary(trials) {
  const rows = trials.filter((row) => Number.isSafeInteger(row.locomoCategory));
  if (rows.length === 0) return undefined;
  const arms = [...new Set(rows.map((row) => row.arm))];
  const byArm = Object.fromEntries(arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    return [arm, {
      overall: officialScoreSummary(armRows),
      nonAdversarial: officialScoreSummary(armRows.filter((row) => row.locomoCategory !== 5)),
      categories: Object.fromEntries([1, 2, 3, 4, 5].map((category) => [
        category, officialScoreSummary(armRows.filter((row) => row.locomoCategory === category)),
      ])),
    }];
  }));
  const paired = byArm["full-history"] && byArm.bujo ? {
    direction: "bujo_minus_full_history",
    overall: pairedDelta(byArm["full-history"].overall, byArm.bujo.overall),
    nonAdversarial: pairedDelta(byArm["full-history"].nonAdversarial, byArm.bujo.nonAdversarial),
    categories: Object.fromEntries([1, 2, 3, 4, 5].map((category) => [
      category, pairedDelta(byArm["full-history"].categories[category], byArm.bujo.categories[category]),
    ])),
  } : undefined;
  return {
    evaluator: "snap-research/locomo@3eb6f2c5:task_eval/evaluation.py",
    headline: "question_weighted_category_aware_score",
    byArm,
    ...(paired === undefined ? {} : { paired }),
  };
}

function locomoFunnel(trials, events, capture) {
  const rows = trials.filter((trial) => Number.isSafeInteger(trial.locomoCategory));
  if (rows.length === 0) return undefined;
  const bujo = rows.filter((trial) => trial.arm === "bujo");
  const completedBujo = bujo.filter((trial) => trial.status === "completed");
  const extraction = capture.filter((row) => row.arm === "bujo" && row.stage === "extraction");
  const reconciliation = capture.filter((row) => row.arm === "bujo" && row.stage === "reconciliation");
  const inventories = capture.filter((row) => row.arm === "bujo" && row.stage === "inventory");
  const completedAdmissions = events.filter((row) => row.arm === "bujo" && row.stage === "admission" && row.status === "completed").length;
  const completedReadiness = events.filter((row) => row.arm === "bujo" && row.stage === "readiness_wait" && row.status === "completed").length;
  const automaticComplete = bujo.length === 0 || (completedBujo.length === bujo.length
    && completedBujo.every((trial) => trial.automatic.length === 1 && trial.automatic[0].status === "completed"));
  const answersComplete = rows.every((trial) => trial.status === "completed" && typeof trial.answer === "string");
  const captureComplete = bujo.length === 0 || (completedAdmissions > 0
    && completedAdmissions === completedReadiness && completedReadiness === inventories.length);
  return {
    status: captureComplete && automaticComplete && answersComplete ? "complete" : "incomplete_unmeasured",
    capture: {
      admissions: completedAdmissions,
      readiness: completedReadiness,
      candidates: extraction.length === 0 ? { availability: "unavailable", records: null } : { availability: "available_private_artifact", records: extraction.length },
      actions: reconciliation.length === 0 ? { availability: "unavailable", records: null } : { availability: "available_private_artifact", records: reconciliation.length },
      committedSnapshots: inventories.length === 0 ? { availability: "unavailable", records: null } : { availability: "available_private_artifact", records: inventories.length },
      complete: captureComplete,
    },
    retrieval: {
      raw: bujo.length === 0 ? { availability: "not_applicable", records: null } : {
        availability: completedBujo.some((trial) => trial.rawRetrievals.length > 0) ? "available_private_artifact" : "unavailable",
        records: completedBujo.reduce((sum, trial) => sum + trial.rawRetrievals.length, 0),
      },
      automaticDelivered: { complete: automaticComplete, records: completedBujo.reduce((sum, trial) => sum + trial.automatic.length, 0) },
      explicitToolDelivered: { availability: "instrumented", resultRecords: completedBujo.reduce((sum, trial) => sum + trial.tools.filter((tool) => tool.phase === "result").length, 0) },
    },
    readerAnswers: { complete: answersComplete, records: rows.filter((trial) => typeof trial.answer === "string").length },
  };
}

export function summarize(trials, events, kind, capture = []) {
  const locomoOfficial = locomoOfficialSummary(trials);
  const diagnosticFunnel = locomoFunnel(trials, events, capture);
  const officialLexicalMetricMeasured = kind === "real" && diagnosticFunnel?.status === "complete"
    && locomoOfficial !== undefined && Object.values(locomoOfficial.byArm).length > 0
    && Object.values(locomoOfficial.byArm).every((arm) => arm.overall.status === "complete");
  // The pinned official metric is a lexical diagnostic. It is not a semantic
  // correctness review, so the generic quality flag stays false until actual
  // human annotations are incorporated by a separate reviewed workflow.
  const semanticQualityMeasured = false;
  return {
    mode: kind,
    qualityMeasured: semanticQualityMeasured,
    semanticQualityMeasured,
    officialLexicalMetricMeasured,
    ...(diagnosticFunnel === undefined ? {} : { diagnosticFunnel }),
    ...(locomoOfficial === undefined ? {} : { locomoOfficial }),
    captureRecovery: {
      scheduled: events.filter((event) => event.stage === "capture_recovery" && event.status === "scheduled").length,
      exhausted: events.filter((event) => event.stage === "capture_recovery" && event.status === "exhausted").length,
    },
    semanticQA: { value: null, status: kind === "real" ? "annotation_pending" : "not_applicable_scripted" },
    capturePrecisionRecall: { precision: null, recall: null, status: "annotation_pending" },
    abstention: { value: null, status: "annotation_pending" },
    humanReview: { status: "not_performed", sampleSize: 0 },
    arms: Object.fromEntries(ARMS.map((arm) => {
      const rows = trials.filter((trial) => trial.arm === arm);
      const stages = [...new Set(events.filter((event) => event.arm === arm).map((event) => event.stage))];
      return [arm, {
        scheduled: rows.length,
        started: rows.filter((row) => row.status !== "unstarted").length,
        completion: ratio(rows.filter((row) => row.status === "completed").length, rows.filter((row) => !["unstarted", "not_applicable"].includes(row.status)).length),
        failures: rows.filter((row) => !["completed", "not_applicable", "unstarted"].includes(row.status)).map((row) => ({ groupId: row.groupId, ...(row.questionId === undefined ? {} : { questionId: row.questionId }), status: row.status, failureKind: row.runtimeFailureKind ?? row.captureFailureKind ?? null })),
        unstarted: rows.filter((row) => row.status === "unstarted").length,
        notApplicable: rows.filter((row) => row.status === "not_applicable").length,
        stages: Object.fromEntries(stages.map((stage) => [stage, {
          attempted: events.filter((e) => e.arm === arm && e.stage === stage).length,
          completed: events.filter((e) => e.arm === arm && e.stage === stage && e.status === "completed").length,
          completedLatency: percentiles(events.filter((e) => e.arm === arm && e.stage === stage && e.status === "completed").map((e) => e.durationMs)),
        }])),
      }];
    })),
  };
}

/** Fail-safe presentation of fictional model text; never serialize raw runtime/error objects. */
export function safeArtifact(value) {
  if (typeof value === "string") return value
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/gu, "<local-path>")
    .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|token)\s*[=:]\s*[^\s,;}]+)/giu, "<redacted>")
    .replace(/https?:\/\/[^\s"<>]+/gu, "<endpoint>");
  if (Array.isArray(value)) return value.map(safeArtifact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:apiKey|headers|env|providerSessionId|stack|cwd|root)$/iu.test(key)).map(([key, entry]) => [key, safeArtifact(entry)]));
  return value;
}

/** Owned relative output only: refuse existing symlinks at every directory boundary. */
export async function ownedParent(root) {
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error("noncanonical_root");
  let current = canonical;
  for (const segment of [".worklab-tmp", "memory-e2e"]) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current) throw new Error("unsafe_output_root");
  }
  return current;
}

export async function writeArtifacts(directory, bundle) {
  const safe = safeArtifact(bundle);
  const checkpoint = checkpointForBundle(safe);
  const files = {
    "manifest.json": JSON.stringify(safe.manifest, null, 2) + "\n",
    "summary.json": JSON.stringify(safe.summary, null, 2) + "\n",
    "trials.jsonl": safe.trials.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "events.jsonl": safe.events.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "capture.jsonl": safe.capture.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "review.json": JSON.stringify(safe.review, null, 2) + "\n",
    "checkpoint.json": JSON.stringify(checkpoint, null, 2) + "\n",
  };
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(directory, file), bytes, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "checksums.json"), JSON.stringify(Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])), null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
