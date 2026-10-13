import { currentProcessIncarnation, readProcessIncarnation, processIncarnationFromJson, processIncarnationsEqual, type ProcessIncarnation } from "./process-incarnation.js";

let current: Promise<ProcessIncarnation | undefined> | undefined;
/** History alone falls back to PID-only when OS identity evidence is unavailable. */
export function currentHistoryProcessIncarnation(): Promise<ProcessIncarnation | undefined> {
  return current ??= currentProcessIncarnation().catch(() => undefined);
}

/** A nullable SQLite JSON value or an optional marker object; unknown identity is never death proof. */
export function historyOwnerIncarnation(value: unknown): ProcessIncarnation | undefined {
  try { return processIncarnationFromJson(typeof value === "string" ? JSON.parse(value) : value); }
  catch { return undefined; }
}

/** One identity lookup per owner per wait/scan, then only kill(0) polling.
 * Do not retain this cache across acquisitions: a new owner requires fresh proof. */
export function historyOwnerLiveness(): (pid: number, incarnation?: ProcessIncarnation) => Promise<boolean> {
  const owners = new Map<string, Promise<ProcessIncarnation | undefined>>();
  return async (pid, incarnation) => {
    if (!isProcessAlive(pid)) return false;
    if (incarnation === undefined) return true;
    const key = JSON.stringify([pid, incarnation.bootSessionId, incarnation.processStartId]);
    let lookup = owners.get(key);
    if (!lookup) {
      lookup = pid === process.pid ? currentHistoryProcessIncarnation() : readProcessIncarnation(pid).catch(() => undefined);
      owners.set(key, lookup);
    }
    const actual = await lookup;
    return isProcessAlive(pid) && (actual === undefined || processIncarnationsEqual(actual, incarnation));
  };
}

/** True when a PID is currently alive or exists but is not signalable by this user. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
