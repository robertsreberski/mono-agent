import { describe, expect, it } from "vitest";
import { createProviderUsageHistoryQueue } from "../providers/provider-usage-history-queue.js";

describe("passive history queue", () => {
  it("defers and serializes operations, bounds stalled work and closes late write admission", async () => {
    const queue = createProviderUsageHistoryQueue({ timeoutMs: 30, closeTimeoutMs: 10, maxPending: 2 });
    let active = 0, maximum = 0;
    const order: string[] = [];
    const first = queue.enqueue(async signal => {
      active++; maximum = Math.max(maximum, active); order.push("first");
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { active--; resolve(); }, { once: true }));
    });
    const second = queue.enqueue(() => { active++; maximum = Math.max(maximum, active); order.push("second"); active--; });
    const firstResult = first.catch(() => undefined), secondResult = second.catch(() => undefined);
    await expect(queue.enqueue(() => undefined)).rejects.toThrow("unavailable");
    expect(order).toEqual([]);
    await Promise.all([firstResult, secondResult]);
    expect(maximum).toBe(1);
    await queue.close();
    await expect(queue.enqueue(() => undefined)).rejects.toThrow("unavailable");
  });
  it("does not wait for an ignored operation promise during shutdown", async () => {
    const queue = createProviderUsageHistoryQueue({ timeoutMs: 1000, closeTimeoutMs: 10 });
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const pending = queue.enqueue(() => { entered(); return new Promise<void>(() => undefined); });
    const result = pending.catch(() => undefined);
    await began; await queue.close(); await result;
  });
});
