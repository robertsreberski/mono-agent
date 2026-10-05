import { createRetryStream } from "../retry-stream.js";
import { describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
vi.mock("@earendil-works/pi-agent-core", { spy: true });
import * as agentCore from "@earendil-works/pi-agent-core";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { buildHarnessSessionContext } from "../session-context.js";
import { MemorySessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";

async function harness(responses, retry, modelDef = {}, tools = [], tokensPerSecond = undefined) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "retry-fixture", ...modelDef }], tokensPerSecond });
  const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  const repo = new MemorySessionRepo(); const raw = await repo.create();
  const adapter = createRunDriver(raw, {
    models, model: faux.getModel(), tools, systemPrompt: "Fictional test.", thinkingLevel: "off",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, ...retry },
  });
  return { adapter, raw, faux };
}
const error = (text) => fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
describe("owned run driver", () => {
  it("retries only the failed request and persists/bills each attempt in event order", async () => {
    const { adapter, raw, faux } = await harness([error("503 service unavailable"), fauxAssistantMessage([fauxText("done")])]);
    const events = []; adapter.subscribe((e) => events.push(e));
    try {
      expect((await adapter.prompt("Fictional request.")).status).toBe("completed");
      expect(faux.state.callCount).toBe(2);
      const boundaries = events.filter((e) => ["run_start", "message_start", "message_end", "retry_scheduled", "retry_start", "retry_end", "turn_end", "run_end"].includes(e.type));
      expect(boundaries.map((e) => e.type)).toEqual([
        "run_start", "message_start", "message_end", "message_start", "message_end", "retry_scheduled",
        "retry_start", "message_start", "retry_end", "message_end", "turn_end", "run_end",
      ]);
      expect(new Set(events.map((e) => e.runId)).size).toBe(1);
      expect((await raw.getEntries()).filter((e) => e.message.role === "assistant").map((e) => e.message.stopReason)).toEqual(["error", "stop"]);
      expect(await raw.getOpenTurns()).toEqual([]);
    } finally { await adapter.close(); await raw.close(); }
  });
  it.each([
    ["billing quota exceeded", undefined],
    ["503 service unavailable", { enabled: false, maxRetries: 0 }],
  ])("does not retry deterministic errors or provider health checks (%s)", async (text, retry) => {
    const { adapter, raw, faux } = await harness([error(text)], retry);
    try { expect((await adapter.prompt("Fictional request.")).status).toBe("failed"); expect(faux.state.callCount).toBe(1); }
    finally { await adapter.close(); await raw.close(); }
  });
  it("aborts during backoff without repeating a request or billing the failed attempt twice", async () => {
    const { adapter, raw, faux } = await harness([error("503 service unavailable")], { baseDelayMs: 10000 });
    const events = [];
    adapter.subscribe((event) => { events.push(event); if (event.type === "retry_scheduled") void adapter.abort(); });
    try {
      expect((await adapter.prompt("Fictional request.")).status).toBe("aborted");
      expect(faux.state.callCount).toBe(1);
      expect((await raw.getEntries()).filter((e) => e.message.role === "assistant")).toHaveLength(1);
      expect(events.filter((e) => e.type === "message_end" && e.message.role === "assistant")).toHaveLength(1);
    } finally { await adapter.close(); await raw.close(); }
  });
});

it("preserves deferred admission without polling or replaying provider work", async () => {
  const { adapter, raw, faux } = await harness([]);
  const model = faux.getModel();
  const handle = { id: "fictional-deferred", provider: model.provider, modelId: model.id, api: model.api };
  faux.setResponses([fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })]);
  const events = []; adapter.subscribe((e) => events.push(e));
  try {
    expect(await adapter.prompt("Fictional request.")).toMatchObject({ status: "suspended", deferred: handle });
    expect(await raw.getOpenTurns()).toHaveLength(1);
    expect(events.some((e) => e.type === "run_suspend")).toBe(true);
    await adapter.abortOpenOperations();
    expect(await raw.getOpenTurns()).toHaveLength(0);
    expect(faux.state.callCount).toBe(1);
  } finally { await adapter.close(); await raw.close(); }
});

