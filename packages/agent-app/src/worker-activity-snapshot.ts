import process from "node:process";
import type { BackgroundLifecycleTarget } from "./background.js";
import type { LaunchdPaths } from "./launchd.js";
import { currentProcessIncarnation, isSameProcessIncarnation, processIncarnationFromJson, type ProcessIncarnation, type SameProcessIncarnation } from "./process-incarnation.js";
import { readPrivateLaunchdState, removePrivateLaunchdState, writePrivateLaunchdState } from "./private-launchd-state.js";
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
  let pending: WorkerActivitySnapshot | undefined;
  const publish = (counts: WorkerActivityCounts): void => {
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
          try { await writePrivateLaunchdState(target, DIRECTORY, snapshot); }
          catch {
            // Do not leave an old authenticated idle snapshot after a failed busy write.
            await removePrivateLaunchdState(target, DIRECTORY).catch(() => undefined);
            try { reportFailure(); } catch { /* Reporting cannot break accounting. */ }
          }
        }
      } finally { writing = false; }
    })();
  };
  const unsubscribe = tracker.subscribe(publish);
  publish(tracker.snapshot());
  await writes;
  return { stop: async () => {
    unsubscribe();
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
