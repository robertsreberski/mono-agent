import { AsyncLocalStorage } from "node:async_hooks";
import type { ProcessIncarnation } from "@mono-agent/conversation/process-incarnation";

import type {
  ManagedBackgroundRuntimeDeps,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimePreparationPhase,
  ManagedRuntimeStagingWarning,
} from "./types.js";
const RUNTIME_PROGRESS_INTERVAL_MS = 5_000;
const RUNTIME_WAIT_PROGRESS_INTERVAL_MS = 30_000;

interface RuntimePreparationProgress {
  phase(phase: ManagedRuntimePreparationPhase, total?: number): void;
  work(packageCopied?: boolean): void;
  waiting(ownerPid?: number, incarnation?: ProcessIncarnation): void;
  warning(reason: ManagedRuntimeStagingWarning): void;
  removed(): void;
  checkFailure(): void;
}
export const runtimePreparationProgress = new AsyncLocalStorage<RuntimePreparationProgress>();

export function preparationProgress(input: ManagedBackgroundRuntimeInput, deps: ManagedBackgroundRuntimeDeps): RuntimePreparationProgress {
  if (input.onProgress === undefined) return { phase() {}, work() {}, waiting() {}, warning() {}, removed() {}, checkFailure() {} };
  const startedAt = deps.now();
  let phase: ManagedRuntimePreparationPhase = "reuse";
  let completed = 0;
  let total: number | undefined;
  let ownerPid: number | undefined;
  let waitingOwner: string | undefined;
  let warning: ManagedRuntimeStagingWarning | undefined;
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  let aborted = false;
  let failure: unknown;
  const emit = (force: boolean): void => {
    if (aborted) return;
    const now = deps.now();
    if (!force && now - lastReportedAt < (phase === "waiting"
      ? RUNTIME_WAIT_PROGRESS_INTERVAL_MS : RUNTIME_PROGRESS_INTERVAL_MS)) return;
    lastReportedAt = now;
    try {
      input.onProgress?.({ phase, elapsedMs: Math.max(0, now - startedAt), completed,
        ...(total === undefined ? {} : { total }), ...(ownerPid === undefined ? {} : { ownerPid }),
        ...(warning === undefined ? {} : { warning }) });
    } catch (error) { aborted = true; failure = error; }
  };
  return {
    // Surface observer errors only outside verifiers which intentionally catch filesystem errors.
    checkFailure() { if (aborted) throw failure; },
    phase(next, count) {
      this.checkFailure();
      phase = next; completed = 0; total = count; ownerPid = undefined; emit(true);
      this.checkFailure();
    },
    work(packageCopied = false) {
      if (phase === "waiting" || phase === "ready" || phase === "cleanup"
        || (phase === "copy" && !packageCopied)) return;
      completed += 1;
      emit(false);
    },
    removed() { completed += 1; emit(true); },
    warning(reason) { warning = reason; try { emit(true); } finally { warning = undefined; } },
    waiting(pid, incarnation) {
      const identity = JSON.stringify([pid, incarnation]);
      const changed = phase !== "waiting" || waitingOwner !== identity;
      waitingOwner = identity;
      phase = "waiting"; ownerPid = pid; total = undefined; completed = 0;
      emit(changed);
    },
  };
}

export function reportRuntimePhase(phase: ManagedRuntimePreparationPhase, total?: number): void {
  runtimePreparationProgress.getStore()?.phase(phase, total);
}
export function reportRuntimeWork(packageCopied = false): void {
  runtimePreparationProgress.getStore()?.work(packageCopied);
}
