// Offline shared-core hardening; no registry, credential or provider access.
import { afterEach, expect, it, vi } from "vitest";
import { guardedModels } from "../lib/continuity-guarded-models.mjs";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";

afterEach(() => { vi.doUnmock("node:fs/promises"); vi.resetModules(); });
function fixture(underlying, permit) {
  const core = guardedModels("lookup-pilot"), contract = { ...guardedProtocol("lookup-pilot").policy.GUARD_CONTRACT, runId: "fictional-run", slotId: "fictional-slot" };
  permit ??= core.createTestOnlyLookupPermitSource();
  const send = vi.fn(() => { throw Error("network_forbidden"); });
  const models = core.guardedLookupModels(underlying, { contract, permit, send });
  return { models, permit, send, model: { provider: contract.provider, id: contract.model, api: contract.api, baseUrl: contract.baseUrl },
    options: { reasoning: contract.effort, transport: "sse", maxRetries: 0 } };
}
it("finalizes a synchronous source.result throw and clears the active request", async () => {
  const failure = Error("fictional_result_failure"), f = fixture({ streamSimple() { return { result() { throw failure; } }; } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = f.models.streamSimple(f.model, {}, f.options);
    await expect(stream.result()).rejects.toBe(failure);
  }
  expect(f.permit.events).toEqual([]); expect(f.send).not.toHaveBeenCalled();
});
it("waits for an already-started admission before settling a synchronous result throw as lost", async () => {
  const source = guardedModels("lookup-pilot").createTestOnlyLookupPermitSource();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const permit = { ...source, async admit(request) { await gate; return source.admit(request); } };
  const failure = Error("fictional_result_failure");
  let pending;
  const f = fixture({ streamSimple(model, _context, options) {
    pending = options.onPayload({ model: model.id, store: false, stream: true, reasoning: { effort: "high" }, input: [{ role: "user", content: "Fictional request." }] }, model);
    return { result() { throw failure; } };
  } }, permit);
  const stream = f.models.streamSimple(f.model, {}, f.options);
  let finished = false; void stream.result().catch(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
  release(); await pending; await expect(stream.result()).rejects.toBe(failure);
  expect(source.events.map(event => event.type)).toEqual(["admit", "settle"]);
  expect(source.events[1].outcome).toEqual({ kind: "lost" });
  expect(() => f.models.streamSimple(f.model, {}, f.options)).toThrow("lookup_slot_terminal");
  expect(f.send).not.toHaveBeenCalled();
});
async function statsFixture(mode) {
  vi.resetModules();
  let inspected = 0, opened = 0, closed = 0;
  vi.doMock("node:fs/promises", async original => ({ ...await original(),
    async lstat(path) {
      inspected++; const directory = mode === "deep" || path === "/fictional/tree";
      return { uid: process.getuid(), mode: directory ? 0o700 : 0o600, size: 1, nlink: 1, dev: 1, ino: inspected,
        isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory };
    },
    async opendir() {
      opened++;
      return { async *[Symbol.asyncIterator]() {
        try { if (mode === "deep") yield { name: "child" }; else for (let i = 0; ; i++) yield { name: `file-${i}` }; }
        finally { closed++; }
      } };
    },
  }));
  const { guardedSnapshot, GUARDED_STATS_LIMITS } = await import("../lib/continuity-guarded-snapshot.mjs");
  const stats = await guardedSnapshot("lookup-pilot").lookupPreparationStats("/fictional/tree");
  return { stats, limits: GUARDED_STATS_LIMITS, inspected, opened, closed };
}
it("bounds preparation stats width and closes streaming directory handles", async () => {
  const f = await statsFixture("wide");
  expect(f.limits).toEqual({ entries: 65536, depth: 64 });
  expect(f.inspected).toBe(f.limits.entries);
  expect(f.stats.fileCount).toBe(f.limits.entries - 1);
  expect(f.stats.rejectedEntries).toEqual([{ kind: "entry_limit", count: 1 }]);
  expect(f.opened).toBe(1); expect(f.closed).toBe(f.opened);
});
it("bounds preparation stats depth and closes every ancestor directory handle", async () => {
  const f = await statsFixture("deep");
  expect(f.inspected).toBe(f.limits.depth + 1);
  expect(f.stats.rejectedEntries).toEqual([{ kind: "depth_limit", count: 1 }]);
  expect(f.closed).toBe(f.opened);
});

it("blocks payload and fetch callbacks arriving after synchronous result finalization", async () => {
  let callbacks; const failure = Error("fictional_result_failure");
  const f = fixture({ streamSimple(_model, _context, options) { callbacks = options; return { result() { throw failure; } }; } });
  const stream = f.models.streamSimple(f.model, {}, f.options);
  await expect(stream.result()).rejects.toBe(failure);
  await expect(callbacks.onPayload({})).rejects.toMatchObject({ code: "lookup_permit_invalid", outcome: "integrity_stop" });
  await expect(callbacks.fetch("unused", {})).rejects.toMatchObject({ code: "lookup_permit_invalid", outcome: "integrity_stop" });
  expect(f.permit.events.map(e => e.type)).toEqual(["stop"]); expect(f.send).not.toHaveBeenCalled();
});
it("does not admit after a paused payload mutator crosses the finishing boundary", async () => {
  let release, pending; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ streamSimple(model, _context, options) {
    pending = options.onPayload({ model: model.id }, model);
    return { result() { throw Error("fictional_result_failure"); } };
  } });
  const stream = f.models.streamSimple(f.model, {}, { ...f.options, onPayload: async payload => { await gate; return payload; } });
  release(); await expect(pending).rejects.toMatchObject({ code: "lookup_permit_invalid" });
  await expect(stream.result()).rejects.toMatchObject({ code: "lookup_permit_invalid", outcome: "integrity_stop" });
  expect(f.permit.events.map(e => e.type)).toEqual(["stop"]); expect(f.send).not.toHaveBeenCalled();
});
it.each([false, true])("drains already-started admission on ordinary finish (async failure=%s)", async failed => {
  const source = guardedModels("lookup-pilot").createTestOnlyLookupPermitSource();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const permit = { ...source, async admit(p) { await gate; return source.admit(p); } };
  const message = { stopReason: "stop", content: [{ type: "text", text: "Fictional response." }] };
  const f = fixture({ streamSimple(model, _context, options) {
    void options.onPayload({ model: model.id, store: false, stream: true, reasoning: { effort: "high" }, input: [] });
    return { result: async () => { if (failed) throw Error("fictional_async_result_failure"); return message; } };
  } }, permit);
  const stream = f.models.streamSimple(f.model, {}, f.options); let done = false;
  void stream.result().then(() => { done = true; }, () => { done = true; });
  await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false);
  expect(() => f.models.streamSimple(f.model, {}, f.options)).toThrow("lookup_concurrent_request");
  release();
  if (failed) await expect(stream.result()).rejects.toThrow("fictional_async_result_failure");
  else expect(await stream.result()).toBe(message);
  expect(source.events.map(e => e.type)).toEqual(["admit", "settle"]);
  expect(source.events[1].outcome).toEqual({ kind: "lost" }); expect(f.send).not.toHaveBeenCalled();
});
it("settles a send-gate integrity refusal as integrity_stop rather than lost", async () => {
  const f = fixture({ streamSimple(model, _context, options) { return { async result() {
    const body = await options.onPayload({ model: model.id, store: false, stream: true, reasoning: { effort: "high" }, input: [] });
    await options.fetch(`${model.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(body) });
  } }; } });
  f.send.mockImplementation(async () => { await f.permit.stop("lookup_body_mismatch"); throw Object.assign(Error("lookup_body_mismatch"), { code: "lookup_body_mismatch", outcome: "integrity_stop" }); });
  await expect(f.models.streamSimple(f.model, {}, f.options).result()).rejects.toMatchObject({ code: "lookup_body_mismatch", outcome: "integrity_stop" });
  expect(f.permit.events.find(e => e.type === "settle").outcome).toEqual({ kind: "integrity_stop", code: "lookup_body_mismatch" });
});

it("refuses late fetch before consume even when a grant existed before finish", async () => {
  const source = guardedModels("lookup-pilot").createTestOnlyLookupPermitSource(), consume = vi.fn(source.consume);
  let callbacks, body;
  const f = fixture({ streamSimple(model, _context, options) {
    callbacks = options;
    const pending = options.onPayload({ model: model.id, store: false, stream: true, reasoning: { effort: "high" }, input: [] });
    return { async result() { body = await pending; throw Error("fictional_result_failure"); } };
  } }, { ...source, consume });
  await expect(f.models.streamSimple(f.model, {}, f.options).result()).rejects.toThrow("fictional_result_failure");
  await expect(callbacks.fetch(`${f.model.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(body) })).rejects.toMatchObject({ code: "lookup_permit_invalid", outcome: "integrity_stop" });
  expect(consume).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  expect(source.events.map(e => e.type)).toEqual(["admit", "settle", "stop"]);
});