it.each([
  ["premature length", fauxAssistantMessage([fauxText("OK")], { stopReason: "length" }), { maxTokens: 64, contextWindow: 4096 }, "failed"],
  ["genuine output cap", fauxAssistantMessage([fauxText("four token reply")], { stopReason: "length" }), { maxTokens: 4, contextWindow: 4096 }, "completed"],
  ["silent overflow", fauxAssistantMessage([fauxText("OK")]), { maxTokens: 64, contextWindow: 1 }, "failed"],
  ["premature length with a tool call", fauxAssistantMessage([fauxToolCall("NeverExecute", {}, { id: "fictional-truncated-call" })], { stopReason: "length" }), { maxTokens: 64, contextWindow: 4096 }, "failed"],
])("preserves removed-harness response classification: %s", async (_name, response, modelDef, status) => {
  const { adapter, raw, faux } = await harness([response], undefined, modelDef);
  const events = []; adapter.subscribe((event) => events.push(event));
  try {
    expect((await adapter.prompt("Fictional request.")).status).toBe(status);
    expect(faux.state.callCount).toBe(1); // Overflow is not a transient retry.
    const final = (await raw.getEntries()).at(-1).message;
    expect(final.content).toEqual(response.content);
    expect(final.stopReason).toBe(status === "failed" ? "error" : "length");
    if (status === "failed") expect(final.errorMessage).toBe("Assistant request exceeded the context window");
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(events.find((event) => event.type === "turn_end").message).toMatchObject({ stopReason: final.stopReason, usage: final.usage });
  } finally { await adapter.close(); await raw.close(); }
});

it("seals one host turn only after overflow, compaction and re-prompt operations", async () => {
  const { adapter, raw, faux } = await harness([error("context window exceeded"), fauxAssistantMessage([fauxText("done")])], { enabled: false });
  const operations = [];
  try {
    await adapter.beginTurn("host-run-fictional", "host");
    expect((await adapter.prompt("Fictional request.", { onOperationAdmitted: (id) => operations.push(id) })).status).toBe("failed");
    expect(await raw.getTurn("host-run-fictional")).toBeNull();
    adapter.hooks.on("before_compaction", () => ({ compaction: { summary: "Fictional summary.", retainedTail: [], tokensBefore: 200 } }));
    await adapter.compact();
    expect((await adapter.prompt("Fictional request.", { onOperationAdmitted: (id) => operations.push(id) })).status).toBe("completed");
    await adapter.endTurn("completed");
    const records = raw.records.filter((r) => r.turnId === "host-run-fictional");
    const starts = records.filter((r) => r.kind === "operation_start");
    expect(starts.map((r) => r.payload.type)).toEqual(["prompt", "compaction", "prompt"]);
    expect(new Set(starts.map((r) => r.operationId)).size).toBe(3);
    expect(records.filter((r) => r.kind === "input_consumed")).toHaveLength(1);
    expect((await raw.getTurn("host-run-fictional")).payload).toMatchObject({ status: "completed", finalOperationId: operations[1] });
    expect(faux.state.callCount).toBe(2);
  } finally { await adapter.close(); await raw.close(); }
});

it("gives standalone manual compaction an explicitly synthetic promptless turn", async () => {
  const { adapter, raw, faux } = await harness([]);
  try {
    adapter.hooks.on("before_compaction", () => ({ compaction: { summary: "Fictional summary.", retainedTail: [], tokensBefore: 200 } }));
    await adapter.compact();
    const start = raw.records.find((r) => r.kind === "operation_start");
    expect(start.payload.type).toBe("compaction");
    const turn = raw.records.find((r) => r.kind === "turn_start" && r.turnId === start.turnId);
    expect(turn.payload.identitySource).toBe("synthetic");
    expect(start.turnId).toMatch(/^synthetic:manual-compaction:/);
    expect((await raw.getTurn(start.turnId)).payload.status).toBe("completed");
    expect(faux.state.callCount).toBe(0);
  } finally { await adapter.close(); await raw.close(); }
});

