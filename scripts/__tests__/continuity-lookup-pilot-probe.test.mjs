import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Socket } from "node:net";
let runner, mint, send, run, a;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("test_egress_denied"); });
  vi.stubGlobal("fetch", () => { throw Error("test_egress_denied"); });
  const config = { fictional: true }, trace = { id: "trace", probes: [{ id: "probe" }] };
  runner = { productionModules: vi.fn(async () => ({ config: { resolveJsonMonoAgentConfig: () => config } })), configJson: () => ({}), lookupConfig: () => ({}), pilotDispatchConfig: p => p,
    buildCheckpoint: vi.fn(async () => ({ work: "/fictional/checkpoint", snapshot: "/fictional/snapshot", record: { conversationId: "fictional-conversation" } })),
    createJudge: vi.fn(() => null), runProbe: vi.fn(async () => ({ status: "completed", score: { pass: true } })) };
  send = Object.assign(() => {}, { permit: { close: vi.fn(), stop: vi.fn(async () => {}) } }); mint = vi.fn(async () => send);
  vi.doMock("../lib/continuity-runner.mjs", () => runner);
  vi.doMock("../lib/continuity-dataset.mjs", () => ({ loadTraces: vi.fn(async () => ({ traces: [trace] })) }));
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({ createLookupRealSend: mint, realLookupSendForGuard: () => false }));
  ({ runLookupConfiguredProbe: run } = await import("../lib/continuity-lookup-pilot-probe.mjs"));
  a = { outputRoot: "/fictional/output", slotId: "fictional-slot", plan: { reader: { model: "openai-codex:gpt-6.1-sol", effort: "high" } },
    authorization: { credentialPath: "/fictional/credential" }, slot: { code: "R0", suite: "holdout", traceId: "trace", probeId: "probe" },
    pilot: { registration: { codes: { R0: { path: "/fictional/r0" } } } }, roleRequest: { binding: { arm: "native-lookup" }, common: { lookupSelection: { seed: 1, perGroup: 2 } } } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of ["runner", "dataset", "lookup-real-capability"]) vi.doUnmock(`../lib/continuity-${path}.mjs`); });
it("mints before helper runtime work and threads the same pilot context through checkpoint, judge and probe", async () => {
  expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
  for (const name of ["createJudge", "buildCheckpoint", "runProbe"]) expect(mint.mock.invocationCallOrder[0]).toBeLessThan(runner[name].mock.invocationCallOrder[0]);
  const pilot = runner.buildCheckpoint.mock.calls[0][0].pilot;
  expect(pilot).toMatchObject({ routeKind: "real", send }); expect(runner.createJudge.mock.calls[0][0].pilot).toBe(pilot); expect(runner.runProbe.mock.calls[0][0].pilot).toBe(pilot);
  expect(runner.buildCheckpoint.mock.calls[0][0].mode).toBe("offline"); expect(send.permit.close).toHaveBeenCalledTimes(1);
});
it("does not enter any helper after mint refusal", async () => {
  mint.mockRejectedValue(Object.assign(Error("lookup_pilot_capability_invalid"), { code: "lookup_pilot_capability_invalid" }));
  await expect(run(a)).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(runner.createJudge).not.toHaveBeenCalled(); expect(runner.buildCheckpoint).not.toHaveBeenCalled(); expect(runner.runProbe).not.toHaveBeenCalled();
});
it("closes the IPC client after a failed offline checkpoint", async () => {
  runner.buildCheckpoint.mockRejectedValue(Error("fictional_checkpoint_failure")); await expect(run(a)).rejects.toThrow("fictional_checkpoint_failure"); expect(send.permit.close).toHaveBeenCalledTimes(1);
});
it("stops a policy-failed trial instead of publishing it as generic loss", async () => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: "lookup_payload_repeated" });
  expect(await run(a)).toEqual({ terminal: "refused_pre_send", score: null, refusalCode: "lookup_payload_repeated" });
  expect(send.permit.stop).toHaveBeenCalledExactlyOnceWith("lookup_payload_repeated"); expect(send.permit.close).toHaveBeenCalledTimes(1);
});

it.each(["not_admitted_input_envelope", "lookup_request_limit", "not_admitted_cap", "lookup_stopped", "lookup_slot_terminal"])("preserves SDK capacity refusal %s without a policy stop", async code => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: code });
  expect(await run(a)).toEqual({ terminal: "refused_pre_send", score: null, refusalCode: code }); expect(send.permit.stop).not.toHaveBeenCalled();
});
it("does not classify SDK account mismatch as provider loss", async () => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: "lookup_account_mismatch" });
  expect(await run(a)).toEqual({ terminal: "integrity_stop", score: null });
});
