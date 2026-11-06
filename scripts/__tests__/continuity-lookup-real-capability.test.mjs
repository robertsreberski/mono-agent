import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { digest } from "../lib/continuity-dataset.mjs";

let cap, a, safety, state, permit, network, graph, binding, schedule;
const sha = value => createHash("sha256").update(value).digest("hex");
const ACCOUNT = "fictional-account", SALT = "fictional-salt";
const accountHash = account => sha(`mono-agent/lookup-pilot/account-v1\0${SALT}\0${account}`);
const BODY = Buffer.from("fictional-body");
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const request = (account = ACCOUNT) => ({ method: "POST", body: BODY, headers: { "chatgpt-account-id": account, "session-id": "assigned", "x-client-request-id": "assigned" } });
const hold = id => ({ permitId: id, consumed: true, revoked: false, settlement: null, payloadDigest: sha(BODY) });
const paths = ["roles", "pilot", "authorization", "pilot-state", "ipc", "pilot-entry", "preparation"].map(n => `../lib/continuity-lookup-${n}.mjs`);
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("test_egress_denied"); });
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("test_egress_denied"); } });
  network = vi.fn(async () => new Response("fictional")); vi.stubGlobal("fetch", network);
  const proc = { env: {}, pid: 41, ppid: 42, connected: true };
  graph = { proc, raw: "original", markers: true, checkout: true, commitment: accountHash(ACCOUNT) };
  vi.doMock("node:process", () => ({ default: proc }));
  binding = { id: "native", code: "R0", arm: "native-lookup" };
  const slot = { slotId: "slot-fictional", roleId: "native", code: "R0", suite: "holdout" }; schedule = [slot];
  const common = { corpora: [{ suite: "holdout" }] }, build = { fictional: true };
  a = { pilot: { registration: { roles: [binding], common, codes: { R0: { path: "/fictional/r0", build } } }, descriptor: { capUSD: 100, deadlines: { deadlineMs: 60000 } } },
    authorization: { schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: "/fictional/authorization", credentialPath: "/fictional/credential", registrationSha256: "raw-registration" },
    outputRoot: "/fictional/output", epoch: "epoch-fictional", runId: "run-fictional", index: 0, cacheKey: "assigned", slotId: slot.slotId, slot,
    plan: { judge: null }, roleRequest: { binding, common, build } };
  graph.approvedPilot = structuredClone(a.pilot);
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({ verifyLookupPreparation: vi.fn(async () => { if (graph.preparationChanged) throw Object.assign(Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); }) }));
  vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({ assertLookupPilotEntry: () => { if (graph.closed) throw Object.assign(Error("lookup_pilot_real_route_unavailable"), { code: "lookup_pilot_real_route_unavailable" }); } }));
  state = { schema: "continuity-lookup-controller-v1", recovery: false, cursor: 0, stop: null, binding: digest(a.pilot), runId: a.runId, epoch: a.epoch,
    deadlineAt: Date.now() + 60000, controller: { pid: 42, startIdentity: "parent" }, cacheKeysUnique: true, schedule,
    slots: [{ terminal: null, slotId: slot.slotId, cacheKey: "assigned", worker: { pid: 41, startIdentity: "child" }, ready: true, startedAt: Date.now(), holds: [hold("one")] }] };
  safety = { plan: a.plan, arm: { id: binding.arm, midCheckpoint: null, ledgerUpkeep: false }, config: {
    runtime: { model: { provider: "openai-codex", model: "gpt-6.1-sol" }, compaction: { enabled: false }, session: {}, retry: { primaryAttempts: 1 } },
    providers: { piNative: { transport: "sse", piMaxRetries: 0 } }, tools: { allowedTools: [] } } };
  permit = Object.freeze({ brand: "lookup-controller-v1", testOnly: false, pilot: true, admit: vi.fn(), consume: vi.fn(), settle: vi.fn(), stop: vi.fn(async () => {}), close: vi.fn() });
  const handle = Object.freeze({});
  vi.doMock("../lib/continuity-lookup-roles.mjs", () => ({ ROOT: "/fictional/r0", roleBinding: () => binding,
    verifyRoleRequest: vi.fn(async () => { if (!graph.checkout) throw Error("fictional_changed_checkout"); }) }));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", () => ({ validateLookupPilotRegistration: vi.fn(async () => {}) }));
  vi.doMock("../lib/continuity-lookup-authorization.mjs", () => ({ LOOKUP_AUTHORIZATION_SCHEMA: "continuity-lookup-pilot-authorization-v1",
    validateLookupAuthorization: vi.fn(async args => {
      if (args.authorizationPath !== "/fictional/authorization" || args.registrationSha256 !== "raw-registration") throw Error("fictional_binding_changed"); return handle;
    }),
    verifyLookupConsumption: vi.fn(async (received, identity) => {
      if (received !== handle || !graph.markers || graph.raw !== "original" || identity.controllerEpoch !== "epoch-fictional") throw Error("fictional_marker_mismatch");
    }),
    lookupAuthorizationBindsPilot: (received, pilot) => received === handle && digest(pilot) === digest(graph.approvedPilot),
    lookupAuthorizationMatchesAccount: (received, account) => received === handle && typeof account === "string" && accountHash(account) === graph.commitment,
  }));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({ LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1",
    readPilotPrivate: vi.fn(async () => state), pilotStatePath: root => `${root}/state`, samePilot: (x, y) => digest(x) === digest(y), lookupPilotSchedule: () => schedule }));
  vi.doMock("../lib/continuity-process-identity.mjs", () => ({ lookupProcessStartIdentity: pid => pid === 42 ? "parent" : "child" }));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", () => ({ createLookupPilotIPC: vi.fn(async () => permit) }));
  cap = await import("../lib/continuity-lookup-real-capability.mjs");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of paths) vi.doUnmock(path); vi.doUnmock("node:process"); vi.doUnmock("node:fs/promises"); vi.doUnmock("../lib/continuity-process-identity.mjs"); });

