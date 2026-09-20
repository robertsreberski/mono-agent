import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "./memory-e2e-dataset.mjs";

const PAYLOAD_FILES = Object.freeze([
  "manifest.json", "summary.json", "trials.jsonl", "events.jsonl", "capture.jsonl", "review.json", "checkpoint.json",
]);

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

export function checkpointIdentity(manifest) {
  return {
    confirmation: manifest.confirmation,
    protocol: manifest.protocol,
    adapterProtocol: manifest.locomo?.protocol ?? null,
    adapterProtocolIdentity: manifest.locomo?.protocolIdentity ?? null,
    codeRevision: manifest.codeRevision,
    corpusSha256: manifest.corpusSha256,
    arms: manifest.arms,
    profile: manifest.profile,
    readerPromptSha256: manifest.readerPrompt?.sha256 ?? null,
    sourceIdentitySha256: manifest.locomo?.source?.identitySha256 ?? null,
    questionIdentitySha256: manifest.locomo?.selected?.questionIdentitySha256 ?? null,
    evaluatorIdentity: manifest.locomo?.evaluator?.identity ?? null,
  };
}

export function checkpointForBundle(bundle) {
  const expected = bundle.manifest.workload?.trials ?? 0;
  const completed = bundle.trials.filter((trial) => trial.status === "completed").length;
  const funnel = bundle.summary.diagnosticFunnel;
  const complete = expected > 0 && completed === expected
    && bundle.manifest.trialsNotStarted === 0
    && bundle.manifest.providerStop === null
    && (funnel === undefined || funnel.status === "complete");
  const identity = checkpointIdentity(bundle.manifest);
  return {
    schemaVersion: 1,
    status: complete ? "complete" : "incomplete_retained_not_reusable",
    identity,
    identitySha256: digest(identity),
    completion: { expectedTrials: expected, completedTrials: completed, diagnosticFunnel: funnel?.status ?? "not_applicable" },
  };
}

async function privateFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error("unsafe_checkpoint_file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

/**
 * Verify an immutable completed artifact before reusing it. Equality is exact:
 * code revision, protocol, source/question projections, prompt, models/profile,
 * limits, and arms are all transitively bound by confirmation plus the expanded
 * identity. Incomplete artifacts are retained evidence, never reusable zeros.
 */
export async function loadReusableArtifact(directory, expectedPlan) {
  const absolute = resolve(directory);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("unsafe_checkpoint_directory");
  const checksumBytes = await privateFile(join(absolute, "checksums.json"));
  const checksums = JSON.parse(checksumBytes.toString("utf8"));
  const payloads = new Map();
  for (const file of PAYLOAD_FILES) {
    if (typeof checksums[file] !== "string") throw new Error("checkpoint_checksum_missing");
    const bytes = await privateFile(join(absolute, file));
    if (sha(bytes) !== checksums[file]) throw new Error("checkpoint_checksum_mismatch");
    payloads.set(file, bytes);
  }
  const manifest = JSON.parse(payloads.get("manifest.json").toString("utf8"));
  const checkpoint = JSON.parse(payloads.get("checkpoint.json").toString("utf8"));
  const expectedIdentity = checkpointIdentity(expectedPlan);
  if (checkpoint.schemaVersion !== 1 || checkpoint.status !== "complete"
    || checkpoint.identitySha256 !== digest(checkpoint.identity)
    || digest(checkpoint.identity) !== digest(expectedIdentity)
    || manifest.confirmation !== expectedPlan.confirmation
    || manifest.executionKind !== "real") {
    throw new Error("checkpoint_identity_mismatch");
  }
  return {
    status: "reused_exact_completed_artifact",
    checkpointIdentitySha256: checkpoint.identitySha256,
    summary: JSON.parse(payloads.get("summary.json").toString("utf8")),
  };
}
