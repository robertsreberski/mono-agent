import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMemoryRituals } from "../memory-rituals.js";
import type { StartMemoryRitualsInput } from "../memory-rituals.js";

// ---------------------------------------------------------------------------
// Fake timer infrastructure
// ---------------------------------------------------------------------------

interface PendingTimer {
  cb: () => void;
  fireAt: number;
  id: number;
  handle: { unref?: () => void };
  cancelled: boolean;
}

function createFakeTimers() {
  let idCounter = 0;
  const timers: PendingTimer[] = [];

  const setTimer = (cb: () => void, ms: number): { unref?: () => void } => {
    const id = ++idCounter;
    const fireAt = ms; // relative ms from "now"; the test advances clock manually
    const handle: { unref?: () => void } = {
      unref: () => {
        /* no-op */
      },
    };
    timers.push({ cb, fireAt, id, handle, cancelled: false });
    return handle;
  };

  const clearTimer = (h: unknown): void => {
    for (const t of timers) {
      if (t.handle === h) {
        t.cancelled = true;
      }
    }
  };

  /** Fire ALL pending, non-cancelled timers (simulates advancing clock). */
  const fireAll = (): void => {
    // snapshot to avoid infinite loops if a fired cb re-registers
    const toFire = timers.filter((t) => !t.cancelled).slice();
    for (const t of toFire) {
      t.cancelled = true; // mark consumed
      t.cb();
    }
  };

  /** Fire only timers with delay <= ms from registration */
  const fireShorterThan = (maxMs: number): void => {
    const toFire = timers.filter((t) => !t.cancelled && t.fireAt <= maxMs).slice();
    for (const t of toFire) {
      t.cancelled = true;
      t.cb();
    }
  };

  const pendingCount = (): number => timers.filter((t) => !t.cancelled).length;

  return { setTimer, clearTimer, fireAll, fireShorterThan, pendingCount, timers };
}

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

