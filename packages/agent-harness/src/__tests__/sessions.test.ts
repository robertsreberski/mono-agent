import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeSessionStore } from "../sessions.js";

describe("createRuntimeSessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("save then acquire returns the record and marks it busy", () => {
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000 });
    store.save("conv-1", "ps-1");
    const record = store.acquire("conv-1");
    expect(record).toMatchObject({ conversationId: "conv-1", providerSessionId: "ps-1", busy: true });
    expect(store.acquire("conv-1")).toBeUndefined();
    store.release("conv-1");
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("evicts after the idle timeout and reports the record to onEvict", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: "ps-1" }),
      "idle_timeout",
    );
  });

  it("lazily evicts on acquire when the wall clock outran the timer", () => {
    let nowValue = 0;
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict, now: () => nowValue });
    store.save("conv-1", "ps-1");
    nowValue = 120_000;
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "idle_timeout");
  });

  it("does not idle-evict while a record is busy", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    expect(store.acquire("conv-1")).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onEvict).not.toHaveBeenCalled();
    store.release("conv-1");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "idle_timeout");
  });

  it("saving a different provider session id evicts the old record with reason replaced", () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    store.save("conv-1", "ps-2");
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "replaced");
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-2" });
  });

  it("saving the same id refreshes activity without eviction", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(50_000);
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(onEvict).not.toHaveBeenCalled();
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("evict with reason stale reports it and forgets the record", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    await store.evict("conv-1", "stale");
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "stale");
    expect(store.acquire("conv-1")).toBeUndefined();
  });

  it("disposeAll evicts everything with reason disposed and swallows onEvict errors", async () => {
    const onEvict = vi.fn().mockRejectedValue(new Error("close failed"));
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    store.save("conv-2", "ps-2");
    await expect(store.disposeAll()).resolves.toBeUndefined();
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(store.acquire("conv-2")).toBeUndefined();
  });

  it("release after eviction is a no-op", async () => {
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000 });
    store.save("conv-1", "ps-1");
    await store.evict("conv-1", "stale");
    expect(() => store.release("conv-1")).not.toThrow();
  });
});
