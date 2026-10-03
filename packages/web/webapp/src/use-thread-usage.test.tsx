import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { notifyThreadUsageChanged } from "./thread-usage-events";
import { useThreadUsage } from "./use-thread-usage";
import { conversationCacheHitPercent } from "./usage";

const response = { total: { costUsd: 2 }, byModel: [{ model: "atlas/standard", costUsd: 2 }], computedAt: "2026-01-01T00:00:00.000Z" };
afterEach(() => vi.restoreAllMocks());

describe("useThreadUsage", () => {
  it("reads on open, reuses last good on reopen and refetches on settlement", async () => {
    const read = vi.spyOn(api, "threadUsage").mockResolvedValue(response);
    const { result, rerender } = renderHook(({ open, running }) => useThreadUsage("fresh-thread-one", open, running), {
      initialProps: { open: false, running: false },
    });
    expect(read).not.toHaveBeenCalled();
    rerender({ open: true, running: true });
    await waitFor(() => expect(result.current.usage?.total.costUsd).toBe(2));
    expect(read).toHaveBeenCalledTimes(1);
    act(() => notifyThreadUsageChanged("fresh-thread-one"));
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ open: true, running: false });
    expect(read).toHaveBeenCalledTimes(1); // settlement is debounced
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    rerender({ open: true, running: true });
    expect(read).toHaveBeenCalledTimes(2); // starting a new turn never reads
    rerender({ open: true, running: false });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    act(() => { notifyThreadUsageChanged("fresh-thread-one"); notifyThreadUsageChanged("fresh-thread-one"); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    rerender({ open: false, running: false });
    rerender({ open: true, running: false });
    expect(result.current.usage).toEqual(response);
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(5));
  });
  it("falls back to the loaded window after endpoint failure and keeps a cursor lower bound", async () => {
    vi.spyOn(api, "threadUsage").mockRejectedValue(new Error("offline"));
    const detail = { messages: [{ role: "assistant", parts: [{ type: "telemetry", event: "usage_update", data: {
      cumulativeUsd: 0, tokens: { input: 2, output: 1, cacheRead: 8 },
    } }] }], messagesNextCursor: "older" } as unknown as Parameters<typeof useThreadUsage>[3];
    const { result, rerender } = renderHook(({ current }) => useThreadUsage("fresh-thread-two", true, false, current),
      { initialProps: { current: detail } });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.usage?.total).toMatchObject({ costUsd: 0, costPartial: true, tokensPartial: true });
    expect(conversationCacheHitPercent(result.current.usage?.total)).toBe("80%");
    const next = { ...detail!, messages: [{ role: "assistant", parts: [{ type: "telemetry", event: "usage_update",
      data: { cumulativeUsd: 1, tokens: { input: 5, output: 2 } } }] }] } as unknown as typeof detail;
    rerender({ current: next });
    await waitFor(() => expect(result.current.usage?.total.costUsd).toBe(1));
    expect(result.current.loading).toBe(false);
  });
});
