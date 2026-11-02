import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";
import { createConversationHarness, createDurableHistoryStore, createToolPolicy, ToolHistoryReader, ToolHistoryWriter } from "../index.js";
import { prepareToolHistoryProjection, renderToolHistoryProjection } from "../tool-history/projection.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const model = { sdk: "pi", provider: "faux", model: "fixture", reference: "pi:faux:fixture" } as const;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "history-availability-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const identityPath = join(root, "IDENTITY.md"); await writeFile(identityPath, "Fictional fixture.");
  const writer = await ToolHistoryWriter.open({ root }); cleanups.push(() => writer.close());
  const reader = new ToolHistoryReader(root);
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "old", isolated: false };
  await writer.persist(binding, { phase: "invocation", toolCallId: "call", toolName: "Read", arguments: {} });
  await writer.persist(binding, { phase: "result", toolCallId: "call", state: "success", content: "Fictional cobalt é evidence." });
  await writer.finishRun(binding, "completed");
  return { root, identityPath, writer, reader };
}

it.each([[true, true], [true, false], [false, true], [false, false]])(
  "resolves both tools late and reuses that header for detached replay (%s, %s)", async (conversationHistory, sessionHistory) => {
    const f = await fixture();
    const read = vi.spyOn(f.reader, "latestProjection");
    const resolver = vi.fn(() => ({ conversationHistory, sessionHistory }));
    let replay = "", detached = "";
    const events: Record<string, unknown>[] = [];
    const harness = createConversationHarness({ identityPath: f.identityPath, model,
      toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id,
        conversationHistoryAvailable: true, historyToolAvailabilityForRuntime: resolver },
      runtime: { async run(_prompt, options) {
        replay = options.messages!.map(message => message.content).join("\n");
        detached = (await options.detachedContext!()).map(message => message.content).join("\n");
        return { text: "Fictional answer." };
      } },
    });
    cleanups.push(() => harness.dispose!());
    expect((await harness.run({ conversationId: "fictional", userMessage: "Inspect", abortSignal: new AbortController().signal, onEvent: event => events.push(event) })).failure).toBeUndefined();
    expect(replay).toContain("Fictional cobalt é evidence."); expect(detached).toContain("Fictional cobalt é evidence.");
    const route = conversationHistory ? "ConversationHistory" : sessionHistory ? "SessionHistory" : undefined;
    for (const text of [replay, detached]) {
      if (route) expect(text).toContain(`Use ${route} for retained details.`);
      else expect(text).not.toMatch(/Use (ConversationHistory|SessionHistory)/u);
    }
    expect(resolver).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
    const forwarded = detached.slice(detached.indexOf("Untrusted historical tool data;"));
    const boundary = events.find(event => event.type === "session_boundary" && event.reason === "detached_context");
    expect(boundary).toMatchObject({ toolProjectionBytes: Buffer.byteLength(forwarded, "utf8"), toolProjectionRecords: 1 });
  });

it.each([false, true])("resolves after authoritative policy override; toolsDisabled=%s wins", async (toolsDisabled) => {
  const f = await fixture();
  const resolver = vi.fn((runtime: Readonly<Record<string, unknown>>) => {
    expect(runtime.allowedTools).toEqual(["SessionHistory"]);
    expect(runtime.disallowedTools).toEqual(["ConversationHistory"]);
    return { conversationHistory: false, sessionHistory: true };
  });
  let replay = "";
  const harness = createConversationHarness({ identityPath: f.identityPath, model,
    toolPolicy: createToolPolicy({ allowedTools: ["*"] }), runtimeOptions: { allowedTools: ["ConversationHistory"] },
    runtimeOptionsForRequest: () => ({ toolPolicyOverride: createToolPolicy({ allowedTools: ["SessionHistory"], disallowedTools: ["ConversationHistory"] }) }),
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id, historyToolAvailabilityForRuntime: resolver },
    runtime: { async run(_prompt, options) { replay = options.messages!.map(message => message.content).join("\n"); return { text: "Fictional answer." }; } },
  });
  cleanups.push(() => harness.dispose!());
  expect((await harness.run({ conversationId: "fictional", userMessage: "Inspect", abortSignal: new AbortController().signal,
    ...(toolsDisabled ? { continuation: { continuationId: "fictional-continuation", originRunId: "old", originContextPolicy: "detached_latest" as const, toolsDisabled: true as const, deferHistoryCommit: true as const } } : {}) })).failure).toBeUndefined();
  if (toolsDisabled) { expect(resolver).not.toHaveBeenCalled(); expect(replay).not.toContain("Use SessionHistory"); }
  else { expect(resolver).toHaveBeenCalledOnce(); expect(replay).toContain("Use SessionHistory"); }
});

