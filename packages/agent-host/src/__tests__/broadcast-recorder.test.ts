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
});
