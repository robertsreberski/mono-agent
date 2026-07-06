import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMemoryRituals } from "../memory-rituals.js";
import type { StartMemoryRitualsInput } from "../memory-rituals.js";

interface PendingTimer {
  cb: () => void;
  fireAt: number;
  handle: { unref?: () => void };
  cancelled: boolean;
}

function createFakeTimers() {
  const timers: PendingTimer[] = [];

  const setTimer = (cb: () => void, ms: number): { unref?: () => void } => {
    const handle: { unref?: () => void } = {
      unref: () => {
        /* no-op */
      },
    };
    timers.push({ cb, fireAt: ms, handle, cancelled: false });
    return handle;
  };

  const clearTimer = (h: unknown): void => {
    for (const timer of timers) {
      if (timer.handle === h) {
        timer.cancelled = true;
      }
    }
  };

  const fireAll = (): void => {
    const toFire = timers.filter((timer) => !timer.cancelled).slice();
    for (const timer of toFire) {
      timer.cancelled = true;
      timer.cb();
    }
  };

  const pendingCount = (): number => timers.filter((timer) => !timer.cancelled).length;

  return { setTimer, clearTimer, fireAll, pendingCount, timers };
}

function createFakeStore(tier: string = "bujo") {
  const calls: string[] = [];

  return {
    tier: () => tier,
    consolidate: async () => {
      calls.push("consolidate");
    },
    calls,
  };
}

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

describe("startMemoryRituals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules nothing for a non-bujo store", () => {
    const fakeTimers = createFakeTimers();
    const result = startMemoryRituals({
      store: createFakeStore("journal"),
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(0);
    result.stop();
  });

  it("schedules one consolidation timer for a bujo store with the default cron", () => {
    const fakeTimers = createFakeTimers();
    const result = startMemoryRituals({
      store: createFakeStore("bujo"),
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(1);
    result.stop();
    expect(fakeTimers.pendingCount()).toBe(0);
  });

  it("calls store.consolidate() when the consolidation timer fires", async () => {
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

    expect(store.calls).toEqual(["consolidate"]);
    expect(fakeTimers.pendingCount()).toBe(1);
    result.stop();
  });

  it("skips consolidation when the previous run is still in flight", async () => {
    const fakeTimers = createFakeTimers();
    const warns: string[] = [];
    let resolveConsolidate!: () => void;
    const store = {
      tier: () => "bujo" as const,
      consolidate: async () => {
        store.calls.push("consolidate");
        await new Promise<void>((resolve) => {
          resolveConsolidate = resolve;
        });
      },
      calls: [] as string[],
    };

    const result = startMemoryRituals({
      store,
      logger: { info: () => undefined, warn: (m) => { warns.push(m); } },
      consolidation: { cron: "* * * * *" },
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    fakeTimers.fireAll();
    await Promise.resolve();
    fakeTimers.fireAll();
    await Promise.resolve();

    resolveConsolidate();
    await Promise.resolve();

    expect(store.calls).toEqual(["consolidate"]);
    expect(warns.some((warning) => /skipped/iu.test(warning))).toBe(true);
    result.stop();
  });

  it("does not crash when store.consolidate() throws and keeps the next timer armed", async () => {
    const fakeTimers = createFakeTimers();
    const warns: string[] = [];

    const result = startMemoryRituals({
      store: {
        tier: () => "bujo",
        consolidate: async (): Promise<void> => {
          throw new Error("consolidation exploded");
        },
      },
      logger: { info: () => undefined, warn: (m) => { warns.push(m); } },
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    expect(warns.some((warning) => warning.includes("consolidation exploded"))).toBe(true);
    expect(fakeTimers.pendingCount()).toBeGreaterThan(0);
    result.stop();
  });

  it("stop() clears all pending timers and prevents further scheduling", async () => {
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(1);
    result.stop();
    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    expect(fakeTimers.pendingCount()).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("does not schedule consolidation when consolidation.enabled is false", () => {
    const fakeTimers = createFakeTimers();
    startMemoryRituals({
      ...makeInput({ consolidation: { enabled: false } }),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    }).stop();

    expect(fakeTimers.pendingCount()).toBe(0);
  });

  it("computes a positive delay for the default consolidation cron '0 */2 * * *' from 02:00 UTC", () => {
    const fakeTimers = createFakeTimers();
    startMemoryRituals({
      store: createFakeStore("bujo"),
      now: () => new Date("2026-06-16T02:00:00Z"),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    }).stop();

    const timer = fakeTimers.timers[0];
    expect(timer).toBeDefined();
    expect(timer!.fireAt).toBeGreaterThan(7_100_000);
    expect(timer!.fireAt).toBeLessThan(7_300_000);
  });

  it("respects a custom consolidation cron expression", () => {
    const fakeTimers = createFakeTimers();
    const result = startMemoryRituals({
      store: createFakeStore("bujo"),
      consolidation: { cron: "5 3 * * *" },
      now: () => new Date("2026-06-16T02:00:00Z"),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.timers[0]?.fireAt).toBeGreaterThan(3_800_000);
    expect(fakeTimers.timers[0]?.fireAt).toBeLessThan(4_000_000);
    result.stop();
  });

  it("warns and schedules nothing for an invalid consolidation cron", () => {
    const fakeTimers = createFakeTimers();
    const warns: string[] = [];
    const result = startMemoryRituals({
      store: createFakeStore("bujo"),
      consolidation: { cron: "not-a-cron" },
      logger: { info: () => undefined, warn: (m) => { warns.push(m); } },
      now: () => BASE_DATE,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.pendingCount()).toBe(0);
    expect(warns.some((warning) => /invalid cron/iu.test(warning))).toBe(true);
    result.stop();
  });

  it("clamps an over-24.8-day delay and re-arms instead of busy-looping", async () => {
    const maxTimeoutMs = 2_147_483_647;
    const fakeTimers = createFakeTimers();
    const store = createFakeStore("bujo");
    const result = startMemoryRituals({
      store,
      consolidation: { cron: "0 4 1 * *" },
      now: () => new Date("2026-07-01T05:00:00Z"),
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    });

    expect(fakeTimers.timers.find((timer) => !timer.cancelled)?.fireAt).toBe(maxTimeoutMs);

    fakeTimers.fireAll();
    await vi.runAllTimersAsync();

    expect(store.calls).toEqual([]);
    expect(fakeTimers.pendingCount()).toBeGreaterThan(0);
    result.stop();
  });
});
