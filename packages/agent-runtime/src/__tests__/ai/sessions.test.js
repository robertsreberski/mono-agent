import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionRegistry,
  disposeProviderSession,
} from "../../ai/runtime/sessions.js";

describe("createSessionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and returns live entries", () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-1", { name: "alpha" });
    expect(registry.get("session-1")).toEqual({ name: "alpha" });
    expect(registry.has("session-1")).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it("evicts entries after the idle timeout fires", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(registry.get("session-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "idle_timeout");
  });

  it("lazily evicts when the wall clock advanced past the TTL without the timer firing", () => {
    let nowValue = 0;
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict, now: () => nowValue });
    registry.set("session-1", { name: "alpha" });
    nowValue = 120_000;
    expect(registry.get("session-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "idle_timeout");
  });

  it("does not idle-evict a busy session; explicit dispose still wins", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({
      idleTimeoutMs: 60_000,
      onEvict,
      isBusy: (value) => value.busy === true,
    });
    const value = { name: "alpha", busy: true };
    registry.set("session-1", value);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onEvict).not.toHaveBeenCalled();
    value.busy = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onEvict).toHaveBeenCalledWith(value, "idle_timeout");

    const disposable = { name: "beta", busy: true };
    registry.set("session-2", disposable);
    await registry.dispose("session-2");
    expect(onEvict).toHaveBeenCalledWith(disposable, "disposed");
  });

  it("touch re-arms the idle timer", async () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(40_000);
    registry.touch("session-1");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(registry.get("session-1")).toEqual({ name: "alpha" });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("delete removes without running onEvict", () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    expect(registry.delete("session-1")).toBe(true);
    expect(onEvict).not.toHaveBeenCalled();
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("dispose runs onEvict with the disposed reason", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await registry.dispose("session-1");
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "disposed");
    expect(registry.size()).toBe(0);
  });

  it("disposeAll evicts every entry", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    registry.set("session-2", { name: "beta" });
    await registry.disposeAll();
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
  });

  it("survives an onEvict that throws", async () => {
    const registry = createSessionRegistry({
      idleTimeoutMs: 60_000,
      onEvict: () => {
        throw new Error("close failed");
      },
    });
    registry.set("session-1", { name: "alpha" });
    await expect(registry.dispose("session-1")).resolves.toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("replacing an entry clears the previous timer", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(50_000);
    registry.set("session-1", { name: "beta" });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(registry.get("session-1")).toEqual({ name: "beta" });
  });
});

describe("disposeProviderSession", () => {
  it("disposes a session in whichever registry holds it", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("cross-registry-session", { name: "alpha" });
    await expect(disposeProviderSession("cross-registry-session")).resolves.toBe(true);
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "disposed");
  });

  it("returns false for unknown or blank ids", async () => {
    await expect(disposeProviderSession("definitely-not-registered")).resolves.toBe(false);
    await expect(disposeProviderSession("")).resolves.toBe(false);
    await expect(disposeProviderSession(undefined)).resolves.toBe(false);
  });
});
