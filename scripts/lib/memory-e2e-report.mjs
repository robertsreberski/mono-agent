import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digest, ARMS } from "./memory-e2e-dataset.mjs";

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), unit: "ms", method: "nearest-rank", exploratory: sorted.length < 20 };
}
export function ratio(numerator, denominator) { return { value: denominator ? numerator / denominator : null, numerator, denominator }; }

/** This is a lexical diagnostic, deliberately NOT semantic correctness or abstention grading. */
export function lexicalDiagnostic(answer, evaluation, kind) {
  if (kind !== "real") return { status: "not_applicable_scripted", value: null };
  if (!evaluation.accepted.length) return { status: "requires_semantic_annotation", value: null };
  const text = answer.toLowerCase();
  const forbidden = evaluation.forbidden.some((word) => text.includes(word.toLowerCase()));
  const negated = /\b(?:not|never|no|isn't|wasn't|don't|cannot)\b/iu.test(text);
  return { status: "lexical_only", value: !forbidden && !negated && evaluation.accepted.some((word) => text.includes(word.toLowerCase())) };
}
export function summarize(trials, events, kind) {
  return {
    mode: kind, qualityMeasured: false,
    semanticQA: { value: null, status: kind === "real" ? "annotation_pending" : "not_applicable_scripted" },
    capturePrecisionRecall: { precision: null, recall: null, status: "annotation_pending" },
    abstention: { value: null, status: "annotation_pending" },
    humanReview: { status: "not_performed", sampleSize: 0 },
    arms: Object.fromEntries(ARMS.map((arm) => {
      const rows = trials.filter((trial) => trial.arm === arm);
      const stages = [...new Set(events.filter((event) => event.arm === arm).map((event) => event.stage))];
      return [arm, {
        scheduled: rows.length, completion: ratio(rows.filter((row) => row.status === "completed").length, rows.filter((row) => row.status !== "not_applicable").length),
        failures: rows.filter((row) => !["completed", "not_applicable"].includes(row.status)).map((row) => ({ groupId: row.groupId, status: row.status, failureKind: row.runtimeFailureKind ?? row.captureFailureKind ?? null })),
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
  const files = {
    "manifest.json": JSON.stringify(safe.manifest, null, 2) + "\n",
    "summary.json": JSON.stringify(safe.summary, null, 2) + "\n",
    "trials.jsonl": safe.trials.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "events.jsonl": safe.events.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "capture.jsonl": safe.capture.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "review.json": JSON.stringify(safe.review, null, 2) + "\n",
  };
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(directory, file), bytes, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "checksums.json"), JSON.stringify(Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])), null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
