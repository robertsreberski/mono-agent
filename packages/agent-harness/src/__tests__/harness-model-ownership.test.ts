import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHarness, createDurableHistoryStore, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessOptions, ConversationHistoryStore } from "../types.js";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";

const model = { provider: "faux", model: "base", reference: "faux:base" };
const alternate = { provider: "faux", model: "override", reference: "faux:override" };
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "harness-model-owner-"));
  dirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.");
  return { dir, identityPath };
}
const request = () => ({ conversationId: "c", userMessage: "hello", abortSignal: new AbortController().signal,
  metadata: { web: { model: alternate.reference } } });
function runtime() {
  return { run: vi.fn(async (_prompt: string, options: RuntimeRunOptions) => ({ text: "answer", providerSessionId: String(options.sessionId ?? "override-id") })),
    refreshSession: vi.fn(async (_id: string) => undefined), syncSession: vi.fn(async (_id: string) => true),
    invalidateSession: vi.fn(async (_id: string) => true), disposeSession: vi.fn(async (_id: string) => true),
    retireDurableSession: vi.fn(async (_id: string, _root: string) => undefined) };
}

describe("harness model owner lifecycle", () => {
  it.each(["reset", "append", "disposeAll", "idle", "failure", "cancellation", "stale retry"])(
    "routes %s session cleanup to the owning model runtime", async (action) => {
      const { identityPath } = await fixture();
      const base = runtime();
      const owner = runtime();
      const harness = createAgentHarness({ identityPath, runtime: base, model,
        runtimeForModel: () => owner, historyStore: createInMemoryHistoryStore(),
        runtimeOptionsForRequest: () => ({ runtimeOptions: { model: alternate } }),
        session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 100 } });
      expect((await harness.run(request())).text).toBe("answer");
      if (action === "reset") await harness.resetConversation?.("c");
      if (action === "append") await harness.appendVerbatimTurn?.("c", "posted");
      if (action === "disposeAll") await harness.dispose?.();
      if (action === "idle") await vi.waitFor(() => expect(owner.disposeSession).toHaveBeenCalledWith("override-id"), { timeout: 2000 });
      if (action === "failure" || action === "cancellation") {
        if (action === "failure") owner.run.mockImplementationOnce(async () => { throw new Error("provider failed"); });
        const next = request();
        if (action === "cancellation") {
          const abort = new AbortController();
          next.abortSignal = abort.signal;
          owner.run.mockImplementationOnce(async () => { abort.abort(); return { text: "late", providerSessionId: "override-id" }; });
        }
        expect((await harness.run(next)).failure).toBeDefined();
      }
      if (action === "stale retry") {
        owner.run.mockImplementationOnce(async () => ({ text: "", providerSessionId: "override-id", failureKind: "session_not_found" }));
        await harness.run(request());
      }
      expect([...owner.disposeSession.mock.calls, ...owner.invalidateSession.mock.calls].flat()).toContain("override-id");
      expect(base.disposeSession).not.toHaveBeenCalled();
      expect(base.invalidateSession).not.toHaveBeenCalled();
      expect(base.run).not.toHaveBeenCalled();
      await harness.dispose?.();
    },
  );

  it.each(["missing", "throwing", "unsynced", "success"])("refreshes and synchronizes override sessions on their owning runtime: %s", async (mode) => {
    const { dir, identityPath } = await fixture();
    const base = runtime();
    const owner = runtime();
    if (mode === "throwing") owner.refreshSession.mockRejectedValue(new Error("refresh rejected"));
    if (mode === "unsynced") owner.syncSession.mockResolvedValue(false);
    const historyStore = createDurableHistoryStore({ root: join(dir, "history"),
      retireProviderSession: async (id, key) => { expect(key).toBe(alternate.reference); await owner.retireDurableSession(id, dir); } });
    const { refreshSession: _refresh, ...withoutRefresh } = owner;
    const options: AgentHarnessOptions = { identityPath, runtime: base, model,
      runtimeForModel: () => mode === "missing" ? withoutRefresh : owner,
      historyStore, piSessionsRoot: join(dir, "pi"), session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000 },
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: alternate } }) };
    const harness = createAgentHarness(options);
    const response = await harness.run(request());
    if (mode === "missing" || mode === "throwing") {
      expect(response.failure).toBeDefined();
      expect(owner.run).not.toHaveBeenCalled();
    } else {
      expect(response.text).toBe("answer");
      expect(owner.syncSession).toHaveBeenCalled();
      if (mode === "unsynced") expect(owner.retireDurableSession).toHaveBeenCalled();
      else {
        const id = owner.run.mock.calls[0]![1].sessionId;
        const reloaded = createAgentHarness(options);
        expect((await reloaded.run(request())).text).toBe("answer");
        expect(owner.refreshSession.mock.calls).toEqual([[id], [id]]);
        await reloaded.dispose?.();
      }
    }
    expect(base.refreshSession).not.toHaveBeenCalled();
    expect(base.syncSession).not.toHaveBeenCalled();
    await harness.dispose?.();
  });

  it.each([undefined, "wrong", "missing"])("keeps custom-store binding capability fail-closed: %s", async (ack) => {
    const { dir, identityPath } = await fixture();
    const base = runtime();
    const owner = runtime();
    const real = createDurableHistoryStore({ root: join(dir, "history"), retireProviderSession: async () => undefined });
    const begin = vi.fn(async (...args: Parameters<typeof real.beginProviderSessionTurn>) => {
      const turn = await real.beginProviderSessionTurn(...args);
      const { modelKey: _key, ...withoutKey } = turn;
      return { ...withoutKey, ...(ack === "wrong" ? { modelKey: model.reference } : {}) };
    });
    const historyStore: ConversationHistoryStore = { load: real.load.bind(real), append: real.append.bind(real),
      providerSessionRetirement: "fail-closed", ...(ack === undefined ? {} : { providerSessionModelBinding: "v1" as const }),
      beginProviderSessionTurn: begin };
    const harness = createAgentHarness({ identityPath, runtime: base, model, runtimeForModel: () => owner,
      historyStore, piSessionsRoot: join(dir, "pi"), session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000 },
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: alternate } }) });
    const response = await harness.run(request());
    if (ack === undefined) {
      expect(response.text).toBe("answer");
      expect(begin).not.toHaveBeenCalled();
      expect(owner.run.mock.calls[0]?.[1].piSessionsRoot).toBeUndefined();
      expect((await harness.run(request())).text).toBe("answer");
      expect(owner.run.mock.calls[1]?.[1].sessionId).toBe("override-id");
    } else {
      expect(response.failure?.kind).toBe("provider_session_model_binding_mismatch");
      expect(owner.run).not.toHaveBeenCalled();
    }
    await harness.dispose?.();
  });
});
