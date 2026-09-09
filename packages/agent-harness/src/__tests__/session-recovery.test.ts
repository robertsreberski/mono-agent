import { afterEach, expect, it, vi } from "vitest";
import { terminalFailureCanRecover, waitForTerminalSettlement } from "../harness/session-recovery.js";

afterEach(() => vi.useRealTimers());
it("permits provider settlement at 999 ms and expires the cancellation budget at 1000 ms", async () => {
  vi.useFakeTimers();
  let settle!: () => void;
  let settled = false;
  const wait = waitForTerminalSettlement(new Promise<void>((resolve) => { settle = resolve; }), Date.now() + 1000);
  void wait.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).toBe(false);
  settle(); await expect(wait).resolves.toBe(true);
  const expired = waitForTerminalSettlement(new Promise<void>(() => {}), Date.now() + 1000);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(expired).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["context_limit", "provider_auth", "usage_limit", "invalid_result", "empty_response", "session_busy", "session_not_found"])("rejects %s even when cancellation wins terminal ownership", (failureKind) => {
  expect(terminalFailureCanRecover({ failureKind }, "cancelled")).toBe(false);
});
it("allows single-primary exhausted transport failure but rejects malformed or additional attempts", () => {
  expect(terminalFailureCanRecover({ failureKind: "provider_unavailable_exhausted", failoverHistory: [{ failureKind: "provider_unavailable", retryIndex: 0 }] }, "failed")).toBe(true);
  for (const failoverHistory of [[null], "unknown", [{ failureKind: "provider_unavailable", retryIndex: 1 }]]) {
    expect(terminalFailureCanRecover({ failureKind: "provider_unavailable_exhausted", failoverHistory }, "failed")).toBe(false);
  }
});
