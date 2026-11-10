// Only source-owned gate mechanics are exercised; assignments/IPC/fetch are mocked.
// The real E2 descriptor stays closed. No credentials, registry or transport is used.
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import process from "node:process";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";
const protocol = guardedProtocol("e2-validation"), connected = Object.getOwnPropertyDescriptor(process, "connected");
afterEach(() => {
  vi.doUnmock("../lib/continuity-guarded-protocols.mjs"); vi.unstubAllGlobals(); vi.resetModules(); vi.restoreAllMocks();
  if (connected) Object.defineProperty(process, "connected", connected); else delete process.connected;
});
it.each(["real", "faux"].flatMap(route => ["e2_body_mismatch", "e2_tools_forbidden"].map(code => [route, code])))("%s gate stops with exact %s before fetch", async (route, code) => {
  vi.resetModules(); Object.defineProperty(process, "connected", { configurable: true, value: true });
  const dispatched = vi.fn(() => { throw Error("network_forbidden"); }); vi.stubGlobal("fetch", dispatched);
  const model = "gpt-6-luna", body = JSON.stringify({ model: code === "e2_body_mismatch" ? "gpt-6.1-sol" : model, stream: true, store: false, input: [], tools: code === "e2_tools_forbidden" ? [{ type: "function", name: "ProofRead" }] : [] });
  const permit = { stop: vi.fn(async () => {}) }, endpoint = "http://127.0.0.1:1/codex/responses";
  const hold = { admittedAt: Date.now(), model: `openai-codex:${model}`, tools: [], consumed: true, revoked: false, settlement: null, permitId: "fictional-permit", payloadDigest: createHash("sha256").update(body).digest("hex") };
  const state = { schema: protocol.policy.FAUX_CONTROLLER, fauxEndpoint: endpoint, stop: null, cursor: 0, deadlineAt: Date.now() + 30000, slots: [{ terminal: null, startedAt: Date.now(), holds: [hold] }] };
  const a = { outputRoot: "/fictional/output", epoch: "fictional-epoch", runId: "fictional-run", slotId: "fictional-slot", index: 0, cacheKey: "fixture", plan: {}, roleRequest: { binding: { arm: "fictional-arm" } }, pilot: { descriptor: { deadlines: { requestDeadlineMs: 30000, phaseDeadlineMs: 30000 } } } };
  const hooks = { ...protocol.hooks, assertResolvedSafety() {}, forwardedObserver: () => ({ notify() {}, register() {} }),
    verifyRealAssignment: async () => ({ handle: {}, state }),
    realModules: async () => ({ wrapModels() {}, assertRealPermitSource() {}, matchesAccount: () => true, createIPC: async () => permit }),
    fauxBindings: async () => ({ readPrivate: async () => state, statePath: () => "fictional-state", verifyParent: async () => state, createIPC: async () => permit,
      verifyPreparation() {}, guardContract: protocol.policy.GUARD_CONTRACT, createDecorator: async () => () => {}, verifyRole() {} }),
  };
  vi.doMock("../lib/continuity-guarded-protocols.mjs", () => ({ guardedProtocol: () => ({ ...protocol, realRoute: true, hooks }) }));
  const safety = { plan: a.plan, arm: { id: "fictional-arm" } };
  const capability = route === "real" ? (await import("../lib/continuity-guarded-real-capability.mjs")).guardedRealCapability("e2-validation") : (await import("../lib/continuity-guarded-faux-capability.mjs")).guardedFauxCapability("e2-validation");
  const send = route === "real" ? await capability.createLookupRealSend(a, safety) : await capability.createLookupFauxSend(a, safety);
  await expect(send(`${protocol.policy.GUARD_CONTRACT.baseUrl}/codex/responses`, { method: "POST", body, headers: { "session-id": a.cacheKey, "x-client-request-id": a.cacheKey, "chatgpt-account-id": "fictional-account" } })).rejects.toMatchObject({ code, outcome: "integrity_stop" });
  expect(permit.stop).toHaveBeenCalledExactlyOnceWith(code); expect(dispatched).not.toHaveBeenCalled();
});

