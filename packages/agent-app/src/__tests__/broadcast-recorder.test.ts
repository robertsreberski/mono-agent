import { describe, expect, it } from "vitest";

import { LIVE_EVENT_SCHEMA, type RunEventFrame, type RunEventSink } from "@mono-agent/agent-contracts";
import type { RunRecorder, RunSummary, RuntimeResultLike } from "@mono-agent/observability";

import { createBroadcastRunRecorder } from "../broadcast-recorder.js";

function innerRecorder(summary: RunSummary): RunRecorder {
  return {
    async start() {
      return summary;
    },
    onEvent() {},
    async finish(_result: RuntimeResultLike) {
      return summary;
    },
    async fail(_error: unknown) {
      return { ...summary, status: "failed" };
    },
  };
}

describe("createBroadcastRunRecorder", () => {
  it("redacts sensitive runtime event payloads before publishing to the live bus", () => {
    const frames: RunEventFrame[] = [];
    const sink: RunEventSink = { publish: (frame) => { frames.push(frame); } };
    const summary: RunSummary = {
      runId: "run-1",
      conversationId: "chat:1",
      status: "succeeded",
      startedAt: "2026-07-04T00:00:00.000Z",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
    };
    const recorder = createBroadcastRunRecorder(innerRecorder(summary), sink, {
      runId: "run-1",
      conversationId: "chat:1",
      sourceId: "src-1",
    });

    recorder.onEvent({
      type: "provider_request",
      apiKey: "sk-live-secret",
      nested: { authorization: "Bearer token-secret" },
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "event", schema: LIVE_EVENT_SCHEMA, sourceId: "src-1", runId: "run-1" });
    expect(JSON.stringify(frames[0])).not.toContain("sk-live-secret");
    expect(JSON.stringify(frames[0])).not.toContain("token-secret");
    expect(JSON.stringify(frames[0])).toContain("[redacted]");
  });

  it("bounds large runtime event strings before publishing to the live bus", () => {
    const frames: RunEventFrame[] = [];
    const sink: RunEventSink = { publish: (frame) => { frames.push(frame); } };
    const summary: RunSummary = {
      runId: "run-large",
      conversationId: "chat:large",
      status: "succeeded",
      startedAt: "2026-07-04T00:00:00.000Z",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
    };
    const recorder = createBroadcastRunRecorder(innerRecorder(summary), sink, {
      runId: "run-large",
      conversationId: "chat:large",
      sourceId: "src-large",
    });

    recorder.onEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(50_000) }] },
    });

    const serialized = JSON.stringify(frames[0]);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).toContain("[truncated");
  });

  it("redacts sensitive fields from terminal summaries before publishing", async () => {
    const frames: RunEventFrame[] = [];
    const sink: RunEventSink = { publish: (frame) => { frames.push(frame); } };
    const summary: RunSummary = {
      runId: "run-2",
      conversationId: "chat:2",
      status: "succeeded",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
      diagnostics: { token: "secret-diagnostic-token" },
    };
    const recorder = createBroadcastRunRecorder(innerRecorder(summary), sink, {
      runId: "run-2",
      conversationId: "chat:2",
      sourceId: "src-2",
    });

    await recorder.finish({});

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "run_finished", sourceId: "src-2", runId: "run-2" });
    expect(JSON.stringify(frames[0])).not.toContain("secret-diagnostic-token");
    expect(JSON.stringify(frames[0])).toContain("[redacted]");
  });

  it("publishes a persistence warning before exactly one idempotent terminal frame", async () => {
    const frames: RunEventFrame[] = [];
    const sink: RunEventSink = { publish: (frame) => { frames.push(frame); } };
    let terminalCalls = 0;
    const summary: RunSummary = {
      runId: "run-two-phase",
      conversationId: "telegram:2",
      status: "succeeded",
      durationMs: 1,
      eventCount: 1,
      artifactPaths: [],
    };
    const inner: RunRecorder = {
      onEvent(): void {},
      async prepareFinish(): Promise<void> {},
      async commitFinish(): Promise<RunSummary> {
        terminalCalls += 1;
        return summary;
      },
      async finish(): Promise<RunSummary> { throw new Error("one-shot finish must not be used"); },
      async fail(): Promise<RunSummary> { return { ...summary, status: "failed" }; },
    };
    const recorder = createBroadcastRunRecorder(inner, sink, {
      runId: summary.runId,
      conversationId: summary.conversationId,
      sourceId: "src-two-phase",
    });

    await recorder.prepareFinish?.({});
    recorder.onEvent({ type: "runtime_warning", warning_kind: "memory_persistence_degraded" });
    await recorder.commitFinish?.({});
    await recorder.commitFinish?.({});
    // The terminal boundary is hard: a late event is ignored, not broadcast.
    recorder.onEvent({ type: "runtime_warning", warning_kind: "too_late" });

    expect(terminalCalls).toBe(1);
    expect(frames.map((frame) => frame.t)).toEqual(["event", "run_finished"]);
    expect(frames[0]).toMatchObject({
      t: "event",
      event: { type: "runtime_warning", warning_kind: "memory_persistence_degraded" },
    });
  });
});
