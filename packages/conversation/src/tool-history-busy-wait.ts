import { performance } from "node:perf_hooks";

/**
 * Poll schedule for a contended SQLite lock. It mirrors SQLite's own default
 * busy handler so a lock released early is still noticed within milliseconds.
 */
export const TOOL_HISTORY_BUSY_RETRY_DELAYS_MS: readonly number[] = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];

/** Clock seam for the synchronous wall-clock busy wait. */
export interface ToolHistoryBusyWaitClock {
  now(): number;
  sleep(milliseconds: number): void;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const systemClock: ToolHistoryBusyWaitClock = {
  now: () => performance.now(),
  sleep: (milliseconds) => {
    Atomics.wait(sleepCell, 0, 0, milliseconds);
  },
};

/**
 * Retries a synchronous SQLite lock acquisition until it succeeds, fails with a
 * non-busy error, or `timeoutMs` of wall-clock time has elapsed.
 *
 * SQLite's built-in `busy_timeout` stops after the sum of the sleeps it
 * requested, not after elapsed time. On darwin, background and utility QoS let
 * the kernel coalesce each short sleep by tens of milliseconds, so a 200 ms
 * SQLite timeout was measured at 1-2 s of wall time. Run the statement with
 * SQLite's timeout disabled and check a real clock between attempts instead:
 * timer slack can delay at most the final attempt by one sleep, never multiply
 * the whole wait.
 */
export function runWithinToolHistoryBusyDeadline<T>(
  operation: () => T,
  timeoutMs: number,
  clock: ToolHistoryBusyWaitClock = systemClock,
): T {
  const deadline = clock.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isToolHistorySqliteBusy(error)) throw error;
      const remainingMs = deadline - clock.now();
      if (remainingMs <= 0) throw error;
      const delay = TOOL_HISTORY_BUSY_RETRY_DELAYS_MS[
        Math.min(attempt, TOOL_HISTORY_BUSY_RETRY_DELAYS_MS.length - 1)
      ] ?? 100;
      clock.sleep(Math.min(delay, remainingMs));
    }
  }
}

/** True for node:sqlite `SQLITE_BUSY`/`SQLITE_LOCKED` failures. */
export function isToolHistorySqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const reason = error instanceof Error ? error.message : String(error);
  return code === "ERR_SQLITE_ERROR" && /busy|locked/u.test(reason.toLocaleLowerCase());
}