it.each([0, 3])("settles retry producer without scheduling retries after early consumer exit (maxRetries=%s)", async (maxRetries) => {
  const message = { role: "assistant", content: [], stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } };
  let signal, closed = false, calls = 0; const events = [];
  const model = { provider: "faux", id: "closed", contextWindow: 100000, maxTokens: 1000 };
  const models = { getModel: () => model, streamSimple: async (_model, _context, options) => {
    signal = options.signal; calls += 1;
    return { async *[Symbol.asyncIterator]() { try { yield { type: "start", partial: message }; yield { type: "text_delta", delta: "Fictional text." }; } finally { closed = true; } }, result: async () => message };
  } };
  const stream = createRetryStream(models, model, { messages: [] }, {}, { enabled: true, maxRetries, baseDelayMs: 0 }, async (event) => { events.push(event); });
  const iterator = stream[Symbol.asyncIterator](); expect((await iterator.next()).value.type).toBe("start");
  await iterator.return(); await expect(stream.result()).rejects.toThrow("consumer closed");
  expect(signal.aborted).toBe(true); expect(closed).toBe(true); expect(calls).toBe(1); expect(events).toEqual([]);
});

it("does not emit retry lifecycle after consumer exit while a retryable result settles", async () => {
  const model = { provider: "faux", id: "closed-result", contextWindow: 100000, maxTokens: 1000 };
  const message = error("503 service unavailable"); let resolveResult, resultEntered; let calls = 0;
  const pending = new Promise((resolve) => { resolveResult = resolve; }); const entered = new Promise((resolve) => { resultEntered = resolve; });
  const events = []; const models = { getModel: () => model, streamSimple: async () => {
    calls += 1; return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; }, result: () => { resultEntered(); return pending; } };
  } };
  const stream = createRetryStream(models, model, { messages: [] }, {}, { enabled: true, maxRetries: 3, baseDelayMs: 0 }, async (event) => { events.push(event); });
  const iterator = stream[Symbol.asyncIterator](); expect((await iterator.next()).value.type).toBe("start");
  const next = iterator.next(); await entered; const returned = iterator.return(); resolveResult(message);
  await next; await returned; await expect(stream.result()).rejects.toThrow("consumer closed");
  expect(calls).toBe(1); expect(events).toEqual([]);
});

it.each(["host", "instance"])("binds authoritative %s ownership append-only without enabling recovery", async (kind) => {
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("Fictional reply.")])]);
  const descriptor = { kind, ownerKey: "fictional-owner", historyBucket: kind === "host" ? "fictional-bucket" : null,
    turnId: "descriptor-turn", handleId: raw.metadata.id, baseRevision: kind === "host" ? 3 : null };
  try {
    await adapter.beginTurn(descriptor.turnId, kind, descriptor); await adapter.prompt("Fictional input."); await adapter.endTurn("completed");
    expect(raw.validator.owner).toEqual({ kind, ownerKey: descriptor.ownerKey, historyBucket: descriptor.historyBucket });
    expect(raw.validator.turns.get(descriptor.turnId).start.payload.identitySource).toBe(kind);
    expect(raw.validator.handleBindings.get(raw.metadata.id)).toMatchObject({ baseRevision: descriptor.baseRevision, authoritative: true });
    const bindings = raw.records.filter((record) => record.kind === "owner_binding"); expect(bindings.map((record) => record.payload.kind)).toEqual(["unbound", kind]);
    expect(raw.metadata.ownership).toBeUndefined(); // immutable header is not rewritten
    const seq = raw.seq;
    await expect(adapter.beginTurn("wrong-owner-turn", kind, { ...descriptor, turnId: "wrong-owner-turn", ownerKey: "other-owner" })).rejects.toThrow("ownership");
    expect(raw.seq).toBe(seq); expect(await raw.getOpenTurns()).toEqual([]);
    await expect(adapter.beginTurn("wrong-logical-turn", kind, descriptor)).rejects.toThrow("sessionTurn");
    expect(raw.seq).toBe(seq);
  } finally { await adapter.close(); await raw.close(); }
});