it.each([
  ["CI present", () => { graph.proc.env.CI = ""; }], ["debug present", () => { graph.proc.env.CONTINUITY_DEBUG = ""; }],
  ["faux authorization", () => { a.authorization.schema = "continuity-lookup-faux-authorization-v1"; }],
  ["faux controller", () => { state.schema = "continuity-lookup-faux-controller-v1"; }],
  ["fake parent", () => { state.controller.pid++; }], ["swapped parent start", () => { state.controller.startIdentity = "other"; }],
  ["preparation changed", () => { graph.preparationChanged = true; }],
  ["preflight schema", () => { state.schema = "lookup-preflight-controller-v1"; }],
  ["preparation PID has no probe assignment", () => { state.slots[0].worker = null; }],
  ["wrong child", () => { state.slots[0].worker.pid++; }], ["wrong child start", () => { state.slots[0].worker.startIdentity = "other"; }],
  ["missing epoch", () => { delete a.epoch; }], ["swapped epoch", () => { a.epoch = "other"; }],
  ["missing marker", () => { graph.markers = false; }], ["raw artifact changed", () => { graph.raw = "changed"; }],
  ["registration bytes changed", () => { a.authorization.registrationSha256 = "changed"; }],
  ["checkout changed", () => { graph.checkout = false; }], ["role changed", () => { a.roleRequest = { ...a.roleRequest, binding: { ...binding, id: "other" } }; }],
  ["unapproved cap", () => { a.pilot.descriptor.capUSD *= 10; state.binding = digest(a.pilot); }],
  ["cache changed", () => { a.cacheKey = "other"; }], ["not ready", () => { state.slots[0].ready = false; }],
  ["recovery", () => { a.recovery = true; }], ["recovered state", () => { state.recovery = true; }],
  ["disconnected", () => { graph.proc.connected = false; }], ["stopped", () => { state.stop = "lookup_auth_failure"; }],
])("does not mint for %s", async (_name, change) => { change(); const code = _name === "CI present" ? "paid_mode_refused_in_ci" : _name === "debug present" ? "lookup_debug_forbidden" : _name === "preparation changed" ? "lookup_preparation_invalid" : "lookup_pilot_capability_invalid"; await expect(cap.createLookupRealSend(a, safety)).rejects.toThrow(code); expect(network).not.toHaveBeenCalled(); });

