import { expect, it, vi } from "vitest";
import { createRouterRuntime } from "../../ai/runtime/router.js";

const primary = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" }, backup = { provider: "anthropic", model: "claude-opus-4-7", reference: "anthropic:claude-opus-4-7" };
const empty = Object.freeze({ version: 1, armed: true, assistantOutput: false, toolAdmitted: false, liveInputTaken: false });
const failure = (extra = {}) => ({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], dispatchProgress: empty, ...extra });
const binding = { sessionId: "fictional-owned", providerSessionId: "fictional-owned", providerAttributionSessionId: "fictional-owned",
  sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: "fictional-owned", baseRevision: 1,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "fictional-input" } } };
function fixture(result = failure(), ack = vi.fn(), third = false) {
  let primaryOptions;
  const order = [], produce = vi.fn(), close = vi.fn(() => order.push("close")), cleanup = vi.fn(() => order.push("cleanup"));
  const run = vi.fn(() => result), backupRun = vi.fn(() => ({ text: "Fictional backup answer", providerSessionId: "fictional-leak", providerSessionRecovery: { secret: "fictional" }, events: [] }));
  const router = createRouterRuntime({ chain: [{ model: primary, attempts: 3 }, { model: backup }, ...(third ? [{ model: { provider: "google", model: "fictional-third", reference: "google:fictional-third" } }] : [])], sessionTurnReconciliation: "v1",
    resolveAttempt: vi.fn(({ attemptIndex }) => attemptIndex ? { runtime: { configureTools() {}, run: backupRun }, options: { customProvider: { baseUrl: "https://fictional-backup.invalid" } } }
      : { cleanup, options: { customProvider: { baseUrl: "https://fictional-primary.invalid" }, piResolvedModel: { id: "private-primary" } },
        runtime: { configureTools() {}, run: vi.fn(), nativePreparedDispatch: "v1", prepareNativeDispatch: async (_prompt, options) => {
          primaryOptions = options; return { snapshot: {}, run, close, produceHandoffSummary: produce }; } } }) });
  return { router, run, backupRun, ack, close, cleanup, produce, order, get primaryOptions() { return primaryOptions; } };
}
it("continues a single-use primary lease from captured canonical messages only after durable acknowledgement", async () => {
  const f = fixture(), messages = [{ role: "user", content: "Fictional earlier fact" }, { role: "assistant", content: "Fictional prior answer" }, { role: "user", content: "Fictional current input" }];
  const lease = await f.router.prepareNativeDispatch("Fictional instructions", { model: primary, messages, onSessionTurnDetached: async (attempt) => {
    expect(f.order).toEqual(["close", "cleanup"]); expect(attempt.descriptor).toEqual(binding.sessionTurn); await f.ack(attempt); },
    customProvider: { baseUrl: "https://fictional-captured.invalid" }, detachedContext: () => { throw new Error("Prepared canonical floor must not reload"); } });
  messages[0].content = "Mutated after preparation";
  const result = await lease.run(binding);
  expect(result.text).toBe("Fictional backup answer"); expect(result.providerSessionId).toBeUndefined(); expect(result.providerSessionRecovery).toBeUndefined();
  expect(f.run).toHaveBeenCalledOnce(); expect(f.ack).toHaveBeenCalledOnce(); expect(f.backupRun).toHaveBeenCalledOnce();
  const options = f.backupRun.mock.calls[0][1]; expect(options.messages[0].content).toBe("Fictional earlier fact"); expect(options.messages).toHaveLength(3);
  expect(options.customProvider.baseUrl).toBe("https://fictional-backup.invalid"); expect(options.piResolvedModel).toBeUndefined();
  for (const key of ["sessionId", "providerSessionId", "sessionTurn", "nativeSessionProjection", "detachedContext", "onSessionTurnDetached"]) expect(options[key]).toBeUndefined();
  expect(options.providerAttributionSessionId).not.toBe(binding.providerAttributionSessionId); expect(result.failoverHistory).toHaveLength(1);
  await expect(lease.run(binding)).rejects.toThrow("no longer available"); await lease.close(); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.produce).not.toHaveBeenCalled();
});
it.each([
  failure({ dispatchProgress: undefined }), failure({ dispatchProgress: { version: 1, armed: true } }), failure({ dispatchProgress: { ...empty, armed: false } }),
  ...["assistantOutput", "toolAdmitted", "liveInputTaken"].map((key) => failure({ dispatchProgress: { ...empty, [key]: true } })),
  failure({ cancelled: true }), failure({ failureKind: "safety_native_suspended" }), failure({ error: "Invalid request", failureKind: "provider_request_invalid" }),
])("fails closed before detach for disallowed primary evidence %#", async (result) => {
  const f = fixture(result), lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  await lease.run(binding); expect(f.ack).not.toHaveBeenCalled(); expect(f.backupRun).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledOnce();
});
it("does not reopen a prepared dispatch after a thrown error, even with empty attached evidence", async () => {
  const f = fixture(); f.run.mockRejectedValue(Object.assign(new Error("Connection error."), { dispatchProgress: empty }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  await expect(lease.run(binding)).rejects.toThrow("Connection error."); expect(f.backupRun).not.toHaveBeenCalled(); expect(f.ack).not.toHaveBeenCalled();
});
it.each(["reject", "late-tool", "abort"])("does not dispatch after %s during acknowledgement", async (mode) => {
  const f = fixture(failure({ providerSessionId: "fictional-owned", providerSessionRecovery: { fictional: true } })), abort = new AbortController();
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], abortSignal: abort.signal, onSessionTurnDetached: async () => {
    if (mode === "reject") throw new Error("Fictional acknowledgement failure");
    if (mode === "abort") abort.abort();
    if (mode === "late-tool") f.primaryOptions.onEvent({ type: "tool_execution_start" });
  } });
  const result = await lease.run(binding); expect(f.backupRun).not.toHaveBeenCalled();
  if (mode === "reject") expect(result.failureKind).toBe("safety_session_turn_reconciliation");
  expect(result.providerSessionId).toBeUndefined();
});
it("never dispatches without the bound host acknowledgement", async () => {
  const f = fixture(), lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [] });
  expect((await lease.run(binding)).failureKind).toBe("safety_session_turn_reconciliation"); expect(f.backupRun).not.toHaveBeenCalled();
});
it("keeps producers primary-only before run, without reserving a backup", async () => {
  const f = fixture(), lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  await lease.produceHandoffSummary({ fictional: true }); expect(f.produce).toHaveBeenCalledOnce(); expect(f.backupRun).not.toHaveBeenCalled(); await lease.close();
});

