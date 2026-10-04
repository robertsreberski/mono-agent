import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { MemorySessionRepo } from "../../ai/providers/pi-native/harness/session-store.js";
import { createPiHarnessAdapter, createPiSessionAdapter } from "../../ai/providers/pi-native/harness-adapter.js";

async function harness(responses, retry) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "retry-fixture" }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  const repo = new MemorySessionRepo(); const raw = await repo.create();
  const adapter = await createPiHarnessAdapter(createPiSessionAdapter(raw), {
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
    } finally { await adapter.close(); }
  });
  it.each([
    ["billing quota exceeded", undefined],
    ["503 service unavailable", { enabled: false, maxRetries: 0 }],
  ])("does not retry deterministic errors or provider health checks (%s)", async (text, retry) => {
    const { adapter, faux } = await harness([error(text)], retry);
    try { expect((await adapter.prompt("Fictional request.")).status).toBe("failed"); expect(faux.state.callCount).toBe(1); }
    finally { await adapter.close(); }
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
    } finally { await adapter.close(); }
  });
});