it("keeps projection blocks cloneable and bounded before late routing/exclusions without refill", async () => {
  const f = await fixture(), read = vi.spyOn(f.reader, "latestProjection");
  const prepared = prepareToolHistoryProjection(f.reader, "fictional", "fictional", "current", new Set())!;
  const copy = structuredClone(prepared);
  expect(JSON.stringify(copy)).not.toContain("Use ConversationHistory");
  const healthy = renderToolHistoryProjection(copy, { conversationHistory: true, sessionHistory: true })!;
  expect(healthy.text).toContain('id="sth1_');
  expect(renderToolHistoryProjection(copy, { conversationHistory: false, sessionHistory: false })!.text).not.toMatch(/Use .*History/u);
  expect(renderToolHistoryProjection(copy, { conversationHistory: true, sessionHistory: true }, new Set(copy.blocks.map(block => block.callId)))).toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
});

it("manual compaction never routes to either tool, even with both configured available", async () => {
  const f = await fixture();
  const store = createDurableHistoryStore({ root: join(f.root, "canonical"), retireProviderSession: async () => {} });
  await store.append("fictional", [{ role: "user", content: "Fictional old request." }]);
  let received: RuntimeRunOptions | undefined;
  const harness = createConversationHarness({ identityPath: f.identityPath, model, historyStore: store,
    sessionsRoot: join(f.root, "native"), session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000 },
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id,
      conversationHistoryAvailable: true, sessionHistoryAvailable: true,
      historyToolAvailabilityForRuntime: () => { throw new Error("Manual compaction must not resolve live endpoints"); } },
    runtime: { async run(_prompt, options) { received = options; return { providerSessionId: options.sessionId,
      manualCompaction: { status: "succeeded", trigger: "manual", operationId: "fictional", tokensBefore: 1000, tokensAfter: 300, tokenCountsExact: false } } as never; },
      async refreshSession() {}, async syncSession() { return true; }, async disposeAllSessions() {} },
  });
  cleanups.push(() => harness.dispose!());
  expect(await harness.compactConversation!("fictional")).toMatchObject({ status: "succeeded" });
  const text = received!.messages!.map(message => message.content).join("\n");
  expect(text).toContain("Fictional cobalt é evidence."); expect(text).not.toMatch(/Use (ConversationHistory|SessionHistory)/u);
  expect(received!.allowedTools).toEqual([]); expect(received!.mcpServers).toEqual({});
});

it("bounds the suffix with the longest late header, including a five-byte availability upgrade", async () => {
  const f = await fixture(), source = f.reader.latestProjection("fictional", "fictional", "current")[0]!;
  let chunk = "";
  vi.spyOn(f.reader, "latestProjection").mockImplementation(() => [{ ...source, result: { ...source.result!, chunk } }]);
  const base = prepareToolHistoryProjection(f.reader, "fictional", "fictional", "current")!;
  const shorter = renderToolHistoryProjection(base, { conversationHistory: false, sessionHistory: true })!;
  // This candidate fits the old configured SessionHistory header exactly, but
  // must not be selected when the late ConversationHistory header is possible.
  chunk = "x".repeat(64 * 1024 - Buffer.byteLength(shorter.text));
  const prepared = prepareToolHistoryProjection(f.reader, "fictional", "fictional", "current")!;
  expect(prepared.truncated).toBe(true); expect(prepared.recordCount).toBe(0);
  for (const availability of [
    { conversationHistory: true, sessionHistory: true }, { conversationHistory: false, sessionHistory: true },
    { conversationHistory: false, sessionHistory: false },
  ]) expect(Buffer.byteLength(renderToolHistoryProjection(prepared, availability)!.text)).toBeLessThanOrEqual(64 * 1024);
});
