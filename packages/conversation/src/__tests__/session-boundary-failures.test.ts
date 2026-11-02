import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RuntimeEventLike } from "@mono-agent/observability";
import { createConversationHarness, createDurableHistoryStore, ToolHistoryReader, ToolHistoryWriter } from "../index.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const primary = { sdk: "pi", provider: "faux", model: "fixture", reference: "pi:faux:fixture" } as const;

async function fixture(path: "cold" | "retry", failure?: "extension" | "resolver" | "cancel", throwOnBoundary = false) {
  const root = await mkdtemp(join(tmpdir(), "boundary-failures-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const identityPath = join(root, "IDENTITY.md"); await writeFile(identityPath, "Fictional fixture.");
  const writer = await ToolHistoryWriter.open({ root }); cleanups.push(() => writer.close());
  const old = { conversationId: "fictional", logicalConversationId: "fictional", runId: "old", isolated: false };
  await writer.persist(old, { phase: "invocation", toolCallId: "fictional-call", toolName: "Read", arguments: {} });
  await writer.persist(old, { phase: "result", toolCallId: "fictional-call", state: "success", content: "Fictional retained evidence." });
  await writer.finishRun(old, "completed");
  const store = createDurableHistoryStore({ root: join(root, "canonical"), retireProviderSession: async () => {} });
  await store.append("fictional", [{ role: "user", content: "Fictional earlier request." }]);
  const events: RuntimeEventLike[] = [];
  let armed = false, retrySeen = false, providerCalls = 0;
  let controller = new AbortController();
  const shouldFail = () => armed && (path === "cold" || retrySeen);
  const harness = createConversationHarness({ identityPath, model: primary, historyStore: store,
    sessionsRoot: join(root, "native"), session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000 },
    toolHistory: { writer, reader: new ToolHistoryReader(root), logicalConversationId: id => id, continuityEnabled: true,
      historyToolAvailabilityForRuntime: () => {
        if (shouldFail() && failure === "resolver") throw new Error("Fictional resolver failure");
        return { conversationHistory: false, sessionHistory: false };
      } },
    runtimeOptionsForRequest: ({ request }) => {
      if (shouldFail() && failure === "extension") throw new Error("Fictional extension failure");
      if (shouldFail() && failure === "cancel") controller.abort(new Error("Fictional cancellation"));
      const other = (request.metadata?.web as { model?: string } | undefined)?.model === "faux:other";
      return { runtimeOptions: { model: other ? { ...primary, model: "other", reference: "pi:faux:other" } : primary } };
    },
    runtime: { async run(_prompt, options) {
      providerCalls++;
      if (armed && path === "retry" && !retrySeen) {
        retrySeen = true;
        throw Object.assign(new Error("Fictional missing session"), { failureKind: "session_not_found" });
      }
      options.onEvent?.({ type: "runtime_warning", warning_kind: "fictional_provider_marker", message: "Fictional provider event" });
      return { text: "Fictional answer.", providerSessionId: typeof options.sessionId === "string" ? options.sessionId : null };
    }, async refreshSession() {}, async syncSession() { return true; }, async disposeAllSessions() {} },
  });
  cleanups.push(() => harness.dispose!());
  const run = async (second = false) => {
    controller = new AbortController();
    return await harness.run({ conversationId: "fictional", userMessage: "Fictional request", abortSignal: controller.signal,
      ...(second && path === "cold" ? { metadata: { web: { model: "faux:other" } } } : {}), onEvent: event => {
        events.push(event);
        if (armed && throwOnBoundary && event.type === "session_boundary") throw new Error("Fictional event consumer failure");
      } });
  };
  expect((await run()).failure).toBeUndefined();
  events.length = 0; providerCalls = 0; armed = true;
  return { run: () => run(true), events, calls: () => providerCalls };
}

it.each(["cold", "retry"] as const)("publishes exactly one %s boundary on every pre-dispatch failure/cancellation", async path => {
  for (const failure of ["extension", "resolver", "cancel"] as const) {
    const f = await fixture(path, failure), result = await f.run();
    expect(result.failure).toBeDefined();
    expect(f.calls()).toBe(path === "retry" ? 1 : 0);
    const boundaries = f.events.filter(event => event.type === "session_boundary" && event.kind === "resume_replay");
    expect(boundaries, `${path}/${failure}`).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ reason: path === "cold" ? "model_change" : "resume_error", context: "reconstructed",
      toolProjectionRecords: 1 });
    expect(boundaries[0]!.toolProjectionBytes).toBeGreaterThan(0);
  }
});

it("documents deferred boundary order for a custom runtime that does not call coldContext", async () => {
  const f = await fixture("cold");
  expect((await f.run()).failure).toBeUndefined();
  const index = (type: string) => f.events.findIndex(event => event.type === type);
  const provider = f.events.findIndex(event => event.warning_kind === "fictional_provider_marker");
  const boundaries = f.events.filter(event => event.type === "session_boundary" && event.kind === "resume_replay");
  expect(boundaries).toHaveLength(1);
  expect(index("run_config")).toBeGreaterThanOrEqual(0);
  expect(index("turn_context")).toBeGreaterThan(index("run_config"));
  expect(provider).toBeGreaterThan(index("turn_context"));
  const boundary = f.events.indexOf(boundaries[0]!);
  expect(boundary).toBeGreaterThan(provider);
  expect(index("provider_bridge_latency")).toBeGreaterThan(boundary);
});

it("preserves a cold extension failure when the boundary event consumer throws during cleanup", async () => {
  const f = await fixture("cold", "extension", true), result = await f.run();
  expect(result.failure?.message).toBe("Fictional extension failure");
  expect(f.calls()).toBe(0);
  expect(f.events.filter(event => event.type === "session_boundary" && event.kind === "resume_replay")).toHaveLength(1);
});
