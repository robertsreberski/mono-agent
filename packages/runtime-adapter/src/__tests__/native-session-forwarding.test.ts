import { it, expect, vi, beforeEach } from "vitest";
const prepared = vi.hoisted(() => ({ snapshot: Object.freeze({ model: { provider: "faux", id: "fixture", api: "faux", contextWindow: 100000, maxTokens: 4096 },
  provenance: { provider: "faux", api: "faux", model: "fixture", account: null }, authSource: "provider", systemPrompt: "Resolved rules", tools: [], messages: [] }),
  assertReady: vi.fn(), checkHandoffSummary: vi.fn(() => ({ status: "ready" as const })),
  produceHandoffSummary: vi.fn(async (_input: unknown) => ({ status: "summary_rejected" as const, reason: "fictional-refusal" })),
  run: vi.fn(async (_binding?: unknown) => ({ text: "Prepared fictional answer" })), close: vi.fn(async () => {}) }));
const kernel = vi.hoisted(() => ({ run: vi.fn(async (_system: string, _options: Record<string, any>): Promise<import("../types.js").RuntimeResult> => ({ text: "Fictional answer" })),
  nativePreparedDispatch: "v1" as "v1" | undefined,
  prepareNativeDispatch: vi.fn(async (_system: string, _options: Record<string, any>) => prepared) }));
beforeEach(() => { vi.clearAllMocks(); kernel.nativePreparedDispatch = "v1"; });
vi.mock("@mono-agent/agent-runtime", () => ({ createRuntime: () => kernel, createRouterRuntime: () => kernel }));
import { createMonoRuntime } from "../runtime-adapter.js";
import type { RuntimeNativeSessionAuthority, RuntimeNativeSessionProjection } from "../types.js";
const model = { provider: "faux", model: "fixture", reference: "faux:fixture" };
it.each([false, true])("forwards host native authority/projection unchanged through the facade (routed=%s)", async (routed) => {
  const authority: RuntimeNativeSessionAuthority = { version: 1, currentHandleId: "a".repeat(64), sessionsRoot: "/fictional/native",
    hostAuthority: { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertCurrent: vi.fn(async () => {}) };
  const projection: RuntimeNativeSessionProjection = { version: 1, artifact: { id: "3".repeat(64), hash: "4".repeat(64) },
    inherited: { messages: [{ role: "user", content: "Fictional retained data" }], coverage: { version: 1, sources: [{ journalId: "retained", sourceTipId: null, sourceSeq: 0, sourceDigest: "5".repeat(64) }] } } };
  const runtime = createMonoRuntime(routed ? { fallbackChain: [{ model }] } : {});
  await runtime.run("Fictional rules", { model, messages: [], abortSignal: new AbortController().signal, nativeSessionAuthority: authority, nativeSessionProjection: projection });
  expect(kernel.run.mock.calls.at(-1)?.[1]).toMatchObject({ nativeSessionAuthority: authority, nativeSessionProjection: projection });
  expect(kernel.run.mock.calls.at(-1)?.[1].nativeSessionAuthority.assertCurrent).toBe(authority.assertCurrent);
});


it.each([false, true])("forwards typed native preparation and its exact lease without implicit activation (routed=%s)", async (routed) => {
  const runtime = createMonoRuntime(routed ? { fallbackChain: [{ model }] } : {});
  expect(runtime.nativePreparedDispatch).toBe("v1"); expect(kernel.prepareNativeDispatch).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  const lease = await runtime.prepareNativeDispatch!("Frozen rules", { model, messages: [{ role: "user", content: "Frozen fictional input" }],
    abortSignal: signal, piSessionsRoot: "/fictional/native", sandbox: { fictional: true } } as any);
  expect(lease).toBe(prepared); expect(lease.snapshot).toBe(prepared.snapshot);
  const forwarded = kernel.prepareNativeDispatch.mock.calls[0]![1];
  expect(forwarded).toMatchObject({ model, piSessionsRoot: "/fictional/native" }); expect(forwarded.abortSignal).toBe(signal);
  expect(forwarded).not.toHaveProperty("sandbox"); expect(kernel.run).not.toHaveBeenCalled();
  lease.assertReady!(); expect(prepared.assertReady).toHaveBeenCalledOnce();
  const producer = { prepared: { status: "prepared" as const, checkpoints: [], ledger: [], recent: [], older: [], coverage: [] }, outputReserve: 256 };
  expect(lease.checkHandoffSummary!(producer)).toEqual({ status: "ready" });
  expect(await lease.produceHandoffSummary!(producer)).toMatchObject({ status: "summary_rejected" }); expect(prepared.produceHandoffSummary).toHaveBeenCalledWith(producer);
  const binding = { sessionId: "fictional-handle", sessionKeepAlive: true };
  expect((await lease.run(binding)).text).toBe("Prepared fictional answer"); expect(prepared.run).toHaveBeenCalledWith(binding);
  await lease.close(); expect(prepared.close).toHaveBeenCalledTimes(1);
});

it("refuses method-only preparation and invalid requests without invoking kernel preparation", async () => {
  kernel.nativePreparedDispatch = undefined;
  const runtime = createMonoRuntime(); expect(runtime.nativePreparedDispatch).toBeUndefined();
  const options = { model, messages: [], abortSignal: new AbortController().signal };
  await expect(runtime.prepareNativeDispatch!("Rules", options)).rejects.toMatchObject({ code: "runtime_backend_unavailable" });
  await expect(runtime.prepareNativeDispatch!("", options)).rejects.toMatchObject({ code: "invalid_runtime_options" });
  await expect(runtime.prepareNativeDispatch!("Rules", { ...options, model: { ...model, reference: "wrong" } })).rejects.toMatchObject({ code: "invalid_model_reference" });
  expect(kernel.prepareNativeDispatch).not.toHaveBeenCalled();
});

it("forwards Pi dispatch progress without dropping fields", async () => {
  const dispatchProgress = { version: 1 as const, armed: true, assistantOutput: true, toolAdmitted: true, liveInputTaken: true };
  kernel.run.mockResolvedValueOnce({ text: "Fictional result", dispatchProgress });
  const result = await createMonoRuntime().run("Fictional rules", { model, messages: [], abortSignal: new AbortController().signal });
  expect(result.dispatchProgress).toEqual(dispatchProgress);
});
