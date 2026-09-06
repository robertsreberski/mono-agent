import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    expect(() => { stop(); }).not.toThrow();
  });
});

describe("what the operator is shown", () => {
  it("formats a session total at a glance", () => {
    expect(formatDataBytes(0)).toBe("0 B");
    expect(formatDataBytes(900)).toBe("900 B");
    expect(formatDataBytes(2_048)).toBe("2 KiB");
    expect(formatDataBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  it("reports a per-minute rate from the session it has actually run for", () => {
    const usage = { bytes: 120_000, since: 1_000 };
    expect(dataUsageRatePerMinute(usage, 61_000)).toBe(120_000);
    expect(dataUsageRatePerMinute(usage, 121_000)).toBe(60_000);
    // A session shorter than a moment cannot have a rate worth quoting.
    expect(dataUsageRatePerMinute(usage, 1_000)).toBe(0);
  });

  it("publishes every record to a subscribed reader", () => {
    const { result } = renderHook(() => useDataUsage());
    expect(result.current.bytes).toBe(0);

    act(() => { recordDataUsage(1_500); });

    expect(result.current.bytes).toBe(1_500);
  });
});
