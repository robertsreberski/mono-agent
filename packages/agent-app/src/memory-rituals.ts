/**
 * In-app memory ritual scheduler for the `bujo` tier.
 *
 * Schedules `store.reflect()` and `store.migrate()` on their configured cron
 * cadences (defaults: `0 3 * * *` / `0 4 1 * *`). Uses a hand-rolled minimal
 * cron next-run calculator (5-field `m h dom mon dow`); avoids adding
 * `cron-parser` as a direct dep of this package.
 *
 * Design guarantees:
 * - Only schedules for `store.tier() === "bujo"` (needs the LLM tier).
 * - Rituals default-enabled; set `enabled: false` to opt out.
 * - Skip-overlap: never starts a run while the previous is in flight.
 * - Never-throws: errors are caught and logged via `logger.warn`; the
 *   scheduler reschedules after every run (success or failure).
 * - Injectable `now` / `setTimer` / `clearTimer` for deterministic testing.
 */

const DEFAULT_REFLECTION_CRON = "0 3 * * *";
const DEFAULT_MIGRATION_CRON = "0 4 1 * *";

export interface MemoryRitualSchedule {
  readonly enabled?: boolean;
  readonly cron?: string;
}

export interface StartMemoryRitualsInput {
  readonly store: {
    tier(): string;
    reflect(): Promise<unknown>;
    migrate(): Promise<unknown>;
  };
  /** From config.memory.reflection */
  readonly reflection?: MemoryRitualSchedule;
  /** From config.memory.migration */
  readonly migration?: MemoryRitualSchedule;
  readonly logger?: {
    info(m: string): void;
    warn(m: string): void;
  };
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Injectable timer factory for tests.
   * Defaults to a `setTimeout` wrapper returning the timeout handle.
   */
  readonly setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
  /** Injectable timer canceller. Defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void;
}

export interface RunningRituals {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startMemoryRituals(input: StartMemoryRitualsInput): RunningRituals {
  const { store, logger } = input;

  // Only schedule for the bujo tier.
  if (store.tier() !== "bujo") {
    return noopRituals();
  }

  const now = input.now ?? (() => new Date());
  const setTimer = input.setTimer ?? defaultSetTimer;
  const clearTimer = input.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const handles: Array<{ unref?: () => void } | undefined> = [];
  let stopped = false;

  function scheduleRitual(
    name: string,
    cronExpr: string,
    run: () => Promise<unknown>,
  ): void {
    let inFlight = false;
    let currentHandle: { unref?: () => void } | undefined;

    function schedule(): void {
      if (stopped) {
        return;
      }
      const current = now();
      let delayMs: number;
      try {
        delayMs = nextCronDelayMs(cronExpr, current);
      } catch (err) {
        logger?.warn(
          `Memory ritual "${name}" has an invalid cron expression "${cronExpr}": ${err instanceof Error ? err.message : String(err)}. Ritual disabled.`,
        );
        return;
      }

      const handle = setTimer(() => {
        // Remove from tracked handles (it has fired)
        const idx = handles.indexOf(handle);
        if (idx !== -1) {
          handles.splice(idx, 1);
        }
        currentHandle = undefined;

        if (stopped) {
          return;
        }

        if (inFlight) {
          // Skip: the previous run is still in flight. Do NOT reschedule here — the in-flight run's
          // .finally schedules the next tick, keeping exactly one pending timer per ritual (no double-schedule).
          logger?.warn(`Memory ritual "${name}" skipped — previous run is still in flight.`);
          return;
        }

        inFlight = true;
        run()
          .catch((err: unknown) => {
            logger?.warn(
              `Memory ritual "${name}" failed: ${err instanceof Error ? err.message : String(err)}.`,
            );
          })
          .finally(() => {
            inFlight = false;
            schedule();
          });
      }, delayMs);

      handle.unref?.();
      currentHandle = handle;
      handles.push(handle);
    }

    schedule();
    void currentHandle; // suppress unused-variable lint; reference is in handles
  }

  // Schedule reflection ritual
  if (input.reflection?.enabled !== false) {
    const cronExpr = input.reflection?.cron ?? DEFAULT_REFLECTION_CRON;
    scheduleRitual("reflect", cronExpr, () => store.reflect());
  }

  // Schedule migration ritual
  if (input.migration?.enabled !== false) {
    const cronExpr = input.migration?.cron ?? DEFAULT_MIGRATION_CRON;
    scheduleRitual("migrate", cronExpr, () => store.migrate());
  }

  return {
    stop() {
      stopped = true;
      for (const h of handles.splice(0)) {
        if (h !== undefined) {
          clearTimer(h);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron next-run calculator
// ---------------------------------------------------------------------------
//
// Supports `m h dom mon dow` where each field is:
//   *              matches every value
//   <number>       exact match
//   */n            step (e.g. */5 = every 5)
//   a-b            range
//   a,b,c          list
//   a-b/n          range with step
//
// Sufficient for the two defaults + most simple expressions.
// Time complexity: O(minutes-until-next-run), bounded by 366*24*60 ≈ 530k.
// ---------------------------------------------------------------------------

function nextCronDelayMs(expression: string, from: Date): number {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error(`Expected 5 fields; got ${fields.length}`);
  }
  const [mField, hField, domField, monField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Search forward minute by minute for up to ~2 years
  // Start from the NEXT minute after `from` (cron fires at the start of the minute)
  const candidate = new Date(from.getTime());
  // Advance to the next whole minute
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const MAX_ITERATIONS = 365 * 24 * 60 * 2; // 2 years in minutes
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const min = candidate.getUTCMinutes();
    const hour = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1; // 1-12
    const dow = candidate.getUTCDay(); // 0 (Sun) – 6 (Sat)

    if (
      matchField(mField, min, 0, 59) &&
      matchField(hField, hour, 0, 23) &&
      matchField(monField, mon, 1, 12) &&
      matchDayField(domField, dowField, dom, dow)
    ) {
      return candidate.getTime() - from.getTime();
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(`No match found in 2 years for cron expression "${expression}"`);
}

/**
 * Standard cron DOM/DOW logic:
 * - If BOTH dom and dow are restricted (not `*`), either matching satisfies.
 * - If only one is restricted, only that one must match.
 * - If both are `*`, always matches.
 */
function matchDayField(domField: string, dowField: string, dom: number, dow: number): boolean {
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";

  if (domRestricted && dowRestricted) {
    return matchField(domField, dom, 1, 31) || matchField(dowField, dow, 0, 6);
  }
  if (domRestricted) {
    return matchField(domField, dom, 1, 31);
  }
  if (dowRestricted) {
    return matchField(dowField, dow, 0, 6);
  }
  return true;
}

function matchField(field: string, value: number, _min: number, _max: number): boolean {
  // Comma-separated list
  const parts = field.split(",");
  return parts.some((part) => matchPart(part.trim(), value, _min, _max));
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  // Wildcard
  if (part === "*") {
    return true;
  }

  // Step: */n or a-b/n
  const slashIdx = part.indexOf("/");
  if (slashIdx !== -1) {
    const stepStr = part.slice(slashIdx + 1);
    const step = parseInt(stepStr, 10);
    if (Number.isNaN(step) || step <= 0) {
      throw new Error(`Invalid step in cron field part "${part}"`);
    }
    const rangePart = part.slice(0, slashIdx);
    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart !== "*") {
      const dashIdx = rangePart.indexOf("-");
      if (dashIdx !== -1) {
        rangeStart = parseInt(rangePart.slice(0, dashIdx), 10);
        rangeEnd = parseInt(rangePart.slice(dashIdx + 1), 10);
      } else {
        rangeStart = parseInt(rangePart, 10);
        rangeEnd = max;
      }
    }
    if (value < rangeStart || value > rangeEnd) {
      return false;
    }
    return (value - rangeStart) % step === 0;
  }

  // Range: a-b
  const dashIdx = part.indexOf("-");
  if (dashIdx !== -1) {
    const rangeStart = parseInt(part.slice(0, dashIdx), 10);
    const rangeEnd = parseInt(part.slice(dashIdx + 1), 10);
    return value >= rangeStart && value <= rangeEnd;
  }

  // Exact number
  const num = parseInt(part, 10);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid cron field part "${part}"`);
  }
  return value === num;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopRituals(): RunningRituals {
  return { stop() { /* no-op */ } };
}

function defaultSetTimer(cb: () => void, ms: number): { unref?: () => void } {
  const handle = setTimeout(cb, ms);
  return { unref: () => handle.unref() };
}