it("rejects fabricated sends, faux permits and a duplicate mint; the real decorator is one-shot", async () => {
  expect(cap.isRealLookupSend(Object.assign(() => {}, { real: true }))).toBe(false);
  const send = await cap.createLookupRealSend(a, safety), guard = await import("../lib/continuity-lookup-guard.mjs");
  expect(cap.isRealLookupSend(send)).toBe(true); expect(cap.isRealLookupDecorator(send.decorator)).toBe(true); expect(guard.isFauxLookupDecorator(send.decorator)).toBe(false);
  const contract = { ...guard.LOOKUP_GUARD_CONTRACT, slotId: a.slotId, runId: a.runId, promptCacheKey: a.cacheKey };
  expect(() => guard.guardedLookupModels({}, { contract, permit: { ...permit }, send, resolvedSafety: safety })).toThrow("lookup_pilot_capability_invalid");
  expect(() => guard.guardedLookupModels({}, { contract: { ...contract, promptCacheKey: "other" }, permit: { ...permit, testOnly: true }, send, resolvedSafety: safety })).toThrow("lookup_faux_permit_forbidden");
  expect(() => guard.guardedLookupModels({}, { contract, permit, send: async () => {}, resolvedSafety: safety })).toThrow("lookup_pilot_capability_invalid");
  expect(() => guard.guardedLookupModels({}, { contract: { ...contract, promptCacheKey: undefined }, permit, send, resolvedSafety: safety })).toThrow("lookup_prompt_cache_key_forbidden");
  expect(() => guard.guardedLookupModels({}, { contract, permit, send })).toThrow("lookup_auxiliary_callers_forbidden");
  const { controlledLookupRuntime } = await import("../lib/continuity-lookup-pilot-runtime.mjs"), dispatch = vi.fn();
  await expect(controlledLookupRuntime({ run: dispatch }, () => ({ piModelsDecorator: send.decorator }), () => {}).run("fictional", {})).rejects.toThrow("lookup_unguarded_dispatch");
  expect(dispatch).not.toHaveBeenCalled(); expect(send.decorator({})).toBeTruthy(); expect(cap.isRealLookupDecorator(send.decorator)).toBe(false);
  expect(() => send.decorator({})).toThrow("lookup_pilot_capability_invalid");
  await expect(cap.createLookupRealSend(a, safety)).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});
