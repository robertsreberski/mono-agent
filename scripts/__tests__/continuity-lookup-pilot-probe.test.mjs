import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Socket } from "node:net";
let runner, mint, fauxMint, restore, send, run, a, state;
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
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({ createLookupRealSend: mint, isRealLookupSend: () => false, realLookupSendForGuard: () => false }));
  state = { schema: "continuity-lookup-controller-v1" };
  fauxMint = vi.fn(async () => send);
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({ readPilotPrivate: async () => state, pilotStatePath: r => r,
    LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1", LOOKUP_FAUX_CONTROLLER: "continuity-lookup-faux-controller-v1" }));
  vi.doMock("../lib/continuity-lookup-faux-capability.mjs", () => ({ createLookupFauxSend: fauxMint }));
  restore = vi.fn(async () => ({ proof: {}, work: "/fictional/checkpoint", manifest: { conversationId: "fictional-conversation", continuity: null } }));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({ assertLookupPilotArm: arm => { if (arm.restart) throw Object.assign(Error("lookup_pilot_boundary_required"), { code: "lookup_pilot_boundary_required" }); },
    restoreLookupPreparation: restore }));
  ({ runLookupConfiguredProbe: run } = await import("../lib/continuity-lookup-pilot-probe.mjs"));
  a = { outputRoot: "/fictional/output", slotId: "fictional-slot", plan: { judge: null, reader: { model: "openai-codex:gpt-6.1-sol", effort: "high" } },
    authorization: { credentialPath: "/fictional/credential" }, slot: { code: "R0", suite: "holdout", traceId: "trace", probeId: "probe" },
    pilot: { registration: { codes: { R0: { path: "/fictional/r0" } } } }, roleRequest: { binding: { arm: "native-lookup" }, common: { lookupSelection: { seed: 1, perGroup: 2 } } } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of ["runner", "dataset", "lookup-real-capability", "lookup-preparation", "lookup-pilot-state", "lookup-faux-capability"]) vi.doUnmock(`../lib/continuity-${path}.mjs`); });
it("restores before mint and threads the same context through judge and probe without building a checkpoint", async () => {
  expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
  for (const name of ["createJudge", "runProbe"]) expect(mint.mock.invocationCallOrder[0]).toBeLessThan(runner[name].mock.invocationCallOrder[0]);
  expect(restore.mock.invocationCallOrder[0]).toBeLessThan(mint.mock.invocationCallOrder[0]);
  expect(fauxMint).not.toHaveBeenCalled();
  const pilot = runner.runProbe.mock.calls[0][0].pilot;
  expect(pilot).toMatchObject({ routeKind: "real", send }); expect(runner.createJudge.mock.calls[0][0].pilot).toBe(pilot); expect(runner.runProbe.mock.calls[0][0].pilot).toBe(pilot);
  expect(runner.buildCheckpoint).not.toHaveBeenCalled(); expect(send.permit.close).toHaveBeenCalledTimes(1);
});
it("does not enter any helper after mint refusal", async () => {
  mint.mockRejectedValue(Object.assign(Error("lookup_pilot_capability_invalid"), { code: "lookup_pilot_capability_invalid" }));
  await expect(run(a)).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(runner.createJudge).not.toHaveBeenCalled(); expect(runner.buildCheckpoint).not.toHaveBeenCalled(); expect(runner.runProbe).not.toHaveBeenCalled();
});
it("refuses an unserved arm before restoration or mint", async () => {
  a.roleRequest.binding.arm = "restart-switch-compact";
  await expect(run(a)).rejects.toThrow("lookup_pilot_boundary_required"); expect(mint).not.toHaveBeenCalled(); expect(runner.buildCheckpoint).not.toHaveBeenCalled();
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

it.each(["pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified"])("preserves non-provider terminal %s", async terminal => {
  runner.runProbe.mockResolvedValue(terminal === "pilot_empty_final_output" ? { status: "failed", failure: terminal } : { status: terminal });
  expect(await run(a)).toEqual({ terminal, score: null }); expect(send.permit.stop).not.toHaveBeenCalled(); expect(send.permit.close).toHaveBeenCalledTimes(1);
});

it("selects faux mint from durable schema even when assignment claims real authorization", async () => {
  state.schema = "continuity-lookup-faux-controller-v1";
  a.authorization.schema = "continuity-lookup-pilot-authorization-v1";
  expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
  expect(mint).not.toHaveBeenCalled(); expect(fauxMint).toHaveBeenCalledOnce();
  expect(runner.runProbe.mock.calls[0][0].pilot.routeKind).toBe("faux");
});
it("refuses preflight state before restoration or either mint", async () => {
  state.schema = "lookup-preflight-controller-v1";
  await expect(run(a)).rejects.toThrow("lookup_preparation_invalid");
  expect(restore).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled(); expect(fauxMint).not.toHaveBeenCalled();
});
