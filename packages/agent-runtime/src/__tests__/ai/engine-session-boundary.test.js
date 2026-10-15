import { afterEach, expect, it, vi } from "vitest";
vi.mock("@mono-agent/engine/sessions.js", { spy: true });
import * as storage from "@mono-agent/engine/sessions.js";
import { resolveSession, commitSession, captureSessionRecovery } from "../../ai/providers/engine-turn/session-lifecycle.js";
import { createManagedNativeJournalStorage } from "../../ai/providers/engine-turn/native-journal-storage.js";
import { checkNativeInheritedPrefix } from "../../ai/providers/engine-turn/handoff-producer.js";
import { createSessionRegistry, syncProviderSession, refreshProviderSession, disposeProviderSession } from "../../ai/runtime/sessions.js";
afterEach(() => vi.restoreAllMocks());

it.each([
  ["session_busy", "pi_session_busy", "session fictional is busy with another turn"],
  ["session_not_found", "pi_session_not_found", "session fictional is not live"],
  ["native_journal_unreadable", "pi_session_unreadable", "session fictional catalogue could not be read; native evidence was preserved"],
])("keeps the legacy unavailable result byte-equivalent for %s", async (failureKind, code, message) => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  vi.spyOn(storage, "resolveSession").mockResolvedValue({ status: "unavailable", unavailable: { sessionId: "fictional", failureKind, code, message } });
  const events = [], runtimeWarnings = [];
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
  expect(storage.commitSession.mock.calls[0][1]).toMatchObject({ keepAlive: true, failed: true, externalAbort: false });
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

it("always supplies runtime prefix preflight through the published factory", () => {
  const native = createManagedNativeJournalStorage({ sessionsRoot: "/fictional/native" });
  expect(native.checkInheritedPrefix).toBe(checkNativeInheritedPrefix);
  expect(storage.createManagedNativeJournalStorage({ sessionsRoot: "/fictional/native" })).not.toHaveProperty("checkInheritedPrefix");
});