function createFakeStore(tier: string = "bujo") {
  const calls: string[] = [];
  let reflectDelay = 0; // simulate slow reflect (for overlap test)

  return {
    tier: () => tier,
    reflect: async () => {
      calls.push("reflect");
      if (reflectDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, reflectDelay));
      }
    },
    migrate: async () => {
      calls.push("migrate");
    },
    calls,
    setReflectDelay: (ms: number) => {
      reflectDelay = ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `now` fixture returning 2026-06-16 02:00:00 UTC */
const BASE_DATE = new Date("2026-06-16T02:00:00Z");

function makeInput(overrides: Partial<StartMemoryRitualsInput> = {}): StartMemoryRitualsInput {
  const fakeTimers = createFakeTimers();
  const store = createFakeStore();
  return {
    store,
    now: () => BASE_DATE,
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startMemoryRituals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Non-bujo tier schedules nothing
  // -------------------------------------------------------------------------

  it("schedules nothing for a non-bujo store", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("journal");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(0);
    result.stop();
  });

  it("schedules nothing for a lite store", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("lite");
    startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    }).stop();

    expect(fakeTimers.pendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Schedules both rituals for a bujo store (defaults)
  // -------------------------------------------------------------------------

  it("schedules two timers for a bujo store with default crons", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    // One timer for reflection, one for migration
    expect(fakeTimers.pendingCount()).toBe(2);
    result.stop();
    expect(fakeTimers.pendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Reflect fires at next cron tick
  // -------------------------------------------------------------------------

  it("calls store.reflect() when the reflection timer fires", async () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    // Fire ALL pending timers
    fakeTimers.fireAll();

    // reflect and migrate are async — wait a tick
    await vi.runAllTimersAsync();

    expect(store.calls).toContain("reflect");
    result.stop();
  });

  it("calls store.migrate() when the migration timer fires", async () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    expect(store.calls).toContain("migrate");
    result.stop();
  });

  // -------------------------------------------------------------------------
  // 4. Skip-overlap: a slow reflect running when the next tick fires doesn't double-run
  // -------------------------------------------------------------------------

  it("skips a reflect that fires while the previous run is still in flight", async () => {
    // We control inFlight by: fire the timer, then fire the RESCHEDULED timer
    // before the first reflect resolves.
    const fakeTimers = createFakeTimers();

    let resolveReflect!: () => void;
    const store = {
      tier: () => "bujo" as const,
      reflect: async () => {
        store.calls.push("reflect");
        await new Promise<void>((resolve) => {
          resolveReflect = resolve;
        });
      },
      migrate: async () => {
        store.calls.push("migrate");
      },
      calls: [] as string[],
    };

    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      // Only schedule reflection; disable migration to isolate
      migration: { enabled: false },
    });

    // Fire the initial reflection timer → reflect starts (in flight)
    fakeTimers.fireAll();
    // A micro-tick so the async reflect body starts executing
    await Promise.resolve();

    // Now reflect is in flight. Fire ALL remaining timers
    // (the rescheduled reflection timer) → should be skipped due to inFlight
    fakeTimers.fireAll();
    await Promise.resolve();

    // Resolve the in-flight reflect
    resolveReflect();
    await Promise.resolve();

    // Only one reflect call, not two
    expect(store.calls.filter((c) => c === "reflect")).toHaveLength(1);
    result.stop();
  });

  // -------------------------------------------------------------------------
  // 5. Never-throws: a throwing reflect logs a warning but doesn't crash the scheduler
  // -------------------------------------------------------------------------

  it("does not crash when store.reflect() throws and still reschedules", async () => {
    const fakeTimers = createFakeTimers();
    const warns: string[] = [];
    const logger = {
      info: (_m: string) => undefined,
      warn: (m: string) => { warns.push(m); },
    };

    const store = {
      tier: () => "bujo" as const,
      reflect: async (): Promise<void> => {
        throw new Error("reflect exploded");
      },
      migrate: async () => { /* no-op */ },
      calls: [] as string[],
    };

    const result = startMemoryRituals({
      store,
      logger,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      migration: { enabled: false },
    });

    // Fire the reflection timer
    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    // Should have logged a warning
    expect(warns.some((w) => w.includes("reflect"))).toBe(true);

    // Scheduler should still have rescheduled (new pending timer)
    expect(fakeTimers.pendingCount()).toBeGreaterThan(0);

    result.stop();
  });

  // -------------------------------------------------------------------------
  // 6. stop() prevents further scheduling
  // -------------------------------------------------------------------------

  it("stop() clears all pending timers", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(2);
    result.stop();
    expect(fakeTimers.pendingCount()).toBe(0);
  });

  it("stop() prevents re-scheduling after a timer fires", async () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      migration: { enabled: false },
    });

    result.stop();
    // Fire after stop — should not re-schedule
    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    // No timers remain (stop() cancelled them before they fired, or they were no-ops)
    expect(fakeTimers.pendingCount()).toBe(0);
    // No reflect call
    expect(store.calls.filter((c) => c === "reflect")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Explicit enabled: false disables a ritual
  // -------------------------------------------------------------------------

  it("does not schedule reflection when reflection.enabled is false", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    startMemoryRituals({
      store,
      reflection: { enabled: false },
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    }).stop();

    // Only migration timer should be pending (before stop)
    // After stop, 0. But before stop: if reflection disabled, only 1 timer (migration)
    // Let's check with a fresh run without stop:
    const fakeTimers2 = createFakeTimers();
    const store2 = createFakeStore("bujo");
    const result2 = startMemoryRituals({
      store: store2,
      reflection: { enabled: false },
      now: () => BASE_DATE,
      setTimer: fakeTimers2.setTimer,
      clearTimer: fakeTimers2.clearTimer,
    });
    expect(fakeTimers2.pendingCount()).toBe(1); // only migration
    result2.stop();
  });

  it("does not schedule migration when migration.enabled is false", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      migration: { enabled: false },
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });
    expect(fakeTimers.pendingCount()).toBe(1); // only reflection
    result.stop();
  });

  // -------------------------------------------------------------------------
  // 8. Cron next-run: default expressions fire at the right delay
  // -------------------------------------------------------------------------

  it("computes a positive delay for the default reflection cron '0 3 * * *' from 02:00 UTC", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    startMemoryRituals({
      store,
      now: () => new Date("2026-06-16T02:00:00Z"), // 02:00 — next 03:00 is in 1h
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      migration: { enabled: false },
    }).stop();

    // The one timer should have been registered with delay ~3600000ms (1 hour)
    const reflectionTimer = fakeTimers.timers.find((t) => !t.cancelled || t.fireAt > 0);
    expect(reflectionTimer).toBeDefined();
    // 1 hour = 3600000ms; allow small rounding
    expect(reflectionTimer!.fireAt).toBeGreaterThan(3_500_000);
    expect(reflectionTimer!.fireAt).toBeLessThan(3_700_000);
  });

  it("computes a positive delay for the default migration cron '0 4 1 * *' from 02:00 UTC on June 16", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    startMemoryRituals({
      store,
      now: () => new Date("2026-06-16T02:00:00Z"), // next 1st is July 1st 04:00 UTC
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      reflection: { enabled: false },
    }).stop();

    // July 1 04:00 UTC - June 16 02:00 UTC = 15 days + 2 hours = 15*86400 + 7200 seconds
    const expectedMs = (15 * 24 * 3600 + 2 * 3600) * 1000;
    const migrationTimer = fakeTimers.timers.find((t) => !t.cancelled || t.fireAt > 0);
    expect(migrationTimer).toBeDefined();
    expect(migrationTimer!.fireAt).toBeGreaterThan(expectedMs - 5000);
    expect(migrationTimer!.fireAt).toBeLessThan(expectedMs + 5000);
  });

  it("clamps an over-24.8-day migration delay and re-arms instead of busy-looping", async () => {
    const MAX_TIMEOUT_MS = 2_147_483_647; // Node's setTimeout ceiling
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      // Just after 04:00 on the 1st → next '0 4 1 * *' is ~31 days out (Aug 1),
      // past Node's 24.8-day setTimeout cap. Unclamped, Node fires it at 1ms and
      // the ritual busy-loops.
      now: () => new Date("2026-07-01T05:00:00Z"),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      reflection: { enabled: false },
    });

    // The delay handed to setTimeout must be capped, never the raw ~31 days.
    const armed = fakeTimers.timers.find((t) => !t.cancelled);
    expect(armed).toBeDefined();
    expect(armed!.fireAt).toBe(MAX_TIMEOUT_MS);

    // Firing the capped timer must re-arm, not run the ritual (target not reached).
    fakeTimers.fireAll();
    await vi.runAllTimersAsync();
    expect(store.calls).not.toContain("migrate");
    expect(fakeTimers.pendingCount()).toBeGreaterThan(0);

    result.stop();
  });

  // -------------------------------------------------------------------------
  // 9. Custom cron expressions
  // -------------------------------------------------------------------------

  it("respects a custom cron expression", () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    // Every minute: 0 minutes = "* * * * *" (but that would be more complex)
    // Use a simple: "5 3 * * *" (03:05 UTC), from 02:00 => ~65 minutes away
    const result = startMemoryRituals({
      store,
      reflection: { cron: "5 3 * * *" },
      migration: { enabled: false },
      now: () => new Date("2026-06-16T02:00:00Z"),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    const timer = fakeTimers.timers[0];
    expect(timer).toBeDefined();
    // 03:05 - 02:00 = 65 minutes = 3900000ms
    expect(timer!.fireAt).toBeGreaterThan(3_800_000);
    expect(timer!.fireAt).toBeLessThan(4_000_000);
    result.stop();
  });
});
