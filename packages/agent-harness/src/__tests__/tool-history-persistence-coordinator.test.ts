import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolHistoryPersistenceCoordinator } from "../tool-history-persistence-coordinator.js";

function controlled<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolHistoryPersistenceCoordinator", () => {
  it("returns a settlement before the foreground ceiling and clears tracking", async () => {
    vi.useFakeTimers();
    const coordinator = new ToolHistoryPersistenceCoordinator(250);
    const observed = vi.fn();

    await expect(coordinator.track("run", Promise.resolve("persisted"), observed)).resolves.toEqual({
      status: "settled",
      settlement: { status: "fulfilled", value: "persisted" },
    });
    expect(observed).toHaveBeenCalledOnce();
    expect(coordinator.pendingForRun("run")).toBe(0);
  });

  it("releases the foreground as deferred while retaining and draining a late success", async () => {
    vi.useFakeTimers();
    const coordinator = new ToolHistoryPersistenceCoordinator(250);
    const operation = controlled<string>();
    const observed = vi.fn();
    const foreground = coordinator.track("run", operation.promise, observed);

    await vi.advanceTimersByTimeAsync(250);
    await expect(foreground).resolves.toEqual({ status: "deferred" });
    expect(coordinator.pendingForRun("run")).toBe(1);

    const boundary = coordinator.boundaryForRun("run");
    operation.resolve("persisted");
    await expect(coordinator.waitForBoundary(boundary, 1_000)).resolves.toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ status: "fulfilled", value: "persisted" });
    expect(coordinator.pendingForRun("run")).toBe(0);
  });

  it("settles a late rejection once without an unhandled rejecting tracker", async () => {
    vi.useFakeTimers();
    const coordinator = new ToolHistoryPersistenceCoordinator(250);
    const operation = controlled<string>();
    const observed = vi.fn();
    const foreground = coordinator.track("run", operation.promise, observed);

    await vi.advanceTimersByTimeAsync(250);
    await expect(foreground).resolves.toEqual({ status: "deferred" });
    const boundary = coordinator.boundaryForRun("run");
    const error = new Error("late failure");
    operation.reject(error);

    await expect(coordinator.waitForBoundary(boundary, 1_000)).resolves.toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ status: "rejected", error });
    expect(coordinator.pendingForRun("run")).toBe(0);
  });

  it("keeps a run-finalization boundary independent of later accepted requests", async () => {
    vi.useFakeTimers();
    const coordinator = new ToolHistoryPersistenceCoordinator(250);
    const first = controlled<string>();
    const later = controlled<string>();
    void coordinator.track("run", first.promise);
    const boundary = coordinator.boundaryForRun("run");
    void coordinator.track("run", later.promise);

    first.resolve("first");
    await expect(coordinator.waitForBoundary(boundary, 1_000)).resolves.toBe(true);
    expect(coordinator.pendingForRun("run")).toBe(1);

    later.resolve("later");
    await expect(coordinator.waitForBoundary(coordinator.boundaryForAll(), 1_000)).resolves.toBe(true);
    expect(coordinator.pendingForRun("run")).toBe(0);
  });

  it("bounds a run or close drain when an accepted request never settles", async () => {
    vi.useFakeTimers();
    const coordinator = new ToolHistoryPersistenceCoordinator(250);
    const operation = controlled<string>();
    void coordinator.track("run", operation.promise);
    const drained = coordinator.waitForBoundary(coordinator.boundaryForAll(), 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drained).resolves.toBe(false);
    expect(coordinator.pendingForRun("run")).toBe(1);

    const remaining = coordinator.boundaryForAll();
    operation.resolve("late");
    await expect(coordinator.waitForBoundary(remaining, 1_000)).resolves.toBe(true);
    expect(coordinator.pendingForRun("run")).toBe(0);
  });
});
