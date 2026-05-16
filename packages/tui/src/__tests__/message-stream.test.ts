import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TuiInkMessageStream } from "../agent/message-stream.js";
import type { TuiStreamState } from "../agent/message-stream.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function captureStates(): {
  states: TuiStreamState[];
  onState: (state: TuiStreamState) => void;
} {
  const states: TuiStreamState[] = [];
  return {
    states,
    onState: (state) => {
      states.push(state);
    },
  };
}

describe("TuiInkMessageStream", () => {
  it("uses the configured initial status text", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({
      initialStatusText: "Routing…",
      onState,
      streamDebounceMs: 30,
    });
    await stream.status("Drafting…");
    vi.advanceTimersByTime(30);
    expect(states.at(-1)?.statusText).toBe("Drafting…");
    expect(stream.snapshot().statusText).toBe("Drafting…");
  });

  it("debounces multiple append calls into a single state emission per window", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("hel");
    await stream.append("lo");
    await stream.append(" world");
    expect(states).toHaveLength(0);
    vi.advanceTimersByTime(30);
    expect(states).toHaveLength(1);
    expect(states[0]?.text).toBe("hello world");
    expect(states[0]?.hasOutput).toBe(true);
    expect(states[0]?.finished).toBe(false);
  });

  it("emits separate snapshots across debounce windows", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("a");
    vi.advanceTimersByTime(30);
    await stream.append("b");
    vi.advanceTimersByTime(30);
    expect(states.map((s) => s.text)).toEqual(["a", "ab"]);
  });

  it("ignores empty deltas without scheduling a flush", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("");
    vi.advanceTimersByTime(30);
    expect(states).toHaveLength(0);
    expect(stream.snapshot().hasOutput).toBe(false);
  });

  it("replace overrides the buffered text", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("draft");
    await stream.replace("final");
    vi.advanceTimersByTime(30);
    expect(states.at(-1)?.text).toBe("final");
  });

  it("finish flushes immediately and marks the stream as finished", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("partial");
    await stream.finish("complete");
    expect(states).toHaveLength(1);
    expect(states[0]?.text).toBe("complete");
    expect(states[0]?.finished).toBe(true);
  });

  it("rejects further calls after finish()", async () => {
    const { onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState });
    await stream.finish();
    await expect(stream.append("x")).rejects.toThrow(/already been finished/);
    await expect(stream.status("x")).rejects.toThrow(/already been finished/);
  });

  it("debounceMs=0 emits synchronously per call", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 0 });
    await stream.append("a");
    await stream.append("b");
    expect(states.map((s) => s.text)).toEqual(["a", "ab"]);
  });

  it("flushPending forces an out-of-band emission for any buffered work", async () => {
    const { states, onState } = captureStates();
    const stream = new TuiInkMessageStream({ onState, streamDebounceMs: 30 });
    await stream.append("partial");
    expect(states).toHaveLength(0);
    stream.flushPending();
    expect(states).toHaveLength(1);
    expect(states[0]?.text).toBe("partial");
  });

  it("rejects negative or non-finite debounce values", () => {
    const { onState } = captureStates();
    expect(
      () => new TuiInkMessageStream({ onState, streamDebounceMs: -1 }),
    ).toThrow(RangeError);
    expect(
      () => new TuiInkMessageStream({ onState, streamDebounceMs: Number.NaN }),
    ).toThrow(RangeError);
  });
});
