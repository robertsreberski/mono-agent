import { useSyncExternalStore } from "react";

/**
 * What this console has spent, so the operator can see it.
 *
 * A data diet nobody can measure is a claim, not a feature. This is the meter:
 * every byte the console asks the network for is counted once, at the place that
 * knows how many there were, and the total is on screen next to the mode that
 * governs it.
 *
 * The browser's own measurement is the authority. `PerformanceObserver` reports
 * a `transferSize` per resource — compressed body plus headers, and zero for
 * anything served out of the HTTP cache — for every request the page makes,
 * `fetch` and XHR included. That is what this counts.
 *
 * It has to be, because the alternative lies. The service answers
 * brotli-encoded and chunked, so a JSON response carries no `content-length`
 * and the only length a page can read for itself is the DECODED one: measured
 * that way, a live console reported roughly four times what it had actually
 * spent. A meter that overstates by four is worse than no meter, because the
 * decision it exists to inform — is Lean worth it here — is a comparison.
 *
 * Two things resource timing cannot see, and only these two are counted
 * directly:
 *
 * - The delta stream. An `EventSource` produces one entry for its connection
 *   whose body size never grows, so its frames are counted where they land
 *   (`console-store.tsx`) and that entry is skipped here.
 * - A request BODY: an upload is bytes leaving the device, and `transferSize`
 *   describes only the response.
 *
 * Where there is no resource timing at all (older Safari), the body-length
 * estimate stands in — see {@link recordTransferredBody}. A reload resets the
 * meter: this is a session meter, not an accounting ledger, and nothing about it
 * is persisted or sent anywhere.
 */
export interface DataUsage {
  /** Bytes this session, as far as this console can see them. */
  readonly bytes: number;
  /** When the session started. */
  readonly since: number;
  /**
   * Whether EVERY component of this total is a browser measurement.
   *
   * False while there is no resource observer, and false once anything the
   * console counted for itself -- a body length, an upload's own size -- has
   * been added to it, because a total that mixes the two is not a reading.
   * Shown as a tilde, and said in words in the accessible name.
   */
  readonly measured: boolean;
}

/**
 * How long records are collected before subscribers are told again.
 *
 * A streaming turn records several times a second, and every notification
 * rebuilds the command palette's action list and re-renders the indicator. The
 * FIRST record of a burst still publishes immediately -- the meter must react
 * when something happens -- and the rest ride the trailing edge.
 */
export const METER_PUBLISH_MS = 500;

/** The window the displayed rate describes. */
export const RATE_WINDOW_MS = 60_000;

/**
 * How often an idle console re-reads its own rate.
 *
 * The rate is a trailing sixty-second window, and nothing recomputes it between
 * records -- so a console that stopped spending anything went on displaying the
 * last minute it had for the rest of the session. This is not an accounting
 * tick: it notifies subscribers only while there is something in the window
 * left to age out, and stops on its own once there is not.
 */
export const RATE_REFRESH_MS = 30_000;

let usage: DataUsage = { bytes: 0, since: Date.now(), measured: false };
const listeners = new Set<() => void>();
let throttleTimer: number | null = null;
let notifyPending = false;
let rateTimer: number | null = null;
/**
 * Whether anything in the session total was ESTIMATED rather than measured.
 *
 * `measured` used to describe only whether a resource observer was installed,
 * which said nothing about the components resource timing cannot see. Once a
 * body length or an upload's own size has been added, the total is a mixture
 * and the console says so with a tilde rather than presenting it as a reading.
 */
let estimated = false;

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/**
 * Snapshot first, notification maybe.
 *
 * `usage` is replaced synchronously, so `dataUsage()` is never behind and
 * `useSyncExternalStore` cannot tear -- what is throttled is only how often
 * React is told to look.
 */
const publish = (next: DataUsage): void => {
  usage = next;
  if (throttleTimer !== null) {
    notifyPending = true;
    return;
  }
  notify();
  throttleTimer = window.setTimeout(function settle() {
    throttleTimer = null;
    if (!notifyPending) return;
    notifyPending = false;
    notify();
    throttleTimer = window.setTimeout(settle, METER_PUBLISH_MS);
  }, METER_PUBLISH_MS);
};

/** What each of the last {@link RATE_WINDOW_MS} carried, for the rate. */
const recent: { at: number; bytes: number }[] = [];

/**
 * Only ever called from a WRITE. `dataUsageRatePerMinute` is read during render
 * and filters instead: a reader that spliced module state made rendering a
 * mutation, which React is entitled to run twice.
 */
const pruneRecent = (now: number): void => {
  while (recent.length > 0 && now - recent[0]!.at >= RATE_WINDOW_MS) recent.shift();
};

/**
 * Wakes subscribers while the window still has something to lose.
 *
 * Armed by a record and disarmed by the first tick with nothing left, so an
 * idle console decays to `0 B/min` and then costs nothing at all -- rather than
 * either freezing on its last minute or running a timer for the session.
 */
const armRateRefresh = (): void => {
  if (rateTimer !== null || typeof window === "undefined") return;
  rateTimer = window.setTimeout(function tick() {
    rateTimer = null;
    pruneRecent(Date.now());
    // A NEW snapshot object with the same totals in it. `useSyncExternalStore`
    // compares snapshots by identity, so telling it to look again at the object
    // it already has is telling it nothing -- and what has moved here is not the
    // total but the minute the indicator draws beside it.
    publish({ ...usage });
    if (recent.length > 0) armRateRefresh();
  }, RATE_REFRESH_MS);
};

/** The session total, as one frozen snapshot `useSyncExternalStore` can cache. */
export const dataUsage = (): DataUsage => usage;

/** One count of bytes the browser itself measured crossing the link. */
export const recordDataUsage = (bytes: number): void => {
  record(bytes, false);
};

