import { expect, it, vi } from "vitest";
import type { AgentHarness, AgentHarnessRequest, ConversationHistoryStore } from "@mono-agent/agent-harness";
import { serializeNativeSwitchHarness } from "../configured-native-switch.js";

const store: ConversationHistoryStore = { load: async () => [], append: async () => {} };
const request = (conversationId = "fictional") => ({ conversationId, userMessage: "Fictional input", abortSignal: new AbortController().signal });
const response = { metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] } };
function latch() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  return { gate, started, release: () => release(), enter: () => entered() };
}

it("disposes an unadmitted waiter before a foreign turn releases the same conversation gate", async () => {
  const lock = latch();
  const foreign = serializeNativeSwitchHarness({ run: async () => { lock.enter(); await lock.gate; return response; } }, "fictional-foreign-root", store);
  const run = vi.fn(async () => response), dispose = vi.fn(async () => {});
  const local = serializeNativeSwitchHarness({ run, dispose }, "fictional-foreign-root", store);
  const active = foreign.run(request()); await lock.started;
  try {
    const queued = local.run(request());
    const cancelled = expect(queued).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
    await local.dispose!(); // Deliberately await while foreign gate is still held.
    await cancelled; expect(run).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  } finally { lock.release(); await active; }
});

it("request abort rejects queued submit immediately without releasing later entries ahead of the predecessor", async () => {
  const lock = latch();
  const first = serializeNativeSwitchHarness({ run: async () => response, submit: async () => { lock.enter(); await lock.gate; return response; } }, "fictional-submit-root", store);
  const submit = vi.fn(async () => response), next = serializeNativeSwitchHarness({ run: async () => response, submit }, "fictional-submit-root", store);
  const active = first.submit!(request()); await lock.started;
  const controller = new AbortController();
  const queued = next.submit!({ ...request(), abortSignal: controller.signal });
  const rejected = expect(queued).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
  controller.abort(); await rejected;
  const later = next.submit!(request()); await Promise.resolve(); expect(submit).not.toHaveBeenCalled();
  lock.release(); await active; await later; expect(submit).toHaveBeenCalledOnce();
});

it("a held conversation does not gate another conversation on the same root", async () => {
  const lock = latch();
  const first = serializeNativeSwitchHarness({ run: async () => { lock.enter(); await lock.gate; return response; } }, "fictional-parallel-root", store);
  const run = vi.fn(async () => response), other = serializeNativeSwitchHarness({ run }, "fictional-parallel-root", store);
  const active = first.run(request("fictional-A")); await lock.started;
  try { await other.run(request("fictional-B")); expect(run).toHaveBeenCalledOnce(); }
  finally { lock.release(); await active; }
});

it("nested same-root append/import complete for other conversations and refuse same-conversation self-waits", async () => {
  const append = vi.fn(async () => {}), importContext = vi.fn(async () => ({ status: "appended" as const }));
  const nested = serializeNativeSwitchHarness({ run: async () => response, appendVerbatimTurn: append, importContext }, "fictional-nested-root", store);
  const raw: AgentHarness = { run: async () => response, submit: async () => {
    await nested.appendVerbatimTurn!("fictional-B", "Fictional delivered text");
    await nested.importContext!("fictional-C", { text: "Fictional context", idempotencyKey: "fictional-import" });
    await expect(nested.appendVerbatimTurn!("fictional-A", "Must not wait"))
      .rejects.toMatchObject({ failureKind: "native_switch_busy", details: { retryable: true } });
    await expect(nested.importContext!("fictional-A", { text: "Must not wait", idempotencyKey: "fictional-self-import" }))
      .rejects.toMatchObject({ failureKind: "native_switch_busy", details: { retryable: true } });
    return response;
  } };
  // APP responders prefer submit: its scope must detect the nested owner too.
  const outer = serializeNativeSwitchHarness(raw, "fictional-nested-root", store);
  await outer.submit!(request("fictional-A")); expect(append).toHaveBeenCalledOnce(); expect(importContext).toHaveBeenCalledOnce();
});

it("nested return to an active ancestor conversation refuses before another claim", async () => {
  let first!: AgentHarness;
  const second = serializeNativeSwitchHarness({ run: async () => {
    await expect(first.run(request("fictional-A"))).rejects.toMatchObject({ failureKind: "native_switch_busy" }); return response;
  } }, "fictional-ancestor-root", store);
  first = serializeNativeSwitchHarness({ run: async () => { await second.run(request("fictional-B")); return response; } }, "fictional-ancestor-root", store);
  await first.run(request("fictional-A"));
});

it("trimmed daily buckets share the durable logical fence even without rollover", async () => {
  const lock = latch();
  const first = serializeNativeSwitchHarness({ run: async () => { lock.enter(); await lock.gate; return response; } }, "fictional-daily-root", store);
  const run = vi.fn(async () => response), second = serializeNativeSwitchHarness({ run }, "fictional-daily-root", store);
  const active = first.run(request("  fictional#2000-01-01  ")); await lock.started;
  const next = second.run(request(" fictional#2000-01-02 ")); await Promise.resolve(); expect(run).not.toHaveBeenCalled();
  await second.run(request("fictional-other#2000-01-02")); expect(run).toHaveBeenCalledOnce();
  lock.release(); await active; await next; expect(run).toHaveBeenCalledTimes(2);
});
