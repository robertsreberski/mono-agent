import { it, expect, vi } from "vitest";
const kernel = vi.hoisted(() => ({ run: vi.fn(async (_system: string, _options: Record<string, any>) => ({ text: "Fictional answer" })) }));
vi.mock("@mono-agent/agent-runtime", () => ({ createRuntime: () => kernel, createRouterRuntime: () => kernel }));
import { createMonoRuntime } from "../runtime-adapter.js";
import type { RuntimeNativeSessionAuthority, RuntimeNativeSessionProjection } from "../types.js";
const model = { provider: "faux", model: "fixture", reference: "faux:fixture" };
it.each([false, true])("forwards host native authority/projection unchanged through the facade (routed=%s)", async (routed) => {
  const authority: RuntimeNativeSessionAuthority = { version: 1, currentHandleId: "a".repeat(64),
    hostAuthority: { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertCurrent: vi.fn(async () => {}) };
  const projection: RuntimeNativeSessionProjection = { version: 1, artifact: { id: "3".repeat(64), hash: "4".repeat(64) },
    inherited: { messages: [{ role: "user", content: "Fictional retained data" }], coverage: { version: 1, sources: [{ journalId: "retained", sourceTipId: null, sourceSeq: 0, sourceDigest: "5".repeat(64) }] } } };
  const runtime = createMonoRuntime(routed ? { fallbackChain: [{ model }] } : {});
  await runtime.run("Fictional rules", { model, messages: [], abortSignal: new AbortController().signal, nativeSessionAuthority: authority, nativeSessionProjection: projection });
  expect(kernel.run.mock.calls.at(-1)?.[1]).toMatchObject({ nativeSessionAuthority: authority, nativeSessionProjection: projection });
  expect(kernel.run.mock.calls.at(-1)?.[1].nativeSessionAuthority.assertCurrent).toBe(authority.assertCurrent);
});
