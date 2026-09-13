import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { validRecoveryProjection } from "../../ai/providers/pi-native/terminal-recovery.js";
import { captureSessionRecovery } from "../../ai/providers/pi-native/session-lifecycle.js";
const model = fauxProvider({ provider: "faux", models: [{ id: "fixture", reasoning: true }] }).getModel();
const assistant = (content, options) => ({ ...fauxAssistantMessage(content, options), provider: model.provider, model: model.id, api: model.api });
const call = assistant([fauxToolCall("Read", { file_path: "file" }, { id: "read-1" })]);
const result = { role: "toolResult", toolCallId: "read-1", toolName: "Read", content: [{ type: "text", text: "evidence" }], isError: false, timestamp: 1 };

describe("terminal native projection", () => {
  it("allows Pi's synthetic error result for an orphaned retained call", () => {
    expect(validRecoveryProjection([call, { role: "user", content: "next", timestamp: 2 }], model)).toBe(true);
  });
  it("filters failed reasoning without changing completed signatures", () => {
    const messages = [assistant([{ ...fauxThinking("done"), thinkingSignature: "faux-signature" }, fauxText("answer")]),
      assistant([{ ...fauxThinking("partial"), thinkingSignature: "partial-signature" }], { stopReason: "aborted" })];
    const original = JSON.stringify(messages);
    expect(validRecoveryProjection(messages, model)).toBe(true);
    expect(JSON.stringify(messages)).toBe(original);
  });
  it.each([
    [result], [call, result, result], [call, result, call],
    [call, { ...result, toolName: "Other" }],
    [assistant([{ type: "thinking", thinking: "bad", thinkingSignature: {} }])],
    [{ role: "unknown", content: [] }],
  ])("rejects ambiguous or malformed native content %j", (...messages) => {
    expect(validRecoveryProjection(messages, model)).toBe(false);
  });
  it.each(["getLeafId", "getEntries", "close"])("releases pending recovery when %s rejects", async (method) => {
    const entry = { durable: true, recoveryPending: true };
    const session = { getLeafId: async () => "tip", getEntries: async () => [], close: async () => undefined };
    vi.spyOn(session, method).mockRejectedValue(new Error(`${method} failed`));
    await expect(captureSessionRecovery({ sessionEntry: entry, recoveryInputIds: [], session },
      { options: { sessionRecovery: { runId: "run", revision: 1 } }, providerSessionId: "id", modelKey: "faux:fixture", model, pending: true })).rejects.toThrow(`${method} failed`);
    expect(entry.recoveryPending).toBe(false);
    expect(entry.recovery).toBeUndefined();
  });
  it.each([undefined, ""])("releases pending recovery when the tip is unavailable (%j)", async (tip) => {
    const entry = { durable: true, recoveryPending: true };
    await expect(captureSessionRecovery({ registeredSessionEntry: entry, recoveryInputIds: [], session: { getLeafId: async () => tip } },
      { options: { sessionRecovery: { runId: "run", revision: 0 } }, providerSessionId: "id", modelKey: "faux:fixture", model, pending: true })).rejects.toThrow("recovery tip is unavailable");
    expect(entry.recoveryPending).toBe(false);
    expect(entry.recovery).toBeUndefined();
  });
});