const fictionalTool = (name, execute) => ({ name, description: "Fictional effect", parameters: { type: "object", properties: {} }, execute });
it("fsyncs logical input, assistant calls, started admission and parallel outcomes before dispatch/return", async () => {
  let raw, durableSeq = 0, effects = 0;
  const tools = ["One", "Two"].map((name) => fictionalTool(name, async (callId) => {
    expect(raw.validator.calls.get(`${raw.activeOperationId()}\0${callId}`).admission).toBe("started");
    expect(durableSeq).toBe(raw.seq); effects += 1;
    return { content: [{ type: "text", text: `${name} fictional outcome` }] };
  }));
  const fixture = await harness([(context) => {
    expect([...raw.validator.turns.values()].at(-1).inputs.size).toBe(1); expect(durableSeq).toBe(raw.seq);
    return fauxAssistantMessage([fauxToolCall("One", {}, { id: "one" }), fauxToolCall("Two", {}, { id: "two" })]);
  }, () => {
    expect(raw.outcomes.size).toBe(2); expect(durableSeq).toBe(raw.seq); return fauxAssistantMessage([fauxText("done")]);
  }], undefined, {}, tools); raw = fixture.raw;
  raw.io = { append: async () => {}, sync: async () => { durableSeq = raw.seq; } };
  try { expect((await fixture.adapter.prompt("Fictional input.")).status).toBe("completed"); expect(effects).toBe(2);
    expect(raw.records.filter((record) => record.kind === "tool_result" && record.payload.phase === "returned")).toHaveLength(2);
    expect([...raw.validator.calls.values()].every((call) => call.placed)).toBe(true);
  } finally { await fixture.adapter.close(); await raw.close(); }
});

it.each(["input", "assistant", "admitted", "started", "returned"])("fails terminally at the %s fsync barrier without another effect/provider request", async (phase) => {
  let effects = 0;
  const { adapter, raw, faux } = await harness([fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "effect" })]), fauxAssistantMessage([fauxText("must not dispatch")])], undefined, {},
    [fictionalTool("Effect", async () => { effects += 1; return { content: [{ type: "text", text: "observed" }] }; })]);
  raw.io = { append: async () => {}, sync: async () => {
    const record = raw.records.at(-1); const matches = phase === "input" ? record.kind === "input_consumed"
      : phase === "assistant" ? record.kind === "tool_call" && record.payload.admission === "observed"
      : phase === "returned" ? record.kind === "tool_result" && record.payload.phase === "returned"
      : record.kind === "tool_call" && record.payload.admission === phase;
    if (matches) throw Object.assign(new Error("Fictional barrier failure"), { code: "ENOSPC" });
  } };
  try { await expect(adapter.prompt("Fictional input.")).rejects.toMatchObject({ name: "JournalStorageError", code: "ENOSPC" });
    expect(effects).toBe(phase === "returned" ? 1 : 0); expect(faux.state.callCount).toBe(phase === "input" ? 0 : 1);
  } finally { await adapter.close().catch(() => {}); await raw.close().catch(() => {}); }
});

it("drains already admitted parallel effects after a poisoned outcome barrier before releasing the driver", async () => {
  let started = 0, releaseSecond, bothStarted; const waitBoth = new Promise((resolve) => { bothStarted = resolve; });
  const waitSecond = new Promise((resolve) => { releaseSecond = resolve; });
  const tools = ["First", "Second"].map((name) => fictionalTool(name, async () => {
    started += 1; if (started === 2) bothStarted(); await waitBoth; if (name === "Second") await waitSecond;
    return { content: [{ type: "text", text: "Fictional completed effect" }] };
  }));
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxToolCall("First", {}, { id: "first" }), fauxToolCall("Second", {}, { id: "second" })])], undefined, {}, tools);
  raw.io = { append: async () => {}, sync: async () => { if (raw.records.at(-1).kind === "tool_result") throw new Error("Fictional poisoned outcome"); } };
  let settled = false; const pending = adapter.prompt("Fictional input."); void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitBoth; await new Promise((resolve) => setImmediate(resolve)); expect(raw.failure).toBeTruthy(); expect(settled).toBe(false);
    releaseSecond(); await expect(pending).rejects.toMatchObject({ name: "JournalStorageError" }); expect(started).toBe(2);
  } finally { releaseSecond(); await adapter.close().catch(() => {}); await raw.close().catch(() => {}); }
});

