// Shared scratch lifecycle for physical-ownership proof fixtures.
//
// Every fixture that creates a mkdtemp root under `.mono-agent/verification/`
// removes that root when it is done — on success and on failure — so
// back-to-back runs stay idempotent for the `check:secrets` gate (gitleaks
// scans the working directory, and `.gitignore` does not hide files from it).
// Before creating a new root each fixture prunes stale roots of its own
// prefix, so a previously SIGKILLed run self-heals. Only the process that
// creates a root may remove it: `owner`/`recover` children receive a root as
// an argument and never call these helpers.
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export const KEEP_VERIFICATION_SCRATCH_ENV = "MONO_AGENT_KEEP_VERIFICATION_SCRATCH";

export function keepVerificationScratch(env = process.env) {
  return env[KEEP_VERIFICATION_SCRATCH_ENV] === "1";
}

export async function pruneVerificationScratch(verificationDir, prefix, label, { keep = false } = {}) {
  // Retention is deliberate: while the keep flag is set, do not delete what a
  // previous run was asked to leave behind for post-mortem inspection.
  if (keep) return [];
  let entries;
  try {
    entries = await readdir(verificationDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries.filter((name) => name.startsWith(prefix))) {
    try {
      await rm(resolve(verificationDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      console.error(`[${label}] failed to prune stale verification scratch ${entry}: ${error?.message ?? error}`);
    }
  }
  if (removed.length > 0) console.error(`[${label}] pruned stale verification scratch: ${removed.join(", ")}`);
  return removed;
}

export async function removeVerificationScratch(root, { keep, label }) {
  if (keep) {
    console.error(`[${label}] retained verification scratch (${KEEP_VERIFICATION_SCRATCH_ENV}=1): ${root}`);
    return "retained";
  }
  try {
    await rm(root, { recursive: true, force: true });
    return "removed";
  } catch (error) {
    // A cleanup failure must never replace the proof's own verdict: the next
    // run's prefix prune self-heals, so report loudly and let the caller pass.
    console.error(`[${label}] failed to remove verification scratch ${root}: ${error?.message ?? error}`);
    return "remove-failed";
  }
}
