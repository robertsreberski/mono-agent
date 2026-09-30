import process from "node:process";
import type { BackgroundLifecycleTarget } from "./background.js";
import type { LaunchdPaths } from "./launchd.js";
import { currentProcessIncarnation, isSameProcessIncarnation, processIncarnationFromJson, type ProcessIncarnation, type SameProcessIncarnation } from "./process-incarnation.js";
import { assertPrivateLaunchdStateWritable, readPrivateLaunchdState, removePrivateLaunchdState, writePrivateLaunchdState } from "./private-launchd-state.js";
import { activityBusy, type WorkerActivityCounts, type WorkerActivityTracker } from "./worker-activity.js";

const DIRECTORY = "worker-activity";
export interface WorkerActivitySnapshot {
  readonly version: 1;
  readonly pid: number;
  readonly incarnation: ProcessIncarnation;
  readonly counts: WorkerActivityCounts;
  readonly busy: boolean;
  readonly updatedAt: string;
}
export interface WorkerActivityProbe {
  readonly disposition: "idle" | "busy" | "unknown" | "not-running";
  readonly counts?: WorkerActivityCounts;
}

export async function publishWorkerActivity(
  target: BackgroundLifecycleTarget,
  tracker: WorkerActivityTracker,
  reportFailure: () => void,
): Promise<{ stop(): Promise<void> }> {
  const incarnation = await currentProcessIncarnation();
  let writes = Promise.resolve();
  let writing = false;
  let stopped = false;
  let dirty = false;
  let failureReported = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pending: WorkerActivitySnapshot | undefined;
  const publish = (counts: WorkerActivityCounts): void => {
    if (stopped) return;
    if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
    pending = {
      version: 1, pid: process.pid, incarnation, counts,
      busy: activityBusy(counts), updatedAt: new Date().toISOString(),
    };
    if (writing) return;
    writing = true;
    // Start immediately, not on a heartbeat/debounce. Coalesce transitions
    // during an atomic write into one latest snapshot, never an unbounded tail
    // of stale idle/busy replacements under a burst of short invocations.
    writes = (async () => {
      try {
        while (pending !== undefined) {
          const snapshot = pending;
          pending = undefined;
          try {
            await writePrivateLaunchdState(target, DIRECTORY, snapshot);
            dirty = false;
            failureReported = false;
          } catch {
            // Retire the main record first; a poisoned .next cannot preserve
            // an authenticated idle snapshot after a busy publication fails.
            try { await removePrivateLaunchdState(target, DIRECTORY); dirty = false; }
            catch {
              dirty = true;
              try {
                if (await readPrivateLaunchdState(target.label, target.paths, DIRECTORY) === undefined) dirty = false;
              } catch { /* Failed removal remains dirty until corrected or gone. */ }
            }
            if (!failureReported) {
              failureReported = true;
              try { reportFailure(); } catch { /* Reporting cannot break accounting. */ }
            }
          }
        }
      } finally {
        writing = false;
        // A failed write AND failed retirement must not wait for another activity
        // transition. This is a worker-local publication retry, not a helper loop.
        if (dirty && !stopped) {
          retry = setTimeout(() => { retry = undefined; publish(tracker.snapshot()); }, 250);
          retry.unref();
        }
      }
    })();
  };
  const unsubscribe = tracker.subscribe(publish);
  publish(tracker.snapshot());
  await writes;
  return { stop: async () => {
    stopped = true;
    unsubscribe();
    if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
    await writes;
    await removePrivateLaunchdState(target, DIRECTORY);
  } };
}

export async function probeWorkerActivity(
  mainLabel: string,
  paths: Pick<LaunchdPaths, "logDir">,
  pid: number | undefined,
  isAlive: (pid: number) => boolean,
  sameIncarnation: SameProcessIncarnation = isSameProcessIncarnation,
): Promise<WorkerActivityProbe> {
  if (pid === undefined || !isAlive(pid)) return { disposition: "not-running" };
  try {
    const value = await readPrivateLaunchdState(mainLabel, paths, DIRECTORY);
    if (!validSnapshot(value) || value.pid !== pid || !await sameIncarnation(pid, value.incarnation)) {
      return { disposition: "unknown" };
    }
    // A writer that cannot replace OR retire this file may be retrying behind
    // an authenticated but stale idle record. Treat immutability/ACL denial as
    // unknown without mutating anything or changing other status read paths.
    await assertPrivateLaunchdStateWritable(mainLabel, paths, DIRECTORY);
    return { disposition: value.busy ? "busy" : "idle", counts: value.counts };
  } catch {
    // Unsupported old workers and unsafe/unreadable snapshots receive the same
    // bounded protection as known busy workers. Never trust PID alone.
    return { disposition: "unknown" };
  }
}

function validSnapshot(value: unknown): value is WorkerActivitySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as WorkerActivitySnapshot;
  const counts = snapshot.counts;
  return Object.keys(snapshot).sort().join(",") === "busy,counts,incarnation,pid,updatedAt,version"
    && snapshot.version === 1 && Number.isSafeInteger(snapshot.pid) && snapshot.pid > 0
    && processIncarnationFromJson(snapshot.incarnation) !== undefined
    && typeof snapshot.updatedAt === "string" && Number.isFinite(Date.parse(snapshot.updatedAt))
    && new Date(snapshot.updatedAt).toISOString() === snapshot.updatedAt
    && typeof counts === "object" && counts !== null
    && Object.keys(counts).sort().join(",") === "asks,jobs,turns"
    && [counts.turns, counts.jobs, counts.asks].every((count) => Number.isSafeInteger(count) && count >= 0)
    && typeof snapshot.busy === "boolean" && snapshot.busy === activityBusy(counts);
}