it("does not project an orphan result after abort mid tool-call stream, including provider transformation after compaction", async () => {
  let effects = 0; const fixture = await harness([fauxAssistantMessage([fauxToolCall("Effect", { note: "Fictional streamed arguments repeated to exercise mid-stream cancellation" }, { id: "draft-call" })])], { enabled: false }, {},
    [{ ...fictionalTool("Effect", async () => { effects += 1; return { content: [] }; }), parameters: { type: "object", properties: { note: { type: "string" } } } }], 1000);
  const { adapter, raw, faux } = fixture; let midStream = false;
  adapter.subscribe((event) => { if (event.type === "message_update" && event.message.content.some((part) => part.type === "toolCall")) { midStream = true; void adapter.abort(); } });
  try {
    expect((await adapter.prompt("Fictional tool request.")).status).toBe("aborted"); expect(midStream).toBe(true); expect(effects).toBe(0);
    const entries = await raw.getEntries(); const draft = entries.findLast((entry) => entry.message?.role === "assistant").message;
    expect(draft.stopReason).toBe("aborted"); expect(draft.content.some((part) => part.type === "toolCall")).toBe(true);
    expect([...raw.validator.calls.values()]).toEqual([]);
    const repairs = await raw.getRepairEntries(); expect(repairs).toHaveLength(1); expect(repairs[0].calls).toEqual([]);
    const assertTranscript = async () => {
      const context = buildHarnessSessionContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() });
      const provider = transformMessages(context, faux.getModel());
      expect(provider.filter((message) => message.role === "toolResult")).toEqual([]);
      expect(provider.filter((message) => message.role === "assistant")).toEqual([]);
      expect(JSON.stringify(provider)).not.toContain("draft-call");
    };
    await assertTranscript();
    // Even a legacy checkpoint that retained the draft and its old synthetic
    // result must not send a tool_result whose tool_use Pi discards.
    await raw.appendCompaction({ summary: "Fictional summary.", retainedTail: [draft,
      { role: "toolResult", toolCallId: "draft-call", toolName: "Effect", content: [], isError: true, projectionOnly: true, timestamp: 2 }], tokensBefore: 100 });
    await assertTranscript();
  } finally { await adapter.close(); await raw.close(); }
});

it("rejects provider schema evidence before append without poisoning or preventing the next turn", async () => {
  let effects = 0; const { adapter, raw, faux } = await harness([
    fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "duplicate" }), fauxToolCall("Effect", {}, { id: "duplicate" })]),
    fauxAssistantMessage([fauxText("Fictional next turn.")]),
  ], { enabled: false }, {}, [fictionalTool("Effect", async () => { effects += 1; return { content: [] }; })]);
  try {
    await expect(adapter.prompt("Fictional invalid calls.")).rejects.toThrow("Invalid provider tool-call evidence");
    expect(raw.failure).toBeNull(); expect(effects).toBe(0); expect([...raw.validator.calls.values()]).toEqual([]); expect(await raw.getOpenOperations()).toEqual([]);
    expect((await raw.getTurn(raw.records.findLast((record) => record.kind === "turn_start").turnId)).payload.status).toBe("failed");
    expect((await adapter.prompt("Fictional next input.")).status).toBe("completed"); expect(faux.state.callCount).toBe(2); await raw.sync();
  } finally { await adapter.close(); await raw.close(); }
});

it("limits after_tool merging to Pi's supported result keys", async () => {
  const original = { content: [{ type: "text", text: "Fictional original" }], details: { original: true }, custom: "keep-original" };
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "merged" })]), fauxAssistantMessage([fauxText("done")])], undefined, {}, [fictionalTool("Effect", async () => original)]);
  let executionResult; adapter.subscribe((event) => { if (event.type === "tool_execution_end") executionResult = event.result; });
  adapter.hooks.on("after_tool", () => ({ content: [{ type: "text", text: "Fictional override" }], details: { updated: true }, usage: { output: 3 }, terminate: false, isError: true, custom: "must-not-merge", unrelated: true }));
  try {
    expect((await adapter.prompt("Fictional input.")).status).toBe("completed");
    const returned = [...raw.outcomes.values()][0].record.payload.message;
    expect(returned).toMatchObject({ content: [{ type: "text", text: "Fictional override" }], details: { updated: true }, usage: { output: 3 }, isError: true });
    expect(executionResult).toMatchObject({ content: [{ type: "text", text: "Fictional override" }], details: { updated: true }, usage: { output: 3 }, terminate: false, custom: "keep-original" });
    expect(executionResult.unrelated).toBeUndefined();
    // Foreign hook keys must not enter host finalization or the returned SDK result.
    expect(original.custom).toBe("keep-original"); expect(returned.unrelated).toBeUndefined();
  } finally { await adapter.close(); await raw.close(); }
});

