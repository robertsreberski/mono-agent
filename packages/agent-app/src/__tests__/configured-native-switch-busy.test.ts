import { expect, it, vi } from "vitest";
import type { AgentHarness, AgentHarnessRequest, ConversationHistoryStore } from "@mono-agent/agent-harness";
import { serializeNativeSwitchHarness } from "../configured-native-switch.js";

it("preserves retryable busy when bounded drain fails, with no hidden run retry", async () => {
  const run = vi.fn(async () => ({ metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] },
    failure: { kind: "native_switch_busy", message: "Fictional busy", details: { retryable: true } } }));
  const store: ConversationHistoryStore = { load: async () => [], append: async () => {}, drainPendingProviderSessionTurns: async () => { throw new Error("Fictional drain failure"); } };
  const harness = serializeNativeSwitchHarness({ run }, "fictional-drain-root", store);
  const request: AgentHarnessRequest = { conversationId: "fictional", userMessage: "Fictional input", abortSignal: new AbortController().signal };
  expect((await harness.run(request)).failure).toMatchObject({ kind: "native_switch_busy", details: { retryable: true, drain: "failed" } });
  expect(run).toHaveBeenCalledOnce();
});

it("disposal waits for active cleanup once and does not cancel an unrelated responder", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const response = { metadata: { runId: "fictional-run", conversationId: "fictional", contextSources: [], contextSectionIds: [] } };
  const store: ConversationHistoryStore = { load: async () => [], append: async () => {} };
  const dispose = vi.fn(async () => { release(); });
  const first: AgentHarness = { run: async () => { entered(); await gate; return response; }, dispose };
  const a = serializeNativeSwitchHarness(first, "fictional-dispose-root", store);
  const run = vi.fn(async () => response), b = serializeNativeSwitchHarness({ run }, "fictional-dispose-root", store);
  const request: AgentHarnessRequest = { conversationId: "fictional", userMessage: "Fictional input", abortSignal: new AbortController().signal };
  const active = a.run(request); await started; const queued = b.run(request);
  const disposing = a.dispose!(); expect(a.dispose!()).toBe(disposing); await disposing; await active; await queued;
  expect(dispose).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
});
