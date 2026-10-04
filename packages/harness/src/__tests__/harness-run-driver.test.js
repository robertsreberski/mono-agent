import { createRetryStream } from "../retry-stream.js";
import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MemorySessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";

async function harness(responses, retry, modelDef = {}) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "retry-fixture", ...modelDef }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  const repo = new MemorySessionRepo(); const raw = await repo.create();
  const adapter = createRunDriver(raw, {
    models, model: faux.getModel(), tools: [], systemPrompt: "Fictional test.", thinkingLevel: "off",
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

it("settles retry producer and aborts its transport when the consumer exits early", async () => {
  const message = { role: "assistant", content: [], stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } };
  let signal, closed = false;
  const model = { provider: "faux", id: "closed", contextWindow: 100000, maxTokens: 1000 };
  const models = { getModel: () => model, streamSimple: async (_model, _context, options) => {
    signal = options.signal;
    return { async *[Symbol.asyncIterator]() { try { yield { type: "start", partial: message }; yield { type: "text_delta", delta: "Fictional text." }; } finally { closed = true; } }, result: async () => message };
  } };
  const stream = createRetryStream(models, model, { messages: [] }, {}, { maxRetries: 0 }, async () => {});
  const iterator = stream[Symbol.asyncIterator](); expect((await iterator.next()).value.type).toBe("start");
  await iterator.return(); await expect(stream.result()).rejects.toThrow("consumer closed");
  expect(signal.aborted).toBe(true); expect(closed).toBe(true);
});