it("guards nested Pi runToolCall before any unjournaled effect with an explicit error, not a TypeError", async () => {
  let wrappedTools, nested, innerEffects = 0;
  const real = (await vi.importActual("@earendil-works/pi-agent-core")).runAgentLoop; const spy = vi.spyOn(agentCore, "runAgentLoop").mockImplementation((prompts, context, ...rest) => { wrappedTools = context.tools; return real(prompts, context, ...rest); });
  const tools = [fictionalTool("Outer", async (_id, _args, signal) => {
    nested = await agentCore.runToolCall({ type: "toolCall", id: "nested", name: "Inner", arguments: {} }, {
      assistantMessage: fauxAssistantMessage([]), context: { messages: [], tools: wrappedTools }, tools: wrappedTools, signal,
    }); return { content: [{ type: "text", text: "Outer fictional result" }] };
  }), fictionalTool("Inner", async () => { innerEffects += 1; return { content: [] }; })];
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxToolCall("Outer", {}, { id: "outer" })]), fauxAssistantMessage([fauxText("done")])], undefined, {}, tools);
  try {
    expect((await adapter.prompt("Fictional nested request.")).status).toBe("completed"); expect(innerEffects).toBe(0);
    expect(nested.isError).toBe(true); expect(nested.result.content[0].text).toContain("nested calls are unsupported");
    expect(nested.result.content[0].text).not.toContain("messageId"); expect([...raw.validator.calls.values()].map((call) => call.callId)).toEqual(["outer"]);
  } finally { spy.mockRestore(); await adapter.close(); await raw.close(); }
});

it("abortOpenOperations accounts only for open operations, not earlier completed model work", async () => {
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("Fictional complete operation.")])]);
  try {
    await adapter.beginTurn("abort-host-turn", "host"); await adapter.prompt("Fictional completed input.");
    const completed = raw.validator.turns.get("abort-host-turn").operations[0];
    await raw.openOperation("abort-open", {}); await adapter.abortOpenOperations();
    const repairs = await raw.getRepairEntries(); expect(repairs).toHaveLength(1); expect(repairs[0].operationIds).toEqual(["abort-open"]);
    expect(raw.validator.operations.get(completed).end.payload.status).toBe("completed"); expect(await raw.getOpenOperations()).toEqual([]);
  } finally { await adapter.close(); await raw.close(); }
});

it("durably binds opted-in ownership in the first start and seals the actual final native reply", async () => {
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("Fictional final reply.")])]);
  const descriptor = { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "protected-first-start", handleId: raw.metadata.id, baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "host-initial" } };
  const sync = raw.sync.bind(raw); const starts = [];
  raw.sync = async () => { starts.push(raw.records.at(-1)); return sync(); };
  try {
    await adapter.beginTurn(descriptor.turnId, "host", descriptor);
    expect(starts[0]).toMatchObject({ kind: "turn_start", payload: { binding: { ownerKey: descriptor.ownerKey, reconciliation: descriptor.reconciliation } } });
    expect(starts[1].kind).toBe("handle_binding");
    const terminal = await adapter.prompt("Fictional request.");
    const result = { text: "Fictional final reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" };
    await adapter.endTurn("completed", result);
    expect((await raw.getTurn(descriptor.turnId)).payload).toMatchObject({ finalOperationId: terminal.operationId, consumedInputIds: ["host-initial"], seal: { version: 1, outcome: "completed", result } });
  } finally { await adapter.close(); await raw.close(); }
});

