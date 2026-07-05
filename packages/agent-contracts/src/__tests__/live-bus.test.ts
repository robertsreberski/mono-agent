import { describe, expect, it, vi } from "vitest";

import { LIVE_EVENT_SCHEMA, createLiveEventBus, type RunEventFrame } from "../index.js";

/** A producer-side frame with the placeholder seq (0) the bus is expected to overwrite. */
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

describe("createLiveEventBus", () => {
  it("stamps a process-wide monotonic seq, overwriting the producer's placeholder", () => {
    const bus = createLiveEventBus();

    bus.publish(runStarted("r1"));
    bus.publish(runStarted("r2"));
    bus.publish(runStarted("r3"));

    expect(bus.recentFrames().map((frame) => frame.seq)).toEqual([0, 1, 2]);
  });

  it("caps the ring buffer at the configured size, evicting oldest-first", () => {
    const bus = createLiveEventBus({ ringBufferSize: 3 });

    for (let i = 0; i < 5; i += 1) {
      bus.publish(runStarted(`r${i}`));
    }

    const frames = bus.recentFrames();
    expect(frames).toHaveLength(3);
    // Oldest-first, retaining the three most recent seqs.
    expect(frames.map((frame) => frame.seq)).toEqual([2, 3, 4]);
    expect(frames.map((frame) => (frame as { runId: string }).runId)).toEqual(["r2", "r3", "r4"]);
  });

  it("delivers future frames to subscribers and stops after unsubscribe", () => {
    const bus = createLiveEventBus();
    const received: number[] = [];
    const unsubscribe = bus.subscribe((frame) => received.push(frame.seq));

    bus.publish(runStarted("r1"));
    bus.publish(runStarted("r2"));
    unsubscribe();
    bus.publish(runStarted("r3"));

    expect(received).toEqual([0, 1]);
  });

  it("isolates a throwing subscriber so peers and the publisher are unaffected", () => {
    const bus = createLiveEventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(good);

    expect(() => bus.publish(runStarted("r1"))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0]?.[0]).toMatchObject({ runId: "r1", seq: 0 });
  });

  it("returns a fresh oldest-first array from recentFrames (not the live buffer)", () => {
    const bus = createLiveEventBus();
    bus.publish(runStarted("r1"));

    const snapshot = bus.recentFrames();
    bus.publish(runStarted("r2"));

    // The earlier snapshot must not observe frames published after it.
    expect(snapshot).toHaveLength(1);
    expect(bus.recentFrames()).toHaveLength(2);
  });

  it("replaces oversized event frames before retention and delivery", () => {
    const bus = createLiveEventBus({ maxFrameBytes: 180 });
    const received: RunEventFrame[] = [];
    bus.subscribe((frame) => received.push(frame));

    bus.publish({
      t: "event",
      schema: LIVE_EVENT_SCHEMA,
      sourceId: "src-1",
      runId: "r1",
      eventIndex: 0,
      event: { text: "x".repeat(1_000) },
      seq: 0,
    });

    const [frame] = bus.recentFrames();
    expect(frame).toMatchObject({
      t: "event",
      event: { type: "live_frame_oversized", originalType: undefined },
    });
    expect(JSON.stringify(frame).length).toBeLessThanOrEqual(180);
    expect(received[0]).toEqual(frame);
  });

  it("replaces unserializable event frames instead of throwing", () => {
    const bus = createLiveEventBus();
    const circular: Record<string, unknown> = { type: "assistant" };
    circular.self = circular;

    expect(() =>
      bus.publish({
        t: "event",
        schema: LIVE_EVENT_SCHEMA,
        sourceId: "src-1",
        runId: "r1",
        eventIndex: 0,
        event: circular,
        seq: 0,
      }),
    ).not.toThrow();

    expect(bus.recentFrames()[0]).toMatchObject({
      t: "event",
      event: { type: "live_frame_unserializable", originalType: "assistant" },
    });
  });

  it("rejects a non-positive ring buffer size loudly", () => {
    expect(() => createLiveEventBus({ ringBufferSize: 0 })).toThrowError(/positive integer/u);
    expect(() => createLiveEventBus({ ringBufferSize: -1 })).toThrowError(/positive integer/u);
    expect(() => createLiveEventBus({ ringBufferSize: 1.5 })).toThrowError(/positive integer/u);
  });
});
