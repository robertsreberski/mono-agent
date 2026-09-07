import { describe, expect, it } from "vitest";

import {
  isTerminalMonitorState,
  MONITOR_PUBLIC_ERROR_MESSAGES,
  MONITOR_STATES,
  monitorPublicError,
  parseMonitorProjection,
  parseMonitorProjections,
  type MonitorProjection,
} from "../monitors.js";

function projection(overrides: Partial<MonitorProjection> = {}): MonitorProjection {
  return {
    schema: "mono-agent.monitor-projection.v2",
    monitorId: "mon-1",
    state: "running",
    description: "Watching the deploy log",
    persistent: false,
    origin: { conversationId: "telegram:42", channel: "telegram", runId: "run-1", bucket: null },
    timestamps: {
      startedAt: "2026-09-03T10:00:00.000Z",
      runtimeDeadlineAt: "2026-09-03T11:00:00.000Z",
      lastEventAt: null,
      completedAt: null,
    },
    limits: { wakeOn: "batch", dedupe: "none", minWakeIntervalMs: 0, maxRuntimeMs: 3_600_000, coalesceMs: 200, maxBatchLines: 200, maxBatchBytes: 65_536, chainDepth: 0 },
    counters: { batchesSuppressed: 0, linesSuppressed: 0, followUpWakes: 0, steeredWakes: 0, unknownDispositionWakes: 0, seq: 0, batchesDelivered: 0, linesObserved: 0, linesDelivered: 0, droppedLines: 0, pendingLines: 0 },
    exitCode: null,
    signal: null,
    cancelRequested: false,
    lastError: null,
    ...overrides,
  };
}

describe("monitor projection contract", () => {
  it("round-trips a well-formed projection", () => {
    const value = projection();
    expect(parseMonitorProjection(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseMonitorProjections([JSON.parse(JSON.stringify(value))])).toHaveLength(1);
  });

  it("migrates historical v1 projections with compatible policy and honest unknown dispositions", () => {
    const current = projection();
    const { wakeOn: _wakeOn, dedupe: _dedupe, minWakeIntervalMs: _interval, ...limits } = current.limits;
    const { batchesSuppressed: _batches, linesSuppressed: _lines, followUpWakes: _follow,
      steeredWakes: _steered, unknownDispositionWakes: _unknown, ...counters } = current.counters;
    const legacy = { ...current, schema: "mono-agent.monitor-projection.v1", limits,
      counters: { ...counters, batchesDelivered: 3 } };
    expect(parseMonitorProjection(legacy)).toMatchObject({
      schema: "mono-agent.monitor-projection.v2",
      limits: { wakeOn: "batch", dedupe: "none", minWakeIntervalMs: 0 },
      counters: { batchesSuppressed: 0, linesSuppressed: 0, followUpWakes: 0, steeredWakes: 0,
        unknownDispositionWakes: 3 },
    });
    expect(() => parseMonitorProjection({ ...legacy, limits: { ...limits, dedupe: "batch" } })).toThrow();
  });

  it("validates v2 policy, suppression counters, and the expanded chain cap", () => {
    expect(parseMonitorProjection({ ...projection(), limits: { ...projection().limits, chainDepth: 64 } })
      .limits.chainDepth).toBe(64);
    for (const limits of [
      { ...projection().limits, wakeOn: "other" },
      { ...projection().limits, minWakeIntervalMs: -1 },
      { ...projection().limits, minWakeIntervalMs: 300_001 },
      { ...projection().limits, wakeOn: "exit", dedupe: "batch" },
      { ...projection().limits, wakeOn: "exit", minWakeIntervalMs: 1 },
    ]) expect(() => parseMonitorProjection({ ...projection(), limits })).toThrow();
    const { linesSuppressed: _suppressed, ...missingCounter } = projection().counters;
    expect(() => parseMonitorProjection({ ...projection(), counters: missingCounter })).toThrow();
    expect(() => parseMonitorProjection({ ...projection(), counters: {
      ...projection().counters, linesSuppressed: 1,
    } })).toThrow(/counters/u);
  });

  it("rejects unknown keys at every depth", () => {
    expect(() => parseMonitorProjection({ ...projection(), extra: 1 })).toThrow(/invalid envelope/u);
    expect(() => parseMonitorProjection({
      ...projection(),
      origin: { ...projection().origin, extra: 1 },
    })).toThrow(/invalid origin/u);
    expect(() => parseMonitorProjection({
      ...projection(),
      counters: { ...projection().counters, extra: 1 },
    })).toThrow(/invalid counters/u);
  });

  it("rejects a wrong schema, an unknown state, and a malformed timestamp", () => {
    expect(() => parseMonitorProjection({ ...projection(), schema: "other" })).toThrow();
    expect(() => parseMonitorProjection({ ...projection(), state: "paused" })).toThrow();
    expect(() => parseMonitorProjection({
      ...projection(),
      timestamps: { ...projection().timestamps, startedAt: "2026-09-03" },
    })).toThrow(/invalid timestamps/u);
  });

  it("rejects counters that claim more delivered than observed", () => {
    expect(() => parseMonitorProjection({
      ...projection(),
      counters: { seq: 1, batchesDelivered: 1, linesObserved: 1, linesDelivered: 2, droppedLines: 0, pendingLines: 0 },
    })).toThrow(/invalid counters/u);
  });

  it("rejects limits above their compiled bounds", () => {
    expect(() => parseMonitorProjection({
      ...projection(),
      limits: { ...projection().limits, maxRuntimeMs: 24 * 60 * 60 * 1_000 + 1 },
    })).toThrow(/invalid limits/u);
    expect(() => parseMonitorProjection({
      ...projection(),
      limits: { ...projection().limits, chainDepth: 65 },
    })).toThrow(/invalid limits/u);
  });

  it("replaces a tampered error message with the stable public one", () => {
    const parsed = parseMonitorProjection({
      ...projection(),
      lastError: { code: "monitor_timeout", message: "spoofed operator guidance" },
    });
    expect(parsed.lastError).toEqual(monitorPublicError("monitor_timeout"));
    expect(parsed.lastError?.message).toBe(MONITOR_PUBLIC_ERROR_MESSAGES.monitor_timeout);
  });

  it("bounds a projection list", () => {
    expect(() => parseMonitorProjections("nope")).toThrow(/invalid/u);
    expect(() => parseMonitorProjections(Array.from({ length: 2_000 }, () => projection()))).toThrow(/invalid/u);
  });

  it("classifies exactly the non-live states as terminal", () => {
    const terminal = MONITOR_STATES.filter((state) => isTerminalMonitorState(state));
    expect(terminal).toEqual(["exited", "timed_out", "cancelled", "spawn_failed", "rate_limited", "interrupted"]);
  });

  it("publishes a message for every declared error code", () => {
    for (const code of Object.keys(MONITOR_PUBLIC_ERROR_MESSAGES)) {
      expect(monitorPublicError(code as never).message.length).toBeGreaterThan(0);
    }
  });
});