it("makes one redirect-refusing native call per consumed hold and permits same-account token rotation", async () => {
  const send = await cap.createLookupRealSend(a, safety);
  await send(endpoint, { ...request(), headers: { ...request().headers, authorization: "FICTIONAL-ROTATION-ONE" } });
  expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][1].redirect).toBe("error");
  await expect(send(endpoint, request())).rejects.toThrow("lookup_pilot_capability_invalid");
  state.slots[0].holds.push(hold("two")); await send(endpoint, { ...request(), headers: { ...request().headers, authorization: "FICTIONAL-ROTATION-TWO" } });
  expect(network).toHaveBeenCalledTimes(2); expect(permit.stop).not.toHaveBeenCalled();
});
it("awaits account stop before throwing, without a native call", async () => {
  let ack; permit.stop.mockImplementation(() => new Promise(resolve => { ack = resolve; }));
  const send = await cap.createLookupRealSend(a, safety), result = send(endpoint, request("other-fictional-account"));
  await vi.waitFor(() => expect(permit.stop).toHaveBeenCalledWith("lookup_account_mismatch"));
  expect(network).not.toHaveBeenCalled(); ack(); await expect(result).rejects.toThrow("lookup_account_mismatch");
});
it.each([[401, "lookup_auth_failure"], [403, "lookup_auth_failure"], [429, "lookup_quota_exhausted"]])("stops on HTTP %s", async (status, code) => {
  network.mockResolvedValue(new Response("fictional", { status }));
  const send = await cap.createLookupRealSend(a, safety); await expect(send(endpoint, request())).rejects.toThrow(code);
  expect(permit.stop).toHaveBeenCalledExactlyOnceWith(code); expect(network).toHaveBeenCalledTimes(1);
});
it.each(["application/json", "text/event-stream"])("classifies usage-limit responses in %s without changing settlement", async type => {
  const body = { type: "response.failed", response: { error: { code: "usage_limit_reached" } }, error: { type: "usage_limit_reached" } };
  network.mockResolvedValue(new Response(type === "application/json" ? JSON.stringify(body) : `data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": type } }));
  const send = await cap.createLookupRealSend(a, safety);
  await expect((async () => { const response = await send(endpoint, request()); await response.text(); })()).rejects.toThrow("lookup_quota_exhausted");
  expect(permit.stop).toHaveBeenCalledExactlyOnceWith("lookup_quota_exhausted"); expect(permit.settle).not.toHaveBeenCalled();
});
it("surfaces a failed stop ACK without attempting an account-mismatched send", async () => {
  permit.stop.mockRejectedValue(Error("fictional_ack_failure"));
  const send = await cap.createLookupRealSend(a, safety);
  await expect(send(endpoint, request("other-fictional-account"))).rejects.toMatchObject({ code: "lookup_account_mismatch", stopCode: "lookup_stop_failed" }); expect(network).not.toHaveBeenCalled();
});
it.each([
  ["channel", () => { graph.proc.connected = false; }], ["epoch", () => { state.epoch = "other"; }],
  ["markers", () => { graph.markers = false; }], ["deadline", () => { state.deadlineAt = 0; }],
  ["unconsumed", () => { state.slots[0].holds[0].consumed = false; }], ["settled", () => { state.slots[0].holds[0].settlement = {}; }],
  ["digest", () => { state.slots[0].holds[0].payloadDigest = sha("other"); }],
])("rechecks %s immediately before network", async (_name, change) => {
  const send = await cap.createLookupRealSend(a, safety); change(); await expect(send(endpoint, request())).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});
it("refuses endpoint, method and redirect substitution; never retries a rejected native call", async () => {
  const send = await cap.createLookupRealSend(a, safety);
  for (const [url, init] of [["https://other.invalid", request()], [endpoint, { ...request(), method: "GET" }], [endpoint, { ...request(), redirect: "follow" }], [endpoint, { ...request(), dispatcher: {} }]]) await expect(send(url, init)).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(network).not.toHaveBeenCalled(); network.mockRejectedValue(Error("fictional_network_failure"));
  await expect(send(endpoint, request())).rejects.toThrow("fictional_network_failure"); await expect(send(endpoint, request())).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).toHaveBeenCalledTimes(1);
});

it("validates the captured method, not a mutable request accessor", async () => {
  const send = await cap.createLookupRealSend(a, safety), bad = request();
  let reads = 0;
  Object.defineProperty(bad, "method", {enumerable: true, get: () => ++reads === 1 ? "PUT" : "POST"});
  await expect(send(endpoint, bad)).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(network).not.toHaveBeenCalled(); expect(reads).toBe(1);
  const good = request(); reads = 0;
  Object.defineProperty(good, "method", {enumerable: true, get: () => ++reads === 1 ? "POST" : "PUT"});
  await send(endpoint, good);
  expect(reads).toBe(1); expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0][1]).toMatchObject({method: "POST", redirect: "error"});
});

it("does not promote a faux IPC source into real send authority", async () => {
  permit = Object.freeze({ ...permit, testOnly: true, brand: "lookup-faux-test-only-v1" });
  await expect(cap.createLookupRealSend(a, safety)).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});

it("permits real harness credential configuration only for the owned binding before construction", async () => {
  const send = await cap.createLookupRealSend(a, safety), mkdir = vi.fn(async () => {});
  vi.doMock("node:fs/promises", async original => ({ ...await original(), mkdir }));
  const { openHarness } = await import("../lib/continuity-runner.mjs"), { lookupPilotWork } = await import("../lib/continuity-lookup-pilot-runtime.mjs");
  const dispatch = vi.fn((_prompt, options) => { options.piModelsDecorator({}); return {}; }), dispose = vi.fn();
  const construct = vi.fn(() => ({ run: dispatch, disposeAllSessions: dispose }));
  const modules = { config: { resolveJsonMonoAgentConfig: vi.fn(() => safety.config) }, app: { createConfiguredAgentRuntime: construct,
    createConfiguredConversationHarness: vi.fn(async () => ({ dispose })) }, coordinator: { acquireAgentRootOwnership: vi.fn(async () => ({})), releaseAgentRootOwnershipWhenIdle: vi.fn() } };
  const input = { modules, work: lookupPilotWork(a), authPath: a.authorization.credentialPath, model: "openai-codex:gpt-6.1-sol", clock: { value: new Date(0) },
    route: () => ({ piModelsDecorator: send.decorator }), pilot: { routeKind: "real", plan: a.plan, arm: safety.arm, send } };
  await expect(openHarness({ ...input, authPath: "/fictional/swapped" })).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(construct).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  const opened = await openHarness(input);
  expect(modules.config.resolveJsonMonoAgentConfig.mock.calls[0][0].json.providers.piAuthPath).toBe(a.authorization.credentialPath);
  const runtime = modules.app.createConfiguredConversationHarness.mock.calls[0][0].runtime;
  const options = { model: safety.config.runtime.model, piTransport: "sse", piMaxRetries: 0, compaction: { enabled: false } };
  await runtime.run("fictional", options); await expect(runtime.run("fictional", options)).rejects.toThrow("lookup_unguarded_dispatch");
  expect(dispatch).toHaveBeenCalledTimes(1); await opened.close(); expect(network).not.toHaveBeenCalled();
});

it("checks the pilot binding again on every send", async () => {
  const send = await cap.createLookupRealSend(a, safety);
  graph.approvedPilot.descriptor.capUSD *= 10;
  await expect(send(endpoint, request())).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});
it.each(["session-id", "x-client-request-id"])("refuses a substituted %s independently of the guard", async key => {
  const send = await cap.createLookupRealSend(a, safety), init = request(); init.headers[key] = "other";
  await expect(send(endpoint, init)).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});
it("honours the shared gate at mint and on sends before assignment reads", async () => {
  const send = await cap.createLookupRealSend(a, safety); graph.closed = true;
  await expect(cap.verifyLookupRealAssignment(null)).rejects.toThrow("lookup_pilot_real_route_unavailable");
  await expect(cap.createLookupRealSend(a, safety)).rejects.toThrow("lookup_pilot_real_route_unavailable");
  await expect(send(endpoint, request())).rejects.toThrow("lookup_pilot_real_route_unavailable"); expect(network).not.toHaveBeenCalled();
});

it("ignores null SSE frames and still awaits the fixed quota stop", async () => {
  let stopped = false;
  permit.stop.mockImplementation(async code => { await Promise.resolve(); expect(code).toBe("lookup_quota_exhausted"); stopped = true; });
  network.mockResolvedValue(new Response('data: null\n\ndata: {"error":{"code":"usage_limit_reached"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const send = await cap.createLookupRealSend(a, safety), response = await send(endpoint, request());
  await expect(response.text()).rejects.toMatchObject({ code: "lookup_quota_exhausted" });
  expect(stopped).toBe(true); expect(network).toHaveBeenCalledTimes(1); expect(permit.stop).toHaveBeenCalledTimes(1);
});

it("revalidates the durable preparation record on every send", async () => {
  const send = await cap.createLookupRealSend(a, safety); graph.preparationChanged = true;
  await expect(send(endpoint, request())).rejects.toThrow("lookup_preparation_invalid"); expect(network).not.toHaveBeenCalled();
});

it.each(["Uint8Array", "ArrayBuffer"])("snapshots %s with fetch BodyInit byte semantics", async kind => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const body = kind === "Uint8Array" ? source.subarray(2) : source.buffer.slice(2);
  const expected = Buffer.from(source.subarray(2)); state.slots[0].holds[0].payloadDigest = sha(expected);
  const send = await cap.createLookupRealSend(a, safety), pending = send(endpoint, {...request(), body}); source.fill(0);
  await pending; expect(network).toHaveBeenCalledOnce(); expect(Buffer.from(network.mock.calls[0][1].body)).toEqual(expected);
});

it.each([new DataView(new ArrayBuffer(4)), new Uint16Array(2), new Int8Array(2), new Uint8ClampedArray(2), new FormData(), new URLSearchParams(), new Blob(["fictional"]), null, undefined])("refuses unsupported real transport body %# before native fetch", async body => {
  const send = await cap.createLookupRealSend(a, safety);
  await expect(send(endpoint, {...request(), body})).rejects.toMatchObject({code: "lookup_body_type_forbidden"});
  expect(network).not.toHaveBeenCalled();
});

it("refuses extra normalized keys introduced while the endpoint is captured", async () => {
  const send = await cap.createLookupRealSend(a, safety), bad = request();
  const url = {toString() {bad.dispatcher = {}; return endpoint;}};
  await expect(send(url, bad)).rejects.toThrow("lookup_pilot_capability_invalid"); expect(network).not.toHaveBeenCalled();
});
it("does not copy a dispatcher added during the real method snapshot", async () => {
  const send = await cap.createLookupRealSend(a, safety), bad = request();
  Object.defineProperty(bad, "method", {enumerable: true, get() {bad.dispatcher = {}; return "POST";}});
  await send(endpoint, bad); expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0][1]).not.toHaveProperty("dispatcher");
});