it("consumes the original protected input once across reactive replay and internal finalization prompts", async () => {
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("First fictional reply.")]), fauxAssistantMessage([fauxText("Second fictional reply.")]), fauxAssistantMessage([fauxText("Final fictional reply.")])]);
  const descriptor = { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "replay-input", handleId: raw.metadata.id, baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "host-initial" } };
  try {
    await adapter.beginTurn(descriptor.turnId, "host", descriptor);
    await adapter.prompt("Fictional original request."); await adapter.prompt("Fictional original request."); await adapter.prompt("Fictional internal finalization.");
    await adapter.endTurn("completed", { text: "Final fictional reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" });
    expect((await raw.getTurn(descriptor.turnId)).payload.consumedInputIds).toEqual(["host-initial"]);
    expect(raw.records.filter((record) => record.turnId === descriptor.turnId && record.kind === "input_consumed")).toHaveLength(1);
    expect(raw.records.filter((record) => record.turnId === descriptor.turnId && record.kind === "message" && record.payload.message.role === "user").map((record) => record.payload.input.id)).toEqual(["host-initial", "host-initial", null]);
  } finally { await adapter.close(); await raw.close(); }
});

function protectedTurn(raw, turnId = "queue-turn", initialInputId = "initial-input") {
  return { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId, handleId: raw.metadata.id, baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId } };
}
const queueSeal = { text: "Fictional reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" };
it.each([false, true])("excludes cancelling input from poll during durable cancellation and restores on failure (reject=%s)", async (reject) => {
  const real = agentCore.runAgentLoop; let poll;
  const loop = vi.spyOn(agentCore, "runAgentLoop").mockImplementation((prompts, context, config, ...rest) => { poll = config.getSteeringMessages; return real(prompts, context, config, ...rest); });
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("Fictional reply.")])]); let release;
  try {
    const descriptor = protectedTurn(raw); await adapter.beginTurn(descriptor.turnId, "host", descriptor); await adapter.prompt("Fictional initial.");
    const queuedId = await adapter.steer("Fictional cancelled follow-up.", { inputId: "live-input" }); const write = raw.write.bind(raw);
    const gate = new Promise((resolve) => { release = resolve; }); let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    raw.write = async (kind, payload, identity) => {
      if (kind === "input_queued" && payload.state === "cancelled") { entered(); await gate; if (reject) throw new Error("Fictional pre-write rejection"); }
      return write(kind, payload, identity);
    };
    const cancel = adapter.cancelQueued(queuedId); await started;
    expect(await poll()).toEqual([]); expect((await raw.getEntries()).some((entry) => entry.message?.content?.[0]?.text === "Fictional cancelled follow-up.")).toBe(false);
    release();
    if (reject) { await expect(cancel).rejects.toThrow("pre-write rejection"); expect(raw.failure).toBeNull(); expect(await poll()).toMatchObject([{ content: [{ text: "Fictional cancelled follow-up." }] }]); }
    else { expect(await cancel).toEqual({ kind: "cancelled", entryId: queuedId }); expect(await poll()).toEqual([]); }
    raw.write = write; await adapter.endTurn("completed", queueSeal);
    expect(raw.records.filter((record) => record.kind === "input_consumed").map((record) => record.payload.inputId)).toEqual(["initial-input"]);
    expect(raw.validator.inputs.get("live-input").state).toBe("cancelled");
  } finally { release?.(); loop.mockRestore(); await adapter.close(); await raw.close(); }
});
it.each(["cancel", "place"])("durably cancels leftover turn-A input before turn-B can %s it", async (action) => {
  const { adapter, raw, faux } = await harness([fauxAssistantMessage([fauxText("Fictional reply.")]), fauxAssistantMessage([fauxText("Fictional reply.")])]);
  try {
    const a = protectedTurn(raw, "turn-a", "initial-a"), b = protectedTurn(raw, "turn-b", "initial-b");
    await adapter.beginTurn(a.turnId, "host", a); await adapter.prompt("Fictional A.");
    const queuedId = await adapter.steer("Fictional leftover A.", { inputId: "leftover-a" });
    await adapter.endTurn("completed", queueSeal); expect(raw.validator.inputs.get("leftover-a").state).toBe("cancelled");
    expect(raw.records.filter((record) => record.kind === "input_queued" && record.payload.state === "cancelled")).toMatchObject([{ turnId: a.turnId, payload: { inputId: "leftover-a" } }]);
    await adapter.beginTurn(b.turnId, "host", b);
    if (action === "cancel") expect(await adapter.cancelQueued(queuedId)).toEqual({ kind: "not_found", entryId: queuedId });
    await adapter.prompt("Fictional B."); await adapter.endTurn("completed", queueSeal);
    expect([...raw.validator.turns.get(b.turnId).admittedInputIds]).toEqual([]);
    expect(raw.records.filter((record) => record.kind === "message").some((record) => record.payload.message.content?.[0]?.text === "Fictional leftover A.")).toBe(false);
    expect(raw.records.filter((record) => record.kind === "input_consumed").map((record) => record.payload.inputId)).toEqual(["initial-a", "initial-b"]); expect(faux.state.callCount).toBe(2);
  } finally { await adapter.close(); await raw.close(); }
});
it("matches first original consumption on replay after a healthy pre-write failure", async () => {
  const { readTurnEvidence, matchTurnEvidence, digestTurnInput } = await import("../turn-evidence.js");
  const { adapter, raw, faux } = await harness([fauxAssistantMessage([fauxText("Fictional reply.")])]);
  try {
    const descriptor = protectedTurn(raw, "first-consumption-replay"); await adapter.beginTurn(descriptor.turnId, "host", descriptor);
    const append = raw.appendMessage.bind(raw); const failed = vi.spyOn(raw, "appendMessage").mockRejectedValueOnce(new Error("Fictional healthy pre-write failure"));
    await expect(adapter.prompt("Fictional original.")).rejects.toThrow("healthy pre-write failure"); failed.mockRestore(); raw.appendMessage = append;
    expect(raw.failure).toBeNull(); expect(raw.validator.turns.get(descriptor.turnId).inputs.size).toBe(0);
    await adapter.prompt("Fictional original."); await adapter.endTurn("completed", queueSeal);
    const evidence = await readTurnEvidence(raw, descriptor.turnId); expect(evidence.inputs).toMatchObject([{ id: "initial-input", placement: "replay" }]);
    expect(matchTurnEvidence(evidence, { descriptor, purpose: "execution", expectedModel: { provider: "faux", id: "retry-fixture" }, expectedInputs: [{ id: "initial-input", placement: "initial", requestDigest: digestTurnInput("Fictional original.") }] }).status).toBe("matched"); expect(faux.state.callCount).toBe(1);
  } finally { await adapter.close(); await raw.close(); }
});

