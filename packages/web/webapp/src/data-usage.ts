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
  /** When the session started, for the rate. */
  readonly since: number;
}

let usage: DataUsage = { bytes: 0, since: Date.now() };
const listeners = new Set<() => void>();

const publish = (next: DataUsage): void => {
  usage = next;
  for (const listener of [...listeners]) listener();
};

/** The session total, as one frozen snapshot `useSyncExternalStore` can cache. */
export const dataUsage = (): DataUsage => usage;

/** One count of bytes that actually crossed the link. */
export const recordDataUsage = (bytes: number): void => {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  publish({ ...usage, bytes: usage.bytes + Math.round(bytes) });
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
  recordDataUsage(bytes);
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
  recordDataUsage(Number.isFinite(declared) && declared > 0 ? declared : encodedLength(text));
};

/** Test hook: a fresh session, because the meter is module state by design. */
export const resetDataUsage = (): void => {
  publish({ bytes: 0, since: Date.now() });
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
  if (typeof Observer !== "function") return () => undefined;
  const observer = new Observer((list) => {
    for (const raw of list.getEntries() as readonly TransferEntry[]) {
      if (raw.entryType !== "resource") continue;
      if (raw.name?.includes(STREAM_PATH) === true) continue;
      recordDataUsage(raw.transferSize ?? 0);
    }
  });
  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    // Safari before 16.4 has no `transferSize` and may refuse the type.
    return () => undefined;
  }
  resourceTimingActive = true;
  return () => {
    resourceTimingActive = false;
    observer.disconnect();
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
 * Bytes per minute over the session so far.
 *
 * Zero until the session has run for a minute: a rate extrapolated from the
 * first two seconds of a page load says more about the load than about the link.
 */
export const dataUsageRatePerMinute = (snapshot: DataUsage, now = Date.now()): number => {
  const minutes = (now - snapshot.since) / 60_000;
  return minutes < 1 ? 0 : Math.round(snapshot.bytes / minutes);
};
