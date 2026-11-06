import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
let run, state, realMint, fauxDecorator, realVerify, runner, readState;
const mocks = ["lookup-pilot-state", "lookup-real-capability", "lookup-ipc", "lookup-preparation", "lookup-pilot-entry", "lookup-roles", "lookup-pilot", "lookup-guard", "lookup-pilot-runtime", "dataset", "runner"];
beforeEach(async () => {
  vi.resetModules();
  state = { schema: "continuity-lookup-faux-controller-v1", fauxEndpoint: "http://127.0.0.1:12345/codex/responses", stop: null, cursor: 0, slots: [{terminal: null}] };
  const permit = { close: vi.fn(), stop: vi.fn() }, send = Object.assign(() => {}, { permit });
  realMint = vi.fn(async () => send); realVerify = vi.fn(); fauxDecorator = vi.fn(async () => () => {});
  runner = { productionModules: async () => ({config: {resolveJsonMonoAgentConfig: () => ({})}}), configJson: () => ({}), lookupConfig: () => ({}), pilotDispatchConfig: p => p,
    createJudge: () => null, runProbe: vi.fn(async () => ({status: "completed", score: {pass: true}})) };
  readState = vi.fn(async () => state);
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({readPilotPrivate: readState, pilotStatePath: p => p, LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1", LOOKUP_FAUX_CONTROLLER: "continuity-lookup-faux-controller-v1"}));
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({createLookupRealSend: realMint, verifyLookupRealAssignment: realVerify}));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", () => ({verifyLookupPilotParent: async () => state, createLookupPilotIPC: async () => permit}));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({assertLookupPilotArm() {}, verifyLookupPreparation() {}, restoreLookupPreparation: async () => ({proof: {}, work: "/fictional/work", manifest: {conversationId: "fictional"}})}));
  vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({assertLookupPilotEntry() {}}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", () => ({ROOT: "/fictional/root", verifyRoleRequest() {}}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", () => ({validateLookupPilotRegistration() {}}));
  vi.doMock("../lib/continuity-lookup-guard.mjs", () => ({createFauxLookupDecorator: fauxDecorator, LOOKUP_GUARD_CONTRACT: {baseUrl: "https://fixture.invalid"}, LOOKUP_GUARD_POLICY_REFUSALS: ["lookup_preparation_invalid"], LOOKUP_PRE_SEND_REFUSALS: [], assertLookupChildSafety() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-runtime.mjs", async original => ({...await original(), lookupPilotWork: () => "/fictional/work", lookupOfflineBoundary: () => ({authPath: "/fictional/absent"}), fauxLookupSafety: () => ({}), assertResolvedLookupSafety() {}}));
  vi.doMock("../lib/continuity-dataset.mjs", () => ({loadTraces: async () => ({traces: [{id: "trace", probes: [{id: "probe"}]}]})}));
  vi.doMock("../lib/continuity-runner.mjs", () => runner);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("test_egress_denied"); }));
  ({runLookupPilotChild: run} = await import("../lib/continuity-lookup-pilot-child.mjs"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const name of mocks) vi.doUnmock(`../lib/continuity-${name}.mjs`); });
it.each([[false, false], [true, false], [false, true], [true, true]])("production probe child selects only its durable mint (real=%s, opposite caller flag=%s)", async (real, opposite) => {
  state.schema = real ? "continuity-lookup-controller-v1" : "continuity-lookup-faux-controller-v1";
  const emitter = new EventEmitter(), a = {index: 0, outputRoot: "/fictional/output", epoch: "epoch", slotId: "slot", runId: "run", cacheKey: "assigned",
    authorization: {schema: real !== opposite ? "continuity-lookup-pilot-authorization-v1" : "continuity-lookup-faux-authorization-v1", credentialPath: "/fictional/credential"},
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

it.each([undefined, {}, Object.create({method: "POST"}), {method: "GET"}, {method: "POST", credentials: "include"}, {method: "POST", dispatcher: {}}, {method: "POST", cache: "no-store"}, {method: "POST", redirect: "follow"}])("faux send refuses unsupported init %j without spending its permit", async bad => {
  const now = Date.now(), body = Buffer.from("fictional guarded body");
  state.deadlineAt = now + 60000; state.slots[0] = {terminal: null, startedAt: now, holds: [{consumed: true, permitId: "fictional-permit", payloadDigest: createHash("sha256").update(body).digest("hex")}]};
  const a = {outputRoot: "/fictional/output", index: 0, slot: {code: "R0"}, cacheKey: "assigned", runId: "fictional-run", slotId: "fictional-slot", plan: {}, roleRequest: {},
    pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}, descriptor: {deadlines: {deadlineMs: 60000}}}};
  fetch.mockResolvedValue(new Response("fictional response"));
  const {createLookupFauxSend} = await import("../lib/continuity-lookup-faux-capability.mjs"), send = await createLookupFauxSend(a, {});
  await expect(send("https://fixture.invalid/codex/responses", bad)).rejects.toThrow("lookup_pilot_faux_required"); expect(fetch).not.toHaveBeenCalled();
  await send("https://fixture.invalid/codex/responses", {method: "POST", body, headers: {"session-id": "assigned", "x-client-request-id": "assigned"}, redirect: "error"});
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe(state.fauxEndpoint);
});

it.each(["method", "redirect"])("rejects a mutating enumerable %s accessor after normalization without spending its permit", async key => {
  const body = Buffer.from("fictional guarded body"), now = Date.now();
  state.deadlineAt = now + 60000; state.slots[0] = {terminal: null, startedAt: now, holds: [{consumed: true, permitId: "fictional-permit", payloadDigest: createHash("sha256").update(body).digest("hex")}]};
  const a = {outputRoot: "/fictional/output", index: 0, slot: {code: "R0"}, cacheKey: "assigned", runId: "fictional-run", slotId: "fictional-slot", plan: {}, roleRequest: {},
    pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}, descriptor: {deadlines: {deadlineMs: 60000}}}};
  fetch.mockResolvedValue(new Response("fictional response"));
  const {createLookupFauxSend} = await import("../lib/continuity-lookup-faux-capability.mjs"), send = await createLookupFauxSend(a, {});
  const good = {method: "POST", body, headers: {"session-id": "assigned", "x-client-request-id": "assigned"}, redirect: "error"}, bad = {...good};
  let reads = 0;
  Object.defineProperty(bad, key, {enumerable: true, get: () => ++reads <= (key === "method" ? 1 : 2) ? good[key] : key === "method" ? "PUT" : "follow"});
  await expect(send("https://fixture.invalid/codex/responses", bad)).rejects.toThrow("lookup_pilot_faux_required");
  expect(fetch).not.toHaveBeenCalled(); expect(reads).toBe(key === "method" ? 2 : 3);
  await send("https://fixture.invalid/codex/responses", good);
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1]).toMatchObject({method: "POST", redirect: "error"});
});

