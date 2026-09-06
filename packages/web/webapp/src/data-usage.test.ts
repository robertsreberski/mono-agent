import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METER_PUBLISH_MS,
  dataUsage,
  dataUsageRatePerMinute,
  formatDataBytes,
  observeTransferredResources,
  recordDataUsage,
  recordResponsePayload,
  recordTransferredBody,
  resetDataUsage,
  useDataUsage,
} from "./data-usage";

beforeEach(() => {
  resetDataUsage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetDataUsage();
});

describe("recording what the network moved", () => {
  it("adds up what it is given and ignores what is not a count of bytes", () => {
    recordDataUsage(100);
    recordDataUsage(2_048);
    recordDataUsage(-5);
    recordDataUsage(Number.NaN);

    expect(dataUsage().bytes).toBe(2_148);
  });

  it("falls back to a body's own length where nothing better is available", () => {
    // Only when resource timing is not installed: see the resource-entry cases,
    // where the browser's own measurement takes over from this estimate.
    const compressed = new Response("x".repeat(4_000), {
      headers: { "content-length": "512" },
    });
    recordResponsePayload(compressed, "x".repeat(4_000));
    expect(dataUsage().bytes).toBe(512);

    // A chunked response declares nothing, so the decoded size is all there is.
    resetDataUsage();
    recordResponsePayload(new Response("héllo"), "héllo");
    expect(dataUsage().bytes).toBe(6);
  });
});

describe("resource entries", () => {
  class FakePerformanceObserver {
    static latest: FakePerformanceObserver | undefined;
    static supportedEntryTypes = ["resource"];
    disconnected = false;
    observed: unknown;
    readonly callback: (list: { getEntries: () => unknown[] }) => void;
    constructor(callback: (list: { getEntries: () => unknown[] }) => void) {
      this.callback = callback;
      FakePerformanceObserver.latest = this;
    }
    observe(options: unknown): void { this.observed = options; }
    disconnect(): void { this.disconnected = true; }
    deliver(entries: unknown[]): void {
      this.callback({ getEntries: () => entries });
    }
  }

  const entry = (initiatorType: string, transferSize: number, name = "/asset") =>
    ({ entryType: "resource", initiatorType, transferSize, name });

  it("counts what the browser says crossed the link, for every kind of request", () => {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const stop = observeTransferredResources();
    const observer = FakePerformanceObserver.latest!;

    observer.deliver([
      entry("img", 4_096, "/api/v1/uploads/one/content"),
      entry("script", 1_000),
      // The console's own reads and writes. `transferSize` is the COMPRESSED
      // size plus headers, which a decoded body length cannot see: the service
      // answers brotli-encoded and chunked, so counting the JSON would report
      // several times what was actually sent.
      entry("fetch", 2_500, "/api/v1/bootstrap"),
      entry("xmlhttprequest", 700, "/api/v1/uploads/one/content"),
      // The delta stream is counted frame by frame where the frames land: this
      // entry describes only the connection, and never grows with the stream.
      entry("other", 300, "/api/v1/events?thread=one"),
      // Served from the browser cache: nothing crossed the link.
      entry("img", 0, "/api/v1/uploads/two/content"),
    ]);

    expect(dataUsage().bytes).toBe(8_296);
    stop();
    expect(observer.disconnected).toBe(true);
  });

  it("stops estimating from bodies once the browser is measuring for it", () => {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const stop = observeTransferredResources();

    // Both of these describe a transfer the resource observer will report
    // itself, so counting them here would report it twice.
    recordResponsePayload(new Response("x".repeat(2_000)), "x".repeat(2_000));
    recordTransferredBody(4_096);
    expect(dataUsage().bytes).toBe(0);

    stop();
    recordTransferredBody(4_096);
    expect(dataUsage().bytes).toBe(4_096);
  });

  it("costs nothing on a browser with no resource timing", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const stop = observeTransferredResources();
    expect(dataUsage().bytes).toBe(0);
    expect(dataUsage().measured).toBe(false);
    expect(() => { stop(); }).not.toThrow();
  });

  it("keeps estimating on a browser whose entries carry no transfer size", () => {
    // Safari before 16.4 ACCEPTS the resource entry type and reports no
    // `transferSize` on it. Reading `observe()` not throwing as "the browser is
    // measuring for us" silenced the estimate and counted zeroes in its place,
    // so the meter read a confident, permanent "0 B" — the one number the whole
    // feature exists to justify.
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    vi.stubGlobal("PerformanceResourceTiming", class { });
    FakePerformanceObserver.latest = undefined;
    const stop = observeTransferredResources();

    // No observer is built at all -- there would be nothing for it to read --
    // so both estimate paths stay live and the snapshot says it is guessing.
    expect(FakePerformanceObserver.latest).toBeUndefined();
    expect(dataUsage().measured).toBe(false);
    recordTransferredBody(4_096);
    recordResponsePayload(new Response("x".repeat(2_000)), "x".repeat(2_000));

    expect(dataUsage().bytes).toBe(4_096 + 2_000);
    stop();
  });

  it("says on the snapshot whether the browser is measuring or the console is guessing", () => {
    expect(dataUsage().measured).toBe(false);
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const stop = observeTransferredResources();
    expect(dataUsage().measured).toBe(true);
    stop();
    expect(dataUsage().measured).toBe(false);
  });
});

describe("what the operator is shown", () => {
  it("formats a session total at a glance", () => {
    expect(formatDataBytes(0)).toBe("0 B");
    expect(formatDataBytes(900)).toBe("900 B");
    expect(formatDataBytes(2_048)).toBe("2 KiB");
    expect(formatDataBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  it("reports what the last minute cost, not what the session averaged", () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      recordDataUsage(100_000);
      // A session shorter than the window cannot have a rate worth quoting: the
      // first seconds of a page load say more about the load than the link.
      expect(dataUsageRatePerMinute()).toBe(0);

      vi.setSystemTime(started + 70_000);
      recordDataUsage(20_000);
      // The burst that loaded the page has aged out of the window; a session
      // AVERAGE would still be reporting it as roughly 100 KB a minute.
      expect(dataUsageRatePerMinute()).toBe(20_000);

      vi.setSystemTime(started + 200_000);
      expect(dataUsageRatePerMinute()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes the first record at once and coalesces the burst behind it", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useDataUsage());
      expect(result.current.bytes).toBe(0);

      act(() => { recordDataUsage(1_500); });
      // A streaming turn records several times a second, and every publish
      // rebuilds the palette's action list. The first one still lands at once.
      expect(result.current.bytes).toBe(1_500);

      act(() => {
        recordDataUsage(500);
        recordDataUsage(500);
      });
      expect(result.current.bytes).toBe(1_500);

      act(() => { vi.advanceTimersByTime(METER_PUBLISH_MS); });
      expect(result.current.bytes).toBe(2_500);
    } finally {
      vi.useRealTimers();
    }
  });
});
