import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForShutdownSignal } from "../cli-background-command.js";
import { AGENT_RESTART_EXIT_CODE, AGENT_RESTART_EXIT_FALLBACK_MS, armAcceptedRestartExitFallback, createSupervisedRestartLatch } from "../supervised-restart-latch.js";

const verified = { supported: true } as const;
afterEach(() => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  vi.useRealTimers();
});

describe("supervised host lifecycle latch", () => {
  it("forces only a leaked accepted-restart worker after its bounded graceful-drain window", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const unref = vi.fn();
    const schedule = vi.fn((handler: () => void, ms: number) => {
      const timer = setTimeout(handler, ms);
      timer.unref = unref;
      return timer;
    });
    armAcceptedRestartExitFallback({ exit, schedule });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), AGENT_RESTART_EXIT_FALLBACK_MS);
    expect(unref).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(AGENT_RESTART_EXIT_FALLBACK_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(AGENT_RESTART_EXIT_CODE);
  });

  it("accepts before the shutdown waiter subscribes, keeps one immutable id and one stop", async () => {
    const latch = createSupervisedRestartLatch();
    const first = latch.accept(verified);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") throw new Error("accept failed");
    expect(latch.accept(verified)).toEqual({ kind: "conflict", operationId: first.operationId });
    latch.beginStop(first.operationId);
    const app = { stop: vi.fn(async () => {}) };
    await expect(waitForShutdownSignal(app, undefined, latch)).resolves.toBe(AGENT_RESTART_EXIT_CODE);
    latch.beginStop(first.operationId);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("a signal before acceptance refuses restart and resolves zero", async () => {
    const latch = createSupervisedRestartLatch();
    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app, undefined, latch);
    process.emit("SIGTERM");
    expect(latch.accept(verified)).toEqual({ kind: "refused", reason: "The agent is already stopping." });
    await expect(pending).resolves.toBe(0);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("a signal after acceptance cannot undo the nonzero disposition", async () => {
    const latch = createSupervisedRestartLatch();
    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app, undefined, latch);
    const result = latch.accept(verified);
    expect(result.kind).toBe("accepted");
    process.emit("SIGTERM");
    await expect(pending).resolves.toBe(AGENT_RESTART_EXIT_CODE);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("stop failure still resolves nonzero and does not schedule a second stop", async () => {
    const latch = createSupervisedRestartLatch();
    const app = { stop: vi.fn(async () => { throw new Error("failed"); }) };
    const pending = waitForShutdownSignal(app, undefined, latch);
    const result = latch.accept(verified);
    if (result.kind !== "accepted") throw new Error("accept failed");
    latch.beginStop(result.operationId);
    await expect(pending).resolves.toBe(AGENT_RESTART_EXIT_CODE);
    latch.beginStop(result.operationId);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });
});
