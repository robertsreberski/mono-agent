import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRunDriver } from "../run-driver.js";
import { JsonlSessionRepo } from "../session-store.js";
import { commitSession, captureSessionRecovery, resolveSession, nativeSessionRegistry } from "../session-lifecycle.js";
import { settleNativeSession } from "../session-settlement.js";
const roots = [];
afterEach(async () => { await nativeSessionRegistry.disposeAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("returns storage-only unavailable and persistence outcomes", async () => {
  expect(await resolveSession({}, { requestedSessionId: "missing", providerSessionId: "missing" })).toEqual({
    status: "unavailable", unavailable: { failureKind: "session_not_found", code: "pi_session_not_found", sessionId: "missing", message: "Pi session missing is not live" },
  });
  const entry = { busy: true };
  nativeSessionRegistry.set("busy", entry);
  expect(await resolveSession({}, { requestedSessionId: "busy", providerSessionId: "busy" })).toEqual({
    status: "unavailable", unavailable: { failureKind: "session_busy", code: "pi_session_busy", sessionId: "busy", message: "Pi session busy is busy with another turn" },
  });
  nativeSessionRegistry.delete("busy");
  const session = { buildContext: async () => { throw Object.assign(new Error("Fictional persistence failure"), { code: "ENOSPC" }); }, close: vi.fn() };
  const repo = { delete: vi.fn() };
  expect(await commitSession({ session, sessionEntry: { metadata: {}, repo } }, { keepAlive: true, providerSessionId: "broken" })).toEqual({
    status: "settled", persistFailure: { code: "ENOSPC", message: "Fictional persistence failure" },
  });
  expect(session.close).toHaveBeenCalledOnce(); expect(repo.delete).toHaveBeenCalledOnce();
});

it("captures only storage receipt coordinates and checks abort after close", async () => {
  expect(await captureSessionRecovery({}, {})).toEqual({ status: "not_durable" });
  const controller = new AbortController(), entry = { durable: true };
  const state = { sessionEntry: entry, recoveryInputIds: [], session: {
    getLeafId: async () => "tip", getEntries: async () => [], close: async () => { controller.abort(); },
  } };
  const identity = { runId: "run", revision: 1, providerSessionId: "id", modelKey: "faux:fixture" };
  expect(await captureSessionRecovery(state, { identity, model: { input: ["text"] }, pending: false, abortSignal: controller.signal })).toEqual({
    status: "captured", receipt: { ...identity, tipId: "tip" },
  });
  expect(entry.recoveryPending).toBe(true);
});

it("seals suspended operations in reverse order, clearing recovery before I/O", async () => {
  const actions = [], entry = { recoveryPending: true, recovery: {} };
  const raw = { getOpenOperations: async () => [{ operationId: "one" }, { operationId: "two" }],
    closeOperation: async (id, status) => { expect(entry.recoveryPending).toBe(false); expect(entry.recovery).toBeUndefined(); actions.push([id, status]); },
    getOpenTurns: async () => [{ turnId: "turn" }], endTurn: async (...args) => actions.push(args), sync: async () => actions.push("sync") };
  const state = { session: { rawSession: raw }, sessionEntry: entry, retainRecoveryTail: true };
  expect(await settleNativeSession(state, { action: "fail-suspended" })).toEqual({ status: "sealed" });
  expect(state.retainRecoveryTail).toBe(false);
  expect(actions).toEqual([["two", "failed"], ["one", "failed"], ["turn", "failed"], "sync"]);
});

it("seals and reopens a real suspended tool turn twice without repeating its effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-suspension-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root }), raw = await repo.create();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "fixture" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel(); let effects = 0;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "effect" })]),
    fauxAssistantMessage([], { stopReason: "deferred", deferred: { id: "fictional-deferred", provider: model.provider, modelId: model.id, api: model.api } })]);
  const driver = createRunDriver(raw, { models, model, retry: { enabled: false }, tools: [{ name: "Effect", description: "Fictional effect", parameters: { type: "object", properties: {} },
    execute: async () => { effects += 1; return { content: [{ type: "text", text: "Fictional effect" }] }; } }] });
  try {
    expect((await driver.prompt("Fictional request")).status).toBe("suspended");
    const state = { session: { rawSession: raw }, sessionEntry: { recoveryPending: true }, retainRecoveryTail: true };
    expect(await settleNativeSession(state, { action: "sync" })).toEqual({ status: "synced" });
    expect(await settleNativeSession(state, { action: "fail-suspended" })).toEqual({ status: "sealed" });
    await driver.close(); await raw.close();
    const bytes = await readFile(raw.metadata.path);
    for (let i = 0; i < 2; i++) {
      const reopened = await repo.open(raw.metadata);
      expect(await reopened.getOpenTurns()).toEqual([]); expect(await reopened.getOpenOperations()).toEqual([]);
      await reopened.close(); expect(await readFile(raw.metadata.path)).toEqual(bytes);
    }
    expect(effects).toBe(1); expect(faux.state.callCount).toBe(2);
  } finally { await driver.close(); await raw.close(); }
});