it("waits for an in-flight live admission and cancels it before sealing the ending turn", async () => {
  const { adapter, raw } = await harness([fauxAssistantMessage([fauxText("Fictional reply.")])]); let release;
  try {
    const descriptor = protectedTurn(raw, "admission-ending"); await adapter.beginTurn(descriptor.turnId, "host", descriptor); await adapter.prompt("Fictional initial.");
    const write = raw.write.bind(raw); let entered; const started = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
    raw.write = async (kind, payload, identity) => { if (kind === "input_queued" && payload.state === "queued") { entered(); await gate; } return write(kind, payload, identity); };
    const admission = adapter.steer("Fictional late offer.", { inputId: "late-live" }); await started;
    let sealed = false; const ending = adapter.endTurn("completed", queueSeal).then(() => { sealed = true; });
    await expect(adapter.steer("Fictional further offer.", { inputId: "forbidden-late" })).rejects.toThrow("ending");
    await expect(adapter.prompt("Fictional premature next prompt.")).rejects.toThrow("ending");
    await expect(adapter.compact()).rejects.toThrow("ending");
    await expect(adapter.endTurn("completed", queueSeal)).rejects.toThrow("ending"); expect(sealed).toBe(false);
    release(); await admission; await ending; expect(raw.validator.inputs.get("late-live").state).toBe("cancelled");
    const records = raw.records.filter((record) => record.turnId === descriptor.turnId); expect(records.findIndex((record) => record.kind === "input_queued" && record.payload.state === "cancelled")).toBeLessThan(records.findIndex((record) => record.kind === "turn_end"));
  } finally { release?.(); await adapter.close(); await raw.close(); }
});
