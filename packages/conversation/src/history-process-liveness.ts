import { readHistoryProcessIncarnation, historyProcessIncarnationFromJson, type HistoryProcessIncarnation } from "./history-process-incarnation.js";

let current: Promise<HistoryProcessIncarnation | undefined> | undefined;
let retryAfter = 0;
const FAILED_PROBE_COOLDOWN_MS = 30_000;
/** History alone falls back to PID-only when OS identity evidence is unavailable.
 * Coalesce probes; cache success, but retry unavailable identity after a bounded
 * monotonic cooldown so persistent OS failures cannot spawn ps per marker. */
export function currentHistoryProcessIncarnation(): Promise<HistoryProcessIncarnation | undefined> {
  if (current) return current;
  if (performance.now() < retryAfter) return Promise.resolve(undefined);
  return current = readHistoryProcessIncarnation(process.pid).catch(() => undefined).then((identity) => {
    if (identity === undefined) {
      current = undefined;
      retryAfter = performance.now() + FAILED_PROBE_COOLDOWN_MS;
    }
    return identity;
  });
}

/** A nullable SQLite JSON value or an optional marker object; unknown identity is never death proof. */
export function historyOwnerIncarnation(value: unknown): HistoryProcessIncarnation | undefined {
  try { return historyProcessIncarnationFromJson(typeof value === "string" ? JSON.parse(value) : value); }
  catch { return undefined; }
}

/** One identity lookup per owner per wait/scan, then only kill(0) polling.
 * Do not retain this cache across acquisitions: a new owner requires fresh proof. */
export function historyOwnerLiveness(): (pid: number, incarnation?: HistoryProcessIncarnation) => Promise<boolean> {
  const owners = new Map<string, Promise<HistoryProcessIncarnation | undefined>>();
  return async (pid, incarnation) => {
    if (!isProcessAlive(pid)) return false;
    if (incarnation === undefined) return true;
    const key = JSON.stringify([pid, incarnation.bootSessionId, incarnation.processStartId]);
    let lookup = owners.get(key);
    if (!lookup) {
      lookup = pid === process.pid ? currentHistoryProcessIncarnation() : readHistoryProcessIncarnation(pid).catch(() => undefined);
      owners.set(key, lookup);
    }
    const actual = await lookup;
    return isProcessAlive(pid) && (actual === undefined || (actual.schema === incarnation.schema && actual.bootSessionId === incarnation.bootSessionId && actual.processStartId === incarnation.processStartId));
  };
}

/** Only ESRCH proves absence; inconclusive probes must retain ownership. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}
