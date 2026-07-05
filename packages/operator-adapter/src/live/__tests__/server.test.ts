import { afterEach, describe, expect, it } from "vitest";

import { LIVE_EVENT_SCHEMA, type RunEventFrame } from "@mono-agent/agent-contracts";

import {
  createLiveEventBus,
  LIVE_ADAPTER_INFO_SCHEMA,
  loadLiveAdapterConfig,
  startLiveAdapter,
  type LiveAdapterHandle,
} from "../index.js";

let running: LiveAdapterHandle | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function runStarted(runId: string): RunEventFrame {
  return {
    t: "run_started",
    schema: LIVE_EVENT_SCHEMA,
    sourceId: "src-1",
    runId,
    conversationId: "conv-1",
    startedAt: "1970-01-01T00:00:00.000Z",
    seq: 0,
  };
}

/**
 * Open an SSE connection and collect `count` `data:` frames (ignoring heartbeat
 * comments), then abort. Resolves once `count` frames arrive or the stream ends.
 */
async function readSseFrames(
  url: string,
  count: number,
  headers: Record<string, string> = {},
): Promise<RunEventFrame[]> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("SSE response had no body.");
  }
  const decoder = new TextDecoder();
  const frames: RunEventFrame[] = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (chunk.startsWith("data:")) {
          frames.push(JSON.parse(chunk.slice("data:".length).trim()) as RunEventFrame);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe("startLiveAdapter", () => {
  it("serves /v1/info with schema, pid, and label", async () => {
    running = await startLiveAdapter({ bus: createLiveEventBus(), label: "test-agent" });

    const info = await (await fetch(`${running.baseUrl}/v1/info`)).json();

    expect(info).toEqual({ schema: LIVE_ADAPTER_INFO_SCHEMA, pid: process.pid, label: "test-agent" });
  });

  it("omits label from /v1/info when unset", async () => {
    running = await startLiveAdapter({ bus: createLiveEventBus() });

    const info = await (await fetch(`${running.baseUrl}/v1/info`)).json();

    expect(info).toEqual({ schema: LIVE_ADAPTER_INFO_SCHEMA, pid: process.pid });
  });

  it("replays already-published frames to a subscriber that connects afterwards", async () => {
    const bus = createLiveEventBus();
    running = await startLiveAdapter({ bus });

    // Publish BEFORE any subscriber connects — these live only in the ring buffer.
    bus.publish(runStarted("r1"));
    bus.publish(runStarted("r2"));

    const frames = await readSseFrames(`${running.baseUrl}/v1/events`, 2);

    expect(frames.map((frame) => frame.seq)).toEqual([0, 1]);
    expect(frames.map((frame) => (frame as { runId: string }).runId)).toEqual(["r1", "r2"]);
  });

  it("streams an unserializable sentinel without closing the stream", async () => {
    const bus = createLiveEventBus();
    const circular: Record<string, unknown> = { type: "assistant" };
    circular.self = circular;
    bus.publish({
      t: "event",
      schema: LIVE_EVENT_SCHEMA,
      sourceId: "src-1",
      runId: "bad",
      eventIndex: 0,
      event: circular,
      seq: 0,
    });
    running = await startLiveAdapter({ bus });

    const framesPromise = readSseFramesWithDeadline(`${running.baseUrl}/v1/events`, 2, 1000);
    await sleep(25);
    bus.publish(runStarted("good"));

    await expect(framesPromise).resolves.toMatchObject([
      { t: "event", runId: "bad", event: { type: "live_frame_unserializable", originalType: "assistant" } },
      { t: "run_started", runId: "good" },
    ]);
  });

  it("streams a frame published after the subscriber connects", async () => {
    const bus = createLiveEventBus();
    running = await startLiveAdapter({ bus });

    const controller = new AbortController();
    const response = await fetch(`${running.baseUrl}/v1/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("SSE response had no body.");
    }

    // Publish after the stream is open; the subscribe() path (not replay) delivers it.
    bus.publish(runStarted("live-1"));

    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }

    const dataLine = text.split("\n\n").find((line) => line.trim().startsWith("data:"));
    expect(dataLine).toBeDefined();
    const frame = JSON.parse(dataLine!.trim().slice("data:".length).trim()) as RunEventFrame;
    expect(frame).toMatchObject({ t: "run_started", runId: "live-1", seq: 0 });
  });

  it("advertises the SSE content type on /v1/events", async () => {
    running = await startLiveAdapter({ bus: createLiveEventBus() });

    const controller = new AbortController();
    const response = await fetch(`${running.baseUrl}/v1/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    controller.abort();
    await response.body?.cancel().catch(() => {});
  });

  it("enforces the bearer key on both routes when configured", async () => {
    running = await startLiveAdapter({ bus: createLiveEventBus(), apiKey: "fixture-secret" });

    expect((await fetch(`${running.baseUrl}/v1/info`)).status).toBe(401);

    const unauthedEvents = await fetch(`${running.baseUrl}/v1/events`);
    expect(unauthedEvents.status).toBe(401);
    await unauthedEvents.body?.cancel().catch(() => {});

    const authed = await fetch(`${running.baseUrl}/v1/info`, {
      headers: { authorization: "Bearer fixture-secret" },
    });
    expect(authed.status).toBe(200);
  });

  it("refuses to bind a non-loopback host without allowNonLoopback", async () => {
    await expect(
      startLiveAdapter({ bus: createLiveEventBus(), host: "0.0.0.0" }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("rejects Express route metacharacters in basePath", async () => {
    await expect(startLiveAdapter({ bus: createLiveEventBus(), basePath: "/live/:source" })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadLiveAdapterConfig({ env: { MONO_AGENT_LIVE_BASE_PATH: "/live/:source" } })).rejects.toMatchObject({ code: "invalid_config" });
  });
});

async function readSseFramesWithDeadline(url: string, count: number, timeoutMs: number): Promise<RunEventFrame[]> {
  return await Promise.race([
    readSseFrames(url, count),
    sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${count} SSE frame(s).`);
    }),
  ]);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
