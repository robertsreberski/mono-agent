import type { MockedFunction } from "vitest";
import type { RuntimeEvent } from "../../contracts/events.js";
import type { PiWarning } from "../../execution/pi/types.js";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@mono-agent/turn/engine/sessions.js", { spy: true });
import * as storage from "@mono-agent/turn/engine/sessions.js";
import { resolveSession, commitSession, captureSessionRecovery } from "../../execution/pi/session-results.js";
import { createManagedNativeJournalStorage } from "../../execution/pi/storage-capability.js";
import { checkNativeInheritedPrefix } from "../../execution/pi/handoff-producer.js";
import { createSessionRegistry, syncProviderSession, refreshProviderSession, disposeProviderSession } from "../../runtime/session-fanout.js";
afterEach(() => vi.restoreAllMocks());

it.each([
  ["session_busy", "pi_session_busy", "Session fictional is busy with another turn"],
  ["session_not_found", "pi_session_not_found", "Session fictional is not live"],
  ["native_journal_unreadable", "pi_session_unreadable", "session fictional catalogue could not be read; native evidence was preserved"],
])("keeps the legacy unavailable result byte-equivalent for %s", async (failureKind, code, message) => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  vi.spyOn(storage, "resolveSession").mockResolvedValue({ status: "unavailable", unavailable: { sessionId: "fictional", failureKind, code, message } });
  const events: RuntimeEvent[] = [], runtimeWarnings: PiWarning[] = [];
  const actual = await resolveSession({}, { requestedSessionId: "fictional", providerSessionId: "fictional", resolved: { reference: "faux:fixture" },
    options: { effort: "none" }, events, runtimeWarnings, start: 993, piTransport: "auto" });
  const expected = { done: true, result: { text: null, events, usage: {}, durationMs: 7, numTurns: 0, model: "faux:fixture", effort: "none", sdk: "pi", cancelled: false,
    error: message, failureKind, providerSessionId: "fictional", runtimeWarnings, diagnostics: { provider_session_id: "fictional", pi_error_code: code, pi_engine: "native", pi_transport_requested: "auto" } } };
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
});

it("builds the same persistence warning in runtime and preserves receipt translation", async () => {
  vi.spyOn(storage, "commitSession").mockResolvedValue({ status: "settled", persistFailure: { code: "ENOSPC", message: "Fictional persistence failure" } });
  const onEvent = vi.fn();
  expect(await commitSession({}, { options: { sessionKeepAlive: true }, onEvent, errorMessage: "failure", externalAbort: false })).toBeUndefined();
  expect(onEvent.mock.calls).toEqual([[{ type: "runtime_warning", warning_kind: "pi_session_persist_failed", message: "Fictional persistence failure" }]]);
  expect((storage.commitSession as MockedFunction<typeof storage.commitSession>).mock.calls[0]![1]).toMatchObject({ keepAlive: true, failed: true, externalAbort: false });
  const receipt = { runId: "run", revision: 1, providerSessionId: "fictional", modelKey: "faux:fixture", tipId: "tip" };
  vi.spyOn(storage, "captureSessionRecovery").mockResolvedValue({ status: "captured", receipt });
  expect(await captureSessionRecovery({}, { options: { sessionRecovery: { runId: "run", revision: 1 } }, providerSessionId: "fictional", modelKey: "faux:fixture" })).toBe(receipt);
});

it("keeps native registry identity in runtime fan-out and registers only runtime-created registries", async () => {
  const repo = { delete: vi.fn() }, id = "fictional-fanout";
  storage.nativeSessionRegistry.set(id, { metadata: { id }, repo, durable: false, busy: false });
  expect(await syncProviderSession(id)).toBe(true);
  await refreshProviderSession(id);
  expect(storage.nativeSessionRegistry.get(id)).toBeUndefined(); expect(repo.delete).toHaveBeenCalledOnce();
  const registered = createSessionRegistry(), standalone = storage.createSessionRegistry();
  registered.set(id, {}); standalone.set(id, {});
  expect(await disposeProviderSession(id)).toBe(true); expect(registered.get(id)).toBeUndefined(); expect(standalone.get(id)).toEqual({});
  await standalone.disposeAll();
});

it("always supplies runtime prefix preflight through the published factory", async () => {
  const native = createManagedNativeJournalStorage({ sessionsRoot: "/fictional/native" });
  const producer = await import("../../execution/pi/handoff-producer.js");
  const fit = { status: "ready" };
  vi.spyOn(producer, "checkNativeInheritedPrefix").mockResolvedValue(fit as never);
  const messages = Object.freeze([{ role: "user", content: "Fictional input." }]);
  const model = { provider: "faux", id: "fixture", api: "faux", contextWindow: 32000, maxTokens: 4096 };
  const compaction = { enabled: true };
  expect(await native.checkInheritedPrefix(messages, model, compaction, 10)).toBe(fit);
  expect(checkNativeInheritedPrefix).toHaveBeenCalledOnce();
  const [copiedMessages, actualModel, actualCompaction, prefixTokenCap] = (checkNativeInheritedPrefix as MockedFunction<typeof checkNativeInheritedPrefix>).mock.calls[0]!;
  expect(copiedMessages).toEqual(messages);
  expect(copiedMessages).not.toBe(messages);
  expect(actualModel).toBe(model);
  expect(actualCompaction).toBe(compaction);
  expect(prefixTokenCap).toBe(10);
  expect(storage.createManagedNativeJournalStorage({ sessionsRoot: "/fictional/native" })).not.toHaveProperty("checkInheritedPrefix");
});
