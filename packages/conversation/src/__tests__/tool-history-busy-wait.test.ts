import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  isToolHistorySqliteBusy,
  runWithinToolHistoryBusyDeadline,
  TOOL_HISTORY_BUSY_RETRY_DELAYS_MS,
  type ToolHistoryBusyWaitClock,
} from "../tool-history-busy-wait.js";

function busyError(): Error {
  return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
}

/** Fake clock whose sleeps overrun the requested duration like coalesced timers. */
function stretchedClock(stretchFactor: number): ToolHistoryBusyWaitClock & { sleeps: number[]; time: number } {
  const clock = {
    time: 0,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: (milliseconds: number) => {
      clock.sleeps.push(milliseconds);
      clock.time += milliseconds * stretchFactor;
    },
  };
  return clock;
}

describe("tool-history wall-clock busy wait", () => {
  it("returns the first successful attempt without sleeping", () => {
    const clock = stretchedClock(1);
    expect(runWithinToolHistoryBusyDeadline(() => "locked-in", 200, clock)).toBe("locked-in");
    expect(clock.sleeps).toEqual([]);
  });

  it("bounds the wait by elapsed time when every sleep overruns tenfold", () => {
    // SQLite's busy timeout would sum the requested sleeps (200 ms) while ten
    // times as much wall time passed. The wall-clock bound gives up after the
    // first busy attempt made at or past the deadline.
    const clock = stretchedClock(10);
    let attempts = 0;
    expect(() => runWithinToolHistoryBusyDeadline(() => {
      attempts += 1;
      throw busyError();
    }, 200, clock)).toThrow("database is locked");
    expect(clock.sleeps).toEqual([1, 2, 5, 10, 15]);
    expect(attempts).toBe(6);
    // One overrun sleep past the deadline, not a tenfold total of 2 s.
    expect(clock.time).toBe(330);
  });

  it("keeps polling on the SQLite schedule and clips the final sleep to the deadline", () => {
    const clock = stretchedClock(1);
    expect(() => runWithinToolHistoryBusyDeadline(() => {
      throw busyError();
    }, 200, clock)).toThrow("database is locked");
    expect(clock.sleeps).toEqual([1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 22]);
    expect(clock.time).toBe(200);
    expect(TOOL_HISTORY_BUSY_RETRY_DELAYS_MS.at(-1)).toBe(100);
  });

  it("succeeds once the competing lock clears before the deadline", () => {
    const clock = stretchedClock(1);
    let attempts = 0;
    expect(runWithinToolHistoryBusyDeadline(() => {
      attempts += 1;
      if (attempts < 4) throw busyError();
      return "committed";
    }, 200, clock)).toBe("committed");
    expect(clock.sleeps).toEqual([1, 2, 5]);
  });

  it("rethrows non-busy failures immediately", () => {
    const clock = stretchedClock(1);
    const failure = Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
    expect(() => runWithinToolHistoryBusyDeadline(() => {
      throw failure;
    }, 200, clock)).toThrow(failure);
    expect(clock.sleeps).toEqual([]);
  });

  it("classifies a real node:sqlite write-lock conflict as busy and waits on the real clock", async () => {
    const base = await mkdtemp(join(tmpdir(), "tool-history-busy-wait-"));
    const path = join(base, "busy.sqlite");
    const holder = new DatabaseSync(path);
    const contender = new DatabaseSync(path);
    try {
      holder.exec("PRAGMA journal_mode=DELETE; CREATE TABLE t(x); BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");
      contender.exec("PRAGMA busy_timeout=0");
      let caught: unknown;
      const started = performance.now();
      try {
        runWithinToolHistoryBusyDeadline(() => contender.exec("BEGIN IMMEDIATE"), 60);
      } catch (error) {
        caught = error;
      }
      const elapsed = performance.now() - started;
      expect(isToolHistorySqliteBusy(caught)).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(60);
      holder.exec("ROLLBACK");
      expect(runWithinToolHistoryBusyDeadline(() => {
        contender.exec("BEGIN IMMEDIATE");
        return "acquired";
      }, 60)).toBe("acquired");
      contender.exec("ROLLBACK");
    } finally {
      holder.close();
      contender.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
