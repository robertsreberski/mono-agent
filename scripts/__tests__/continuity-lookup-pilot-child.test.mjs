import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
let run, state, realMint, fauxDecorator, realVerify, runner;
const mocks = ["lookup-pilot-state", "lookup-real-capability", "lookup-ipc", "lookup-preparation", "lookup-pilot-entry", "lookup-roles", "lookup-pilot", "lookup-guard", "lookup-pilot-runtime", "dataset", "runner"];
beforeEach(async () => {
  vi.resetModules();
  state = { schema: "continuity-lookup-faux-controller-v1", fauxEndpoint: "http://127.0.0.1:12345/codex/responses", stop: null, cursor: 0, slots: [{terminal: null}] };
  const permit = { close: vi.fn(), stop: vi.fn() }, send = Object.assign(() => {}, { permit });
  realMint = vi.fn(async () => send); realVerify = vi.fn(); fauxDecorator = vi.fn(async () => () => {});
  runner = { productionModules: async () => ({config: {resolveJsonMonoAgentConfig: () => ({})}}), configJson: () => ({}), lookupConfig: () => ({}), pilotDispatchConfig: p => p,
    createJudge: () => null, runProbe: vi.fn(async () => ({status: "completed", score: {pass: true}})) };
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({readPilotPrivate: async () => state, pilotStatePath: p => p, LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1", LOOKUP_FAUX_CONTROLLER: "continuity-lookup-faux-controller-v1"}));
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({createLookupRealSend: realMint, verifyLookupRealAssignment: realVerify}));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", () => ({verifyLookupPilotParent: async () => state, createLookupPilotIPC: async () => permit}));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({assertLookupPilotArm() {}, verifyLookupPreparation() {}, restoreLookupPreparation: async () => ({proof: {}, work: "/fictional/work", manifest: {conversationId: "fictional"}})}));
  vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({assertLookupPilotEntry() {}}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", () => ({ROOT: "/fictional/root", verifyRoleRequest() {}}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", () => ({validateLookupPilotRegistration() {}}));
  vi.doMock("../lib/continuity-lookup-guard.mjs", () => ({createFauxLookupDecorator: fauxDecorator, LOOKUP_GUARD_CONTRACT: {baseUrl: "https://fixture.invalid"}, LOOKUP_GUARD_POLICY_REFUSALS: ["lookup_preparation_invalid"], LOOKUP_PRE_SEND_REFUSALS: [], assertLookupChildSafety() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-runtime.mjs", () => ({lookupPilotWork: () => "/fictional/work", lookupOfflineBoundary: () => ({authPath: "/fictional/absent"}), fauxLookupSafety: () => ({}), assertResolvedLookupSafety() {}}));
  vi.doMock("../lib/continuity-dataset.mjs", () => ({loadTraces: async () => ({traces: [{id: "trace", probes: [{id: "probe"}]}]})}));
  vi.doMock("../lib/continuity-runner.mjs", () => runner);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("test_egress_denied"); }));
  ({runLookupPilotChild: run} = await import("../lib/continuity-lookup-pilot-child.mjs"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const name of mocks) vi.doUnmock(`../lib/continuity-${name}.mjs`); });
it.each([false, true])("production probe child selects only its durable mint (real=%s)", async real => {
  state.schema = real ? "continuity-lookup-controller-v1" : "continuity-lookup-faux-controller-v1";
  const emitter = new EventEmitter(), a = {index: 0, outputRoot: "/fictional/output", epoch: "epoch", slotId: "slot", runId: "run", cacheKey: "assigned",
    authorization: {schema: real ? "continuity-lookup-faux-authorization-v1" : "continuity-lookup-pilot-authorization-v1", credentialPath: "/fictional/credential"},
    plan: {judge: null, reader: {model: "fictional:model", effort: "high"}}, roleRequest: {binding: {arm: "native-lookup"}, common: {lookupSelection: {seed: 1, perGroup: 2}}},
    slot: {code: "R0", suite: "holdout", traceId: "trace", probeId: "probe"}, pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}}};
  const proc = {...process, connected: true, on: emitter.on.bind(emitter), once: emitter.once.bind(emitter), off: emitter.off.bind(emitter),
    disconnect() { proc.connected = false; }, send(message) { queueMicrotask(() => emitter.emit("message", {type: message.type === "ready" ? "go" : "done-ack", epoch: a.epoch, slotId: a.slotId})); }};
  vi.stubGlobal("process", proc);
  await run(a);
  expect(runner.runProbe).toHaveBeenCalledOnce();
  expect(realMint).toHaveBeenCalledTimes(Number(real)); expect(realVerify).toHaveBeenCalledTimes(Number(real));
  expect(fauxDecorator).toHaveBeenCalledTimes(Number(!real));
});

it.each(["https://fixture.invalid/codex/responses", "http://localhost:12345/codex/responses", "http://127.0.0.1:12345/other", "http://127.0.0.1:12345/codex/responses?redirect=1", null])("faux mint rejects non-fixture destination %s before constructing a decorator", async endpoint => {
  state.fauxEndpoint = endpoint;
  const {createLookupFauxSend} = await import("../lib/continuity-lookup-faux-capability.mjs");
  await expect(createLookupFauxSend({outputRoot: "/fictional/output", index: 0, slot: {code: "R0"}, plan: {}, roleRequest: {}, pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}}}, {})).rejects.toThrow("lookup_pilot_faux_required");
  expect(fauxDecorator).not.toHaveBeenCalled(); expect(realMint).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