/**
 * Bytes the console counted for itself -- a body length, a request body, a
 * declared size -- which are floors, not readings. Recorded the same way and
 * marked, so the total stops claiming to be a measurement.
 */
export const recordEstimatedUsage = (bytes: number): void => {
  record(bytes, true);
};

const record = (bytes: number, isEstimate: boolean): void => {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const counted = Math.round(bytes);
  const now = Date.now();
  pruneRecent(now);
  recent.push({ at: now, bytes: counted });
  if (isEstimate) estimated = true;
  armRateRefresh();
  publish({ ...usage, bytes: usage.bytes + counted, measured: resourceTimingActive && !estimated });
};

const encodedLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Whether the browser is measuring transfers for us. */
let resourceTimingActive = false;

/**
 * Bytes of a body the resource observer will report itself, if it is running.
 *
 * An estimate, and only ever a stand-in: it is silent while resource timing is
 * installed, so nothing is ever counted twice, and it is what a browser without
 * resource timing falls back to.
 */
export const recordTransferredBody = (bytes: number): void => {
  if (resourceTimingActive) return;
  recordEstimatedUsage(bytes);
};

/**
 * One response body, estimated from what the page can read of it.
 *
 * `content-length` when the server declared one; otherwise the decoded text,
 * which OVERSTATES a compressed response — hence the guard above.
 */
export const recordResponsePayload = (response: Response, text: string): void => {
  if (resourceTimingActive) return;
  const declared = Number(response.headers.get("content-length"));
  recordEstimatedUsage(Number.isFinite(declared) && declared > 0 ? declared : encodedLength(text));
};

/** Test hook: a fresh session, because the meter is module state by design. */
export const resetDataUsage = (): void => {
  if (throttleTimer !== null) window.clearTimeout(throttleTimer);
  if (rateTimer !== null) window.clearTimeout(rateTimer);
  throttleTimer = null;
  rateTimer = null;
  notifyPending = false;
  estimated = false;
  recent.length = 0;
  usage = { bytes: 0, since: Date.now(), measured: resourceTimingActive };
  notify();
};

interface TransferEntry {
  readonly entryType?: string;
  readonly initiatorType?: string;
  readonly transferSize?: number;
  readonly name?: string;
}

/** The delta stream, whose frames are counted where they arrive instead. */
const STREAM_PATH = "/api/v1/events";

/**
 * Whether this browser's resource entries carry a transfer size at all.
 *
 * The FIELD, not the entry type. `observe({ type: "resource" })` throwing
 * detects an unsupported type, and the browser this guard exists for -- Safari
 * before 16.4 -- accepts the type and reports no `transferSize`. Gating on the
 * type alone silenced the body-length estimate and counted zeroes in its place,
 * so the meter would have read a confident, permanent "0 B" on exactly the
 * device the whole feature is for.
 */
const resourceTransferSizeReported = (): boolean => {
  const timing = (globalThis as { PerformanceResourceTiming?: { readonly prototype?: object } })
    .PerformanceResourceTiming;
  const prototype = timing?.prototype;
  return prototype !== undefined && "transferSize" in prototype;
};

/**
 * Counts what the browser says each request actually moved.
 *
 * `transferSize` is 0 for a response served out of the HTTP cache, which is
 * exactly right — PR 1's immutable upload headers mean a re-shown image costs
 * nothing, and the meter should show that it cost nothing.
 *
 * Installed by the app entry point rather than on import, so a test that never
 * asks for it never gets an observer — and the body-length estimate stays live
 * for everything that runs without one.
 */
export const observeTransferredResources = (): (() => void) => {
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof Observer !== "function" || !resourceTransferSizeReported()) return () => undefined;
  // Construction inside the guard as well as the call: this runs at module scope
  // before `createRoot`, so a `PerformanceObserver` that throws on construction
  // would white-screen the console rather than cost it a meter.
  let observer: PerformanceObserver;
  try {
    observer = new Observer((list) => {
      for (const raw of list.getEntries() as readonly TransferEntry[]) {
        if (raw.entryType !== "resource") continue;
        if (raw.name?.includes(STREAM_PATH) === true) continue;
        recordDataUsage(raw.transferSize ?? 0);
      }
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {
    // A browser that reports the field but refuses the type. The estimate stays.
    return () => undefined;
  }
  resourceTimingActive = true;
  publish({ ...usage, measured: !estimated });
  return () => {
    resourceTimingActive = false;
    observer.disconnect();
    publish({ ...usage, measured: false });
  };
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useDataUsage = (): DataUsage => useSyncExternalStore(subscribe, dataUsage, dataUsage);

/** Same units the file cards use, so two numbers on one screen agree. */
export const formatDataBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

/**
 * What the last minute cost, not what the session averaged.
 *
 * A session average is dominated by the page load for the rest of the visit and
 * says nothing about the link the operator is on now. Zero until the session has
 * run for a whole window, because a rate extrapolated from the first seconds of
 * a load describes the load.
 *
 * Read from the module's own ring rather than from a snapshot: a rate is about
 * WHEN bytes arrived, which a running total cannot say. Between records it is as
 * stale as the total is -- a live console records on every stream frame, so in
 * practice it decays continuously.
 */
export const dataUsageRatePerMinute = (now = Date.now()): number => {
  if (now - usage.since < RATE_WINDOW_MS) return 0;
  // FILTERED, never pruned: this runs during render, and a render that splices
  // module state is a render with a side effect -- which React is entitled to
  // run twice. The ring is trimmed by {@link recordDataUsage} and by the
  // refresh tick, both of which are writes.
  return recent.reduce(
    (sum, entry) => (now - entry.at < RATE_WINDOW_MS ? sum + entry.bytes : sum),
    0,
  );
};
