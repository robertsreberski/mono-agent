import type { ManagedRuntimeProgress } from "./types.js";

const PHASE_LABELS = {
  reuse: "checking finalized runtime reuse",
  source: "capturing the source dependency closure",
  "source-verification": "rechecking source identity and dependency resolution",
  copy: "copying the exact dependency packages",
  "staged-verification": "verifying staged runtime bytes",
  promotion: "promoting and verifying the private runtime",
  "proof-publication": "publishing the runtime reuse proof",
  "final-verification": "verifying the finalized runtime",
  cleanup: "cleaning abandoned runtime staging",
  ready: "runtime preparation complete",
} as const;

/** Shared terminal prose for agent and web lifecycle preparation. No filesystem paths. */
export function formatManagedRuntimeProgress(progress: ManagedRuntimeProgress): string {
  if (progress.warning !== undefined) {
    const reasons = {
      "unsafe-staging": "unsafe abandoned staging was left untouched",
      "staging-changed": "abandoned staging changed during cleanup and was retained",
      "staging-cleanup-failed": "abandoned staging cleanup could not finish; retained artifacts can be retried",
    };
    return `Managed runtime: ${reasons[progress.warning]}.`;
  }
  const duration = `${(Math.max(0, progress.elapsedMs) / 1_000).toFixed(1)}s elapsed`;
  if (progress.phase === "waiting") {
    return "Waiting for another mono-agent process preparing the runtime"
      + (progress.ownerPid === undefined ? "" : ` (pid ${progress.ownerPid})`)
      + `; ${duration}. The existing installer is still live.`;
  }
  const count = progress.completed === 0 ? "" : progress.phase === "copy"
    ? `; ${progress.completed}${progress.total === undefined ? "" : `/${progress.total}`} packages copied`
    : `; ${progress.completed} filesystem checks`;
  return `Managed runtime: ${PHASE_LABELS[progress.phase]}${count} (${duration}).`;
}