it("maps the initial probe-child state read to the preparation refusal", async () => {
  readState.mockRejectedValue(Object.assign(Error("fictional private location"), {code: "lookup_receipt_invalid"}));
  await expect(run({outputRoot: "/fictional/output"})).rejects.toThrow("lookup_preparation_invalid");
  expect(realMint).not.toHaveBeenCalled(); expect(fauxDecorator).not.toHaveBeenCalled();
});

it.each(["Uint8Array", "ArrayBuffer"])("faux transport snapshots %s as fetch would", async kind => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]), expected = Buffer.from(source.subarray(2));
  const body = kind === "Uint8Array" ? source.subarray(2) : source.buffer.slice(2), now = Date.now();
  state.deadlineAt = now + 60000; state.slots[0] = {terminal: null, startedAt: now, holds: [{consumed: true, permitId: "fictional-permit", payloadDigest: createHash("sha256").update(expected).digest("hex")}]};
  const a = {outputRoot: "/fictional/output", index: 0, slot: {code: "R0"}, cacheKey: "assigned", runId: "fictional-run", slotId: "fictional-slot", plan: {}, roleRequest: {},
    pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}, descriptor: {deadlines: {deadlineMs: 60000}}}};
  fetch.mockResolvedValue(new Response("fictional response"));
  const {createLookupFauxSend} = await import("../lib/continuity-lookup-faux-capability.mjs"), send = await createLookupFauxSend(a, {});
  const pending = send("https://fixture.invalid/codex/responses", {method: "POST", body, headers: {"session-id": "assigned", "x-client-request-id": "assigned"}}); source.fill(0);
  await pending; expect(fetch).toHaveBeenCalledOnce(); expect(Buffer.from(fetch.mock.calls[0][1].body)).toEqual(expected);
});

it.each([new DataView(new ArrayBuffer(4)), new Uint16Array(2), new Int8Array(2), new Uint8ClampedArray(2), new FormData(), new URLSearchParams(), new Blob(["fictional"]), null, undefined])("refuses unsupported faux transport body %# before native fetch", async body => {
  const {createLookupFauxSend} = await import("../lib/continuity-lookup-faux-capability.mjs");
  const a = {index: 0, outputRoot: "/fictional/output", pilot: {registration: {codes: {R0: {path: "/fictional/root"}}}}, slot: {code: "R0"}, plan: {}, roleRequest: {}};
  const send = await createLookupFauxSend(a, {});
  await expect(send("https://fixture.invalid/codex/responses", {method: "POST", body})).rejects.toMatchObject({code: "lookup_body_type_forbidden"});
  expect(fetch).not.toHaveBeenCalled();
});