it("requires the assigned phase identity even for cache-off summaries", async () => {
  const { e2ExecutionPolicy: policy } = await import("../lib/continuity-e2-execution-policy.mjs"), key = "fictional-phase-cache";
  expect(() => policy.assertCacheHeaders(new Headers(), { paidRole: "summary" }, key)).toThrow("e2_prompt_cache_key_forbidden");
  expect(() => policy.assertCacheHeaders(new Headers(), { paidRole: "summary" }, undefined)).not.toThrow();
  expect(() => policy.assertCacheHeaders(new Headers({ "session-id": key, "x-client-request-id": key }), { paidRole: "summary" }, key)).not.toThrow();
  expect(() => policy.assertCacheHeaders(new Headers(), { paidRole: "probe" }, key)).toThrow("e2_prompt_cache_key_forbidden");
  for (const headers of [new Headers({ "session-id": key }), new Headers({ "session-id": "foreign", "x-client-request-id": "foreign" })])
    expect(() => policy.assertCacheHeaders(headers, { paidRole: "summary" }, key)).toThrow("e2_prompt_cache_key_forbidden");
  expect(() => policy.assertCacheHeaders(new Headers({ "session-id": key, "x-client-request-id": key }), { paidRole: "probe" }, key)).not.toThrow();
});

it.each(["request", "phase", "run", "post-body"])("real native gate refuses %s expiry without a fetch or integrity reclassification", async kind => {
  vi.resetModules(); Object.defineProperty(process, "connected", { configurable: true, value: true });
  const base = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(base);
  const dispatched = vi.fn(() => { throw Error("network_forbidden"); }); vi.stubGlobal("fetch", dispatched);
  const body = JSON.stringify({ model: "gpt-6-luna", stream: true, store: false, input: [], tools: [] });
  const hold = { admittedAt: kind === "run" ? base + 9500 : kind === "phase" ? base + 4500 : base,
    model: "openai-codex:gpt-6-luna", tools: [], consumed: true, revoked: false, settlement: null, permitId: "fictional-permit", payloadDigest: createHash("sha256").update(body).digest("hex") };
  const state = { stop: null, deadlineAt: base + 10000, slots: [{ startedAt: kind === "run" ? base + 9000 : base, holds: [hold] }] };
  const a = { outputRoot: "/fictional/output", epoch: "fictional-epoch", runId: "fictional-run", slotId: "fictional-slot", index: 0, cacheKey: "fixture", plan: {}, roleRequest: { binding: { arm: "fictional-arm" } }, pilot: { descriptor: { deadlines: { requestDeadlineMs: 1000, phaseDeadlineMs: 5000 } } } };
  const permit = { stop: vi.fn(async () => {}) }, hooks = { ...protocol.hooks, assertResolvedSafety() {}, forwardedObserver: () => ({ notify() {}, register() {} }),
    verifyRealAssignment: async () => ({ handle: {}, state }), realModules: async () => ({ wrapModels() {}, assertRealPermitSource() {}, matchesAccount: () => true, createIPC: async () => permit }) };
  const execution = { ...protocol.execution, verifyNativeBody: async () => { if (kind === "post-body") clock.mockReturnValue(base + 1000); } };
  vi.doMock("../lib/continuity-guarded-protocols.mjs", () => ({ guardedProtocol: () => ({ ...protocol, hooks, execution }) }));
  const capability = (await import("../lib/continuity-guarded-real-capability.mjs")).guardedRealCapability("e2-validation");
  const send = await capability.createLookupRealSend(a, { plan: a.plan, arm: { id: "fictional-arm" } });
  if (kind !== "post-body") clock.mockReturnValue(base + ({ request: 1000, phase: 5000, run: 10000 }[kind]));
  const code = kind === "run" ? "e2_run_deadline" : "e2_worker_timeout";
  await expect(send(`${protocol.policy.GUARD_CONTRACT.baseUrl}/codex/responses`, { method: "POST", body, headers: { "session-id": a.cacheKey, "x-client-request-id": a.cacheKey, "chatgpt-account-id": "fictional-account" } })).rejects.toMatchObject({ code });
  expect(permit.stop).toHaveBeenCalledExactlyOnceWith(code); expect(dispatched).not.toHaveBeenCalled();
});
