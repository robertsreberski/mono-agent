import { expect, it, vi } from "vitest";
import { createRouterRuntime } from "../../ai/runtime/router.js";

// Prepared native dispatch is primary-only: a retryable or auth failure is
// returned once, never detached or continued on a configured backup.
const primary = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" }, backup = { provider: "anthropic", model: "claude-opus-4-7", reference: "anthropic:claude-opus-4-7" };
const empty = Object.freeze({ version: 1, armed: true, toolAdmitted: false, liveInputTaken: false });
const binding = { sessionId: "fictional-owned", providerSessionId: "fictional-owned", providerAttributionSessionId: "fictional-owned",
  sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: "fictional-owned", baseRevision: 1,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "fictional-input" } } };

it.each(["provider_unavailable", "provider_auth"])("returns an untouched %s prepared failure without detaching or starting a backup", async (failureKind) => {
  const order = [], close = vi.fn(() => order.push("close")), cleanup = vi.fn(() => order.push("cleanup")), backupRun = vi.fn(), ack = vi.fn(), loader = vi.fn(), opened = vi.fn();
  const run = vi.fn(async () => ({ text: null, error: failureKind === "provider_auth" ? "Invalid API key" : "Connection error.", failureKind, events: [], dispatchProgress: empty }));
  const router = createRouterRuntime({ chain: [{ model: primary, attempts: 3 }, { model: backup }], sessionTurnReconciliation: "v1",
    resolveAttempt: vi.fn(({ attemptIndex }) => attemptIndex ? { runtime: { configureTools() {}, run: backupRun } }
      : { cleanup, runtime: { configureTools() {}, run: vi.fn(), nativePreparedDispatch: "v1", prepareNativeDispatch: async () => ({ snapshot: {}, run, close }) } }) });
  const liveInput = { async *[Symbol.asyncIterator]() { opened(); yield { id: "fictional-live", body: "Fictional steer" }; } };
  const lease = await router.prepareNativeDispatch("Fictional instructions", { model: primary, messages: [{ role: "user", content: "Fictional input" }],
    liveInput, onSessionTurnDetached: ack, detachedContext: loader });
  const result = await lease.run(binding);
  expect(result.failureKind).toBe(failureKind);
  expect(result.failoverHistory).toEqual([expect.objectContaining({ model: primary, failureKind })]);
  expect(run).toHaveBeenCalledOnce(); expect(backupRun).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled();
  expect(loader).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled(); expect(order).toEqual(["close", "cleanup"]);
  await expect(lease.run(binding)).rejects.toThrow("no longer available");
  await lease.close(); expect(cleanup).toHaveBeenCalledOnce();
});

it("still releases route resources when a consumed prepared lease's close rejects", async () => {
  const cleanup = vi.fn(), close = vi.fn(async () => { throw new Error("Fictional close failure"); });
  const run = vi.fn(async () => ({ text: "Fictional prepared answer", events: [] }));
  const router = createRouterRuntime({ chain: [{ model: primary }, { model: backup }], sessionTurnReconciliation: "v1",
    resolveAttempt: vi.fn(() => ({ cleanup, runtime: { configureTools() {}, run: vi.fn(), nativePreparedDispatch: "v1", prepareNativeDispatch: async () => ({ snapshot: {}, run, close }) } })) });
  const lease = await router.prepareNativeDispatch("Fictional instructions", { model: primary, messages: [{ role: "user", content: "Fictional input" }] });
  await expect(lease.run(binding)).rejects.toThrow("Fictional close failure");
  expect(run).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
  await expect(lease.run(binding)).rejects.toThrow("no longer available");
});