it("transfers only never-yielded live input to a fresh backup consumer", async () => {
  const f = fixture(), consumed = vi.fn(), opened = vi.fn();
  const liveInput = { async *[Symbol.asyncIterator]() { opened(); yield { id: "fictional-live", body: "Fictional steer", consume: consumed }; } };
  f.backupRun.mockImplementation(async (_prompt, options) => {
    const ids = []; for await (const input of options.liveInput) { ids.push(input.id); input.consume(); }
    return { text: "Fictional backup answer", events: [], consumedInputIds: ids };
  });
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], liveInput, onSessionTurnDetached: f.ack });
  const result = await lease.run(binding); expect(result.consumedInputIds).toEqual(["fictional-live"]);
  expect(opened).toHaveBeenCalledOnce(); expect(consumed).toHaveBeenCalledOnce(); expect(f.run).toHaveBeenCalledOnce();
});

it.each(["assistantOutput", "toolAdmitted", "liveInputTaken", "missing"])("stops further prepared backups after %s on a backup", async (flag) => {
  const f = fixture(failure(), vi.fn(), true);
  f.backupRun.mockReturnValue(failure({ providerSessionId: "fictional-backup-leak", dispatchProgress: flag === "missing" ? undefined : { ...empty, [flag]: true } }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  const result = await lease.run(binding); expect(f.backupRun).toHaveBeenCalledOnce(); expect(result.providerSessionId).toBeUndefined();
});
it("scrubs exhausted prepared backups and their attribution identities", async () => {
  const f = fixture(failure(), vi.fn(), true);
  f.backupRun.mockReturnValue(failure({ providerSessionId: "fictional-backup-leak", providerSessionRecovery: { fictional: true } }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  const result = await lease.run(binding); expect(f.backupRun).toHaveBeenCalledTimes(2); expect(result.failureKind).toBe("provider_unavailable_exhausted");
  expect(result.providerSessionId).toBeUndefined(); expect(result.providerSessionRecovery).toBeUndefined();
  expect(f.backupRun.mock.calls[0][1].providerAttributionSessionId).not.toBe(f.backupRun.mock.calls[1][1].providerAttributionSessionId);
});

it.each(["provider_auth", "provider_unavailable"])("continues after certified provider auth failure (classified as %s)", async (failureKind) => {
  const f = fixture(failure({ failureKind, error: "Invalid API key" }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  const result = await lease.run(binding);
  expect(result.text).toBe("Fictional backup answer"); expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
  expect(f.run).toHaveBeenCalledOnce(); expect(f.ack).toHaveBeenCalledOnce(); expect(f.backupRun).toHaveBeenCalledOnce();
  expect(result.providerSessionId).toBeUndefined(); expect(result.providerSessionRecovery).toBeUndefined();
});
it.each([undefined, { ...empty, armed: false }, ...["assistantOutput", "toolAdmitted", "liveInputTaken"].map((key) => ({ ...empty, [key]: true }))])("auth failure still requires complete no-progress certification %#", async (dispatchProgress) => {
  const f = fixture(failure({ failureKind: "provider_auth", error: "Invalid API key", dispatchProgress }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  await lease.run(binding); expect(f.run).toHaveBeenCalledOnce(); expect(f.ack).not.toHaveBeenCalled(); expect(f.backupRun).not.toHaveBeenCalled();
});

it("does not detach a cancelled provider-auth failure", async () => {
  const f = fixture(failure({ failureKind: "provider_auth", error: "Invalid API key", cancelled: true }));
  const lease = await f.router.prepareNativeDispatch("sys", { model: primary, messages: [], onSessionTurnDetached: f.ack });
  await lease.run(binding); expect(f.ack).not.toHaveBeenCalled(); expect(f.backupRun).not.toHaveBeenCalled();
});
